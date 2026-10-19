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
	DEFAULT_IDENTITY_CACHE,
	MAX_IDENTITY_CACHE_ENTRIES,
	MAX_IDENTITY_CACHE_REFRESH_SECONDS,
	MAX_IDENTITY_CACHE_TTL_MINUTES,
	MIN_IDENTITY_CACHE_REFRESH_SECONDS,
} from "./identity-cache.ts";
import {
	decodeStageDefinition,
	decodeStagePolicy,
	isOAuth2Role,
	STAGE_CREDENTIAL_FIELDS,
	STAGE_IDENT_PATTERN,
	STAGE_ROLE_CREDENTIAL_FIELDS,
	type StageApp,
	type StageDefinition,
	type StageLimits,
	type StageLocator,
	type StageLoginRecipe,
	type StageLoginRecipeKind,
	type StageOAuth2Grant,
	type StageOAuth2Provider,
	type StagePolicy,
	type StageRole,
	type StageRoleCredentialField,
} from "./schema.ts";

/** The bounds a stage resolves to when it declares none: the documented
 * defaults of the design, all of them clamped down by the policy ceiling. */
export const DEFAULT_STAGE_LIMITS = {
	maxSessions: 3,
	maxActionsPerMinute: 60,
	maxWaitSeconds: 600,
	maxScreenshots: 60,
	maxRecordingMinutes: 30,
	maxLoginHandoffSeconds: 900,
} as const;

/** The hard ceiling of a login hand-off, whatever the policy says: 30 minutes of
 * a developer's window is as long as one hand-off may block a stage action, and
 * a policy that declares a larger one is clamped to this. */
export const MAX_LOGIN_HANDOFF_SECONDS = 1800;

/** The identity cache's documented defaults and hard ceilings live with the
 * cache (`add-stage-identity-cache`); the policy and the effective bounds are
 * resolved here, where every other bound is. */
export {
	DEFAULT_IDENTITY_CACHE,
	MAX_IDENTITY_CACHE_ENTRIES,
	MAX_IDENTITY_CACHE_REFRESH_SECONDS,
	MAX_IDENTITY_CACHE_TTL_MINUTES,
	MIN_IDENTITY_CACHE_REFRESH_SECONDS,
};

export interface EffectiveStageLimits {
	readonly maxSessions: number;
	readonly maxActionsPerMinute: number;
	readonly maxWaitSeconds: number;
	readonly maxScreenshots: number;
	readonly maxRecordingMinutes: number;
	readonly maxLoginHandoffSeconds: number;
}

/** Whether this server may open a headed window for a stage login it cannot
 * automate: the policy's value, narrowed by the stage and never widened by it. */
export type InteractiveLoginMode = "local" | "never";

/** One stage's effective identity-cache bounds: whether it may cache at all, how
 * long one capture lives, how many entries the process keeps, and how often a
 * living session re-captures. */
export interface EffectiveIdentityCache {
	readonly enabled: boolean;
	readonly ttlMs: number;
	readonly maxEntries: number;
	readonly refreshMs: number;
}

/** The effective identity-cache bounds of one stage: the policy's ceilings (or
 * the documented defaults), each clamped to its own hard ceiling, and the
 * stage's own `identityCache: false` opt-out. A stage cannot raise a bound; a
 * refresh interval can never outlive the entry it refreshes. */
export function effectiveIdentityCache(
	stage: Pick<StageDefinition, "identityCache">,
	policy: StagePolicy,
): EffectiveIdentityCache {
	const declared = policy.identityCache ?? {};
	const ttlMinutes = Math.min(
		declared.ttlMinutes ?? DEFAULT_IDENTITY_CACHE.ttlMinutes,
		MAX_IDENTITY_CACHE_TTL_MINUTES,
	);
	const refreshSeconds = Math.min(
		MAX_IDENTITY_CACHE_REFRESH_SECONDS,
		// A floor, because the refresh is bound to *use*: at a one-second interval a
		// session whose calls are a second apart re-captures on each of them, which is
		// the per-call cost the interval exists to keep off the hot path (PERF).
		Math.max(
			MIN_IDENTITY_CACHE_REFRESH_SECONDS,
			declared.refreshSeconds ?? DEFAULT_IDENTITY_CACHE.refreshSeconds,
		),
		// A re-capture after the entry has already expired would put a value into
		// the store that no read could ever install, so a short TTL still wins over
		// the floor.
		ttlMinutes * 60,
	);
	return {
		enabled: stage.identityCache !== false,
		ttlMs: ttlMinutes * 60_000,
		maxEntries: Math.min(
			declared.maxEntries ?? DEFAULT_IDENTITY_CACHE.maxEntries,
			MAX_IDENTITY_CACHE_ENTRIES,
		),
		refreshMs: refreshSeconds * 1_000,
	};
}

