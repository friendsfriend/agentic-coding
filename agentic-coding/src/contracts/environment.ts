// Environment wire contract: the observation requests the dashboard sends and
// the state records it reads back. Pure schemas and types.
import { Effect, Schema } from "effect";
import { localChangeSchema } from "./integration.ts";

const observedState = Schema.Unknown;

const observationSchema = Schema.Union([
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
		kind: Schema.Literal("setup-changes"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("setup-diff"),
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
	Schema.Struct({
		kind: Schema.Literal("openspec-changes"),
		repo: Schema.String,
		limit: Schema.optional(Schema.Int),
	}),
	Schema.Struct({ kind: Schema.Literal("workflow-targets") }),
	Schema.Struct({ kind: Schema.Literal("branches"), repo: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("evidence"),
		repo: Schema.String,
		workflowId: Schema.String,
		/** Narrow the manifest to one debug request's entries. */
		requestId: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("debug-requests"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("stage-journal"),
		repo: Schema.String,
		workflowId: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("sessions-report"),
		since: Schema.optional(Schema.String),
	}),
]);

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
	Schema.check(Schema.isMaxLength(512)),
	Schema.check(
		Schema.makeFilter((value) => !hasControlCharacters(value), {
			message: "control characters are not allowed",
		}),
	),
);

export const acquireSlotsRequestSchema = Schema.Struct({
	owner: safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	apps: Schema.Array(
		safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	).pipe(
		Schema.check(Schema.isMinLength(1)),
		Schema.check(Schema.isMaxLength(16)),
	),
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
	/** A bounded long poll: the tool layer re-polls, so one call never blocks
	 * longer than this. */
	waitSec: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isFinite(value) && value >= 0, {
					message: "waitSec must be a non-negative number",
				}),
			),
			Schema.check(Schema.isLessThanOrEqualTo(300)),
		),
	),
	/** Narrow the runtime the owner asked for (`docker`, `shell`,
	 * `systemshell`, `kubernetes`); an unavailable one is refused rather than
	 * substituted. */
	runtime: Schema.optional(safeInstanceText),
	/** Replica count of a Kubernetes start (`add-kubernetes-run-replicas`):
	 * applied through the target's Helm value path, and refused for any other
	 * runtime rather than silently started as a single copy. */
	replicas: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isInteger(value) && value >= 1, {
					message: "replicas must be an integer of at least 1",
				}),
			),
			Schema.check(Schema.isLessThanOrEqualTo(100)),
		),
	),
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
	Schema.check(
		Schema.makeFilter((value) => Object.keys(value as object).length === 0, {
			message: "this route takes no body fields; the app is named by the path",
		}),
	),
);

/**
 * Body of the workflow-API build/test route: the *workflow runtime* is the
 * caller (not an agent capability), exactly as with `acquire`, so the owner and
 * the app are named by the request and the server resolves the owner's own
 * configuration view and checkout for them. `staged-env-setup-config-root` uses
 * it so the validation gate can run the real `env_build`/`env_test` path against
 * the staged configuration root.
 */
export const environmentOwnerActionRequestSchema = Schema.Struct({
	owner: safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	app: safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	action: Schema.Literals(["build", "test"]),
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
});

export type EnvironmentOwnerActionRequest =
	typeof environmentOwnerActionRequestSchema.Type;

export const environmentOwnerActionResultSchema = Schema.Struct({
	owner: Schema.String,
	app: Schema.String,
	action: Schema.String,
	status: Schema.String,
	targetId: Schema.String,
	runtime: Schema.String,
	exitCode: Schema.Union([Schema.Number, Schema.Null]),
	output: Schema.String,
	truncated: Schema.Boolean,
	error: Schema.optional(Schema.String),
});

export type EnvironmentOwnerActionResult =
	typeof environmentOwnerActionResultSchema.Type;

/**
 * Body of the owner teardown route: a workflow's durable `environment.teardown`
 * effect names the owner whose apps it releases. The owner is the only input —
 * which apps an owner holds is the server's own state, never a request's claim.
 */
