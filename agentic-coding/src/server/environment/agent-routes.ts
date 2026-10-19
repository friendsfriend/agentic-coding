// Agent environment routes (`add-agent-environment-tools`): the bounded HTTP
// surface a durable run's `env_*` tools call.
//
// Owner-scoped by construction. The caller presents the owner-scoped capability
// `environmentTokenFor` derived for `workflow:<id>` (`auth.ts`) together with
// the owner it names, and `app.ts` hands this module the verified owner — never
// a request field. Every operation therefore acts on that owner's own apps:
// `list`/`status` read the app slots, `acquire` waits for them through the same
// exclusive-slot controller the developer's actions use, `stop` refuses an app
// another owner holds, and `build`/`test` run in the workflow's own checkout.
//
// Two bounds apply to every response: the payload is redacted (the configuration
// `.env` and the secret/ephemeral action inputs become `«redacted:NAME»`) and
// the text-carrying results are truncated rather than streamed.
//
// Every read is bounded at the source, not after the fact: a log tail reads only
// the last bytes of a file, docker log fan-out is capped and fetched in parallel,
// and the kubernetes reader is given a per-pod tail and a total character budget.
// `grep` is a literal substring filter — an untrusted pattern is never compiled
// as a regular expression and run on the server's shared event loop.
import fs from "node:fs";
import path from "node:path";
import type { ActionDefinition } from "@devenv/types";
import type {
	AgentEnvironmentAcquire,
	AgentEnvironmentBuild,
} from "../../contracts/environment.ts";
import { loadEnvFile } from "../../env-file.ts";
import {
	type DefaultCandidate,
	decideDefaultTarget,
	declaredTargetId,
	defaultDeclarationRelative,
	readDefaultDeclaration,
} from "../actions/default-target.ts";
import { discoverActionTargets } from "../actions/discovery.ts";
import type { ActionRegistry } from "../actions/registry.ts";
import {
	ActionConflictError,
	type ActionRouteContext,
	runAppBuildTestAction,
} from "../actions/routes.ts";
import type { ActionTarget } from "../actions/targets.ts";
import { readJsonBody } from "../auth.ts";
import {
	AGENT_ACQUIRE_PATH,
	AGENT_BUILD_PATH,
	AGENT_ENVIRONMENT_PREFIX,
	AGENT_LIST_PATH,
	AGENT_LOGS_PATH,
	AGENT_STATUS_PATH,
	AGENT_STOP_PATH,
	AGENT_TEST_PATH,
	decodeRouteRequest,
} from "../protocol.ts";
import { MIN_SECRET_CHARS } from "../redaction.ts";
import {
	containerNameMatches,
	type DockerRuntimeSelection,
} from "../runtime/docker.ts";
import {
	containerFromConfigFiles,
	type EnvironmentInstanceController,
	EnvironmentInstanceError,
} from "../runtime/instances.ts";
import {
	kubernetesLogsForRelease,
	type RuntimeRouteServices,
} from "../runtime/routes.ts";
import {
	dockerRuntimeStatus,
	state as runtimeState,
} from "../runtime/status.ts";
import type { App } from "./config.ts";
import { parseEnvironmentOwner } from "./instances/model.ts";
import type { EnvironmentManager } from "./manager.ts";
import { stagedSymlinkedDefinitions } from "./setup-drafts.ts";

/** The infrastructure-service fields the log reader and the listing need. The
 * configured and runtime models both carry them, so either is accepted rather
 * than forcing one model onto the other. */
interface InfraLogSource {
	readonly ident: string;
	readonly displayName?: string;
	readonly type?: string;
	readonly containerBaseName?: string;
	readonly status?: string;
	readonly logPath?: string;
	/** The read-only connection `db_query` may use, when one is declared. */
	readonly query?: {
		readonly kind: string;
		readonly database: string;
		readonly userEnv: string;
		readonly passwordEnv: string;
	};
	readonly kubernetes?: {
		readonly namespace?: string;
		readonly release?: string;
	};
}

/** Default number of log lines one `env_logs` call returns. */
const DEFAULT_TAIL_LINES = 200;
/** Hard cap on `tail`, whatever the caller asks for. */
const MAX_TAIL_LINES = 1000;
/** One response's text budget; a larger result is cut, not streamed. */
const MAX_OUTPUT_CHARS = 40_000;
/** How much of a log file one read may touch: a script's log grows for the
 * service's whole lifetime, so the read is bounded, not the answer alone. */
const MAX_LOG_READ_BYTES = 512 * 1024;
/** How many of an app's containers one `env_logs` call reads. */
const MAX_LOG_CONTAINERS = 8;
/** The character budget one log collection may accumulate before it stops
 * reading further sources. */
const MAX_LOG_COLLECT_CHARS = 4 * MAX_OUTPUT_CHARS;

/** Everything the agent routes read. Absent capabilities answer 503 instead of
 * pretending the environment is empty. */