/** The origins a cached identity may cover (`add-stage-identity-cache`, D2): the
 * stage's own applications, plus the origin each of its login recipes runs on.
 * A third-party host a page happens to call is in neither set, so neither its
 * cookies nor its storage are ever captured or installed. */
export function stageIdentityOrigins(stage: StageDefinition): string[] {
	const origins = new Set<string>(stageAppOrigins(stage));
	for (const recipe of Object.values(stage.logins ?? {})) {
		if (recipe.origin === undefined) continue;
		const origin = originOf(recipe.origin);
		if (origin) origins.add(origin);
	}
	return [...origins];
}

/** What a run can expect of one role's login, as both read surfaces report it:
 * `automated` (this server performs it), `handoff` (it needs the developer and
 * a window may be opened), `unavailable` (it needs the developer and this
 * configuration forbids the window). */
export type StageLoginMode = "automated" | "handoff" | "unavailable";

/** The login kinds a read surface reports: a declared recipe of the stage's
 * `logins` table, or the reserved `oauth2` recipe (`add-stage-oauth2-auth`),
 * which is performed against a declared provider and types nothing into a page. */
export type StageLoginKind = StageLoginRecipeKind | "oauth2";

/** The effective interactive-login mode of one stage. The policy decides, the
 * stage may narrow to `never`, and a stage that asks for `local` under a
 * `never` policy does not widen it (the widening is reported as a warning). */
export function effectiveInteractiveLogin(
	stage: Pick<StageDefinition, "interactiveLogin">,
	policy: StagePolicy,
): InteractiveLoginMode {
	if ((policy.interactiveLogin ?? "local") === "never") return "never";
	return stage.interactiveLogin ?? "local";
}

/** The login mode of one role: an unautomatable or credential-less login in a
 * configuration that forbids a window is `unavailable` rather than a hand-off
 * that could never happen. */
export function roleLoginMode(input: {
	readonly recipeKind?: StageLoginKind;
	/** The grant of an `oauth2` role, which decides whether the login needs a
	 * person at all. */
	readonly grant?: StageOAuth2Grant;
	readonly credentialStatus: string;
	readonly interactiveLogin: InteractiveLoginMode;
}): StageLoginMode {
	const mayOpenWindow = input.interactiveLogin === "local";
	// A role with no recipe has no login at all: nothing to automate and nothing
	// to hand off.
	if (input.recipeKind === undefined) return "automated";
	if (input.recipeKind === "interactive")
		return mayOpenWindow ? "handoff" : "unavailable";
	if (input.recipeKind === "oauth2") {
		// The authorization code grant is a person's sign-in
		// (`add-stage-oauth2-code-pkce`): no reference of the role's own decides it,
		// because the identity is the developer's at the provider. It is a hand-off
		// whenever a window may be opened, and `unavailable` only under a policy that
		// forbids one — the value the contract reserves for "needs a person, and this
		// build cannot".
		if (input.grant === "authorization_code")
			return mayOpenWindow && input.credentialStatus === "set"
				? "handoff"
				: "unavailable";
		// The two unattended grants need no person at all; a missing reference is
		// a `.env` gap no window could fill, so it is `unavailable` too.
		return input.grant === undefined || input.credentialStatus !== "set"
			? "unavailable"
			: "automated";
	}
	if (input.credentialStatus === "set") return "automated";
	// A `http-basic` login cannot be handed off: the browser's own authentication
	// dialog does not appear in a window this server launched (spike 0.2), so the
	// role keeps the foundation's `credential-missing` refusal under either
	// policy instead of handing off to a window that could never accept it.
	if (input.recipeKind === "http-basic") return "unavailable";
	// No reference at all, or a reference this `.env` does not set: both need the
	// developer, and both keep the `credential-missing` refusal under `never`.
	return mayOpenWindow ? "handoff" : "unavailable";
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
	/** The stage's effective interactive-login mode: the policy's value narrowed
	 * by the stage. */
	readonly interactiveLogin: InteractiveLoginMode;
	/** The stage's allow-list: the origins of its applications together with its
	 * `allowedOrigins`. */
	readonly origins: readonly string[];
	/** The identity cache's effective bounds for this stage
	 * (`add-stage-identity-cache`). */
	readonly identity: EffectiveIdentityCache;
	/** The origins a cached identity covers: the applications and the login
	 * recipes, never a third-party host. */
	readonly identityOrigins: readonly string[];
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
			interactiveLogin: effectiveInteractiveLogin(pending.stage, policyRead),
			origins: stageOrigins(pending.stage),
			identity: effectiveIdentityCache(pending.stage, policyRead),
			identityOrigins: stageIdentityOrigins(pending.stage),
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
	// A ceiling above the hard one is a value the operator wrote and that no stage
	// can ever be bounded by, so it says so here instead of reading back lowered
	// under a stage's own clamp message (MIG-006).
	const declaredCeiling = decoded.value.ceilings?.maxLoginHandoffSeconds;
	if (
		declaredCeiling !== undefined &&
		declaredCeiling > MAX_LOGIN_HANDOFF_SECONDS
	)
		diagnostics.push({
			file,
			field: "ceilings.maxLoginHandoffSeconds",
			kind: "warning",
			message: `is lowered to the ${MAX_LOGIN_HANDOFF_SECONDS} s login hand-off ceiling, which is the longest one hand-off may block a stage action`,
		});
	// The same for the identity cache's three ceilings
	// (`add-stage-identity-cache`): a policy value no stage can ever be bounded by
	// is reported once, at the policy, rather than under every stage's own view.
	for (const [field, hard] of [
		["ttlMinutes", MAX_IDENTITY_CACHE_TTL_MINUTES],
		["maxEntries", MAX_IDENTITY_CACHE_ENTRIES],
		["refreshSeconds", MAX_IDENTITY_CACHE_REFRESH_SECONDS],
	] as const) {
		const declared = identityCacheCeiling(decoded.value, field);
		if (declared === undefined || declared <= hard) continue;
		diagnostics.push({
			file,
			field: `identityCache.${field}`,
			kind: "warning",
			message: `is lowered to the hard ceiling ${hard}, which no stage identity cache may exceed`,
		});
	}
	return decoded.value;
}

