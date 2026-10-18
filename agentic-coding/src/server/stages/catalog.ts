// The stage catalog (`add-stage-testing-foundation`, tasks 1.2–1.3).
//
// Stages are global, operator-owned configuration: `stages/definitions/*.json`
// and one `stages/policy.json` under the canonical configuration root. They are
// never read from `config.json`, from a repository overlay, from an env-setup
// staged root or from a workflow worktree, because the catalog *is* the
// allow-list — a repository must not be able to add itself to it.
//
// Two rules shape this module:
//
// * **A diagnostic is value-free.** It names the file and the field and never
//   the value, because the value a stage validation refuses is exactly the
//   literal credential that must not reach a log, a response or a model.
// * **Refusal is fail-closed.** Only a stage that passes every check is in the
//   allow-list; a policy file that cannot be read refuses *every* stage, since
//   the operator's deny list is then unknown.
//
// `resolveStageCredential` is deliberately the only function in the whole server
// that turns a reference into a value, and it is exported to the login path and
// to nothing else (no route module imports it).
import fs from "node:fs";
import path from "node:path";
import {
	envReferenceName,
	isEnvReference,
	loadEnvFile,
} from "../../env-file.ts";
import {
	decodeStageDefinition,
	decodeStagePolicy,
	STAGE_CREDENTIAL_FIELDS,
	STAGE_IDENT_PATTERN,
	type StageApp,
	type StageCredentialField,
	type StageDefinition,
	type StageLimits,
	type StageLocator,
	type StageLoginRecipe,
	type StagePolicy,
	type StageRole,
} from "./schema.ts";

/** The bounds a stage resolves to when it declares none: the documented
 * defaults of the design, all of them clamped down by the policy ceiling. */
export const DEFAULT_STAGE_LIMITS = {
	maxSessions: 3,
	maxActionsPerMinute: 60,
	maxWaitSeconds: 600,
	maxScreenshots: 60,
	maxRecordingMinutes: 30,
} as const;

export interface EffectiveStageLimits {
	readonly maxSessions: number;
	readonly maxActionsPerMinute: number;
	readonly maxWaitSeconds: number;
	readonly maxScreenshots: number;
	readonly maxRecordingMinutes: number;
}

export interface StageDiagnostic {
	/** The stage (or policy) file the complaint is about. */
	readonly file: string;
	/** The field path inside that file, as `apps.clerk.url`. */
	readonly field: string;
	readonly kind: "error" | "warning";
	readonly message: string;
}

/** One stage file that is not in the allow-list, with the reason. */
export interface ExcludedStage {
	readonly file: string;
	readonly ident?: string;
	readonly diagnostics: readonly StageDiagnostic[];
}

/** One allow-listed stage: the validated definition plus what the server reads
 * from it (effective bounds, the origin allow-list, its diagnostics). */
export interface StageEntry {
	readonly ident: string;
	readonly file: string;
	readonly stage: StageDefinition;
	readonly limits: EffectiveStageLimits;
	/** The stage's allow-list: the origins of its applications together with its
	 * `allowedOrigins`. */
	readonly origins: readonly string[];
	readonly diagnostics: readonly StageDiagnostic[];
}

export interface StageCatalog {
	readonly defsDir: string;
	readonly policyFile: string;
	readonly policy: StagePolicy;
	readonly entries: readonly StageEntry[];
	readonly excluded: readonly ExcludedStage[];
	readonly diagnostics: readonly StageDiagnostic[];
}

export interface StageCatalogOptions {
	/** App idents a stage may link (`apps/definitions`). Defaults to a read of
	 * that directory in the same configuration root. */
	readonly appIdents?: () => readonly string[];
}

/** Resolve the stage tree of one configuration root. */
export function stagePaths(configDir: string): {
	readonly defsDir: string;
	readonly policyFile: string;
} {
	const root = path.join(configDir, "stages");
	return {
		defsDir: path.join(root, "definitions"),
		policyFile: path.join(root, "policy.json"),
	};
}

