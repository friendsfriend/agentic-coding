// The `env-setup` validation gate (add-environment-setup-workflow):
// deterministic, structural checks over the drafts before a developer is asked
// to approve them, plus a real start of the drafted run targets.
//
// Nothing here is agent-owned: the checks are the same every round (drafts name
// a documented configuration path, parse, discover and compile, `AC_OTEL_*` is
// referenced by every drafted run target, no host port collides with another
// app's definition, every referenced `${VAR}` exists) and the start reports
// readiness from the action engine. Both the compiler and the starter are
// injected, so the gate's pass and fail paths are testable with doubles and the
// effect handler supplies the real ones.
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "../../env-file.ts";
import {
	configDirEntries,
	discoverActionTargets,
} from "../actions/discovery.ts";
import { compileContainerTargetsWithTools } from "../actions/target-compile.ts";
import type { ActionTarget, AppAction } from "../actions/targets.ts";
import { checkToolAvailability } from "../actions/toolcheck.ts";
import {
	assertSetupDraftsDir,
	isAllowedDraftPath,
	listDraftEntries,
	listDraftFiles,
} from "./setup-drafts.ts";

/**
 * Which discovery action a drafted file must resolve under. Every drafted
 * action the author may write is covered: the run definitions and the build/test
 * definitions, so a draft that no action picks up is reported instead of
 * reaching the approval gate as if it were runnable.
 */
const DRAFT_ACTIONS: ReadonlyArray<{ prefix: string; action: AppAction }> = [
	{ prefix: "apps/compose/", action: "run" },
	{ prefix: "apps/run/", action: "run" },
	{ prefix: "apps/kubernetes/", action: "run" },
	{ prefix: "apps/k8s/", action: "run" },
	{ prefix: "apps/build/", action: "build" },
	{ prefix: "apps/build/", action: "test" },
];

/** How long one Kubernetes reachability probe may take before it answers
 * "not reachable": the gate must not block on an unreachable API server. */
const KUBERNETES_PROBE_TIMEOUT_MS = 5000;

export interface SetupValidationFinding {
	/** Stable check id, so the author's report groups findings by check. */
	readonly check:
		| "no-drafts"
		| "non-regular-file"
		| "unexpected-path"
		| "unparsable"
		| "empty-file"
		| "discover"
		| "undiscovered"
		| "compile"
		| "otel"
		| "port-collision"
		| "missing-variable"
		| "start";
	readonly message: string;
	/** Configuration-relative draft path or target id, when the finding has one. */
	readonly subject?: string;
}

export interface SetupTargetStartResult {
	readonly ready: boolean;
	readonly detail?: string;
}

/** Starts one target and reports whether it reached readiness. */
export type SetupTargetStarter = (
	target: ActionTarget,
) => Promise<SetupTargetStartResult>;

/** Compiles one target; a compile failure is thrown and reported as a finding. */
export type SetupTargetCompiler = (target: ActionTarget) => Promise<void>;

export interface SetupValidationContext {
	readonly configDir: string;
	readonly draftsDir: string;
	readonly appIdent: string;
	readonly checkoutDir: string;
	readonly platform?: string;
	readonly startTarget: SetupTargetStarter;
	readonly compileTarget?: SetupTargetCompiler;
	/** Host ports the *other* apps already declare, keyed by port. */
	readonly otherAppPorts?: () => Map<number, string>;
	/** Whether a Kubernetes cluster the target names is reachable. */
	readonly clusterAvailable?: (target: ActionTarget) => boolean;
	/** Variables the environment file provides; defaults to the config `.env`. */
	readonly envFileVariables?: () => Map<string, string>;
	readonly processEnv?: Record<string, string | undefined>;
}

export interface SetupValidationTargetReport {
	readonly id: string;
	readonly runtime: string;
	readonly profile: string;
	readonly sourcePath: string;
	readonly drafted: boolean;
	readonly started: "ready" | "failed" | "skipped";
	readonly detail?: string;
}

export interface SetupValidationReport {
	readonly ok: boolean;
	readonly app: string;
	readonly drafts: string[];
	readonly targets: SetupValidationTargetReport[];
	readonly findings: SetupValidationFinding[];
	readonly variables: { readonly used: string[]; readonly missing: string[] };
	readonly otel: Array<{ readonly target: string; readonly ok: boolean }>;
}

/**
 * Validate every drafted definition and start every drafted run target.
 * Docker is always started (a setup that cannot start the app's own container
 * target has not been validated); script and Kubernetes targets only when a
 * draft defines them, and a Kubernetes target only when its cluster exists.
 */
