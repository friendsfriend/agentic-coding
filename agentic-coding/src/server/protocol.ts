import type { Schema } from "effect";
import {
	agentHandoffRequestSchema,
	agentQuestionRequestSchema,
	agentResearchHandoffRequestSchema,
	agentsMutationRequestSchema,
	reviewSaveRequestSchema,
	workflowActionRequestSchema,
	workflowExecuteRequestSchema,
	workflowQuestionRequestSchema,
	workflowRepairRequestSchema,
	workflowStartRequestSchema,
} from "../contracts/actions.ts";
import { credentialRespondSchema } from "../contracts/credential.ts";
import { decodeContract } from "../contracts/decode.ts";
import {
	type ObservationRequest,
	observeRequestSchema,
} from "../contracts/environment.ts";
import {
	telemetryPruneRequestSchema,
	telemetryScanRequestSchema,
	telemetrySpansRequestSchema,
	telemetryTracesRequestSchema,
	telemetryWatchRequestSchema,
} from "../contracts/telemetry.ts";

/** Bumped whenever a breaking wire change lands; clients send it back. */
export const SERVER_API_VERSION = "v1";

/** Bounded request body (a single observation/diff can be a few MiB). */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Bounded textual path/argument length accepted from a client. */
export const MAX_PATH_CHARS = 4096;
/** Bounded event replay window retained per server instance. */
export const EVENT_REPLAY_CAPACITY = 512;
/** Bounded credential interaction lifetime. */
export const CREDENTIAL_TIMEOUT_MS = 120_000;

/** The retired mixed-runtime ownership values are gone: every versioned route is
 * served by this process, and `app.ts` rejects anything the manifest does not
 * cover. */
export type RouteOwner = "bun";

/** Ownership domains a route (or an observation kind) can belong to. */
export const ROUTE_DOMAINS = [
	"health",
	"observe",
	"workflow",
	"telemetry",
	"events",
	"credentials",
	"environment",
	"integrations",
	"git",
	"wiki",
	"herdr",
] as const;
export type RouteDomain = (typeof ROUTE_DOMAINS)[number];

export interface RouteOwnership {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly owner: RouteOwner;
	readonly domain: RouteDomain;
}

/** Static route ownership manifest (design decision 2): the server never
 * guesses an owner and a test can assert the split without a router framework. */
export const ROUTE_OWNERSHIP: readonly RouteOwnership[] = [
	{ method: "GET", path: "/api/v1/health", owner: "bun", domain: "health" },
	{ method: "POST", path: "/api/v1/observe", owner: "bun", domain: "observe" },
	{
		method: "GET",
		path: "/api/v1/workflow/view",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/action",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/start",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/repair",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/question",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/review-save",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/execute",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/handoff",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/question",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/research-handoff",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/config/agents",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: "/api/v1/config/agents",
		owner: "bun",
		domain: "workflow",
	},
	{ method: "GET", path: "/api/v1/events", owner: "bun", domain: "events" },
	{
		method: "GET",
		path: "/api/v1/telemetry/workspaces",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/traces",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/spans",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/watch",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/scan",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/prune",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/credentials/respond",
		owner: "bun",
		domain: "credentials",
	},
	{
		method: "POST",
		path: "/api/v1/environment/private/*",
		owner: "bun",
		domain: "environment",
	},
];

/** Resolve the owner of a method+path, longest prefix first so a wildcard
 * route never shadows an exact one. */
export function routeOwner(
	method: string,
	pathname: string,
): RouteOwnership | undefined {
	const normalized = method.toUpperCase();
	const matches = ROUTE_OWNERSHIP.filter((route) => {
		if (route.method !== normalized) return false;
		if (!route.path.includes("*")) return route.path === pathname;
		return pathname.startsWith(route.path.slice(0, route.path.indexOf("*")));
	});
	matches.sort((a, b) => b.path.length - a.path.length);
	return matches[0];
}

// ---------------------------------------------------------------------------
// Request-schema manifest
// ---------------------------------------------------------------------------
// The route's request contract lives here, not at the call site: a route whose
// body is not decoded through a contract schema cannot be registered, and a
// test can assert the manifest and the served routes agree.

export interface RouteRequestSchema {
	readonly path: string;
	/** Contract id used in decode diagnostics. */
	readonly schemaId: string;
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
	readonly schema: Schema.Schema<any, any, never>;
}

