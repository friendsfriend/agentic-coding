// Environment wire contract: the observation requests the dashboard sends and
// the state records it reads back. Pure schemas and types.
import { Schema } from "effect";
import { localChangeSchema } from "./integration.ts";

const observedState = Schema.Unknown;

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
		file: localChangeSchema,
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
		file: localChangeSchema,
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
	Schema.Struct({ kind: Schema.Literal("branches"), repo: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("sessions-report"),
		since: Schema.optional(Schema.String),
	}),
);

export type ObservationRequest = typeof observationSchema.Type;

// ---------------------------------------------------------------------------
// Observation requests
// ---------------------------------------------------------------------------

export const observeRequestSchema = Schema.Struct({
	observation: observationSchema,
});

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

const safeInstanceText = Schema.String.pipe(
	Schema.maxLength(512),
	Schema.filter((value) => !hasControlCharacters(value), {
		message: () => "control characters are not allowed",
	}),
);

export const acquireSlotsRequestSchema = Schema.Struct({
	owner: safeInstanceText.pipe(Schema.minLength(1)),
	apps: Schema.Array(safeInstanceText.pipe(Schema.minLength(1))).pipe(
		Schema.minItems(1),
		Schema.maxItems(16),
	),
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
	/** A bounded long poll: the tool layer re-polls, so one call never blocks
	 * longer than this. */
	waitSec: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isFinite(value) && value >= 0, {
				message: () => "waitSec must be a non-negative number",
			}),
			Schema.lessThanOrEqualTo(300),
		),
	),
	/** Narrow the runtime the owner asked for (`docker`, `shell`,
	 * `systemshell`); an unavailable one is refused rather than substituted. */
	runtime: Schema.optional(safeInstanceText),
});

/**
 * Body of the release/stop routes: both operations are app-scoped, so the path
 * alone names their subject. No `configOverlay` is accepted anywhere on this
 * surface: a request may never choose the configuration root the server
 * discovers and executes from (a row that already carries a reserved overlay
 * keeps it in storage). An empty struct alone would still accept fields, so the
 * filter is what makes the body strictly empty.
 */
export const appSlotOperationRequestSchema = Schema.Struct({}).pipe(
	Schema.filter((value) => Object.keys(value as object).length === 0, {
		message: () =>
			"this route takes no body fields; the app is named by the path",
	}),
);

/**
 * Body of the owner teardown route: a workflow's durable `environment.teardown`
 * effect names the owner whose apps it releases. The owner is the only input —
 * which apps an owner holds is the server's own state, never a request's claim.
 */
export const environmentTeardownRequestSchema = Schema.Struct({
	owner: safeInstanceText.pipe(Schema.minLength(1)),
});

/** What one owner teardown stopped, so the caller can record the release. */
export const environmentTeardownResultSchema = Schema.Struct({
	owner: Schema.String,
	apps: Schema.Array(Schema.String),
});

export type EnvironmentTeardownRequest =
	typeof environmentTeardownRequestSchema.Type;
export type EnvironmentTeardownResult =
	typeof environmentTeardownResultSchema.Type;

export type AcquireSlotsRequest = typeof acquireSlotsRequestSchema.Type;
export type AppSlotOperationRequest = typeof appSlotOperationRequestSchema.Type;

// ---------------------------------------------------------------------------
// Agent environment requests (`add-agent-environment-tools`)
// ---------------------------------------------------------------------------
// The bodies a durable run's `env_*` tools send. The owner is never a field:
// it comes from the capability the run presents (`environmentTokenFor`), so a
// request cannot name another workflow's apps.

const agentAppName = safeInstanceText.pipe(Schema.minLength(1));
/** How many apps one acquire may name, in the controller's own bound. */
export const MAX_AGENT_ENV_APPS = 16;