export const environmentTeardownRequestSchema = Schema.Struct({
	owner: safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
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

/**
 * The slot controller's acquire answer as the client reports it: a grant, a
 * wait (with the position and holder per app), a developer release or a
 * deadlock. The record stays open — the answer carries the started instance's
 * endpoints and grant id, and a caller reads the fields it needs — so this is
 * a shape check, not a second copy of the controller's type.
 */
export const acquireSlotsResultSchema = Schema.Record(
	Schema.String,
	Schema.Unknown,
);

// ---------------------------------------------------------------------------
// Agent environment requests (`add-agent-environment-tools`)
// ---------------------------------------------------------------------------
// The bodies a durable run's `env_*` tools send. The owner is never a field:
// it comes from the capability the run presents (`environmentTokenFor`), so a
// request cannot name another workflow's apps.

const agentAppName = safeInstanceText.pipe(Schema.check(Schema.isMinLength(1)));
/** How many apps one acquire may name, in the controller's own bound. */
export const MAX_AGENT_ENV_APPS = 16;

export const agentEnvironmentAcquireSchema = Schema.Struct({
	/** One app name, or a bounded list: the tool sends every app it needs in
	 * one call so the server can grant atomically and detect a deadlock. */
	apps: Schema.Union([
		agentAppName,
		Schema.Array(agentAppName).pipe(
			Schema.check(Schema.isMinLength(1)),
			Schema.check(Schema.isMaxLength(MAX_AGENT_ENV_APPS)),
		),
	]),
	target: Schema.optional(safeInstanceText),
	profile: Schema.optional(safeInstanceText),
	runtime: Schema.optional(safeInstanceText),
	/** The replica count of a Kubernetes run; the server refuses it for any other
	 * runtime, so a request that needs concurrency is never silently started
	 * once. */
	replicas: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isInteger(value) && value >= 1, {
					message: "replicas must be an integer of at least 1",
				}),
			),
			Schema.check(Schema.isLessThanOrEqualTo(100)),
		),
	),
	waitSec: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isFinite(value) && value >= 0, {
					message: "waitSec must be a non-negative number",
				}),
			),
			Schema.check(Schema.isLessThanOrEqualTo(300)),
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
// Agent debug requests (`add-agent-debug-tools`)
// ---------------------------------------------------------------------------
// The bodies the `otel_query`, `db_query` and `http_request` tools send. Like
// the environment bodies, the workflow is not a field: the capability the run
// presents names it, so a query can only ever read this workflow's own runs,
// data and endpoints.

/** Multi-line free text (a SQL statement, a request body): bounded by length,
 * with every control character but newline, carriage return and tab refused. */
const agentFreeText = (max: number) =>
	Schema.String.pipe(
		Schema.check(Schema.isMaxLength(max)),
		Schema.check(
			Schema.makeFilter(
				(value) => {
					for (let index = 0; index < value.length; index++) {
						const code = value.charCodeAt(index);
						if (code === 0x0a || code === 0x09 || code === 0x0d) continue;
						if (code < 0x20 || code === 0x7f) return false;
					}
					return true;
				},
				{ message: "control characters are not allowed" },
			),
		),
	);

const agentLimit = (max: number) =>
	Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter(
					(value) => Number.isInteger(value) && value >= 1 && value <= max,
					{ message: `limit must be an integer between 1 and ${max}` },
				),
			),
		),
	);

/** `otel_query`: a bounded trace list, or one trace's span tree when a
 * `traceId` names it. The owner comes from the capability, never the body. */
export const agentOtelQuerySchema = Schema.Struct({
	/** `traces` (the default) or the log records of the same runs. */
	mode: Schema.optional(Schema.Literals(["traces", "logs"])),
	app: Schema.optional(agentAppName),
	since: Schema.optional(safeInstanceText),
	status: Schema.optional(Schema.Literals(["all", "error", "success"])),
	name: Schema.optional(safeInstanceText),
	traceId: Schema.optional(safeInstanceText),
	/** Trace-list filters: a minimum span count, the root span's kind, an HTTP
	 * route the root names, names to exclude, and whether the single-span
	 * background traces are ranked with the rest. */
	minSpans: agentLimit(500),
	rootKind: Schema.optional(safeInstanceText),
	http: Schema.optional(safeInstanceText),
	excludeNames: Schema.optional(safeInstanceText),
	includeNoise: Schema.optional(Schema.Boolean),
	/** Log filters: a severity substring and a substring of body/attributes. */
	severity: Schema.optional(safeInstanceText),
	text: Schema.optional(agentFreeText(500)),
	limit: agentLimit(200),
});

/** `db_query`: one read-only statement against an infra service whose declared
 * query connection a held app requires. */
export const agentDbQuerySchema = Schema.Struct({
	infra: agentAppName,
	sql: agentFreeText(20_000).pipe(Schema.check(Schema.isMinLength(1))),
	schema: Schema.optional(safeInstanceText),
	limit: agentLimit(200),
});