export interface AgentEnvironmentDeps {
	readonly configDir: string;
	readonly instances?: EnvironmentInstanceController;
	readonly apps?: Pick<EnvironmentManager, "getApps" | "getAppByIdent">;
	/** The configured infrastructure services `env_list` reports and `env_logs`
	 * reads: an env-setup author has to see the infrastructure a drafted app
	 * depends on, not only the apps (fix-env-tools-for-all-runs). */
	readonly infraServices?: () => readonly InfraLogSource[];
	readonly registry?: ActionRegistry;
	/** The action engine, for `env_build`/`env_test`. */
	readonly actions?: ActionRouteContext;
	/** Container/Kubernetes capabilities, for `env_logs`. */
	readonly runtime?: RuntimeRouteServices;
	/** Resolves a workflow's own checkout for an app (never a request path). */
	readonly resolveOwnerCheckout?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined | Promise<string | undefined>;
	/** Resolves the owner's configuration view: the staged configuration root an
	 * env-setup workflow pinned (`staged-env-setup-config-root`), or nothing for
	 * every other owner. `env_build`/`env_test`/`env_list` resolve through it, so
	 * "the drafts are what runs" holds for the whole `env_*` surface and not only
	 * for `env_start`. */
	readonly resolveOwnerOverlay?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined;
	readonly logger?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

interface EnvironmentSecret {
	readonly name: string;
	readonly value: string;
}

/** The values a response must never carry: the configuration `.env` and every
 * secret or ephemeral action input's declared value. Longest first, so a value
 * that contains another is replaced whole. */
export function environmentSecrets(configDir: string): EnvironmentSecret[] {
	const secrets: EnvironmentSecret[] = [];
	if (configDir !== "") {
		for (const [name, value] of loadEnvFile(path.join(configDir, ".env")))
			if (value.trim() !== "") secrets.push({ name, value });
	}
	return secrets.sort((left, right) => right.value.length - left.value.length);
}

/** The secret values the action registry's definitions declare. Read per call:
 * a reloaded configuration must redact immediately, not after a restart. */
function actionSecrets(
	registry: ActionRegistry | undefined,
): EnvironmentSecret[] {
	const secrets: EnvironmentSecret[] = [];
	for (const definition of (registry?.snapshot().definitions ??
		[]) as readonly ActionDefinition[]) {
		for (const input of definition.inputs ?? []) {
			if (input.visibility !== "secret" && input.visibility !== "ephemeral")
				continue;
			const value: unknown = input.default;
			if (typeof value !== "string" || value.trim() === "") continue;
			secrets.push({ name: input.key, value });
		}
	}
	return secrets;
}

function redactorFor(deps: AgentEnvironmentDeps): (value: unknown) => unknown {
	const secrets = [
		...environmentSecrets(deps.configDir),
		...actionSecrets(deps.registry),
	].sort((left, right) => right.value.length - left.value.length);
	return (value) => redact(value, secrets);
}

/** Escape one literal for use inside a regular expression. */
function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the declared secret values in one string.
 *
 * A value of any length is a secret, but a two-character value redacted
 * everywhere would make ordinary output unreadable (`PORT=80` would rewrite
 * every `80`). So a value below the literal threshold is still redacted, in the
 * one form that names it — `NAME=value` / `NAME: value`, with optional quotes —
 * which is exactly how an app prints its own environment or connection string.
 * Nothing a caller declared as a secret survives, and the noise stays bounded.
 */
function redactString(
	value: string,
	secrets: readonly EnvironmentSecret[],
): string {
	let redacted = value;
	for (const secret of secrets) {
		// A cheap scan first: replacing a secret allocates a fresh copy of the
		// payload even when that secret does not occur in it.
		if (!redacted.includes(secret.value)) continue;
		const marker = `«redacted:${secret.name}»`;
		if (secret.value.length >= MIN_SECRET_CHARS) {
			redacted = redacted.split(secret.value).join(marker);
			continue;
		}
		const assignment = new RegExp(
			`(${escapePattern(secret.name)}\\s*[=:]\\s*['"]?)${escapePattern(secret.value)}(['"]?)`,
			"g",
		);
		redacted = redacted.replace(assignment, `$1${marker}$2`);
	}
	return redacted;
}

/** Deep-replace the declared secret values in a response value. */
export function redact(
	value: unknown,
	secrets: readonly EnvironmentSecret[],
): unknown {
	if (secrets.length === 0) return value;
	if (typeof value === "string") return redactString(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value))
		out[key] = redact(item, secrets);
	return out;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function errorResponse(
	status: number,
	code: string,
	message: string,
): Response {
	return json({ error: { code, message } }, status);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

/** One agent environment request, or `undefined` for a path this module does
 * not own. `owner` has already been verified against the capability. */
export async function handleAgentEnvironmentRoute(
	deps: AgentEnvironmentDeps,
	request: Request,
	url: URL,
	owner: string,
): Promise<Response | undefined> {
	const method = request.method.toUpperCase();
	const path = url.pathname;
	if (!path.startsWith(AGENT_ENVIRONMENT_PREFIX)) return undefined;
	const redactValue = redactorFor(deps);
	const ok = (value: unknown, status = 200) =>
		json({ ok: true, value: redactValue(value) }, status);
	try {
		return await dispatch(deps, request, url, method, path, owner, ok);
	} catch (error) {
		if (error instanceof EnvironmentInstanceError) {
			// A detected wait cycle is a first-class answer, not a transport failure:
			// the tool reports `deadlock` and the agent knows to stop an app it holds
			// rather than repeat the call.
			if (error.code === "deadlock")
				return ok({ outcome: "deadlock", owner, message: error.message });
			return errorResponse(
				error.status,
				error.code,
				redactValue(error.message) as string,
			);
		}
		if (error instanceof ActionConflictError)
			return errorResponse(
				error.status,
				error.code,
				redactValue(error.message) as string,
			);
		return errorResponse(
			400,
			"bad-request",
			redactValue(message(error)) as string,
		);
	}
}

async function dispatch(
	deps: AgentEnvironmentDeps,
	request: Request,
	url: URL,
	method: string,
	path: string,
	owner: string,
	ok: (value: unknown, status?: number) => Response,
): Promise<Response | undefined> {
	if (method === "GET" && path === AGENT_LIST_PATH)
		return ok(await environmentList(deps, owner, url.searchParams));
	if (method === "GET" && path === AGENT_STATUS_PATH)
		return ok(
			await environmentStatus(deps, owner, url.searchParams.get("app")),
		);
	if (method === "GET" && path === AGENT_LOGS_PATH)
		return ok(await environmentLogs(deps, owner, url.searchParams));
	if (method === "POST" && path === AGENT_ACQUIRE_PATH) {
		const body = decodeRouteRequest<AgentEnvironmentAcquire>(
			AGENT_ACQUIRE_PATH,
			await readJsonBody(request),
		);
		return ok(await environmentAcquire(deps, owner, body, request.signal));
	}
	if (method === "POST" && path === AGENT_STOP_PATH) {
		const body = decodeRouteRequest<{ app: string }>(
			AGENT_STOP_PATH,
			await readJsonBody(request),
		);
		return ok(await environmentStop(deps, owner, body.app));
	}
	for (const [action, actionPath] of [
		["build", AGENT_BUILD_PATH],
		["test", AGENT_TEST_PATH],
	] as const) {
		if (method !== "POST" || path !== actionPath) continue;
		const body = decodeRouteRequest<AgentEnvironmentBuild>(
			actionPath,
			await readJsonBody(request),
		);
		return ok(await environmentBuildTest(deps, owner, body, action));
	}
	return errorResponse(
		404,
		"not-found",
		`unknown agent environment route ${path}`,
	);
}

function requireInstances(
	deps: AgentEnvironmentDeps,
): EnvironmentInstanceController {
	if (!deps.instances)
		throw new EnvironmentInstanceError(
			"instances-unavailable",
			503,
			"the environment slot capability is not attached",
		);
	return deps.instances;
}

/**
 * Stamp the apps this owner is using.
 *
 * The idle reaper stops an agent-held app whose activity stamp is older than the
 * configured TTL, and it reads that stamp as "any operation on the app". The
 * environment tools are operations, so every one of them reports its use —
 * otherwise an agent could build, test and read logs for an hour and have its
 * app reaped out from under it. An app another owner holds is deliberately left
 * alone: one workflow's read must not keep another workflow's run alive.
 */
function noteUse(
	instances: EnvironmentInstanceController,
	owner: string,
	apps: readonly string[],
): void {
	for (const app of apps) instances.touchOwnedActivity(owner, app);
}

/** A `since` the caller meant as a window must be one, or the answer silently
 * covers more history than it asked for. */
function validateSince(since: string | null): void {
	if (since === null || since.trim() === "") return;
	if (!Number.isFinite(Date.parse(since)))
		throw new EnvironmentInstanceError(
			"invalid-since",
			400,
			`since must be an ISO 8601 instant, received ${JSON.stringify(since)}`,
		);
}

function requireApp(deps: AgentEnvironmentDeps, ident: string): App {
	const app = deps.apps?.getAppByIdent(ident);
	if (!app)
		throw new EnvironmentInstanceError(
			"app-not-found",
			404,
			`app ${JSON.stringify(ident)} not found`,
		);
	return app;
}

function claimedApps(apps: string | readonly string[]): string[] {
	const list = typeof apps === "string" ? [apps] : [...apps];
	const unique: string[] = [];
	for (const app of list) if (!unique.includes(app)) unique.push(app);
	return unique;
}

/** The discovered target ids a definition row renders. */
function rowTargetId(row: Record<string, unknown>): string | undefined {
	const targetId = row.targetId;
	return typeof targetId === "string" && targetId !== "" ? targetId : undefined;
}

/**
 * Mark the deterministic default target per action, so the choice between two
 * default-profile candidates is visible instead of silently picked
 * (`staged-env-setup-config-root`), with the reason it was chosen and the same
 * rule every other consumer applies (`fix-default-target-after-promotion`): a
 * declaration in `apps/defaults/<app>.json` wins, one runtime family is no
 * choice at all, and a `build`/`test` of several families with nothing declared
 * is reported ambiguous rather than guessed.
 */
function markDefaultTargets(
	deps: AgentEnvironmentDeps,
	appIdent: string,
	overlay: string | undefined,
	targets: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const declaration = readDefaultDeclaration(deps.configDir, appIdent, overlay);
	for (const action of ["build", "test", "run"] as const) {
		const rows = targets.filter((row) => row.action === action);
		if (rows.length === 0) continue;
		const candidates: DefaultCandidate[] = rows.map((row) => ({
			id: String(row.id ?? ""),
			...(rowTargetId(row) ? { targetId: rowTargetId(row) as string } : {}),
			definitionId: String(row.id ?? ""),
			action,
			runtime: String(row.runtime ?? ""),
			...(typeof row.profile === "string" && row.profile !== ""
				? { profile: row.profile }
				: {}),
			...(typeof row.label === "string" ? { label: row.label } : {}),
		}));
		const decision = decideDefaultTarget({
			action,
			candidates,
			...(declaration.actions[action] !== undefined
				? { declared: declaration.actions[action] as string }
				: {}),
			declarationPath: defaultDeclarationRelative(appIdent),
		});
		if (decision.ambiguous) {
			const names = new Set(
				decision.candidates.map((candidate) => candidate.id),
			);
			for (const row of rows)
				if (names.has(String(row.id ?? "")))
					Object.assign(row, {
						defaultAmbiguous: true,
						defaultReason: decision.reason,
					});
			continue;
		}
		const chosen = decision.target?.id;
		if (chosen === undefined) continue;
		const winner = rows.find((row) => String(row.id ?? "") === chosen);
		if (!winner) continue;
		Object.assign(winner, {
			default: true,
			...(decision.target?.targetId
				? { defaultTargetId: decision.target.targetId }
				: {}),
			defaultReason: decision.reason,
		});
	}
	return targets;
}

/** The targets `env_list` reports for one owner, plus the staged definition files
 * that are symlinks into the developer's own files.
 *
 * For an owner without a configuration view this is the compiled registry's live
 * list: what the app offers, on which runtime, and whether it can run right now.
 * An `env-setup` run resolves its staged configuration root instead, and that
 * root is what `env_start`/`env_build`/`env_test` execute — so the listing is
 * rediscovered against the same overlay those tools use (a complete copy of the
 * live configuration, so nothing is lost) and every target that came from the
 * staged root is marked `staged: true`. Without this the tool an author uses to
 * see "what exists" contradicts the tools that run it. */
interface OwnerStagedView {
	readonly targets: Map<string, Array<Record<string, unknown>>>;
	/** The staged definition files that are symlinks, with their targets. */
	readonly symlinks: Array<{ path: string; target: string }>;
}

async function targetsByApp(
	deps: AgentEnvironmentDeps,
	owner: string,
): Promise<OwnerStagedView> {
	const byApp = liveTargetsByApp(deps);
	const symlinks = new Map<string, Array<{ path: string; target: string }>>();
	for (const app of deps.apps?.getApps() ?? []) {
		const overlay = deps.resolveOwnerOverlay?.(
			owner as `workflow:${string}`,
			app,
		);
		if (!overlay) continue;
		// A staged path that is a symlink points at the developer's real file, so
		// the author must know which ones those are before writing anything
		// (`staged-env-setup-config-root`): scanned once per overlay, then reported.
		if (!symlinks.has(overlay))
			symlinks.set(overlay, stagedSymlinkedDefinitions(overlay));
		const checkout =
			(await deps.resolveOwnerCheckout?.(owner as `workflow:${string}`, app)) ??
			"";
		if (checkout === "") continue;
		const discovered: ActionTarget[] = [];
		for (const action of ["build", "test", "run"] as const) {
			try {
				discovered.push(
					...discoverActionTargets({
						appIdent: app.ident,
						localDir: checkout,
						action,
						configDir: deps.configDir,
						configOverlay: overlay,
					}),
				);
			} catch (error) {
				// A staged definition that cannot be discovered is the validation
				// gate's finding to report, not a reason to hide the whole listing.
				deps.logger?.(
					`env_list: discovery over the staged root failed for ${app.ident}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		const prefix = `${overlay}${path.sep}`;
		const staged = discovered.filter((target) =>
			target.sourcePath.startsWith(prefix),
		);
		if (staged.length === 0) continue;
		byApp.set(
			app.ident,
			markDefaultTargets(
				deps,
				app.ident,
				overlay,
				staged.map((target) => ({
					id: target.id,
					targetId: target.id,
					action: target.action,
					runtime: target.runtime,
					label: target.label,
					profile: target.profile ?? "",
					// Availability is the compiled registry's judgement (it probes the
					// tools); the staged view rediscovers definitions without probing, so
					// it states what it knows and leaves `available` to the live half
					// rather than claiming every staged target can run right now.
					staged: true,
				})),
			),
		);
	}
	return {
		targets: byApp,
		symlinks: [...symlinks.values()]
			.flat()
			.sort((a, b) => (a.path < b.path ? -1 : 1)),
	};
}

/** The compiled registry's live targets, keyed by app. */
function liveTargetsByApp(
	deps: AgentEnvironmentDeps,
): Map<string, Array<Record<string, unknown>>> {
	const byApp = new Map<string, Array<Record<string, unknown>>>();
	const definitions = (deps.registry?.snapshot().definitions ??
		[]) as readonly ActionDefinition[];
	for (const definition of definitions) {
		if (definition.owner.kind !== "app") continue;
		if (
			definition.type !== "run" &&
			definition.type !== "build" &&
			definition.type !== "test"
		)
			continue;
		const list = byApp.get(definition.owner.id) ?? [];
		list.push({
			id: definition.id,
			...(definitionTargetId(definition)
				? { targetId: definitionTargetId(definition) as string }
				: {}),
			action: definition.type,
			runtime: definition.runtime,
			label: definition.label,
			profile: definitionProfile(definition),
			available: definition.availability.available,
			...(definition.availability.reason
				? { reason: definition.availability.reason }
				: {}),
		});
		byApp.set(definition.owner.id, list);
	}
	for (const [app, list] of byApp)
		byApp.set(app, markDefaultTargets(deps, app, undefined, list));
	return byApp;
}

/** One value a compiled definition's steps recorded, first match wins. */
function definitionStepValue(
	definition: ActionDefinition,
	key: string,
): string | undefined {
	let found: string | undefined;
	const walk = (step: unknown): void => {
		if (found !== undefined) return;
		if (typeof step !== "object" || step === null) return;
		const value = (step as { configuration?: Record<string, unknown> })
			.configuration?.[key];
		if (typeof value === "string" && value !== "") found = value;
		const children = (step as { children?: unknown[] }).children;
		if (Array.isArray(children)) for (const child of children) walk(child);
	};
	walk(definition.root);
	return found;
}

/** The discovered target id a compiled definition renders, when it has one. */
function definitionTargetId(definition: ActionDefinition): string | undefined {
	return definitionStepValue(definition, "targetId");
}

/** The profile a compiled target definition carries, as its leaf recorded it. */
function definitionProfile(definition: ActionDefinition): string {
	return definitionStepValue(definition, "profile") ?? "";
}

/**
 * The environment listing.
 *
 * The default answer is compact on purpose: the full view of a real
 * configuration ran to 31-43 KB per call whose tail — the infrastructure
 * section — was cut by the tool's own output bound, so an agent never saw it
 * (`fix-env-tool-defects-from-e2e`). `detail=full` (or naming one app) returns
 * the long form with the label, the id and the reason each default was chosen.
 */
async function environmentList(
	deps: AgentEnvironmentDeps,
	owner: string,
	params: URLSearchParams,
): Promise<unknown> {
	const instances = requireInstances(deps);
	const detail = (params.get("detail") ?? "").trim();
	const only = (params.get("app") ?? "").trim();
	// Naming one app is a request for that app's own detail: a filtered answer is
	// small whatever it carries.
	const full = detail === "full" || only !== "";
	const slots = await instances.slots();
	const byApp = new Map(slots.map((slot) => [slot.app, slot]));
	const stagedView = await targetsByApp(deps, owner);
	const targets = stagedView.targets;
	const configured = (deps.apps?.getApps() ?? []).filter(
		(app) => app.appType !== "library" && app.appType !== "LIB",
	);
	if (only !== "") {
		const known = configured.some((app) => app.ident === only);
		const infra = (deps.infraServices?.() ?? []).some(
			(service) => service.ident === only,
		);
		if (!known && !infra)
			throw new EnvironmentInstanceError(
				"app-not-found",
				404,
				`app ${JSON.stringify(only)} not found`,
			);
	}
	// Reading the environment is using it: the apps this owner holds stay live.
	noteUse(
		instances,
		owner,
		slots.map((slot) => slot.app),
	);
	const apps = configured
		.filter((app) => only === "" || app.ident === only)
		.map((app) => {
			const slot = byApp.get(app.ident);
			const rows = targets.get(app.ident) ?? [];
			return {
				app: app.ident,
				displayName: app.displayName,
				holder: slot?.holder ?? null,
				status: slot?.status ?? null,
				waiters: slot?.waiters ?? [],
				heldByYou: slot?.holder === owner,
				targets: full ? rows : rows.map(compactTarget),
			};
		});
	return {
		owner,
		detail: full ? "full" : "compact",
		apps,
		// A staged definition file that is a symlink *is* the developer's real
		// file: a write to it writes through the link (the motivating run
		// overwrote a file in the developer's own repository that way). The
		// listing names them, and where they point, so the author deletes the
		// staged link and writes a regular file instead
		// (`staged-env-setup-config-root`).
		...(stagedView.symlinks.length > 0
			? { stagedSymlinks: stagedView.symlinks }
			: {}),
		// The configured infrastructure is part of what this run may act on (it
		// has no slot of its own): the section names every service, how it is
		// reached, whether it is up and whether `db_query` can use it.
		infrastructure: await infrastructureSection(deps),
		...(full
			? {}
			: {
					notice:
						"targets are compact (targetId, label, action, runtime, default, availability); call env_list with detail=full, or with app=<ident>, for the ids and the reasons behind each default",
				}),
	};
}

/** One target row on the default's scale: what to name in env_start/env_build,
 * on which runtime, and whether it is the deterministic default. */
function compactTarget(row: Record<string, unknown>): Record<string, unknown> {
	return {
		...(rowTargetId(row) ? { targetId: rowTargetId(row) } : {}),
		...(typeof row.label === "string" ? { label: row.label } : {}),
		action: row.action,
		runtime: row.runtime,
		...(typeof row.profile === "string" && row.profile !== ""
			? { profile: row.profile }
			: {}),
		...(row.default === true ? { default: true } : {}),
		...(row.defaultAmbiguous === true ? { defaultAmbiguous: true } : {}),
		...(row.available === false ? { available: false } : {}),
		...(typeof row.reason === "string" && row.reason !== ""
			? { reason: row.reason }
			: {}),
		...(row.staged === true ? { staged: true } : {}),
	};
}

/**
 * The infrastructure section: name, kind, ports, whether it is up and whether
 * `db_query` can use it, per service.
 *
 * "Up" is observed, never remembered: a container service is read from one
 * container list (cached by the client, so the section costs one call whatever
 * the number of services), a script service from its own configured state, and a
 * cluster release reports `unknown` because this surface has no cluster read to
 * justify a stronger claim. Ports come from the running container; a definition
 * file does not declare them.
 */
async function infrastructureSection(
	deps: AgentEnvironmentDeps,
): Promise<Array<Record<string, unknown>>> {
	const services = deps.infraServices?.() ?? [];
	if (services.length === 0) return [];
	const docker = deps.runtime?.docker;
	const containerTargets = services
		.filter((service) => (service.type ?? "docker") === "docker")
		.map((service) => ({
			ident: service.ident,
			containerBaseName: service.containerBaseName ?? service.ident,
		}));
	let info = new Map<string, { Status: string; Ports: string }>();
	if (docker && containerTargets.length > 0) {
		try {
			info = await docker.client.batchGetInfo([], containerTargets);
		} catch (error) {
			deps.logger?.(
				`env_list: reading the infrastructure containers failed: ${message(error)}`,
			);
		}
	}
	return services.map((service) => {
		const kind = service.type ?? "docker";
		const observed = info.get(service.ident);
		const ports = (observed?.Ports ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
		const state =
			kind === "docker"
				? dockerInfraState(docker !== undefined, observed)
				: kind === "script" && service.status
					? runtimeState(service.status)
					: "unknown";
		return {
			ident: service.ident,
			...(service.displayName ? { displayName: service.displayName } : {}),
			kind,
			...(ports.length > 0 ? { ports } : {}),
			state,
			...(service.logPath ? { logPath: service.logPath } : {}),
			// `db_query` needs a declared connection *and* an app this workflow
			// holds that requires the service; the listing names the declaration.
			query: service.query
				? {
						kind: service.query.kind,
						database: service.query.database,
						userEnv: service.query.userEnv,
						passwordEnv: service.query.passwordEnv,
					}
				: null,
		};
	});
}

/**
 * One infrastructure container's state, from what was actually probed.
 *
 * A service without a container is `not-created` when the container runtime is
 * attached (the probe answered for it) and `unknown` when there is no runtime to
 * ask: a service that was never created and a runtime nobody could reach are
 * different facts, and the round-1 answer reported the first as the second
 * (`fix-env-tools-round-2`).
 */
function dockerInfraState(
	runtimeAttached: boolean,
	observed: { Status: string } | undefined,
): string {
	if (!runtimeAttached) return "unknown";
	if (!observed) return "not-created";
	const status = observed.Status ?? "";
	if (status === "not found") return "not-created";
	// The runtime is attached but the probe could not read it: that is the one
	// case where the answer is genuinely unknown.
	if (status === "error") return "unknown";
	return runtimeState(dockerRuntimeStatus(status));
}

/**
 * The app whose own definition requires one infrastructure service, when a live
 * owned lease names it: the lease key is `dependency/<identity>` and the
 * identity is the service's ident (with its runtime/profile/provider appended
 * when the reference names those).
 */
function requiredBy(
	deps: AgentEnvironmentDeps,
	service: string,
): { readonly app: string; readonly lifecycle: string } | undefined {
	for (const lease of deps.actions?.services.leases?.active() ?? []) {
		if (
			lease.targetId === `dependency/${service}` ||
			lease.targetId.startsWith(`dependency/${service}/`)
		)
			return { app: lease.ownerApp, lifecycle: lease.lifecycle };
	}
	return undefined;
}

/** The refusal one infrastructure ident gets from `env_start`: the app that
 * requires it is what starts it, and when a live lease names that app the
 * answer names it too. */
function infrastructureRefusal(
	deps: AgentEnvironmentDeps,
	ident: string,
): EnvironmentInstanceError {
	const owner = requiredBy(deps, ident);
	return new EnvironmentInstanceError(
		"infrastructure-managed",
		409,
		owner
			? `infrastructure ${JSON.stringify(ident)} is started by app ${owner.app}'s requirement; start that app instead`
			: `infrastructure ${JSON.stringify(ident)} is not started by this surface: the app whose definition requires it starts it, and the developer's environment panel can start it on its own`,
	);
}

async function environmentStatus(
	deps: AgentEnvironmentDeps,
	owner: string,
	app: string | null,
): Promise<unknown> {
	const instances = requireInstances(deps);
	const slots = await instances.slots();
	const named =
		app === null || app === "" ? slots : slots.filter((s) => s.app === app);
	if (app !== null && app !== "" && named.length === 0) {
		// An infrastructure service has no slot of its own, but it is part of what
		// this run may act on (`env_logs` takes its ident): its status is answered
		// rather than reported as a missing app (`fix-env-tool-defects-from-e2e`).
		const service = (deps.infraServices?.() ?? []).find(
			(candidate) => candidate.ident === app,
		);
		if (service) {
			const rows = await infrastructureSection(deps);
			const row = rows.find((entry) => entry.ident === app) ?? { ident: app };
			return {
				owner,
				apps: [],
				infrastructure: [
					{
						...row,
						...(requiredBy(deps, app)
							? {
									requiredBy: requiredBy(deps, app)?.app,
									notice: `started by app ${requiredBy(deps, app)?.app}'s requirement; env_stop stops the app, not the shared service`,
								}
							: {}),
					},
				],
			};
		}
		throw new EnvironmentInstanceError(
			"app-not-found",
			404,
			`app ${JSON.stringify(app)} not found`,
		);
	}
	noteUse(
		instances,
		owner,
		named.map((slot) => slot.app),
	);
	return {
		owner,
		apps: await Promise.all(
			named.map(async (slot) => ({
				app: slot.app,
				holder: slot.holder,
				status: slot.status,
				waiters: slot.waiters,
				heldByYou: slot.holder === owner,
				...(await runDetail(instances, slot.app, slot.status)),
				// The developer's force release is a notice the holder reads once.
				...(slot.holder === owner && slot.status === "released-by-developer"
					? {
							notice: `the developer released ${slot.app}; call env_start again if you still need it`,
						}
					: {}),
			})),
		),
	};
}

/**
 * The run detail one status row carries: the runtime, the exit code and the last
 * output lines of a run that already ended.
 *
 * It is the same row `slots()` reports and the same record the status API and
 * `env_logs` read (`EnvironmentInstanceController.runRecord`), so the three
 * signals cannot disagree about a live run, a dead one or a replacement
 * (`fix-env-tool-defects-from-e2e`). A live run carries the detail too — its
 * runtime and its captured log file — but no exit code, because there is none.
 */
async function runDetail(
	instances: EnvironmentInstanceController,
	app: string,
	slotStatus: string | null | undefined,
): Promise<Record<string, unknown>> {
	const record = instances.runRecord?.(app);
	if (!record) return {};
	const dead = record.status === "failed" || record.status === "stopped";
	// What the definition declares about this run's readiness, probed once for
	// this read: a container or a process that is up is not an application that
	// serves (`fix-env-tools-round-2`).
	const readiness = await instances.runReadinessOf?.(app);
	return {
		// What the definition declares about this run's readiness, probed once for
		// this read: a container or a process that is up is not an application that
		// serves (`fix-env-tools-round-2`).
		...(readiness
			? {
					readiness: {
						ready: readiness.ready,
						...(readiness.waitingFor
							? { waitingFor: readiness.waitingFor }
							: {}),
						...(readiness.lastProbe ? { lastProbe: readiness.lastProbe } : {}),
					},
				}
			: {}),
		run: {
			runtime: record.runtime,
			status: record.status,
			...(slotStatus === record.status ? {} : { slotStatus }),
			...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
			...(record.pid === undefined ? {} : { pid: record.pid }),
			...(dead && record.logPath ? { logPath: record.logPath } : {}),
			...(dead && record.logPath ? { logTail: logTailOf(record.logPath) } : {}),
		},
	};
}

/** The last lines of a dead run's captured output, bounded like the failure the
 * start itself reports. Returns nothing when the file is not there. */
function logTailOf(file: string): string | undefined {
	try {
		const size = fs.statSync(file).size;
		const window = Math.min(size, 8 * 1024);
		if (window === 0) return undefined;
		const handle = fs.openSync(file, "r");
		try {
			const buffer = Buffer.alloc(window);
			fs.readSync(handle, buffer, 0, window, size - window);
			let text = buffer.toString("utf8");
			if (window < size) {
				const newline = text.indexOf("\n");
				text = newline < 0 ? "" : text.slice(newline + 1);
			}
			const lines = text.split("\n").filter((line) => line !== "");
			return lines.slice(-20).join("\n");
		} finally {
			fs.closeSync(handle);
		}
	} catch {
		return undefined;
	}
}

/** The run target id an owner's declaration names for one app, when it has one. */
function declaredRunTargetId(
	deps: AgentEnvironmentDeps,
	owner: string,
	appIdent: string,
): string | undefined {
	const app = deps.apps?.getAppByIdent(appIdent);
	if (!app) return undefined;
	const overlay = deps.resolveOwnerOverlay?.(
		owner as `workflow:${string}`,
		app,
	);
	return declaredTargetId({
		configDir: deps.configDir,
		appIdent,
		action: "run",
		checkoutDir: app.localDirectoryPath,
		...(overlay ? { configOverlay: overlay } : {}),
	});
}

async function environmentAcquire(
	deps: AgentEnvironmentDeps,
	owner: string,
	body: AgentEnvironmentAcquire,
	signal?: AbortSignal,
): Promise<unknown> {
	const instances = requireInstances(deps);
	const claimed = claimedApps(body.apps);
	// An infrastructure service has no slot to acquire: it is started by the app
	// whose definition requires it (or by the developer), and this surface says so
	// precisely instead of answering "app not found"
	// (`fix-env-tool-defects-from-e2e`).
	const infrastructure = claimed.filter((ident) =>
		(deps.infraServices?.() ?? []).some((service) => service.ident === ident),
	);
	if (infrastructure.length > 0)
		throw infrastructureRefusal(deps, infrastructure[0] as string);
	// A declaration that names the app's run target is honoured here by naming that
	// target: the caller asked for "the app", and `apps/defaults/<app>.json` is
	// where the developer said which run target that is
	// (`fix-default-target-after-promotion`). Without a declaration nothing is
	// passed and the slot controller's documented runtime preference decides —
	// including when several apps are claimed at once, which one target cannot
	// express.
	const declaredRun =
		!body.target && !body.runtime && !body.profile && claimed.length === 1
			? declaredRunTargetId(deps, owner, claimed[0] as string)
			: undefined;
	const result = await instances.acquire({
		owner: parseEnvironmentOwner(owner),
		apps: claimed,
		...((body.target ?? declaredRun)
			? { target: body.target ?? declaredRun }
			: {}),
		...(body.profile ? { profile: body.profile } : {}),
		...(body.runtime ? { runtime: body.runtime } : {}),
		...(body.replicas === undefined ? {} : { replicas: body.replicas }),
		...(body.waitSec === undefined ? {} : { waitSec: body.waitSec }),
		// A caller that goes away ends its wait: the queue entry is withdrawn
		// instead of being left to commit a start nobody asked for any more.
		...(signal ? { signal } : {}),
	});
	return summarizeAcquire(result);
}

/** The acquire answer as the tool layer reports it. A grant carries the
 * endpoints the app exposes; a wait carries the position and holder per app, so
 * the tool can explain the wait to the model without a second call. */
export function summarizeAcquire(result: {
	readonly outcome: string;
	readonly owner: string;
	readonly apps?: readonly string[];
	readonly positions?: Record<string, number>;
	readonly holders?: Record<string, string>;
	readonly readiness?: Readonly<
		Record<
			string,
			{
				readonly ready: boolean;
				readonly waitingFor?: string;
				readonly lastProbe?: string;
			}
		>
	>;
	readonly instances?: readonly {
		readonly app: string;
		readonly id: string;
		readonly targetId: string;
		readonly runtime: string;
		readonly status: string;
		readonly checkoutPath: string;
		readonly imageTag: string;
		readonly endpoints: Readonly<Record<string, string>>;
		/** The slot grant this run started under (`ac.run`), when this process
		 * started it and therefore knows the grant. */
		readonly run?: string;
	}[];
}): Record<string, unknown> {
	if (result.outcome === "started" || result.outcome === "already-running") {
		const readiness = result.readiness ?? {};
		// A run whose definition declares a readiness that has not passed is
		// `starting`, not `started`: the container or the process is up, the
		// application is not serving yet (`fix-env-tools-round-2`).
		const waiting = (result.instances ?? []).some(
			(instance) => readiness[instance.app]?.ready === false,
		);
		return {
			outcome: waiting ? "starting" : result.outcome,
			owner: result.owner,
			apps: (result.instances ?? []).map((instance) => ({
				app: instance.app,
				status: instance.status,
				targetId: instance.targetId,
				runtime: instance.runtime,
				checkout: instance.checkoutPath,
				imageTag: instance.imageTag,
				endpoints: instance.endpoints,
				// What the definition declares about this run's readiness, and what
				// the last probe found, so the agent can tell "up" from "serving".
				...(readiness[instance.app]
					? {
							readiness: {
								ready: readiness[instance.app]?.ready === true,
								...(readiness[instance.app]?.waitingFor === undefined
									? {}
									: { waitingFor: readiness[instance.app]?.waitingFor }),
								...(readiness[instance.app]?.lastProbe === undefined
									? {}
									: { lastProbe: readiness[instance.app]?.lastProbe }),
							},
						}
					: {}),
				// The run's own id, so the agent can match the spans `otel_query`
				// reports (`ac.run`) to the hold it is debugging.
				...(instance.run ? { run: instance.run } : {}),
			})),
			...(waiting
				? {
						notice:
							"the run holds the app but the readiness its definition declares has not passed yet; call env_status for the current probe, and raise environment.instances.readiness_timeout_seconds when this run needs longer",
					}
				: {}),
		};
	}
	if (result.outcome === "released-by-developer")
		return {
			outcome: result.outcome,
			owner: result.owner,
			apps: result.apps ?? [],
			notice:
				"the developer released these apps; call env_start again if you still need them",
		};
	if (result.outcome === "cancelled")
		return {
			outcome: result.outcome,
			owner: result.owner,
			apps: result.apps ?? [],
			notice: "the wait was cancelled; nothing was started",
		};
	return {
		outcome: result.outcome,
		owner: result.owner,
		apps: result.apps ?? [],
		positions: result.positions ?? {},
		holders: result.holders ?? {},
	};
}

async function environmentStop(
	deps: AgentEnvironmentDeps,
	owner: string,
	app: string,
): Promise<unknown> {
	const instances = requireInstances(deps);
	// Stopping an infrastructure service is not this surface's: it is shared by
	// every app that requires it, so the app's stop releases it and the developer's
	// panel owns the service itself (`fix-env-tool-defects-from-e2e`).
	if ((deps.infraServices?.() ?? []).some((service) => service.ident === app)) {
		const owner = requiredBy(deps, app);
		throw new EnvironmentInstanceError(
			"infrastructure-managed",
			409,
			owner
				? `infrastructure ${JSON.stringify(app)} is started by app ${owner.app}'s requirement: stop that app, and the service is stopped once no app requires it`
				: `infrastructure ${JSON.stringify(app)} is shared, not held by this run: stop the app that requires it, or ask the developer to stop the service`,
		);
	}
	const occupant = await instances.occupancy(app);
	if (!occupant)
		throw new EnvironmentInstanceError(
			"no-holder",
			409,
			`no environment instance holds ${JSON.stringify(app)}`,
		);
	// The read above names the holder for the caller (and catches a human run,
	// which has no row); the authorization itself is the controller's
	// `stopOwned`, which checks the holder and claims the row in one synchronous
	// step, so an app that changed owner cannot be stopped by the owner that no
	// longer holds it.
	const instance = await instances.stopOwned(parseEnvironmentOwner(owner), app);
	noteUse(instances, owner, [app]);
	return {
		owner,
		app,
		status: instance.status,
		targetId: instance.targetId,
		runtime: instance.runtime,
	};
}

async function environmentBuildTest(
	deps: AgentEnvironmentDeps,
	owner: string,
	body: AgentEnvironmentBuild,
	action: "build" | "test",
): Promise<unknown> {
	if (!deps.actions)
		throw new EnvironmentInstanceError(
			"actions-unavailable",
			503,
			"the environment action engine is not attached",
		);
	const app = requireApp(deps, body.app);
	const checkout = await deps.resolveOwnerCheckout?.(
		owner as `workflow:${string}`,
		app,
	);
	if (!checkout)
		throw new EnvironmentInstanceError(
			"owner-checkout-unavailable",
			409,
			`no managed checkout is available for ${owner}; ${action} runs in the workflow's own checkout`,
		);
	const overlay = deps.resolveOwnerOverlay?.(
		owner as `workflow:${string}`,
		app,
	);
	const result = await runAppBuildTestAction(deps.actions, {
		app,
		action,
		checkoutDir: checkout,
		// The owner's own configuration view: an env-setup run builds and tests the
		// definition it staged, not the live one
		// (`staged-env-setup-config-root`).
		...(overlay ? { configOverlay: overlay } : {}),
		...(body.target ? { target: body.target } : {}),
		...(body.profile ? { profile: body.profile } : {}),
	});
	noteUse(requireInstances(deps), owner, [app.ident]);
	return { owner, app: app.ident, action, ...result };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

interface LogResult {
	readonly source: string;
	readonly lines: string[];
	readonly truncated: boolean;
}

function boundedInt(raw: string | null, fallback: number, max: number): number {
	const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(max, Math.floor(value));
}

/** `grep` is a literal substring filter, deliberately not a regular
 * expression: the pattern is caller-supplied and the server runs on one shared
 * event loop, so a compiled pattern such as `(a+)+$` against a long log line
 * could stall every other workflow's request, the dashboard's reads and the slot
 * controller's long polls. A literal filter cannot backtrack. */
function lineMatcher(
	grep: string | null,
): ((line: string) => boolean) | undefined {
	const pattern = (grep ?? "").trim();
	if (pattern === "") return undefined;
	return (line) => line.includes(pattern);
}

/** Lines that carry an ISO timestamp older than `since` are dropped; a line
 * without one is kept, because dropping it would hide output the source never
 * attributed to a time. */
function afterSince(lines: readonly string[], since: string | null): string[] {
	const boundary = since === null ? Number.NaN : Date.parse(since);
	if (!Number.isFinite(boundary)) return [...lines];
	return lines.filter((line) => {
		const match = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/);
		if (!match) return true;
		const at = Date.parse(match[0]);
		return !Number.isFinite(at) || at >= boundary;
	});
}

function boundedLines(
	lines: readonly string[],
	tail: number,
): { lines: string[]; truncated: boolean } {
	const kept = lines.slice(Math.max(0, lines.length - tail));
	let truncated = kept.length < lines.length;
	let budget = MAX_OUTPUT_CHARS;
	// Collected newest-first, then reversed once: `unshift` per line would move
	// every line already collected on every iteration.
	const out: string[] = [];
	for (let index = kept.length - 1; index >= 0; index--) {
		const line = kept[index] as string;
		if (line.length > budget) {
			out.push(`${line.slice(0, Math.max(0, budget))}…`);
			truncated = true;
			break;
		}
		budget -= line.length + 1;
		out.push(line);
	}
	out.reverse();
	return { lines: out, truncated };
}

/**
 * The last `tail` lines of a log file, reading only the last bytes of it.
 *
 * A script infrastructure service appends to one log for its whole lifetime, so
 * reading the file whole would make one `env_logs` call grow with total history:
 * bytes read, memory and latency. The read is bounded to `MAX_LOG_READ_BYTES`
 * (and asynchronous, so a large read does not block the shared event loop), and
 * a window that starts mid-line drops that partial first line.
 */
async function readTextFileTail(
	file: string,
	tail: number,
): Promise<{ lines: string[]; truncated: boolean }> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch (error) {
		throw new EnvironmentInstanceError(
			"log-unavailable",
			404,
			`cannot read ${file}: ${message(error)}`,
		);
	}
	try {
		const size = (await handle.stat()).size;
		const window = Math.min(size, MAX_LOG_READ_BYTES);
		const start = size - window;
		const buffer = Buffer.alloc(window);
		await handle.read(buffer, 0, window, start);
		let text = buffer.toString("utf8");
		// A window that starts mid-line would answer with a mangled first line.
		if (start > 0) {
			const newline = text.indexOf("\n");
			text = newline < 0 ? "" : text.slice(newline + 1);
		}
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		return {
			lines: lines.slice(Math.max(0, lines.length - tail)),
			truncated: window < size,
		};
	} finally {
		await handle.close();
	}
}

async function environmentLogs(
	deps: AgentEnvironmentDeps,
	owner: string,
	params: URLSearchParams,
): Promise<unknown> {
	const ident = (params.get("app") ?? "").trim();
	if (ident === "")
		throw new EnvironmentInstanceError("app-required", 400, "app is required");
	const service = (params.get("service") ?? "").trim() || undefined;
	const grep = params.get("grep");
	const since = params.get("since");
	const tail = boundedInt(
		params.get("tail"),
		DEFAULT_TAIL_LINES,
		MAX_TAIL_LINES,
	);
	const infraOnly = params.get("infra") === "1";
	validateSince(since);
	const result = await collectLogs(deps, ident, service, tail, infraOnly);
	// Order matters: the window is bounded first (lines and characters), so the
	// matcher only ever sees bounded input and a huge line cannot be handed to it.
	const bounded = boundedLines(afterSince(result.lines, since), tail);
	const matcher = lineMatcher(grep);
	const lines = matcher ? bounded.lines.filter(matcher) : bounded.lines;
	noteUse(requireInstances(deps), owner, [ident]);
	return {
		owner,
		app: ident,
		source: result.source,
		lines,
		truncated: result.truncated || bounded.truncated,
		matched: lines.length,
	};
}

async function collectLogs(
	deps: AgentEnvironmentDeps,
	ident: string,
	service: string | undefined,
	tail: number,
	infraOnly: boolean,
): Promise<LogResult> {
	const app = infraOnly ? undefined : deps.apps?.getAppByIdent(ident);
	const infraServices =
		deps.actions?.services.infraServices ?? deps.runtime?.infraServices ?? [];
	const infra: InfraLogSource | undefined = infraServices.find(
		(candidate) => candidate.ident === ident,
	);
	if (!app && !infra)
		throw new EnvironmentInstanceError(
			"app-not-found",
			404,
			`app ${JSON.stringify(ident)} not found`,
		);
	if (infra && infra.type === "script") {
		if (!infra.logPath)
			throw new EnvironmentInstanceError(
				"log-unavailable",
				404,
				`${JSON.stringify(ident)} has no log file`,
			);
		const fileTail = await readTextFileTail(infra.logPath, tail);
		return {
			source: infra.logPath,
			lines: fileTail.lines,
			truncated: fileTail.truncated,
		};
	}
	if (infra && infra.type === "kubernetes") {
		const kubernetes = infra.kubernetes;
		if (!kubernetes?.release)
			throw new EnvironmentInstanceError(
				"log-unavailable",
				404,
				`${JSON.stringify(ident)} has no kubernetes release to read`,
			);
		return kubernetesLogResult(
			deps,
			kubernetes.namespace ?? "default",
			kubernetes.release,
			tail,
		);
	}
	if (app) {
		// A shell (script) run has no container: its own captured output file is
		// what `env_logs` reads, resolved from the app's latest run row so a run
		// that already failed still answers (`fix-env-tool-defects-from-e2e`).
		const run = deps.instances?.runRecord?.(app.ident);
		if (run?.logPath) {
			if (!fs.existsSync(run.logPath))
				throw new EnvironmentInstanceError(
					"log-unavailable",
					404,
					`the script run of ${JSON.stringify(ident)} has no captured log at ${run.logPath}`,
				);
			const fileTail = await readTextFileTail(run.logPath, tail);
			return {
				source: run.logPath,
				lines: fileTail.lines,
				truncated: fileTail.truncated,
			};
		}
		const dir = app.localDirectoryPath;
		const kubernetesTarget = deps.runtime?.resolveKubernetesTarget?.(
			app.ident,
			dir,
		);
		if (kubernetesTarget)
			return kubernetesLogResult(
				deps,
				kubernetesTarget.namespace ?? "default",
				kubernetesTarget.release,
				tail,
			);
	}
	return dockerLogResult(deps, ident, app, service);
}

async function kubernetesLogResult(
	deps: AgentEnvironmentDeps,
	namespace: string,
	release: string,
	tail: number,
): Promise<LogResult> {
	const runtime = deps.runtime;
	if (!runtime)
		throw new EnvironmentInstanceError(
			"runtime-unavailable",
			503,
			"the container runtime capability is not attached",
		);
	// A release's pod list is a growing store (completed pods stay listed), so the
	// reader is given this request's per-pod tail and a total character budget
	// instead of reading every pod's 500 lines into memory first.
	const text = await kubernetesLogsForRelease(
		runtime,
		runtime.runner ?? runtime.kubernetes.runner,
		namespace,
		release,
		{ tail, maxChars: MAX_LOG_COLLECT_CHARS },
	);
	return {
		source: `kubernetes ${namespace}/${release}`,
		lines: text.split("\n").filter((line) => line !== ""),
		truncated: text.length >= MAX_LOG_COLLECT_CHARS,
	};
}

/** The compose files an app's runs are created from, whatever worktree started
 * them: the config directory's `<app>-compose.yml` and `<app>-<profile>-compose.yml`
 * files, which is what a container's `com.docker.compose.project.config_files`
 * label carries. */
function composeSourcePaths(configDir: string, ident: string): string[] {
	const dir = path.join(configDir, "apps", "compose");
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter(
			(name) =>
				name.startsWith(`${ident}-`) &&
				(name.endsWith("-compose.yml") || name.endsWith("-compose.yaml")),
		)
		.map((name) => path.join(dir, name));
}

async function dockerLogResult(
	deps: AgentEnvironmentDeps,
	ident: string,
	app: App | undefined,
	service: string | undefined,
): Promise<LogResult> {
	const docker: DockerRuntimeSelection | undefined = deps.runtime?.docker;
	if (!docker)
		throw new EnvironmentInstanceError(
			"runtime-unavailable",
			503,
			// The probe's own finding, not a bare "no runtime": a failure that does
			// not say what was looked for costs the caller a call it cannot answer
			// (`fix-env-tool-defects-from-e2e`).
			`no container runtime is available: ${
				deps.runtime?.dockerProbe ??
				"the server attached no container-runtime capability at all"
			}`,
		);
	const sourcePaths = composeSourcePaths(deps.configDir, ident);
	const containers = (await docker.client.allContainers()).filter(
		(container) =>
			(container.Names ?? []).some((name) =>
				containerNameMatches(name, ident, app?.containerBaseName ?? ident),
			) || containerFromConfigFiles(container, sourcePaths),
	);
	if (containers.length === 0)
		throw new EnvironmentInstanceError(
			"log-unavailable",
			404,
			`no container of ${JSON.stringify(ident)} is present`,
		);
	const matching = service
		? containers.filter((container) =>
				(container.Names ?? []).some((name) => name.includes(service)),
			)
		: containers;
	if (matching.length === 0)
		throw new EnvironmentInstanceError(
			"log-unavailable",
			404,
			`no container of ${JSON.stringify(ident)} matches service ${JSON.stringify(service)}`,
		);
	// A stale or stopped container of an older worktree stays listed forever, so
	// the fan-out is capped (deterministically, by container name) and the round
	// trips run together instead of one after another.
	const selected = [...matching]
		.sort((left, right) =>
			(left.Names?.[0] ?? left.Id).localeCompare(right.Names?.[0] ?? right.Id),
		)
		.slice(0, MAX_LOG_CONTAINERS);
	const read = await Promise.all(
		selected.map(async (container) => {
			const name = (container.Names?.[0] ?? container.Id).replace(/^\//, "");
			try {
				return {
					name,
					text: await docker.client.getContainerLogs(container.Id),
				};
			} catch (error) {
				return { name, text: `cannot read logs: ${message(error)}` };
			}
		}),
	);
	const lines: string[] = [];
	let budget = MAX_LOG_COLLECT_CHARS;
	for (const container of read) {
		for (const line of container.text.split("\n")) {
			if (line === "") continue;
			const framed = `[${container.name}] ${line}`;
			if (framed.length > budget)
				return {
					source: `docker ${selected.length} container(s)`,
					lines,
					truncated: true,
				};
			budget -= framed.length + 1;
			lines.push(framed);
		}
	}
	return {
		source: `docker ${selected.length} container(s)`,
		lines,
		truncated: selected.length < matching.length,
	};
}
