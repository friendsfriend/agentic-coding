// Wire contracts for the unified Bun backend API (expose-unified-bun-backend,
// task 1.2). The server is the single owner of workflow application scopes,
// observations, telemetry and (later) event delivery; the TUI and CLI are
// typed clients.
//
// Every request/response shape is an Effect Schema, decoded through the same
// `decodeContract` helper the workflow layer uses, so a malformed or
// over-broad payload fails as a bounded structured error rather than reaching
// an operation. Secrets and capability tokens travel in headers, never in a
// body, query string or log line.
import { Schema } from "effect";
import { decodeContract } from "../workflow/schema.ts";

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

/** Who owns a path. `bun` paths are served in-process; `go` paths are private
 * delegated environment capabilities during the migration. */
export type RouteOwner = "bun" | "go";

export interface RouteOwnership {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly owner: RouteOwner;
	readonly domain:
		| "health"
		| "observe"
		| "workflow"
		| "telemetry"
		| "events"
		| "credentials"
		| "environment";
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
		path: "/api/v1/telemetry/snapshot",
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
		method: "GET",
		path: "/api/v1/environment/*",
		owner: "go",
		domain: "environment",
	},
	{
		method: "POST",
		path: "/api/v1/environment/*",
		owner: "go",
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
// Request/response schemas
// ---------------------------------------------------------------------------

const observedState = Schema.Unknown;
const localChange = Schema.Struct({
	oldPath: Schema.optional(Schema.String),
	newPath: Schema.String,
	linesAdded: Schema.Number,
	linesDeleted: Schema.Number,
	newFile: Schema.Boolean,
	deletedFile: Schema.Boolean,
	renamedFile: Schema.Boolean,
});

const observationSchema = Schema.Union(
	Schema.Struct({ kind: Schema.Literal("workflows") }),
	Schema.Struct({ kind: Schema.Literal("projects") }),
	Schema.Struct({
		kind: Schema.Literal("dashboard"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("artifacts"),
		state: observedState,
	}),
	Schema.Struct({
		kind: Schema.Literal("artifact-content"),
		state: observedState,
		artifact: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("wiki-changes"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("wiki-diff"),
		repo: Schema.String,
		workflowId: Schema.String,
		file: localChange,
	}),
	Schema.Struct({
		kind: Schema.Literal("local-changes"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("local-diff"),
		repo: Schema.String,
		workflowId: Schema.String,
		file: localChange,
	}),
	Schema.Struct({
		kind: Schema.Literal("verifier-findings"),
		repo: Schema.String,
		workflowId: Schema.String,
		role: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("verifier-report"),
		repo: Schema.String,
		workflowId: Schema.String,
		role: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("developer-review-findings"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("repair-preview"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("changes"), repo: Schema.String }),
);

export type ObservationRequest = typeof observationSchema.Type;

export const observeRequestSchema = Schema.Struct({
	observation: observationSchema,
});

export const workflowViewRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
});

export const workflowActionRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	actionId: Schema.String,
	input: Schema.optional(Schema.Unknown),
});

export const workflowStartRequestSchema = Schema.Struct({
	repo: Schema.String,
	ticket: Schema.optional(Schema.String),
	workflowId: Schema.String,
	task: Schema.optional(Schema.String),
	mode: Schema.String,
	workflowType: Schema.optional(Schema.String),
	preset: Schema.optional(Schema.String),
});

export const workflowRepairRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	targetStep: Schema.String,
	reason: Schema.optional(Schema.String),
});

export const workflowQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	questionId: Schema.String,
	answer: Schema.Unknown,
});

export const credentialRespondSchema = Schema.Struct({
	ownerId: Schema.String,
	interactionId: Schema.String,
	value: Schema.String,
});

export const reviewSaveRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	kind: Schema.Literal("developer", "plan", "wiki"),
	comments: Schema.Array(Schema.Unknown),
});

export const workflowExecuteRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.optional(Schema.String),
});

export const telemetryScanRequestSchema = Schema.Struct({
	repo: Schema.String,
});

export const telemetryPruneRequestSchema = Schema.Struct({
	days: Schema.optional(Schema.Number),
});

/** Managed-agent handoff across the transport (task 1.4/3.4): the CLI forwards
 * its authenticated caller environment and run capability; the server resolves
 * the run identity and the engine independently validates the capability, so
 * the instance session and the agent run remain distinct authorities. */
export const agentHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	outcome: Schema.Literal("complete", "blocked", "failed"),
	artifact: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
	drain: Schema.optional(Schema.Boolean),
});

/** Agent-config mutation: the payload is validated by the typed mutation
 * applier, which rejects unknown kinds and malformed profile/preset tables. */
export const agentsMutationRequestSchema = Schema.Struct({
	repository: Schema.optional(Schema.String),
	mutation: Schema.Unknown,
});

/** Managed-agent developer question across the transport. The request signal
 * bounds the wait; the engine validates the run capability. */
export const agentQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	input: Schema.Unknown,
	timeoutMs: Schema.optional(Schema.Number),
});

/** Managed researcher structured handoff across the transport. */
export const agentResearchHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	handoff: Schema.Unknown,
});

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
