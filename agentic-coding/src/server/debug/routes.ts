// The agent debug routes (`add-agent-debug-tools`, tasks 2.1-2.3).
//
// The owner-scoped HTTP surface a durable run's `otel_query`, `db_query` and
// `http_request` tools call. It rides the same verified capability as
// `/api/v1/agent-env/*` (`app.ts` resolves the owner before this module runs),
// so every answer is this workflow's own: its runs' spans, the data of an infra
// service an app it holds requires, and the endpoints of the apps it holds.
//
// The bounds are the point of the surface, and each one lives where the risk is:
//
//   * `otel_query` reads the live index, which only holds spans that name their
//     owner and is bounded in traces, spans and attribute length
//     (`trace-index.ts`);
//   * `db_query` runs one read-only transaction through `db-query.ts`, which
//     bounds the statement timeout, the rows and every value, and always rolls
//     back; and
//   * `http_request` targets an endpoint of a held app only, bounds the request
//     body, reads the response up to a cap, and redacts what is a credential by
//     definition (`http.ts`). The shared environment redactor runs over every
//     answer as well, so a declared secret cannot travel back either.

import type {
	AgentDbQuery,
	AgentHttpRequest,
	AgentOtelQuery,
} from "../../contracts/environment.ts";
import { configEnvValue } from "../../workflow/effects.ts";
import { discoverActionTargets } from "../actions/discovery.ts";
import type { ActionTarget } from "../actions/targets.ts";
import { readJsonBody } from "../auth.ts";
import { environmentSecrets, redact } from "../environment/agent-routes.ts";
import type { App, InfraService } from "../environment/config.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import {
	AGENT_DB_QUERY_PATH,
	AGENT_DEBUG_PREFIX,
	AGENT_HTTP_REQUEST_PATH,
	AGENT_OTEL_QUERY_PATH,
	decodeRouteRequest,
} from "../protocol.ts";
import type { EnvironmentInstanceController } from "../runtime/instances.ts";
import {
	bunSqlPort,
	type DbQueryConnection,
	DbQueryError,
	runReadOnlyQuery,
	type SqlPort,
} from "./db-query.ts";
import { callEndpoint, endpointUrl, HttpRequestError } from "./http.ts";
import {
	type LogIndex,
	MAX_INDEXED_TRACES,
	type TraceIndex,
	TraceIndexError,
} from "./trace-index.ts";

/** Everything the debug routes read. A missing capability answers 503 for the
 * operation it serves instead of inventing a result. */
export interface DebugRouteDeps {
	/** The live trace index the receivers feed. Absent means this server receives
	 * no telemetry, so no trace is queryable. */
	readonly traceIndex?: TraceIndex;
	/** The live log index the same receivers feed. Absent means this server
	 * receives no telemetry, so no log is queryable either. */
	readonly logIndex?: LogIndex;
	readonly instances?: EnvironmentInstanceController;
	readonly apps?: Pick<EnvironmentManager, "getAppByIdent">;
	/** The configured infra services, read per call so a reload applies. */
	readonly infraServices?: () => readonly InfraService[];
	/** Test seam: the SQL port. Defaults to `Bun.sql`. */
	readonly sql?: SqlPort;
	/** Test seam: run-target discovery. Defaults to the real discovery. */
	readonly discovery?: (context: {
		readonly appIdent: string;
		readonly localDir: string;
		readonly action: "run";
		readonly configDir: string;
	}) => ActionTarget[];
	/** Test seam: the configuration environment a credential is read from. */
	readonly env?: (name: string) => string | undefined;
	/** Test seam: the HTTP transport. Defaults to `fetch`. */
	readonly send?: typeof fetch;
	readonly configDir?: string;
	readonly resolveOwnerCheckout?: (
		owner: `workflow:${string}`,
		app: App,
	) => string | undefined | Promise<string | undefined>;
	readonly logger?: (message: string) => void;
}

/** A refusal the route answers with its own status instead of a 500. */
export class DebugRouteError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "DebugRouteError";
		this.code = code;
		this.status = status;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The owner-scoped debug routes. Answers `undefined` for a path this module does
 * not own, so `app.ts` keeps handing the rest of the capability prefix to the
 * environment routes.
 */