export const ROUTE_REQUESTS: readonly RouteRequestSchema[] = [
	{
		path: "/api/v1/observe",
		schemaId: "server.observe",
		schema: observeRequestSchema,
	},
	{
		path: "/api/v1/workflow/action",
		schemaId: "server.workflow.action",
		schema: workflowActionRequestSchema,
	},
	{
		path: "/api/v1/workflow/start",
		schemaId: "server.workflow.start",
		schema: workflowStartRequestSchema,
	},
	{
		path: "/api/v1/workflow/repair",
		schemaId: "server.workflow.repair",
		schema: workflowRepairRequestSchema,
	},
	{
		path: "/api/v1/workflow/question",
		schemaId: "server.workflow.question",
		schema: workflowQuestionRequestSchema,
	},
	{
		path: "/api/v1/workflow/review-save",
		schemaId: "server.workflow.review-save",
		schema: reviewSaveRequestSchema,
	},
	{
		path: "/api/v1/workflow/execute",
		schemaId: "server.workflow.execute",
		schema: workflowExecuteRequestSchema,
	},
	{
		path: "/api/v1/agent/handoff",
		schemaId: "server.agent.handoff",
		schema: agentHandoffRequestSchema,
	},
	{
		path: "/api/v1/agent/question",
		schemaId: "server.agent.question",
		schema: agentQuestionRequestSchema,
	},
	{
		path: "/api/v1/agent/research-handoff",
		schemaId: "server.agent.research-handoff",
		schema: agentResearchHandoffRequestSchema,
	},
	{
		path: "/api/v1/config/agents",
		schemaId: "server.config.agents",
		schema: agentsMutationRequestSchema,
	},
	{
		path: "/api/v1/credentials/respond",
		schemaId: "server.credentials.respond",
		schema: credentialRespondSchema,
	},
	{
		path: "/api/v1/telemetry/traces",
		schemaId: "server.telemetry.traces",
		schema: telemetryTracesRequestSchema,
	},
	{
		path: "/api/v1/telemetry/spans",
		schemaId: "server.telemetry.spans",
		schema: telemetrySpansRequestSchema,
	},
	{
		path: "/api/v1/telemetry/watch",
		schemaId: "server.telemetry.watch",
		schema: telemetryWatchRequestSchema,
	},
	{
		path: "/api/v1/telemetry/scan",
		schemaId: "server.telemetry.scan",
		schema: telemetryScanRequestSchema,
	},
	{
		path: "/api/v1/telemetry/prune",
		schemaId: "server.telemetry.prune",
		schema: telemetryPruneRequestSchema,
	},
];

/** Decode a route body through the schema the manifest declares for it. */
export function decodeRouteRequest<T>(path: string, value: unknown): T {
	const route = ROUTE_REQUESTS.find((entry) => entry.path === path);
	if (!route) throw new Error(`no request contract registered for ${path}`);
	return decodeRequest<T>(route.schemaId, route.schema, value);
}

// ---------------------------------------------------------------------------
// Observation ownership
// ---------------------------------------------------------------------------
// Git, wiki and Herdr reads travel as observation kinds on the versioned
// observe route; each kind names the ownership domain it belongs to, so a
// domain cannot be served without appearing in the manifest.

export interface ObservationOwnership {
	readonly kind: ObservationRequest["kind"];
	readonly domain: RouteDomain;
}

export const OBSERVATION_OWNERSHIP: readonly ObservationOwnership[] = [
	{ kind: "workflows", domain: "workflow" },
	{ kind: "projects", domain: "environment" },
	{ kind: "dashboard", domain: "workflow" },
	{ kind: "artifacts", domain: "workflow" },
	{ kind: "artifact-content", domain: "workflow" },
	{ kind: "wiki-changes", domain: "wiki" },
	{ kind: "wiki-diff", domain: "wiki" },
	{ kind: "local-changes", domain: "git" },
	{ kind: "local-diff", domain: "git" },
	{ kind: "changes", domain: "git" },
	{ kind: "verifier-findings", domain: "workflow" },
	{ kind: "verifier-report", domain: "workflow" },
	{ kind: "developer-review-findings", domain: "workflow" },
	{ kind: "repair-preview", domain: "workflow" },
];

/** Decode a request body through its schema, throwing `ContractFailure`.
 * `onExcessProperty: error` keeps an unknown field from being silently
 * ignored and smuggled past the typed boundary. */
export function decodeRequest<T>(
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
	schema: Schema.Schema<T, any, never>,
	value: unknown,
): T {
	return decodeContract<T>(id, schema, value, { onExcessProperty: "error" });
}