export async function validateSetupDrafts(
	context: SetupValidationContext,
): Promise<SetupValidationReport> {
	const findings: SetupValidationFinding[] = [];
	// The drafts directory arrives from the workflow's pinned metadata: a value
	// that is not this configuration's drafts root is a named finding, never a
	// discovery over an unknown tree.
	try {
		assertSetupDraftsDir(context.configDir, context.draftsDir);
	} catch (error) {
		return {
			ok: false,
			app: context.appIdent,
			drafts: [],
			targets: [],
			findings: [{ check: "unexpected-path", message: message(error) }],
			variables: { used: [], missing: [] },
			otel: [],
		};
	}
	// Only plain files may be published, so a symbolic link or special file in
	// the drafts tree is reported instead of being silently skipped (which is
	// what let discovery resolve a target the approval view never showed).
	const nonRegularDrafts = new Set<string>();
	for (const entry of listDraftEntries(context.draftsDir))
		if (entry.kind !== "file") {
			nonRegularDrafts.add(entry.relative);
			findings.push({
				check: "non-regular-file",
				message: `${entry.relative}: drafts must be plain files (${entry.kind})`,
				subject: entry.relative,
			});
		}
	const drafts = listDraftFiles(context.draftsDir);
	if (drafts.length === 0)
		findings.push({
			check: "no-drafts",
			message: `no drafts were found in ${context.draftsDir}`,
		});

	const draftTexts = new Map<string, string>();
	for (const relative of drafts) {
		const filePath = path.join(context.draftsDir, ...relative.split("/"));
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			findings.push({
				check: "unparsable",
				message: `${relative}: unreadable (${message(error)})`,
				subject: relative,
			});
			continue;
		}
		draftTexts.set(relative, text);
		// A draft that does not name a documented configuration path is refused
		// here: the promotion would otherwise publish a file the configuration
		// does not define (`agent-definitions/instructions/env-setup.md`).
		if (!isAllowedDraftPath(relative))
			findings.push({
				check: "unexpected-path",
				message: `${relative}: drafts must mirror the configuration layout (build, run, compose, kubernetes, infrastructure definitions/compose)`,
				subject: relative,
			});
		if (text.trim() === "")
			findings.push({
				check: "empty-file",
				message: `${relative}: the draft is empty`,
				subject: relative,
			});
		// A JSON definition must parse: a malformed draft must never reach the
		// approval gate as if it were runnable.
		if (relative.endsWith(".json")) {
			try {
				JSON.parse(text);
			} catch (error) {
				findings.push({
					check: "unparsable",
					message: `${relative}: invalid JSON (${message(error)})`,
					subject: relative,
				});
			}
		}
	}

	// Discovery resolves the drafts through the same per-file overlay a held
	// app run uses, so what validates is exactly what would run. It throws on a
	// malformed definition (for example a `x-devenv.requires` block that is not
	// inline JSON), which is a finding the author must see — never a defect that
	// parks the workflow.
	const targetsByAction = new Map<AppAction, ActionTarget[]>();
	const discovered = (action: AppAction): ActionTarget[] => {
		const cached = targetsByAction.get(action);
		if (cached) return cached;
		let found: ActionTarget[] = [];
		try {
			found = discoverActionTargets({
				appIdent: context.appIdent,
				localDir: context.checkoutDir,
				action,
				configDir: context.configDir,
				configOverlay: context.draftsDir,
				...(context.platform ? { platform: context.platform } : {}),
			});
		} catch (error) {
			findings.push({
				check: "discover",
				message: `discovery over the drafts failed: ${message(error)}`,
			});
		}
		targetsByAction.set(action, found);
		return found;
	};

	const draftedPaths = new Set<string>();
	const draftedActions = new Map<string, AppAction[]>();
	for (const relative of drafts) {
		const actions = DRAFT_ACTIONS.filter((entry) =>
			relative.startsWith(entry.prefix),
		).map((entry) => entry.action);
		if (actions.length === 0) continue;
		const absolute = path.join(context.draftsDir, ...relative.split("/"));
		draftedPaths.add(absolute);
		draftedActions.set(absolute, actions);
	}
	for (const [draftPath, actions] of draftedActions) {
		const relative = relativeOfDraft(context.draftsDir, draftPath);
		if (
			actions.some((action) =>
				discovered(action).some((target) => target.sourcePath === draftPath),
			)
		)
			continue;
		findings.push({
			check: "undiscovered",
			message: `${relative}: no ${[...new Set(actions)].join("/")} target resolves from this draft`,
			subject: relative,
		});
	}

	// Every drafted target of every action is compiled; the observability check
	// and the start apply to the run targets, which are what a run of the app
	// executes.
	const draftedTargets = [...targetsByAction.values()]
		.flat()
		.filter((target) => draftedPaths.has(target.sourcePath));
	const draftedRunTargets = draftedTargets.filter(
		(target) => target.action === "run",
	);
	const otel: Array<{ target: string; ok: boolean }> = [];
	for (const target of draftedRunTargets) {
		let text: string | undefined = draftTexts.get(
			relativeOfDraft(context.draftsDir, target.sourcePath),
		);
		if (text === undefined) {
			try {
				text = fs.readFileSync(target.sourcePath, "utf8");
			} catch {
				text = undefined;
			}
		}
		const wired = text !== undefined && referencesOtelVariables(text);
		otel.push({ target: target.id, ok: wired });
		if (!wired)
			findings.push({
				check: "otel",
				message: `${relativeOfDraft(context.draftsDir, target.sourcePath)}: the drafted target does not reference any AC_OTEL_* variable`,
				subject: target.id,
			});
	}

	const collisions = detectPortCollisions(
		context.draftsDir,
		draftTexts,
		context.otherAppPorts?.() ?? new Map(),
	);
	for (const collision of collisions)
		findings.push({
			check: "port-collision",
			message: collision,
		});

	const variables = setupVariables(
		draftTexts,
		context.envFileVariables?.() ??
			loadEnvFile(path.join(context.configDir, ".env")),
		context.processEnv ?? process.env,
	);
	for (const name of variables.missing)
		findings.push({
			check: "missing-variable",
			message: `${name} is referenced by the drafts but is not set in the configuration .env`,
		});

	const compiler = context.compileTarget ?? (() => Promise.resolve());
	for (const target of draftedTargets) {
		try {
			await compiler(target);
		} catch (error) {
			findings.push({
				check: "compile",
				message: `${target.id}: ${message(error)}`,
				subject: target.id,
			});
		}
	}

	// One probe per cluster context, not per target: every target naming the
	// same context has the same answer, and the probe is a subprocess.
	const clusterAvailability = new Map<string, boolean>();
	const clusterReachable = (target: ActionTarget): boolean => {
		const contextName = target.kubernetes?.contextName ?? "";
		if (contextName === "") return false;
		const known = clusterAvailability.get(contextName);
		if (known !== undefined) return known;
		const reachable = context.clusterAvailable
			? context.clusterAvailable(target)
			: true;
		clusterAvailability.set(contextName, reachable);
		return reachable;
	};

	const runTargets = discovered("run");
	const reports: SetupValidationTargetReport[] = [];
	for (const target of runTargets) {
		const drafted = draftedPaths.has(target.sourcePath);
		const docker = target.runtime === "docker";
		if (!drafted && !docker) continue;
		if (target.runtime === "kubernetes" && !drafted) continue;
		if (target.runtime === "kubernetes" && !clusterReachable(target)) {
			reports.push({
				id: target.id,
				runtime: target.runtime,
				profile: target.profile ?? "",
				sourcePath: target.sourcePath,
				drafted,
				started: "skipped",
				detail: "the Kubernetes cluster is not reachable",
			});
			continue;
		}
		// A target that resolves from a non-regular draft is never run: what the
		// approval gate shows and the promotion publishes is plain files only.
		if (
			target.action === "run" &&
			nonRegularDrafts.has(
				relativeOfDraft(context.draftsDir, target.sourcePath),
			)
		) {
			reports.push({
				id: target.id,
				runtime: target.runtime,
				profile: target.profile ?? "",
				sourcePath: target.sourcePath,
				drafted,
				started: "skipped",
				detail: "the draft is not a plain file",
			});
			continue;
		}
		let started: SetupTargetStartResult;
		try {
			started = await context.startTarget(target);
		} catch (error) {
			started = { ready: false, detail: message(error) };
		}
		reports.push({
			id: target.id,
			runtime: target.runtime,
			profile: target.profile ?? "",
			sourcePath: target.sourcePath,
			drafted,
			started: started.ready ? "ready" : "failed",
			...(started.detail ? { detail: started.detail } : {}),
		});
		if (!started.ready)
			findings.push({
				check: "start",
				message: `${target.id} did not reach readiness${started.detail ? `: ${started.detail}` : ""}`,
				subject: target.id,
			});
	}

	return {
		ok:
			findings.length === 0 &&
			reports.every((report) => report.started !== "failed"),
		app: context.appIdent,
		drafts,
		targets: reports,
		findings,
		variables,
		otel,
	};
}