/** `http_request`: one call to a static endpoint of an app this workflow
 * holds. */
export const agentHttpRequestSchema = Schema.Struct({
	app: agentAppName,
	endpoint: agentAppName,
	method: Schema.optional(
		Schema.Literals([
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"OPTIONS",
		]),
	),
	path: Schema.optional(safeInstanceText),
	headers: Schema.optional(
		Schema.Array(
			Schema.Struct({
				name: safeInstanceText.pipe(Schema.check(Schema.isMaxLength(128))),
				value: agentFreeText(4096),
			}),
		).pipe(Schema.check(Schema.isMaxLength(32))),
	),
	body: Schema.optional(agentFreeText(65_536)),
});

export type AgentOtelQuery = typeof agentOtelQuerySchema.Type;
export type AgentDbQuery = typeof agentDbQuerySchema.Type;
export type AgentHttpRequest = typeof agentHttpRequestSchema.Type;

// ---------------------------------------------------------------------------
// Evidence store (`add-workflow-evidence-store`)
// ---------------------------------------------------------------------------
// The manifest entry, the attach body and the manifest a reader gets back.
// Every text field is length-checked so an agent-supplied caption or URL can
// never become an unbounded manifest.

/** The evidence kinds one entry may declare. */
export const EVIDENCE_KINDS = [
	"screenshot",
	"video",
	"trace",
	"script",
	"log",
	"other",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const evidenceKindSchema: Schema.Codec<EvidenceKind> =
	Schema.Literals(EVIDENCE_KINDS);

/** The caption and short metadata fields, bounded and control-character free. */
const evidenceText = (max: number) =>
	safeInstanceText.pipe(Schema.check(Schema.isMaxLength(max)));

/** One recorded piece of evidence. `file` is relative to the workflow's
 * evidence root and always inside it (`[req-<requestId>/]<id>.<ext>`). */
export const evidenceEntrySchema = Schema.Struct({
	id: evidenceText(64),
	kind: evidenceKindSchema,
	file: evidenceText(512),
	/** Empty is allowed: an entry without a caption is still listed. */
	caption: evidenceText(512),
	createdAt: evidenceText(64),
	step: Schema.optional(evidenceText(128)),
	role: Schema.optional(evidenceText(128)),
	app: Schema.optional(evidenceText(256)),
	/** Where the evidence came from (the page or endpoint a trace describes). */
	url: Schema.optional(evidenceText(2048)),
	/** The screenshot entry showing a video's final frame. */
	poster: Schema.optional(evidenceText(64)),
	/** Bytes on disk, so the workflow's quota is answerable from the manifest. */
	bytes: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isInteger(value) && value >= 0, {
					message: "expected integer >= 0",
				}),
			),
		),
	),
	/** Pinned evidence is kept by any future prune and is not charged against
	 * the workflow's cap. */
	pinned: Schema.optional(Schema.Boolean),
	/** This entry is the workflow's markdown report (`evidence-summary-subview`).
	 * The newest flagged entry is the effective report; a manifest written before
	 * the flag existed reads exactly as before, so the manifest version is
	 * unchanged. */
	report: Schema.optional(Schema.Boolean),
	/** The flow segment a kept recording belongs to (`add-stage-flow-evidence`):
	 * journal steps of that segment link to this video at their own offset. */
	segment: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isInteger(value) && value > 0, {
					message: "expected a positive integer segment",
				}),
			),
		),
	),
});
export type EvidenceEntry = typeof evidenceEntrySchema.Type;

/** What one workflow's (or one debug request's) manifest holds. */
export const evidenceManifestSchema = Schema.Struct({
	workflowId: evidenceText(80),
	requestId: Schema.optional(evidenceText(64)),
	entries: Schema.Array(evidenceEntrySchema),
	/** Non-pinned bytes recorded, and the cap they are measured against. */
	bytes: Schema.Number.pipe(
		Schema.check(
			Schema.makeFilter((value) => Number.isFinite(value) && value >= 0, {
				message: "expected a non-negative number",
			}),
		),
	),
	quotaBytes: Schema.Number.pipe(
		Schema.check(
			Schema.makeFilter((value) => Number.isFinite(value) && value >= 0, {
				message: "expected a non-negative number",
			}),
		),
	),
});
export type EvidenceManifest = typeof evidenceManifestSchema.Type;

/** One delegated debug request as the dashboard reads it
 * (add-debug-subagent-requests): the durable row, the report text the debug run
 * produced, and the evidence filed under the request. Read-only: the view
 * offers navigation and opening files, never an action. */