/**
 * Read and validate the whole catalog.
 *
 * Re-read on every call (like the other configuration domains), so a stage file
 * the developer just edited applies to the next browser call.
 */
export function readStageCatalog(
	configDir: string,
	options: StageCatalogOptions = {},
): StageCatalog {
	const { defsDir, policyFile } = stagePaths(configDir);
	const diagnostics: StageDiagnostic[] = [];
	if (configDir.trim() === "") {
		// An empty root names no directory: `path.join("", "stages")` is the
		// process's own working directory, and a stage must never be allow-listed
		// from there — that is the one way a repository could add itself to the
		// allow-list. Every `?? ""` fallback in the server ends here, so this is the
		// place that has to fail closed.
		diagnostics.push({
			file: "",
			field: "$",
			kind: "error",
			message:
				"no configuration root was given, so no stage is configured (an empty root would resolve against the process's working directory)",
		});
		return {
			defsDir,
			policyFile,
			policy: {},
			entries: [],
			excluded: [],
			diagnostics,
		};
	}
	const policyRead = readPolicy(policyFile, diagnostics);
	const files = listDefinitionFiles(defsDir);
	if (policyRead === undefined) {
		// Without a trustworthy policy the operator's deny list is unknown, so no
		// stage is allow-listed. an empty `stages/` tree is not this case: an empty
		// catalog is simply an empty allow-list.
		return {
			defsDir,
			policyFile,
			policy: {},
			entries: [],
			excluded: files.map((file) => ({
				file,
				// The policy's diagnostics are recorded under the policy file's own
				// basename, so the comparison has to be like for like: a stage that
				// vanished must always carry the reason it vanished.
				diagnostics: diagnostics.filter(
					(entry) => entry.file === path.basename(policyFile),
				),
			})),
			diagnostics,
		};
	}
	const appIdents = options.appIdents
		? options.appIdents()
		: defaultAppIdents(configDir);
	const knownApps = new Set(appIdents);
	const entries: StageEntry[] = [];
	const excluded: ExcludedStage[] = [];
	for (const file of files) {
		const pending = readStageFile(file, defsDir, policyRead, knownApps);
		diagnostics.push(...pending.diagnostics);
		const errors = pending.diagnostics.some((entry) => entry.kind === "error");
		if (errors || !pending.stage) {
			excluded.push({
				file,
				...(pending.stage ? { ident: pending.stage.ident } : {}),
				diagnostics: pending.diagnostics.filter(
					(entry) => entry.kind === "error",
				),
			});
			continue;
		}
		entries.push({
			ident: pending.stage.ident,
			file,
			stage: pending.stage,
			limits: pending.limits,
			origins: stageOrigins(pending.stage),
			diagnostics: pending.diagnostics,
		});
	}
	entries.sort((left, right) => left.ident.localeCompare(right.ident));
	return {
		defsDir,
		policyFile,
		policy: policyRead,
		entries,
		excluded,
		diagnostics,
	};
}

/** One allow-listed stage by ident. */
export function stageByIdent(
	catalog: StageCatalog,
	ident: string,
): StageEntry | undefined {
	return catalog.entries.find((entry) => entry.ident === ident);
}

/** Why one ident is not usable, as one value-free sentence. */
export function stageRefusalReason(
	catalog: StageCatalog,
	ident: string,
): string {
	const excluded = catalog.excluded;
	const match = excluded.find(
		(entry) =>
			entry.ident === ident || path.basename(entry.file, ".json") === ident,
	);
	if (match) {
		const first = match.diagnostics[0];
		return first
			? `${path.basename(match.file)} is not allow-listed: ${first.field}: ${first.message}`
			: `${path.basename(match.file)} is not allow-listed`;
	}
	return `no stage ${JSON.stringify(ident)} is configured under ${catalog.defsDir}`;
}