/** The variables the drafts reference and the ones the environment lacks. */
export function setupVariables(
	draftTexts: ReadonlyMap<string, string>,
	envFile: ReadonlyMap<string, string>,
	processEnv: Record<string, string | undefined>,
): { used: string[]; missing: string[] } {
	const used = new Set<string>();
	for (const text of draftTexts.values())
		for (const name of referencedVariables(text)) used.add(name);
	const sorted = [...used].sort();
	return {
		used: sorted,
		missing: sorted.filter(
			(name) =>
				!envFile.has(name) &&
				(processEnv[name] === undefined || processEnv[name] === ""),
		),
	};
}

/** `${VAR}` references, in declaration order and deduplicated. */
export function referencedVariables(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g)) {
		const name = match[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Whether a drafted definition wires the app to the injected OTel variables. */
export function referencesOtelVariables(text: string): boolean {
	return /AC_OTEL_[A-Z0-9_]+/.test(text);
}

/**
 * Host ports a drafted target publishes, compared with the ports the other
 * apps already declare. A collision names both sides, so the author can move
 * its port instead of guessing.
 */
export function detectPortCollisions(
	draftsDir: string,
	draftTexts: ReadonlyMap<string, string>,
	otherPorts: ReadonlyMap<number, string>,
): string[] {
	const findings: string[] = [];
	if (otherPorts.size === 0) return findings;
	for (const [relative, text] of draftTexts) {
		const drafted = isComposePath(relative)
			? composeHostPorts(text)
			: relative.endsWith(".k8s.json")
				? kubernetesHostPorts(text)
				: [];
		for (const port of drafted) {
			const owner = otherPorts.get(port);
			if (!owner) continue;
			findings.push(
				`${relative}: host port ${port} is already declared by ${owner}`,
			);
		}
	}
	// Kept for signature symmetry with the drafts root: a caller may report the
	// drafts directory in the message.
	void draftsDir;
	return findings;
}

function isComposePath(relative: string): boolean {
	if (
		!relative.startsWith("apps/compose/") &&
		!relative.startsWith("infrastructure/compose/")
	)
		return false;
	return relative.endsWith(".yml") || relative.endsWith(".yaml");
}

/** Host ports published by a compose file's `ports:` lists. */
export function composeHostPorts(text: string): number[] {
	const ports: number[] = [];
	const lines = text.split("\n");
	let listIndent: number | undefined;
	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (listIndent !== undefined) {
			if (indent < listIndent) {
				listIndent = undefined;
			} else if (trimmed.startsWith("- ")) {
				const value = trimmed.slice(2).trim();
				const long = longSyntaxKey(value);
				if (long !== undefined) ports.push(long);
				else {
					const parsed = shortSyntaxPort(value);
					if (parsed !== undefined) ports.push(parsed);
				}
				continue;
			} else {
				const published = longSyntaxKey(trimmed);
				if (published !== undefined) ports.push(published);
				continue;
			}
		}
		if (/^ports\s*:\s*$/.test(trimmed)) listIndent = indent + 1;
	}
	return ports;
}

function longSyntaxKey(value: string): number | undefined {
	if (!value.startsWith("published")) return undefined;
	const raw = value.slice("published".length).replace(/^:/, "").trim();
	return firstPortNumber(raw);
}

function shortSyntaxPort(value: string): number | undefined {
	const unquoted = value.replace(/^["']|["']$/g, "");
	const withoutProtocol = unquoted.split("/")[0] ?? unquoted;
	const segments = withoutProtocol.split(":");
	if (segments.length < 2) return undefined;
	// `[HOST_IP:]PUBLISHED:TARGET` — the published port is the second to last.
	return firstPortNumber(segments[segments.length - 2] ?? "");
}

function firstPortNumber(value: string): number | undefined {
	const unquoted = value.trim().replace(/^["']|["']$/g, "");
	const match = unquoted.match(/^(\d{1,5})(?:-\d{1,5})?$/);
	if (!match) return undefined;
	const port = Number(match[1]);
	return port >= 1 && port <= 65535 ? port : undefined;
}

/** Host ports a Kubernetes run config forwards locally. */
export function kubernetesHostPorts(text: string): number[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const ports: number[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "localPort" && typeof child === "number") ports.push(child);
			else visit(child);
		}
	};
	visit(parsed);
	return ports;
}

/**
 * Host ports the other apps already declare: every live compose file's
 * published ports and every live Kubernetes run config's forwarded ports,
 * excluding the app being set up. Ownership is decided by the file-name prefix
 * of a *configured* app ident — never by truncating the name at a hyphen, which
 * would both report the app's own definitions as another app's and mask a real
 * collision between an ident and a longer one that starts with it.
 */
export function declaredAppPorts(
	configDir: string,
	excludeApp: string,
): Map<number, string> {
	const ports = new Map<number, string>();
	const claim = (port: number, owner: string): void => {
		if (!ports.has(port)) ports.set(port, owner);
	};
	const idents = configuredAppIdents(configDir);
	const ownedBy = (name: string): string | undefined => {
		let best: string | undefined;
		for (const ident of idents) {
			if (!name.startsWith(`${ident}-`)) continue;
			if (best === undefined || ident.length > best.length) best = ident;
		}
		return best;
	};
	// The app under setup is excluded by the ident its file resolves to: a file
	// owned by a longer, different ident (`installer` vs `installer-fe`) stays in
	// the map, so a real collision cannot hide behind the prefix. The raw prefix
	// remains the fallback for an app with no definition file to resolve.
	const isOwn = (name: string): boolean => {
		if (excludeApp === "") return false;
		const owner = ownedBy(name);
		if (owner !== undefined) return owner === excludeApp;
		return name.startsWith(`${excludeApp}-`);
	};
	for (const { name, path: filePath } of configDirEntries(
		{ configDir },
		"apps",
		"compose",
	)) {
		if (isOwn(name)) continue;
		const app = ownedBy(name) ?? appIdentOfComposeFile(name);
		if (!app) continue;
		for (const port of composeHostPorts(readText(filePath)))
			claim(port, `${app} (${name})`);
	}
	for (const { name, path: filePath } of configDirEntries(
		{ configDir },
		"apps",
		"kubernetes",
	)) {
		if (!name.endsWith(".k8s.json")) continue;
		if (isOwn(name)) continue;
		const app = ownedBy(name);
		if (!app) continue;
		for (const port of kubernetesHostPorts(readText(filePath)))
			claim(port, `${app} (${name})`);
	}
	return ports;
}

/** The configured app idents, from the app definition file names. */
export function configuredAppIdents(configDir: string): string[] {
	const idents: string[] = [];
	for (const { name } of configDirEntries(
		{ configDir },
		"apps",
		"definitions",
	)) {
		if (!name.endsWith(".json")) continue;
		const ident = name.slice(0, name.length - ".json".length);
		if (ident !== "") idents.push(ident);
	}
	return idents.sort();
}

function appIdentOfComposeFile(name: string): string | undefined {
	for (const suffix of ["-compose.yml", "-compose.yaml"]) {
		if (!name.endsWith(suffix)) continue;
		const head = name.slice(0, name.length - suffix.length);
		return head === "" ? undefined : head;
	}
	return undefined;
}

function readText(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

/**
 * Whether a Kubernetes context is reachable, used for the k8s start rule. The
 * probe is bounded: an unreachable API server answers "not reachable" after the
 * timeout instead of blocking the process running the effect.
 */
export function kubernetesClusterAvailable(context: string): boolean {
	if (context === "") return false;
	const result = Bun.spawnSync(
		["kubectl", "--context", context, "version", "--output=json"],
		{
			stdout: "ignore",
			stderr: "ignore",
			timeout: KUBERNETES_PROBE_TIMEOUT_MS,
		},
	);
	return result.exitCode === 0;
}

/**
 * The real compiler: the registry's own compilers over the drafted targets, so
 * a draft that cannot compile is refused before a developer is asked to
 * approve it. The tool probe is resolved once per compiler instance — every
 * target of one validation round compiles against the same tool snapshot, as
 * the action routes do.
 */
export function defaultSetupTargetCompiler(options: {
	readonly appIdent: string;
	readonly checkoutDir: string;
	readonly configDir: string;
	readonly tempDir?: string;
}): SetupTargetCompiler {
	let toolsPromise: ReturnType<typeof checkToolAvailability> | undefined;
	return async (target) => {
		if (!toolsPromise) toolsPromise = checkToolAvailability();
		const tools = await toolsPromise;
		compileContainerTargetsWithTools(
			options.appIdent,
			target,
			undefined,
			tools,
			{
				checkoutDir: options.checkoutDir,
				configDir: options.configDir,
				tempDir: options.tempDir ?? "",
			},
		);
	};
}

/** The config-relative path of an absolute draft path. */
export function relativeOfDraft(draftsDir: string, draftPath: string): string {
	const relative = path.relative(draftsDir, draftPath);
	return relative.split(path.sep).join("/");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