export const debugRequestStatusSchema = Schema.Literals([
	"queued",
	"running",
	"done",
	"failed",
	"cancelled",
]);
export const debugRequestViewSchema = Schema.Struct({
	id: evidenceText(64),
	status: debugRequestStatusSchema,
	callerRole: evidenceText(128),
	callerRunId: evidenceText(128),
	goal: evidenceText(4096),
	context: Schema.optional(evidenceText(16384)),
	createdAt: evidenceText(64),
	finishedAt: Schema.optional(evidenceText(64)),
	durationSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((value) => Number.isFinite(value) && value >= 0, {
					message: "expected a non-negative number",
				}),
			),
		),
	),
	reportPath: Schema.optional(evidenceText(4096)),
	/** The report markdown, when the request produced one. */
	report: Schema.optional(evidenceText(200_000)),
	changedFiles: Schema.Array(evidenceText(1024)),
	/** Whether the changed-file list could measure tracked changes at all. */
	baseline: Schema.Literals(["usable", "unavailable"]),
	delivered: Schema.Boolean,
	/** The request's own evidence entries, filtered from the workflow manifest. */
	evidence: Schema.Array(evidenceEntrySchema),
});
export type DebugRequestView = typeof debugRequestViewSchema.Type;

export const debugRequestsSchema = Schema.Struct({
	workflowId: evidenceText(80),
	requests: Schema.Array(debugRequestViewSchema),
});
export type DebugRequests = typeof debugRequestsSchema.Type;

/** Body of an attach: a file the caller produced, and the caption it carries.
 * `path` is an absolute path the server resolves and re-checks against the
 * workflow's own roots; it is never accepted as the destination. */
export const evidenceAttachRequestSchema = Schema.Struct({
	path: safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	kind: evidenceKindSchema,
	caption: evidenceText(512),
	/** The debug request this evidence belongs to, when it belongs to one. */
	requestId: Schema.optional(
		safeInstanceText.pipe(Schema.check(Schema.isMinLength(1))),
	),
	step: Schema.optional(evidenceText(128)),
	role: Schema.optional(evidenceText(128)),
	app: Schema.optional(evidenceText(256)),
	url: Schema.optional(evidenceText(2048)),
	poster: Schema.optional(evidenceText(64)),
	pinned: Schema.optional(Schema.Boolean),
	/** Flag this entry as the workflow's report: `other` kind, `md`/`markdown`
	 * text. The store refuses anything else under this flag. */
	report: Schema.optional(Schema.Boolean),
});
export type EvidenceAttachRequest = typeof evidenceAttachRequestSchema.Type;

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

export const connectionStateSchema: Schema.Codec<ConnectionState> =
	Schema.Literals(["connecting", "open", "reconnecting", "closed"]);

/** Bounded envelope: every field is length-checked so a hostile or buggy
 * publisher cannot push an unbounded string into the dashboard. */
export const dashboardEventSchema: Schema.Codec<EventEnvelope, unknown> =
	Schema.Struct({
		instance: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
		sequence: Schema.Number.pipe(
			Schema.check(
				Schema.makeFilter((n) => Number.isInteger(n) && n >= 0, {
					message: "expected integer >= 0",
				}),
			),
		),
		domain: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
		kind: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
		resource: Schema.optional(
			Schema.String.pipe(Schema.check(Schema.isMaxLength(512))),
		),
		runId: Schema.optional(
			Schema.String.pipe(Schema.check(Schema.isMaxLength(512))),
		),
		revision: Schema.optional(
			Schema.Number.pipe(
				Schema.check(
					Schema.makeFilter((n) => Number.isInteger(n) && n >= 0, {
						message: "expected integer >= 0",
					}),
				),
			),
		),
		at: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
		payload: Schema.Unknown.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed(undefined)),
		),
	});

export const wireErrorSchema: Schema.Codec<WireError> = Schema.Struct({
	code: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
	message: Schema.String.pipe(Schema.check(Schema.isMaxLength(512))),
	detail: Schema.optional(
		Schema.String.pipe(Schema.check(Schema.isMaxLength(2048))),
	),
});

/** Every JSON response is one of these two shapes: a value, or a structured
 * error. Decoding it at the client boundary keeps a malformed body from being
 * mistaken for data. */
export const wireEnvelopeSchema = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
	Schema.Struct({ ok: Schema.Literal(false), error: wireErrorSchema }),
]);

/** Decoded request type for `observeRequestSchema`. */
export type ObserveRequest = typeof observeRequestSchema.Type;
