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
import type { ActionRegistry } from "../actions/registry.ts";
import {
	ActionConflictError,
	type ActionRouteContext,
	runAppBuildTestAction,
} from "../actions/routes.ts";
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
import type { App } from "./config.ts";
import { parseEnvironmentOwner } from "./instances/model.ts";
import type { EnvironmentManager } from "./manager.ts";

/** The infrastructure-service fields the log reader needs. The configured and
 * runtime models both carry them, so the reader accepts either rather than
 * forcing one model onto the other. */
interface InfraLogSource {
	readonly ident: string;
	readonly type?: string;
	readonly logPath?: string;
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
/** Declared secrets at least this long are replaced wherever they appear. */
const MIN_SECRET_CHARS = 6;

/** Everything the agent routes read. Absent capabilities answer 503 instead of
 * pretending the environment is empty. */
export interface AgentEnvironmentDeps {
	readonly configDir: string;
	readonly instances?: EnvironmentInstanceController;
	readonly apps?: Pick<EnvironmentManager, "getApps" | "getAppByIdent">;
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
		return ok(await environmentList(deps, owner));
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

/** The configured app's run/build/test actions, as the compiled registry knows
 * them: what it offers, on which runtime, and whether it can run right now. */
function targetsByApp(
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
			action: definition.type,
			runtime: definition.runtime,
			label: definition.label,
			available: definition.availability.available,
			...(definition.availability.reason
				? { reason: definition.availability.reason }
				: {}),
		});
		byApp.set(definition.owner.id, list);
	}
	return byApp;
}

async function environmentList(
	deps: AgentEnvironmentDeps,
	owner: string,
): Promise<unknown> {
	const instances = requireInstances(deps);
	const slots = await instances.slots();
	const byApp = new Map(slots.map((slot) => [slot.app, slot]));
	const targets = targetsByApp(deps);
	// Reading the environment is using it: the apps this owner holds stay live.
	noteUse(
		instances,
		owner,
		slots.map((slot) => slot.app),
	);
	return {
		owner,
		apps: (deps.apps?.getApps() ?? [])
			.filter((app) => app.appType !== "library" && app.appType !== "LIB")
			.map((app) => {
				const slot = byApp.get(app.ident);
				return {
					app: app.ident,
					displayName: app.displayName,
					holder: slot?.holder ?? null,
					status: slot?.status ?? null,
					waiters: slot?.waiters ?? [],
					heldByYou: slot?.holder === owner,
					targets: targets.get(app.ident) ?? [],
				};
			}),
	};
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
	if (app !== null && app !== "" && named.length === 0)
		throw new EnvironmentInstanceError(
			"app-not-found",
			404,
			`app ${JSON.stringify(app)} not found`,
		);
	noteUse(
		instances,
		owner,
		named.map((slot) => slot.app),
	);
	return {
		owner,
		apps: named.map((slot) => ({
			app: slot.app,
			holder: slot.holder,
			status: slot.status,
			waiters: slot.waiters,
			heldByYou: slot.holder === owner,
			// The developer's force release is a notice the holder reads once.
			...(slot.holder === owner && slot.status === "released-by-developer"
				? {
						notice: `the developer released ${slot.app}; call env_start again if you still need it`,
					}
				: {}),
		})),
	};
}

async function environmentAcquire(
	deps: AgentEnvironmentDeps,
	owner: string,
	body: AgentEnvironmentAcquire,
	signal?: AbortSignal,
): Promise<unknown> {
	const instances = requireInstances(deps);
	const result = await instances.acquire({
		owner: parseEnvironmentOwner(owner),
		apps: claimedApps(body.apps),
		...(body.target ? { target: body.target } : {}),
		...(body.profile ? { profile: body.profile } : {}),
		...(body.runtime ? { runtime: body.runtime } : {}),
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
	readonly instances?: readonly {
		readonly app: string;
		readonly id: string;
		readonly targetId: string;
		readonly runtime: string;
		readonly status: string;
		readonly checkoutPath: string;
		readonly imageTag: string;
		readonly endpoints: Readonly<Record<string, string>>;
	}[];
}): Record<string, unknown> {
	if (result.outcome === "started" || result.outcome === "already-running")
		return {
			outcome: result.outcome,
			owner: result.owner,
			apps: (result.instances ?? []).map((instance) => ({
				app: instance.app,
				status: instance.status,
				targetId: instance.targetId,
				runtime: instance.runtime,
				checkout: instance.checkoutPath,
				imageTag: instance.imageTag,
				endpoints: instance.endpoints,
			})),
		};
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
	const result = await runAppBuildTestAction(deps.actions, {
		app,
		action,
		checkoutDir: checkout,
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
			"no container runtime is available",
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
