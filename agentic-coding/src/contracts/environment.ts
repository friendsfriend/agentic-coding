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
);

export type ObservationRequest = typeof observationSchema.Type;

// ---------------------------------------------------------------------------
// Observation requests
// ---------------------------------------------------------------------------

export const observeRequestSchema = Schema.Struct({
	observation: observationSchema,
});

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