/** One declared identity-cache ceiling of the policy, when it has one. */
function identityCacheCeiling(
	policy: StagePolicy,
	field: keyof typeof DEFAULT_IDENTITY_CACHE,
): number | undefined {
	return policy.identityCache?.[field];
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
	validateReservedRecipeName(stage, file, diagnostics);
	validateRefreshTokenSharing(stage, fail);
	validateOAuth2Providers(stage, policy, fail);
	// A stage may narrow the operator's policy and never widen it. The stage is
	// still allow-listed (nothing about it is unsafe to *read*), so the ignored
	// widening is a warning that names the file and the field.
	if (
		stage.interactiveLogin === "local" &&
		(policy.interactiveLogin ?? "local") === "never"
	)
		diagnostics.push({
			file,
			field: "interactiveLogin",
			kind: "warning",
			message:
				'is ignored: the policy denies interactive login (policy.json interactiveLogin: "never")',
		});
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
	const warn = (sub: string, message: string) => {
		diagnostics.push({
			file,
			field: `${field}${sub}`,
			kind: "warning",
			message,
		});
	};
	for (const name of STAGE_ROLE_CREDENTIAL_FIELDS) {
		const value = role[name];
		if (value === undefined) continue;
		if (!isEnvReference(value))
			fail(
				`.${name}`,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the diagnostic must show the reference syntax a stage file writes
				"must be exactly one ${VARIABLE} reference resolved from the configuration .env",
			);
	}
	if (isOAuth2Role(role)) {
		validateOAuth2Role(stage, role, fail, warn);
		return;
	}
	// A recipe of the stage's own `logins` table is what a role without the new
	// fields selects, even when that recipe is named `oauth2` (MIG-001).
	// The `oauth2` recipe's fields mean nothing on any other role: a stage that
	// declares them there has a typo or an unfinished edit, and a leftover
	// `bearerOrigins` would install a token on a role that never obtains one.
	for (const sub of [".provider", ".grant", ".bearerOrigins", ".refreshToken"])
		if (Object.hasOwn(role, sub.slice(1)))
			fail(
				sub,
				`belongs to the oauth2 recipe; add "login": "oauth2" to this role or remove it`,
			);
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

/**
 * The `oauth2` recipe of one role (`add-stage-oauth2-auth`, task 1.1).
 *
 * Every refusal is value-free: it names the field and, at most, the provider or
 * the grant that failed, never a reference's value.
 */
function validateOAuth2Role(
	stage: StageDefinition,
	role: StageRole,
	fail: (sub: string, message: string) => void,
	warn: (sub: string, message: string) => void,
): void {
	if (role.login !== "oauth2")
		fail(
			".login",
			'is required: a role that declares `provider` or `grant` selects the oauth2 recipe with "login": "oauth2"',
		);
	for (const name of STAGE_CREDENTIAL_FIELDS)
		if (role[name] !== undefined)
			warn(
				`.${name}`,
				"is ignored: the oauth2 recipe types nothing into a page",
			);
	const providerName = role.provider;
	if (providerName === undefined || providerName.trim() === "") {
		fail(".provider", "names no oauth2 provider of this stage");
		return;
	}
	const provider = stage.oauth2?.providers?.[providerName];
	if (!provider) {
		fail(
			".provider",
			`names the oauth2 provider ${JSON.stringify(providerName)}, which the stage does not declare`,
		);
		return;
	}
	const grant = role.grant;
	if (grant === undefined) {
		fail(".grant", "names no oauth2 grant");
		return;
	}
	// A confidential client is what the two unattended grants speak as; the
	// authorization code grant may be a public client, whose secret is optional.
	if (grant !== "authorization_code" && provider.clientSecret === undefined)
		fail(
			".provider",
			`selects ${JSON.stringify(providerName)}, which declares no clientSecret; the ${grant} grant needs one`,
		);
	if (grant === "refresh_token" && role.refreshToken === undefined)
		fail(
			".refreshToken",
			"must reference the refresh token a refresh_token grant exchanges for access tokens",
		);
	if (grant !== "refresh_token" && role.refreshToken !== undefined)
		fail(
			".refreshToken",
			`is declared, but only the refresh_token grant uses one (this role's grant is ${grant})`,
		);
	if (
		grant === "authorization_code" &&
		provider.authorizationEndpoint === undefined
	)
		fail(
			".provider",
			`selects ${JSON.stringify(providerName)}, which declares no authorizationEndpoint; the authorization_code grant needs one`,
		);
	const appOrigins = stageAppOrigins(stage);
	for (const [index, origin] of (role.bearerOrigins ?? []).entries()) {
		const parsed = originOf(origin);
		if (parsed === undefined || origin !== parsed) {
			fail(
				`.bearerOrigins[${index}]`,
				"must be one origin, written exactly as `https://host[:port]`",
			);
			continue;
		}
		if (!appOrigins.includes(parsed))
			fail(
				`.bearerOrigins[${index}]`,
				`is not the origin of one of this stage's applications (${appOrigins.join(", ") || "none declared"})`,
			);
	}
}

/**
 * The stage's OAuth 2.0 providers (`add-stage-oauth2-auth`, task 1.1).
 *
 * A provider is a host this server sends a credential to, so it gets the
 * foundation's URL rules *and* the allow-list: an endpoint whose origin the
 * stage never declared is refused, because nothing else would keep a token
 * request on the stage's own origins. The client id and secret are references
 * and nothing else — a literal that failed the check is never quoted.
 */
function validateOAuth2Providers(
	stage: StageDefinition,
	policy: StagePolicy,
	fail: (field: string, message: string) => void,
): void {
	const origins = stageOrigins(stage);
	for (const [name, provider] of Object.entries(
		stage.oauth2?.providers ?? {},
	)) {
		const field = `oauth2.providers.${name}`;
		for (const [key, value] of [
			["tokenEndpoint", provider.tokenEndpoint],
			["authorizationEndpoint", provider.authorizationEndpoint],
		] as const) {
			if (value === undefined) continue;
			validateUrl(
				value,
				stage,
				policy,
				(message) => fail(`${field}.${key}`, message),
				{ requireHttps: true },
			);
			const origin = originOf(value);
			if (origin !== undefined && !origins.includes(origin))
				fail(
					`${field}.${key}`,
					"is not in the stage's allow-list (add its origin to allowedOrigins)",
				);
		}
		for (const key of ["clientId", "clientSecret"] as const) {
			const reference = provider[key];
			if (reference === undefined) continue;
			if (!isEnvReference(reference))
				fail(
					`${field}.${key}`,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: the diagnostic must show the reference syntax a stage file writes
					"must be exactly one ${VARIABLE} reference resolved from the configuration .env",
				);
		}
		for (const [index, scope] of (provider.scope ?? []).entries())
			if (scope.trim() === "")
				fail(`${field}.scope[${index}]`, "must not be empty");
		if (provider.audience !== undefined && provider.audience.trim() === "")
			fail(`${field}.audience`, "must not be empty when declared");
	}
}

/**
 * The reserved recipe name (`add-stage-oauth2-auth`).
 *
 * `oauth2` names the built-in token login; a stage that declares a recipe of its
 * own under that name keeps working (a role without `provider`/`grant` selects
 * it), but the operator is told why the name is a trap for the next reader.
 */
function validateReservedRecipeName(
	stage: StageDefinition,
	file: string,
	diagnostics: StageDiagnostic[],
): void {
	if (!Object.hasOwn(stage.logins ?? {}, "oauth2")) return;
	diagnostics.push({
		file,
		field: "logins.oauth2",
		kind: "warning",
		message:
			'is the reserved name of the OAuth 2.0 login: a role that declares `provider` or `grant` selects that built-in recipe and ignores this one. Rename it, e.g. "oauth2-form"',
	});
}

/**
 * Two roles of one stage may not exchange the same refresh token.
 *
 * A provider that rotates a refresh token invalidates the one it handed out
 * before, and this store keeps the rotated value per role. Two roles that name
 * the same `${VAR}` would therefore desynchronize as soon as either renews: the
 * second role presents a value the provider has already retired and can never
 * recover without a credential rewrite (CONC-003). The diagnostic names the
 * roles and never the reference's value.
 */
function validateRefreshTokenSharing(
	stage: StageDefinition,
	fail: (field: string, message: string) => void,
): void {
	const holders = new Map<string, string[]>();
	for (const [appKey, app] of Object.entries(stage.apps))
		for (const [roleName, role] of Object.entries(app.roles ?? {})) {
			const reference = role.refreshToken;
			if (reference === undefined) continue;
			const roles = holders.get(reference) ?? [];
			roles.push(`${appKey}.${roleName}`);
			holders.set(reference, roles);
		}
	for (const roles of holders.values()) {
		if (roles.length < 2) continue;
		for (const role of roles)
			fail(
				`apps.${role}.refreshToken`,
				`is the same refresh token as ${roles.filter((other) => other !== role).join(", ")}: a provider that rotates the token it issued invalidates the other role's copy, so every role needs its own reference`,
			);
	}
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
	if (recipe.kind === "interactive") {
		if (steps.length > 0)
			fail(
				`${field}.steps`,
				`the interactive recipe ${field} declares no steps: the developer performs the login`,
			);
		if (!recipe.success)
			fail(
				`${field}.success`,
				`the interactive recipe ${field} must declare how the login counts as complete`,
			);
	}
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
 * denied host. `requireHttps` is what the OAuth 2.0 provider endpoints use: a
 * token endpoint carries the client secret and the refresh token, so the
 * stage-wide `insecureHttp` flag (which exists for a local *application* URL)
 * never exempts it (SEC-003). */
function validateUrl(
	value: string,
	stage: StageDefinition,
	policy: StagePolicy,
	fail: (message: string) => void,
	options: { readonly requireHttps?: boolean } = {},
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
		if (options.requireHttps === true) {
			fail(
				"must use https: a token endpoint carries the client secret and the refresh token, which insecureHttp never allows here",
			);
			return;
		}
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
		// The ceiling is the one `effectiveCeiling` resolves, so the bound a value is
		// clamped to and the bound the clamp *reports* cannot be computed two ways.
		const ceiling = effectiveCeiling(field, ceilings[field]);
		return ceiling === undefined ? base : Math.min(base, ceiling.value);
	};
	return {
		maxSessions: pick("maxSessions"),
		maxActionsPerMinute: pick("maxActionsPerMinute"),
		maxWaitSeconds: pick("maxWaitSeconds"),
		maxScreenshots: pick("maxScreenshots"),
		maxRecordingMinutes: pick("maxRecordingMinutes"),
		maxLoginHandoffSeconds: pick("maxLoginHandoffSeconds"),
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
		"maxLoginHandoffSeconds",
	] as const) {
		const declared = limits?.[field];
		const ceiling = effectiveCeiling(field, ceilings[field]);
		if (declared === undefined || ceiling === undefined) continue;
		if (declared <= ceiling.value) continue;
		diagnostics.push({
			file,
			field: `limits.${field}`,
			kind: "warning",
			message:
				ceiling.source === "policy"
					? `clamped to the policy ceiling ${ceiling.value}`
					: `clamped to the ${ceiling.value} s login hand-off ceiling`,
		});
	}
}