// ---------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------

interface PendingStage {
	readonly file: string;
	readonly stage?: StageDefinition;
	readonly limits: EffectiveStageLimits;
	readonly diagnostics: StageDiagnostic[];
}

/** Read `stages/policy.json`. `undefined` means "present but unusable", which
 * refuses every stage rather than validating against an unknown deny list. */
function readPolicy(
	policyFile: string,
	diagnostics: StageDiagnostic[],
): StagePolicy | undefined {
	const file = path.basename(policyFile);
	let raw: string;
	try {
		raw = fs.readFileSync(policyFile, "utf8");
	} catch (error) {
		if (isMissing(error)) return {};
		diagnostics.push({
			file,
			field: "$",
			kind: "error",
			message: "the stage policy could not be read",
		});
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		diagnostics.push({
			file,
			field: "$",
			kind: "error",
			message: "not valid JSON, so no stage is allow-listed",
		});
		return undefined;
	}
	const decoded = decodeStagePolicy(parsed);
	if (!decoded.ok) {
		for (const issue of decoded.issues)
			diagnostics.push({
				file,
				field: issue.path,
				kind: "error",
				message: issue.message,
			});
		return undefined;
	}
	return decoded.value;
}

/** Stage definition files, sorted, so diagnostics and views are stable. */
function listDefinitionFiles(defsDir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(defsDir);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.filter((name) => {
			try {
				return fs.statSync(path.join(defsDir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

function readStageFile(
	file: string,
	defsDir: string,
	policy: StagePolicy,
	knownApps: ReadonlySet<string>,
): PendingStage {
	const fallbackLimits = effectiveLimits({}, policy);
	const diagnostics: StageDiagnostic[] = [];
	const fail = (field: string, message: string): PendingStage => {
		diagnostics.push({ file, field, kind: "error", message });
		return { file, limits: fallbackLimits, diagnostics };
	};
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(defsDir, file), "utf8");
	} catch {
		return fail("$", "the stage file could not be read");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fail("$", "not valid JSON");
	}
	const decoded = decodeStageDefinition(parsed);
	if (!decoded.ok) {
		for (const issue of decoded.issues)
			diagnostics.push({
				file,
				field: issue.path,
				kind: "error",
				message: issue.message,
			});
		return { file, limits: fallbackLimits, diagnostics };
	}
	const stage = decoded.value;
	const stem = file.slice(0, -".json".length);
	if (stage.ident !== stem)
		return fail("ident", `must equal the file stem ${JSON.stringify(stem)}`);
	const refusals = validateStage(stage, file, policy, diagnostics, knownApps);
	if (refusals) return { file, stage, limits: fallbackLimits, diagnostics };
	return {
		file,
		stage,
		limits: effectiveLimits(stage.limits, policy),
		diagnostics,
	};
}

/**
 * The semantic checks of the allow-list. Answers `true` when the stage must be
 * refused; every refusal is an `error` diagnostic, and clamping is a `warning`
 * that leaves the stage in the allow-list.
 */
function validateStage(
	stage: StageDefinition,
	file: string,
	policy: StagePolicy,
	diagnostics: StageDiagnostic[],
	knownApps: ReadonlySet<string>,
): boolean {
	const fail = (field: string, message: string) => {
		diagnostics.push({ file, field, kind: "error", message });
	};
	if (!STAGE_IDENT_PATTERN.test(stage.ident))
		fail("ident", "must match ^[a-z0-9][a-z0-9-]{0,62}$");
	for (const [field, value] of [
		["ident", stage.ident],
		["environment", stage.environment],
	] as const) {
		const token = productionToken(value);
		if (token)
			fail(
				field,
				`names ${JSON.stringify(token)}; a production-like stage can never be configured`,
			);
	}
	const appKeys = Object.keys(stage.apps);
	if (appKeys.length === 0) fail("apps", "declares no application");
	for (const [key, app] of Object.entries(stage.apps)) {
		const field = `apps.${key}`;
		if (app.label.trim() === "") fail(`${field}.label`, "must not be empty");
		validateUrl(app.url, stage, policy, (message) =>
			fail(`${field}.url`, message),
		);
		// A link to an app that does not exist is a typo that would otherwise only
		// surface as `app-not-found` at the moment an agent opens the stage.
		if (app.app !== undefined && !knownApps.has(app.app))
			fail(
				`${field}.app`,
				`names ${JSON.stringify(app.app)}, which is not configured under apps/definitions`,
			);
		for (const [name, role] of Object.entries(app.roles ?? {}))
			validateRole(stage, role, `${field}.roles.${name}`, diagnostics, file);
	}
	for (const [index, origin] of (stage.allowedOrigins ?? []).entries())
		validateUrl(origin, stage, policy, (message) =>
			fail(`allowedOrigins[${index}]`, message),
		);
	for (const [name, recipe] of Object.entries(stage.logins ?? {}))
		validateRecipe(recipe, `logins.${name}`, stage, fail);
	for (const [index, exception] of (stage.readOnlyExceptions ?? []).entries()) {
		if (exception.origin.trim() === "" || exception.pathPrefix === "")
			fail(`readOnlyExceptions[${index}]`, "needs an origin and a pathPrefix");
	}
	clampDiagnostics(stage.limits, policy, file, diagnostics);
	return diagnostics.some(
		(entry) => entry.file === file && entry.kind === "error",
	);
}

function validateRole(
	stage: StageDefinition,
	role: StageRole,
	field: string,
	diagnostics: StageDiagnostic[],
	file: string,
): void {
	const fail = (sub: string, message: string) => {
		diagnostics.push({ file, field: `${field}${sub}`, kind: "error", message });
	};
	for (const name of STAGE_CREDENTIAL_FIELDS) {
		const value = role[name];
		if (value === undefined) continue;
		if (!isEnvReference(value))
			fail(
				`.${name}`,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the diagnostic must show the reference syntax a stage file writes
				"must be exactly one ${VARIABLE} reference resolved from the configuration .env",
			);
	}
	if (role.login === undefined) return;
	const recipe = stage.logins?.[role.login];
	if (!recipe) {
		fail(
			".login",
			`names the login recipe ${JSON.stringify(role.login)}, which the stage does not declare`,
		);
		return;
	}
	// A recipe may only type a one-time code the role can actually supply: a
	// missing `totp` reference would otherwise fail mid-login at the MFA step.
	const usesTotp = (recipe.steps ?? []).some((step) =>
		step.fields.some((entry) => entry.credential === "totp"),
	);
	if (usesTotp && role.totp === undefined)
		fail(
			".login",
			`uses a TOTP field of ${JSON.stringify(role.login)} but the role declares no totp reference`,
		);
}

function validateRecipe(
	recipe: StageLoginRecipe,
	field: string,
	stage: StageDefinition,
	fail: (field: string, message: string) => void,
): void {
	const steps = recipe.steps ?? [];
	if (recipe.kind === "form" && steps.length === 0)
		fail(`${field}.steps`, "a form recipe needs at least one step");
	for (const [index, step] of steps.entries()) {
		for (const [position, entry] of step.fields.entries())
			if (!locatorNamesSomething(entry))
				fail(
					`${field}.steps[${index}].fields[${position}]`,
					"needs a label, a role plus name, or a selector",
				);
		if (step.submit && !locatorNamesSomething(step.submit))
			fail(
				`${field}.steps[${index}].submit`,
				"needs a role plus name, or a selector",
			);
	}
	if (recipe.origin !== undefined) {
		try {
			const origin = new URL(recipe.origin).origin;
			if (!stageOrigins(stage).includes(origin))
				fail(
					`${field}.origin`,
					"is not in the stage's allow-list (add it to allowedOrigins)",
				);
		} catch {
			fail(`${field}.origin`, "is not an absolute URL");
		}
	}
}

function locatorNamesSomething(locator: StageLocator): boolean {
	if (locator.selector !== undefined && locator.selector.trim() !== "")
		return true;
	if (locator.label !== undefined && locator.label.trim() !== "") return true;
	return locator.role !== undefined && locator.role.trim() !== "";
}

/** One application URL or declared origin: `https`, allow-listed host, not a
 * denied host. */
function validateUrl(
	value: string,
	stage: StageDefinition,
	policy: StagePolicy,
	fail: (message: string) => void,
): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("must be an absolute URL");
		return;
	}
	const denied = (policy.deniedHostPatterns ?? []).find((pattern) =>
		hostMatches(url.hostname, pattern),
	);
	if (denied !== undefined) {
		fail(`host ${url.hostname} matches the denied pattern ${denied}`);
		return;
	}
	if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
		if (stage.insecureHttp !== true)
			fail(
				"must use https unless the host is a loopback address or the stage sets insecureHttp",
			);
	}
}

/** One denied-host pattern against one host. `*` matches any run of characters
 * and `?` one, case-insensitively; a pattern with no wildcard is an exact host. */
export function hostMatches(host: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (trimmed === "") return false;
	const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(
		`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
		"i",
	);
	return regex.test(host);
}

function isLoopback(host: string): boolean {
	const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized.startsWith("127.")
	);
}

/** `prod`-like tokens, as whole tokens of an ident or an environment label. */
function productionToken(value: string): string | undefined {
	for (const token of value.toLowerCase().split(/[^a-z0-9]+/))
		if (
			token === "prod" ||
			token === "production" ||
			token === "prd" ||
			token === "live"
		)
			return token;
	return undefined;
}

/** The effective bounds of one stage: declared value, else the documented
 * default, never above the policy ceiling. */
export function effectiveLimits(
	limits: StageLimits | undefined,
	policy: StagePolicy,
): EffectiveStageLimits {
	const ceilings = policy.ceilings ?? {};
	const pick = (field: keyof EffectiveStageLimits): number => {
		const declared = limits?.[field];
		const base = declared ?? DEFAULT_STAGE_LIMITS[field];
		const ceiling = ceilings[field];
		return ceiling === undefined ? base : Math.min(base, ceiling);
	};
	return {
		maxSessions: pick("maxSessions"),
		maxActionsPerMinute: pick("maxActionsPerMinute"),
		maxWaitSeconds: pick("maxWaitSeconds"),
		maxScreenshots: pick("maxScreenshots"),
		maxRecordingMinutes: pick("maxRecordingMinutes"),
	};
}

/** Report every clamp as a warning, so a stage whose bound was reduced says so
 * instead of silently running with a different value. */
function clampDiagnostics(
	limits: StageLimits | undefined,
	policy: StagePolicy,
	file: string,
	diagnostics: StageDiagnostic[],
): void {
	const ceilings = policy.ceilings ?? {};
	for (const field of [
		"maxSessions",
		"maxActionsPerMinute",
		"maxWaitSeconds",
		"maxScreenshots",
		"maxRecordingMinutes",
	] as const) {
		const declared = limits?.[field];
		const ceiling = ceilings[field];
		if (declared === undefined || ceiling === undefined) continue;
		if (declared <= ceiling) continue;
		diagnostics.push({
			file,
			field: `limits.${field}`,
			kind: "warning",
			message: `clamped to the policy ceiling ${ceiling}`,
		});
	}
}

/** The origins a stage may be driven on: its applications' origins plus its
 * declared `allowedOrigins`. */
export function stageOrigins(stage: StageDefinition): string[] {
	const origins = new Set<string>();
	for (const app of Object.values(stage.apps)) {
		const origin = originOf(app.url);
		if (origin) origins.add(origin);
	}
	for (const declared of stage.allowedOrigins ?? []) {
		const origin = originOf(declared);
		if (origin) origins.add(origin);
	}
	return [...origins];
}

function originOf(value: string): string | undefined {
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** A credential reference that cannot be resolved right now. It names the
 * variable and never a value. */
export class StageCredentialError extends Error {
	constructor(readonly variable: string) {
		super(
			`${variable} is not set in the configuration .env; set it in Settings → Stages before this login`,
		);
		this.name = "StageCredentialError";
	}
}

/**
 * Resolve one role's credential reference to its value.
 *
 * This is the only function in the server that returns a credential value, and
 * no route module imports it: the login path (`browser/login.ts`) resolves,
 * types and forgets. The value is read from the configuration root `.env` at
 * call time, so a credential the developer just set applies to the next login.
 */
export function resolveStageCredential(
	stage: StageDefinition,
	appKey: string,
	roleName: string,
	field: StageCredentialField,
	configDir: string,
): string {
	const role = stage.apps[appKey]?.roles?.[roleName];
	if (!role) throw new StageCredentialError(`${appKey}.${roleName}.${field}`);
	const reference = role[field];
	if (reference === undefined)
		throw new StageCredentialError(`${appKey}.${roleName}.${field}`);
	const name = envReferenceName(reference) ?? `${appKey}.${roleName}.${field}`;
	// An empty root can never resolve a credential: `path.join("", ".env")` is the
	// working directory's `.env`, which is not a configuration root.
	if (configDir.trim() === "") throw new StageCredentialError(name);
	const value = loadEnvFile(path.join(configDir, ".env")).get(name);
	if (value === undefined || value.trim() === "")
		throw new StageCredentialError(name);
	return value;
}

/** The variable one credential field references. */
export function credentialVariable(
	stage: StageDefinition,
	appKey: string,
	roleName: string,
	field: StageCredentialField,
): string | undefined {
	const role = stage.apps[appKey]?.roles?.[roleName];
	const reference = role?.[field];
	return reference === undefined ? undefined : envReferenceName(reference);
}

/** Every credential variable an allow-listed stage references, for the Settings
 * credential flow: only a referenced key may be written from a stage section. */
export function stageCredentialVariables(catalog: StageCatalog): Map<
	string,
	{
		readonly stage: string;
		readonly app: string;
		readonly role: string;
		readonly field: StageCredentialField;
	}
> {
	const variables = new Map<
		string,
		{ stage: string; app: string; role: string; field: StageCredentialField }
	>();
	for (const entry of catalog.entries) {
		for (const app of Object.values(entry.stage.apps)) {
			for (const [roleName, role] of Object.entries(app.roles ?? {})) {
				for (const field of STAGE_CREDENTIAL_FIELDS) {
					const reference = role[field];
					if (reference === undefined) continue;
					const name = envReferenceName(reference);
					if (!name) continue;
					variables.set(name, {
						stage: entry.ident,
						app: app.label,
						role: roleName,
						field,
					});
				}
			}
		}
	}
	return variables;
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export interface StageCredentialView {
	readonly field: StageCredentialField;
	/** The `.env` variable this field references. Reported with *every* status, so
	 * a value that is already set can still be replaced: the key that would be
	 * written is the key the row has to name. */
	readonly variable: string;
	/** `set` or `missing <VAR>`. */
	readonly status: string;
}

export interface StageRoleView {
	readonly role: string;
	readonly login?: string;
	readonly loginKind?: "form" | "http-basic";
	readonly credentials: readonly StageCredentialView[];
}

export interface StageAppView {
	readonly key: string;
	readonly label: string;
	readonly url: string;
	readonly kind: StageApp["kind"];
	readonly api?: string;
	readonly app?: string;
	readonly roles: readonly StageRoleView[];
	readonly version?: { readonly path: string; readonly field: string };
}

/** One stage as a read surface sees it: structure, credential *status* and
 * diagnostics. Never a credential value, never a resolved reference. */
export interface StageView {
	readonly ident: string;
	readonly displayName: string;
	readonly environment: string;
	readonly system: string;
	readonly access: StageDefinition["access"];
	readonly planApproval: NonNullable<StageDefinition["planApproval"]>;
	readonly exclusive: boolean;
	readonly apps: readonly StageAppView[];
	readonly allowedOrigins: readonly string[];
	readonly readOnlyExceptions: readonly {
		readonly origin: string;
		readonly pathPrefix: string;
		readonly methods: readonly string[];
	}[];
	readonly data: {
		readonly prefix?: string;
		readonly notes?: string;
		readonly cleanup?: string;
	};
	readonly limits: EffectiveStageLimits;
	readonly wiki: { readonly processes: readonly string[] };
	readonly diagnostics: readonly StageDiagnostic[];
}

/** Project one allow-listed stage for a read surface (dashboard, Settings and
 * `stage_info`). Credential status is read from `.env` per call. */
export function stageView(entry: StageEntry, configDir: string): StageView {
	const env = loadEnvFile(path.join(configDir, ".env"));
	const apps: StageAppView[] = Object.entries(entry.stage.apps).map(
		([key, app]) => ({
			key,
			label: app.label,
			url: app.url,
			kind: app.kind,
			...(app.api === undefined ? {} : { api: app.api }),
			...(app.app === undefined ? {} : { app: app.app }),
			roles: Object.entries(app.roles ?? {}).map(([role, value]) => {
				const recipe =
					value.login === undefined
						? undefined
						: entry.stage.logins?.[value.login];
				return {
					role,
					...(value.login === undefined ? {} : { login: value.login }),
					...(recipe ? { loginKind: recipe.kind } : {}),
					credentials: roleCredentialViews(value, env),
				};
			}),
			...(app.version
				? { version: { path: app.version.path, field: app.version.field } }
				: {}),
		}),
	);
	return {
		ident: entry.ident,
		displayName: entry.stage.displayName,
		environment: entry.stage.environment,
		system: entry.stage.system,
		access: entry.stage.access,
		planApproval: entry.stage.planApproval ?? "when-writing",
		exclusive: entry.stage.exclusive === true,
		apps,
		allowedOrigins: entry.stage.allowedOrigins ?? [],
		readOnlyExceptions: (entry.stage.readOnlyExceptions ?? []).map(
			(exception) => ({
				origin: exception.origin,
				pathPrefix: exception.pathPrefix,
				methods: exception.methods ?? ["POST"],
			}),
		),
		data: {
			...(entry.stage.data?.prefix === undefined
				? {}
				: { prefix: entry.stage.data.prefix }),
			...(entry.stage.data?.notes === undefined
				? {}
				: { notes: entry.stage.data.notes }),
			...(entry.stage.data?.cleanup === undefined
				? {}
				: { cleanup: entry.stage.data.cleanup }),
		},
		limits: entry.limits,
		wiki: { processes: entry.stage.wiki?.processes ?? [] },
		diagnostics: entry.diagnostics,
	};
}

function roleCredentialViews(
	role: StageRole,
	env: ReadonlyMap<string, string>,
): StageCredentialView[] {
	const views: StageCredentialView[] = [];
	for (const field of STAGE_CREDENTIAL_FIELDS) {
		const reference = role[field];
		if (reference === undefined) continue;
		const name = envReferenceName(reference);
		if (name === undefined) continue;
		const value = env.get(name);
		views.push({
			field,
			variable: name,
			status:
				value === undefined || value.trim() === "" ? `missing ${name}` : "set",
		});
	}
	return views;
}

/** The app idents under `apps/definitions` of the same configuration root. */
function defaultAppIdents(configDir: string): string[] {
	const dir = path.join(configDir, "apps", "definitions");
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length));
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