export async function handleDebugRoute(
	deps: DebugRouteDeps,
	request: Request,
	url: URL,
	owner: string,
): Promise<Response | undefined> {
	const path = url.pathname;
	if (!path.startsWith(AGENT_DEBUG_PREFIX)) return undefined;
	const redactValue = (value: unknown) =>
		redact(value, environmentSecrets(deps.configDir ?? ""));
	try {
		if (request.method.toUpperCase() !== "POST")
			throw new DebugRouteError(
				"method-not-allowed",
				"the debug surface answers POST only",
				405,
			);
		const body = await readJsonBody(request);
		if (path === AGENT_OTEL_QUERY_PATH)
			return ok(
				redactValue(
					await otelQuery(
						deps,
						owner,
						decodeRouteRequest<AgentOtelQuery>(path, body),
					),
				),
			);
		if (path === AGENT_DB_QUERY_PATH)
			return ok(
				redactValue(
					await dbQuery(
						deps,
						owner,
						decodeRouteRequest<AgentDbQuery>(path, body),
					),
				),
			);
		if (path === AGENT_HTTP_REQUEST_PATH)
			return ok(
				redactValue(
					await httpRequest(
						deps,
						owner,
						decodeRouteRequest<AgentHttpRequest>(path, body),
					),
				),
			);
		throw new DebugRouteError(
			"not-found",
			`unknown agent debug route ${path}`,
			404,
		);
	} catch (error) {
		const known =
			error instanceof DebugRouteError ||
			error instanceof TraceIndexError ||
			error instanceof DbQueryError ||
			error instanceof HttpRequestError;
		const status = known ? (error as { status: number }).status : 400;
		const code = known
			? (error as { code: string }).code
			: "debug-request-invalid";
		// The redactor runs over the message too: a connection string or a secret
		// a driver echoed must not reach the agent through an error.
		return json(
			{
				error: {
					code,
					message: redactValue(message(error)) as string,
				},
			},
			status,
		);
	}
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function ok(value: unknown): Response {
	return json({ ok: true, value });
}

// ---------------------------------------------------------------------------
// otel_query
// ---------------------------------------------------------------------------

function otelQuery(
	deps: DebugRouteDeps,
	owner: string,
	body: AgentOtelQuery,
): unknown {
	const index = deps.traceIndex;
	if (!index)
		throw new DebugRouteError(
			"trace-index-unavailable",
			"this server receives no telemetry, so no trace of this workflow is queryable",
			503,
		);
	const traceId = body.traceId?.trim();
	const app = body.app?.trim();
	const name = body.name?.trim();
	const severity = body.severity?.trim();
	const textBody = body.text?.trim();
	if (
		body.mode === "logs" ||
		(severity !== undefined && severity !== "") ||
		(textBody !== undefined && textBody !== "")
	) {
		// A log read is a read of the same receiver: the records are indexed by
		// the same `ac.owner`, and the answer says what it did not return
		// (`fix-env-tool-defects-from-e2e`).
		const logs = deps.logIndex;
		if (!logs)
			throw new DebugRouteError(
				"log-index-unavailable",
				"this server receives no telemetry, so no log line of this workflow is queryable",
				503,
			);
		return {
			mode: "logs",
			...logs.list(owner, {
				...(traceId === undefined || traceId === "" ? {} : { traceId }),
				...(severity === undefined || severity === "" ? {} : { severity }),
				...(textBody === undefined || textBody === ""
					? {}
					: { text: textBody }),
				...(body.since === undefined ? {} : { since: body.since }),
				...(body.limit === undefined ? {} : { limit: body.limit }),
			}),
		};
	}
	if (traceId !== undefined && traceId !== "") {
		const tree = index.tree(owner, traceId);
		if (!tree) {
			// A trace the index received and then dropped answers with its own code:
			// "the span tree is gone" and "this workflow never exported it" are two
			// different findings, and a caller that only sees `trace-unknown` for both
			// re-runs a request that is already lost.
			if (index.evictedTrace(owner, traceId))
				throw new DebugRouteError(
					"trace-evicted",
					`trace ${JSON.stringify(traceId)} was received for ${owner} and has since been evicted from this server's live index, which retains the newest ${MAX_INDEXED_TRACES} traces (background single-span traces first); list the traces again, or re-run the request and query it while it is quiet`,
					410,
				);
			throw new DebugRouteError(
				"trace-unknown",
				`no span of ${owner} was received for trace ${JSON.stringify(traceId)}; list the traces first to see which ones this workflow has`,
				404,
			);
		}
		return { mode: "tree", ...tree };
	}
	const http = body.http?.trim();
	const excludeNames = body.excludeNames?.trim();
	const rootKind = body.rootKind?.trim();
	return {
		mode: "list",
		...index.list(owner, {
			...(app === undefined || app === "" ? {} : { app }),
			...(body.since === undefined ? {} : { since: body.since }),
			...(body.status === undefined ? {} : { status: body.status }),
			...(name === undefined || name === "" ? {} : { name }),
			...(body.limit === undefined ? {} : { limit: body.limit }),
			...(body.minSpans === undefined ? {} : { minSpans: body.minSpans }),
			...(rootKind === undefined || rootKind === "" ? {} : { rootKind }),
			...(http === undefined || http === "" ? {} : { http }),
			...(excludeNames === undefined || excludeNames === ""
				? {}
				: { excludeNames }),
			...(body.includeNoise === undefined
				? {}
				: { includeNoise: body.includeNoise }),
		}),
	};
}

// ---------------------------------------------------------------------------
// db_query
// ---------------------------------------------------------------------------

async function dbQuery(
	deps: DebugRouteDeps,
	owner: string,
	body: AgentDbQuery,
): Promise<unknown> {
	const connection = await resolveConnection(deps, owner, body);
	const schema = body.schema?.trim();
	return runReadOnlyQuery(deps.sql ?? bunSqlPort, connection, {
		sql: body.sql,
		...(schema === undefined || schema === "" ? {} : { schema }),
		...(body.limit === undefined ? {} : { limit: body.limit }),
	});
}

/**
 * The connection of one query, and the precondition that makes it allowed: an
 * infra service that declares a query connection *and* an app this workflow
 * holds that requires it. A read is data access, so it is tied to holding the
 * app that uses that data, exactly like `env_start` ties a start to a slot.
 */
async function resolveConnection(
	deps: DebugRouteDeps,
	owner: string,
	body: AgentDbQuery,
): Promise<DbQueryConnection> {
	const ident = body.infra.trim();
	const service = (deps.infraServices?.() ?? []).find(
		(candidate) => candidate.ident === ident,
	);
	if (!service)
		throw new DebugRouteError(
			"infra-not-found",
			`infra ${JSON.stringify(ident)} not found in this environment`,
			404,
		);
	const query = service.query;
	if (!query)
		throw new DebugRouteError(
			"no-query-connection",
			`infra ${JSON.stringify(ident)} declares no query connection, so it is not queryable`,
			409,
		);
	const app = await requiredByHeldApp(deps, owner, ident);
	const read = (name: string) => deps.env?.(name) ?? configEnvValue(name);
	const user = read(query.userEnv);
	const password = read(query.passwordEnv);
	if (
		user === undefined ||
		user === "" ||
		password === undefined ||
		password === ""
	)
		throw new DebugRouteError(
			"credentials-missing",
			`the query connection of ${JSON.stringify(ident)} needs ${query.userEnv} and ${query.passwordEnv} in the configuration .env; the values are never echoed here`,
			409,
		);
	// Querying the data of the app this workflow holds is using that app, so the
	// idle reaper must not stop it out from under the run.
	deps.instances?.touchOwnedActivity(owner, app);
	return {
		kind: query.kind,
		host: query.host,
		port: query.port,
		database: query.database,
		user,
		password,
	};
}

/** The held app whose run target requires this infra, or a refusal naming why
 * no query is allowed. */
async function requiredByHeldApp(
	deps: DebugRouteDeps,
	owner: string,
	infra: string,
): Promise<string> {
	const instances = deps.instances;
	if (!instances)
		throw new DebugRouteError(
			"instances-unavailable",
			"the environment slot capability is not attached, so no held app can be checked",
			503,
		);
	const slots = await instances.slots();
	const held = slots.filter(
		(slot) => slot.holder === owner && slot.app.trim() !== "",
	);
	if (held.length === 0)
		throw new DebugRouteError(
			"app-not-held",
			`${owner} holds no app, and a query is allowed only through an app it holds; start the app that needs ${JSON.stringify(infra)} with env_start first`,
			409,
		);
	const discover = deps.discovery ?? discoverActionTargets;
	for (const slot of held) {
		const app = deps.apps?.getAppByIdent(slot.app);
		if (!app) continue;
		const checkout =
			owner === "user"
				? app.localDirectoryPath
				: await deps.resolveOwnerCheckout?.(owner as `workflow:${string}`, app);
		if (!checkout) continue;
		let targets: ActionTarget[];
		try {
			targets = discover({
				appIdent: app.ident,
				localDir: checkout,
				action: "run",
				configDir: deps.configDir ?? "",
			});
		} catch (error) {
			deps.logger?.(
				`[debug] discovering run targets of ${app.ident} failed: ${message(error)}`,
			);
			continue;
		}
		if (
			targets.some((target) =>
				(target.requires ?? []).some(
					(requirement) => requirement.infra === infra,
				),
			)
		)
			return slot.app;
	}
	throw new DebugRouteError(
		"infra-not-required",
		`no app ${owner} holds requires ${JSON.stringify(infra)}; a query is allowed only while the workflow holds the app that uses that infra`,
		409,
	);
}

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

/**
 * One call to an app endpoint this workflow holds.
 *
 * The endpoint is the same static export `env_start` reported and
 * `browser_open` resolves, held-checked the same way: an app another workflow
 * holds is refused by naming the holder, because the answer would otherwise be
 * that workflow's code answering.
 */
async function httpRequest(
	deps: DebugRouteDeps,
	owner: string,
	body: AgentHttpRequest,
): Promise<unknown> {
	const instances = deps.instances;
	if (!instances)
		throw new DebugRouteError(
			"instances-unavailable",
			"the environment slot capability is not attached, so no app endpoint can be resolved",
			503,
		);
	const app = body.app.trim();
	const endpoint = body.endpoint.trim();
	const slot = (await instances.slots()).find((entry) => entry.app === app);
	if (!slot)
		throw new DebugRouteError(
			"app-not-found",
			`app ${JSON.stringify(app)} not found`,
			404,
		);
	if (slot.holder !== owner)
		throw new DebugRouteError(
			"app-not-held",
			slot.holder
				? `${app} is held by ${slot.holder}; this run does not hold it, so its endpoint is not called. Stop it there, or start it here with env_start first.`
				: `${app} is not held by any workflow; start it first with env_start so this run holds it.`,
			409,
		);
	const base = slot.endpoints[endpoint];
	if (!base)
		throw new DebugRouteError(
			"endpoint-unknown",
			`${app} exports no endpoint ${JSON.stringify(endpoint)}; it exports ${Object.keys(slot.endpoints).join(", ") || "nothing"}`,
			404,
		);
	const result = await callEndpoint({
		url: endpointUrlOrRefuse(base, body.path),
		...(body.method === undefined ? {} : { method: body.method }),
		...(body.headers === undefined ? {} : { headers: body.headers }),
		...(body.body === undefined ? {} : { body: body.body }),
		...(deps.send === undefined ? {} : { send: deps.send }),
	});
	// Calling the app is using it: the idle reaper must not stop it mid-debug.
	instances.touchOwnedActivity(owner, app);
	return result;
}

/** `http.ts` owns the URL rules; this keeps the refusal a `DebugRouteError` so
 * the transport answers with the tool's own code. */
function endpointUrlOrRefuse(base: string, path: string | undefined): string {
	try {
		return endpointUrl(base, path);
	} catch (error) {
		if (error instanceof HttpRequestError)
			throw new DebugRouteError(error.code, error.message, error.status);
		throw error;
	}
}