/** The bound a field is clamped to, and which file declared it: the policy's
 * ceiling when it declares one, or the field's own documented hard ceiling —
 * which is what answers a policy that declares none, a stage that declares more
 * than the hard ceiling, and a policy whose own ceiling was above it. */
function effectiveCeiling(
	field: keyof EffectiveStageLimits,
	policyCeiling: number | undefined,
): { readonly value: number; readonly source: "policy" | "hard" } | undefined {
	if (field !== "maxLoginHandoffSeconds")
		return policyCeiling === undefined
			? undefined
			: { value: policyCeiling, source: "policy" };
	if (policyCeiling !== undefined && policyCeiling <= MAX_LOGIN_HANDOFF_SECONDS)
		return { value: policyCeiling, source: "policy" };
	return { value: MAX_LOGIN_HANDOFF_SECONDS, source: "hard" };
}

/** The origins a stage may be driven on: its applications' origins plus its
 * declared `allowedOrigins`. */
export function stageOrigins(stage: StageDefinition): string[] {
	const origins = new Set<string>();
	for (const origin of stageAppOrigins(stage)) origins.add(origin);
	for (const declared of stage.allowedOrigins ?? []) {
		const origin = originOf(declared);
		if (origin) origins.add(origin);
	}
	return [...origins];
}