export const agentEnvironmentAcquireSchema = Schema.Struct({
	/** One app name, or a bounded list: the tool sends every app it needs in
	 * one call so the server can grant atomically and detect a deadlock. */
	apps: Schema.Union(
		agentAppName,
		Schema.Array(agentAppName).pipe(
			Schema.minItems(1),
			Schema.maxItems(MAX_AGENT_ENV_APPS),
		),
	),
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
	runtime: Schema.optional(safeInstanceText),
	waitSec: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isFinite(value) && value >= 0, {
				message: () => "waitSec must be a non-negative number",
			}),
			Schema.lessThanOrEqualTo(300),
		),
	),
});

export const agentEnvironmentAppSchema = Schema.Struct({
	app: agentAppName,
});

export const agentEnvironmentBuildSchema = Schema.Struct({
	app: agentAppName,
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
});

export type AgentEnvironmentAcquire = typeof agentEnvironmentAcquireSchema.Type;
export type AgentEnvironmentApp = typeof agentEnvironmentAppSchema.Type;
export type AgentEnvironmentBuild = typeof agentEnvironmentBuildSchema.Type;

// ---------------------------------------------------------------------------
// Dashboard session wire records: event envelopes, connection state, errors
// ---------------------------------------------------------------------------

/** One published domain event. `instance` + `sequence` make gaps detectable,
 * so a client can tell "nothing changed" from "I missed events". */
export interface EventEnvelope {
	readonly instance: string;
	/** Monotonic per-instance sequence; gaps are detectable. */
	readonly sequence: number;
	readonly domain: string;
	readonly kind: string;
	readonly resource?: string;
	readonly runId?: string;
	readonly revision?: number;
	readonly at: string;
	readonly payload: unknown;
}

/** Where a subscription resumes from; omitted means live-only. */
export interface SubscriptionCursor {
	readonly after?: number;
}

/** Connection state of the dashboard's backend port. `reconnecting` keeps the
 * last data on screen; `snapshotRequired` forces an authoritative refresh. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** Structured error a transport returns instead of an unstructured failure. */
export interface WireError {
	readonly code: string;
	readonly message: string;
	readonly detail?: string;
}

export const connectionStateSchema: Schema.Schema<ConnectionState> =
	Schema.Literal("connecting", "open", "reconnecting", "closed");

/** Bounded envelope: every field is length-checked so a hostile or buggy
 * publisher cannot push an unbounded string into the dashboard. */
export const dashboardEventSchema: Schema.Schema<EventEnvelope> = Schema.Struct(
	{
		instance: Schema.String.pipe(Schema.maxLength(128)),
		sequence: Schema.Number.pipe(
			Schema.filter((n) => Number.isInteger(n) && n >= 0, {
				message: () => "expected integer >= 0",
			}),
		),
		domain: Schema.String.pipe(Schema.maxLength(64)),
		kind: Schema.String.pipe(Schema.maxLength(128)),
		resource: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
		runId: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
		revision: Schema.optional(
			Schema.Number.pipe(
				Schema.filter((n) => Number.isInteger(n) && n >= 0, {
					message: () => "expected integer >= 0",
				}),
			),
		),
		at: Schema.String.pipe(Schema.maxLength(64)),
		payload: Schema.Unknown,
	},
);

export const wireErrorSchema: Schema.Schema<WireError> = Schema.Struct({
	code: Schema.String.pipe(Schema.maxLength(64)),
	message: Schema.String.pipe(Schema.maxLength(512)),
	detail: Schema.optional(Schema.String.pipe(Schema.maxLength(2048))),
});

/** Every JSON response is one of these two shapes: a value, or a structured
 * error. Decoding it at the client boundary keeps a malformed body from being
 * mistaken for data. */
export const wireEnvelopeSchema = Schema.Union(
	Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
	Schema.Struct({ ok: Schema.Literal(false), error: wireErrorSchema }),
);

/** Decoded request type for `observeRequestSchema`. */
export type ObserveRequest = typeof observeRequestSchema.Type;