/** The origins of the stage's own applications, and nothing else: this is the
 * set a `bearerOrigins` entry has to name, because a bearer token belongs to a
 * page of a staged application and to nowhere else. */
export function stageAppOrigins(stage: StageDefinition): string[] {
	const origins = new Set<string>();
	for (const app of Object.values(stage.apps)) {
		const origin = originOf(app.url);
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

/** The wording of a `.env` gap, shared by every surface that answers one: the
 * variable's name and where it is set, never a value. */
export function credentialMissingMessage(variable: string): string {
	return `${variable} is not set in the configuration .env; set it in Settings → Stages before this login`;
}

/** A credential field the stage file does not declare at all: no `.env` value can
 * fill it, so the remedy names the stage-file field rather than a variable that
 * does not exist (USAB-208). */
export function undeclaredCredentialMessage(path: string): string {
	return `${path} is not declared in the stage file, so the configuration .env cannot fill it; add the field there before this login`;
}

/** A credential reference that cannot be resolved right now. It names the
 * variable and never a value. */
export class StageCredentialError extends Error {
	constructor(
		readonly variable: string,
		message?: string,
	) {
		super(message ?? credentialMissingMessage(variable));
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
	field: StageRoleCredentialField,
	configDir: string,
): string {
	const role = stage.apps[appKey]?.roles?.[roleName];
	if (!role) throw new StageCredentialError(`${appKey}.${roleName}.${field}`);
	const reference = role[field];
	if (reference === undefined)
		throw new StageCredentialError(
			`${appKey}.${roleName}.${field}`,
			undeclaredCredentialMessage(`${appKey}.${roleName}.${field}`),
		);
	return resolveReference(
		reference,
		`${appKey}.${roleName}.${field}`,
		configDir,
	);
}

/**
 * Resolve one OAuth 2.0 provider credential reference to its value
 * (`add-stage-oauth2-auth`): the client id, the client secret or the refresh
 * token of a role's provider. Like every other resolver it answers the value and
 * is imported by the token path alone, and a missing reference names the
 * variable, never a value.
 */
export function resolveStageOAuthCredential(
	stage: StageDefinition,
	providerName: string,
	field: "clientId" | "clientSecret",
	configDir: string,
): string {
	const reference = stage.oauth2?.providers?.[providerName]?.[field];
	if (reference === undefined)
		throw new StageCredentialError(
			`oauth2.providers.${providerName}.${field}`,
			undeclaredCredentialMessage(`oauth2.providers.${providerName}.${field}`),
		);
	return resolveReference(
		reference,
		`oauth2.providers.${providerName}.${field}`,
		configDir,
	);
}

function resolveReference(
	reference: string,
	fallbackName: string,
	configDir: string,
): string {
	const name = envReferenceName(reference) ?? fallbackName;
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
	field: StageRoleCredentialField,
): string | undefined {
	const role = stage.apps[appKey]?.roles?.[roleName];
	const reference = role?.[field];
	return reference === undefined ? undefined : envReferenceName(reference);
}

/** One credential field a stage file may reference: the login form's three, a
 * role's refresh token, or a provider's client id and client secret
 * (`add-stage-oauth2-auth`). */
export type StageCredentialReference =
	| StageRoleCredentialField
	| "clientId"
	| "clientSecret";

/** Every credential variable an allow-listed stage references, for the Settings
 * credential flow: only a referenced key may be written from a stage section.
 * That includes an OAuth 2.0 provider's client id and secret and a role's
 * refresh token: they are `.env` values like any other, and this flow is the
 * protected path that writes one. */
export function stageCredentialVariables(catalog: StageCatalog): Map<
	string,
	{
		readonly stage: string;
		readonly app: string;
		readonly role: string;
		readonly field: StageCredentialReference;
	}
> {
	const variables = new Map<
		string,
		{
			stage: string;
			app: string;
			role: string;
			field: StageCredentialReference;
		}
	>();
	for (const entry of catalog.entries) {
		for (const [providerName, provider] of Object.entries(
			entry.stage.oauth2?.providers ?? {},
		))
			for (const field of ["clientId", "clientSecret"] as const) {
				const reference = provider[field];
				if (reference === undefined) continue;
				const name = envReferenceName(reference);
				if (!name) continue;
				variables.set(name, {
					stage: entry.ident,
					app: providerName,
					role: "oauth2",
					field,
				});
			}
		for (const app of Object.values(entry.stage.apps)) {
			for (const [roleName, role] of Object.entries(app.roles ?? {})) {
				for (const field of STAGE_ROLE_CREDENTIAL_FIELDS) {
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
	readonly field: StageCredentialReference;
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
	readonly loginKind?: StageLoginKind;
	/** The `oauth2` provider and grant this role selects. */
	readonly provider?: string;
	readonly grant?: StageOAuth2Grant;
	/** The origins this role's bearer token is added on. */
	readonly bearerOrigins?: readonly string[];
	/** `set`, `none` (the role references no credential at all) or
	 * `missing <VAR>`. */
	readonly credentialStatus: string;
	readonly loginMode: StageLoginMode;
	/** Whether a successful login of this role may leave a cached identity
	 * (`add-stage-identity-cache`). False for a stage that set `identityCache:
	 * false`, and false for the `http-basic` recipe: the driver cannot observe the
	 * `Authorization` header a browser's own credential dialog generates, so there
	 * is nothing to capture (`design.md` D2). A plan that needs the reuse can read
	 * this instead of inferring it from the login kind. */
	readonly cacheable: boolean;
	readonly credentials: readonly StageCredentialView[];
}

/** One OAuth 2.0 provider as a read surface reports it: endpoints, scopes and
 * the *status* of its credential references. Never a value. */
export interface StageOAuth2ProviderView {
	readonly name: string;
	readonly tokenEndpoint: string;
	readonly authorizationEndpoint?: string;
	readonly audience?: string;
	readonly scope: readonly string[];
	readonly clientAuth: StageOAuth2Provider["clientAuth"];
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
	/** The identity cache's effective bounds (`add-stage-identity-cache`): what a
	 * run can expect of a silent login on this stage. */
	readonly identityCache: EffectiveIdentityCache;
	readonly wiki: { readonly processes: readonly string[] };
	/** The stage's OAuth 2.0 providers (`add-stage-oauth2-auth`). */
	readonly oauth2: { readonly providers: readonly StageOAuth2ProviderView[] };
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
				// `oauth2` is the reserved recipe a role selects with the fields this
				// change added (`add-stage-oauth2-auth`): it types nothing into a page and
				// obtains its token from a declared provider. The fields decide, not the
				// name, so a stage that declares a recipe called `oauth2` keeps it
				// (MIG-001).
				const oauth2 = isOAuth2Role(value);
				const recipe =
					value.login === undefined || oauth2
						? undefined
						: entry.stage.logins?.[value.login];
				// An `oauth2` role's credentials are the *provider's* client id and
				// secret plus its own refresh token: that is the set a developer can
				// fix, and the set whose presence decides whether the login can be
				// automated at all. A form field the recipe would ignore is not part
				// of it (it is warned about instead).
				const credentials = oauth2
					? oauth2CredentialViews(
							value,
							entry.stage.oauth2?.providers?.[value.provider ?? ""],
							env,
						)
					: roleCredentialViews(value, env);
				const credentialStatus = roleCredentialStatus(credentials);
				const loginKind: StageLoginKind | undefined = oauth2
					? "oauth2"
					: recipe?.kind;
				return {
					role,
					...(value.login === undefined ? {} : { login: value.login }),
					...(loginKind === undefined ? {} : { loginKind }),
					...(value.provider === undefined ? {} : { provider: value.provider }),
					...(value.grant === undefined ? {} : { grant: value.grant }),
					...(value.bearerOrigins === undefined
						? {}
						: { bearerOrigins: [...value.bearerOrigins] }),
					credentialStatus,
					loginMode: roleLoginMode({
						...(loginKind === undefined ? {} : { recipeKind: loginKind }),
						...(value.grant === undefined ? {} : { grant: value.grant }),
						credentialStatus,
						interactiveLogin: entry.interactiveLogin,
					}),
					// A `http-basic` credential is entered by the browser itself, and the
					// driver cannot see the header that produces it, so that login leaves no
					// capture to reuse (D2). Everything else is cacheable unless the stage
					// opted out.
					cacheable: entry.identity.enabled && loginKind !== "http-basic",
					credentials,
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
		identityCache: entry.identity,
		wiki: { processes: entry.stage.wiki?.processes ?? [] },
		oauth2: {
			providers: Object.entries(entry.stage.oauth2?.providers ?? {}).map(
				([name, provider]) => ({
					name,
					tokenEndpoint: provider.tokenEndpoint,
					...(provider.authorizationEndpoint === undefined
						? {}
						: { authorizationEndpoint: provider.authorizationEndpoint }),
					...(provider.audience === undefined
						? {}
						: { audience: provider.audience }),
					scope: [...(provider.scope ?? [])],
					clientAuth: provider.clientAuth ?? "basic",
					credentials: providerCredentialViews(provider, env),
				}),
			),
		},
		diagnostics: entry.diagnostics,
	};
}

/** The one status of a role's credential references: `set` when every one of
 * them is set, `none` when the role references none at all (valid since
 * `add-stage-interactive-login`), and otherwise the first `missing <VAR>`. */
function roleCredentialStatus(views: readonly StageCredentialView[]): string {
	if (views.length === 0) return "none";
	const missing = views.find((view) => view.status !== "set");
	return missing ? missing.status : "set";
}

function roleCredentialViews(
	role: StageRole,
	env: ReadonlyMap<string, string>,
): StageCredentialView[] {
	const views: StageCredentialView[] = [];
	for (const field of STAGE_ROLE_CREDENTIAL_FIELDS) {
		const reference = role[field];
		if (reference === undefined) continue;
		const name = envReferenceName(reference);
		if (name === undefined) continue;
		views.push(credentialView(field, name, env));
	}
	return views;
}

/**
 * The credential references one `oauth2` role needs, in section order: the
 * provider's client id and secret (when it declares one), then the role's own
 * refresh token when the grant is `refresh_token`.
 *
 * The provider's own views are the *same objects* the stage's provider list
 * reports, so a Settings row and the provider status can never disagree about a
 * variable.
 */
function oauth2CredentialViews(
	role: StageRole,
	provider: StageOAuth2Provider | undefined,
	env: ReadonlyMap<string, string>,
): StageCredentialView[] {
	const views =
		provider === undefined ? [] : providerCredentialViews(provider, env);
	if (role.grant !== "refresh_token") return views;
	const reference = role.refreshToken;
	if (reference === undefined) return views;
	const name = envReferenceName(reference);
	if (name === undefined) return views;
	return [...views, credentialView("refreshToken", name, env)];
}

/** One provider's credential *status*, in section order. */
function providerCredentialViews(
	provider: StageOAuth2Provider,
	env: ReadonlyMap<string, string>,
): StageCredentialView[] {
	const views: StageCredentialView[] = [];
	for (const field of ["clientId", "clientSecret"] as const) {
		const reference = provider[field];
		if (reference === undefined) continue;
		const name = envReferenceName(reference);
		if (name === undefined) continue;
		views.push(credentialView(field, name, env));
	}
	return views;
}

function credentialView(
	field: StageCredentialReference,
	name: string,
	env: ReadonlyMap<string, string>,
): StageCredentialView {
	const value = env.get(name);
	return {
		field,
		variable: name,
		status:
			value === undefined || value.trim() === "" ? `missing ${name}` : "set",
	};
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
