// The typed workflow event catalog (add-orchestrator-event-subscriptions,
// task 1.1). One versioned table of stable event ids, each declaring its
// category, whether it owes the developer a decision and its bounded payload
// schema; plus the wire types for the recorded event, the subscription and the
// delivery frame.
//
// Every layer may import this module (contract layer, pure): it derives from
// nothing and imports no application layer. The derivation from real workflow
// state lives in `src/server/workflow-events.ts`; this file only fixes the
// vocabulary so the server, the shell, the CLI and the dashboard can never
// drift apart.
import { Schema } from "effect";
import { redactSecrets, type StartedBy } from "./workflow.ts";

/** Bumped whenever an id, a category or a payload shape changes. */
export const WORKFLOW_EVENT_CATALOG_VERSION = 2;

/** The category vocabulary, in the order events of one observation are
 * reported, so a note is deterministic. */
export const WORKFLOW_EVENT_CATEGORIES = [
	"workflow",
	"step",
	"review",
	"question",
	"attention",
	"run",
	"effect",
	"delivery",
	"verification",
	"compaction",
	"gate",
	"limit",
	"progress",
] as const;
export type WorkflowEventCategory = (typeof WORKFLOW_EVENT_CATEGORIES)[number];

/** The stable event id vocabulary. */
export const WORKFLOW_EVENT_IDS = [
	"workflow.started",
	"workflow.completed",
	"workflow.closed",
	"workflow.failed",
	"step.entered",
	"step.completed",
	"review.waiting",
	"review.resolved",
	"question.pending",
	"question.routed",
	"question.answered",
	"attention.raised",
	"attention.cleared",
	"run.started",
	"run.completed",
	"run.blocked",
	"run.aborted",
	"run.stalled",
	"effect.failed",
	"delivery.push",
	"pull-request.state",
	"verification.finished",
	"compaction",
	"gate.decided",
	"events.suppressed",
	"openspec.task-progress",
] as const;
export type WorkflowEventId = (typeof WORKFLOW_EVENT_IDS)[number];

/** What the four review kinds are called in an event payload. The step ids
 * themselves live in `src/server/orchestrator-policy.ts` (one table, derived
 * from it), so a review kind can never name a step the server does not treat
 * as a developer review. */
export const WORKFLOW_REVIEW_KINDS = [
	"plan",
	"developer",
	"findings",
	"wiki",
] as const;
export type WorkflowReviewKind = (typeof WORKFLOW_REVIEW_KINDS)[number];

/** How urgent an event is. `minSeverity` filters compare against this rank. */
export const WORKFLOW_EVENT_SEVERITIES = [
	"info",
	"warning",
	"critical",
] as const;
export type WorkflowEventSeverity = (typeof WORKFLOW_EVENT_SEVERITIES)[number];

export function severityRank(severity: WorkflowEventSeverity): number {
	return WORKFLOW_EVENT_SEVERITIES.indexOf(severity);
}

/** A payload is a bounded, secret-free summary: no credential, no raw
 * transcript, no task text beyond a bounded summary. */
export type WorkflowEventPayload = Readonly<Record<string, unknown>>;

/** The events that owe the developer a decision. They raise one shell
 * notification each whatever subscriptions exist, exactly as before this
 * change; nothing else notifies. */
export const HUMAN_NEEDED_EVENT_IDS = [
	"review.waiting",
	"question.pending",
] as const satisfies readonly WorkflowEventId[];

export function isHumanNeededEvent(id: WorkflowEventId): boolean {
	return (HUMAN_NEEDED_EVENT_IDS as readonly WorkflowEventId[]).includes(id);
}

export function isWorkflowEventId(value: unknown): value is WorkflowEventId {
	return (
		typeof value === "string" &&
		(WORKFLOW_EVENT_IDS as readonly string[]).includes(value)
	);
}

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

// The payload union cannot be expressed as one Effect Schema generic that
// still lines up with the per-id structs, so the table is typed by this alias.
// The table is declarative: the derivation in `src/server/workflow-events.ts` is
// the only producer of a payload, and every free-form string it records goes
// through `boundedSummary`/`boundedReasons` (bounded, control-stripped, and
// credential-masked); the delivery frame is decoded with
// `workflowEventDeliveryFrameSchema` before the shell reads it.
// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics do not line up with the per-id payload structs.
export type WorkflowEventPayloadSchema = Schema.Schema<any, any, never>;

const reasons = Schema.Array(Schema.String.pipe(Schema.maxLength(256)));

export const WORKFLOW_EVENT_PAYLOAD_SCHEMAS: Record<
	WorkflowEventId,
	WorkflowEventPayloadSchema
> = {
	"workflow.started": Schema.Struct({
		taskSummary: Schema.optional(Schema.String.pipe(Schema.maxLength(160))),
	}),
	"workflow.completed": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
	}),
	"workflow.closed": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
	}),
	"workflow.failed": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
		reasons,
	}),
	"step.entered": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
		attempt: Schema.Number,
	}),
	"step.completed": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
		nextStepId: Schema.String,
		attempt: Schema.Number,
	}),
	"review.waiting": Schema.Struct({
		review: Schema.String,
		stepId: Schema.String,
		stepLabel: Schema.String,
	}),
	"review.resolved": Schema.Struct({
		review: Schema.String,
		stepId: Schema.String,
		stepLabel: Schema.String,
		nextStepId: Schema.String,
	}),
	"question.pending": Schema.Struct({
		questionId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
	}),
	"question.routed": Schema.Struct({
		questionId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
	}),
	"question.answered": Schema.Struct({
		questionId: Schema.String,
		role: Schema.String,
		answeredBy: Schema.String,
		kind: Schema.String,
	}),
	"attention.raised": Schema.Struct({ reasons }),
	"attention.cleared": Schema.Struct({ reasons }),
	"run.started": Schema.Struct({
		runId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
		attempt: Schema.Number,
		model: Schema.optional(Schema.String),
	}),
	"run.completed": Schema.Struct({
		runId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
		status: Schema.String,
	}),
	"run.blocked": Schema.Struct({
		runId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
	}),
	"run.aborted": Schema.Struct({
		runId: Schema.String,
		role: Schema.String,
		stepId: Schema.String,
	}),
	"run.stalled": Schema.Struct({
		stepId: Schema.String,
		stepLabel: Schema.String,
		minutes: Schema.Number,
	}),
	"effect.failed": Schema.Struct({
		effectId: Schema.String,
		kind: Schema.String,
		attempts: Schema.Number,
		error: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
	}),
	"delivery.push": Schema.Struct({
		effectId: Schema.String,
		kind: Schema.String,
		status: Schema.String,
	}),
	"pull-request.state": Schema.Struct({
		effectId: Schema.String,
		status: Schema.String,
	}),
	"verification.finished": Schema.Struct({
		role: Schema.String,
		round: Schema.Number,
		counts: Schema.Struct({
			critical: Schema.Number,
			warning: Schema.Number,
			info: Schema.Number,
		}),
	}),
	compaction: Schema.Struct({
		role: Schema.String,
		reason: Schema.optional(Schema.String.pipe(Schema.maxLength(128))),
		tokensBefore: Schema.optional(Schema.Number),
		tokensAfter: Schema.optional(Schema.Number),
	}),
	"gate.decided": Schema.Struct({
		gateId: Schema.String,
		stepId: Schema.String,
		stage: Schema.String,
		policy: Schema.String,
		decision: Schema.String,
		forced: Schema.Boolean,
	}),
	// The bus's own rate limit tripping. Bounded by construction: a count, the one
	// workflow it applies to and the window the count belongs to.
	"events.suppressed": Schema.Struct({
		count: Schema.Number,
		workflowId: Schema.String,
		windowMs: Schema.Number,
	}),
	"openspec.task-progress": Schema.Struct({
		changeId: Schema.String,
		done: Schema.Number,
		total: Schema.Number,
	}),
};

/** One catalog entry: id, category, human-needed flag and payload schema. */
export interface WorkflowEventCatalogEntry {
	readonly id: WorkflowEventId;
	readonly category: WorkflowEventCategory;
	readonly humanNeeded: boolean;
	readonly payload: WorkflowEventPayloadSchema;
}

const CATEGORY_OF: Record<WorkflowEventId, WorkflowEventCategory> = {
	"workflow.started": "workflow",
	"workflow.completed": "workflow",
	"workflow.closed": "workflow",
	"workflow.failed": "workflow",
	"step.entered": "step",
	"step.completed": "step",
	"review.waiting": "review",
	"review.resolved": "review",
	"question.pending": "question",
	"question.routed": "question",
	"question.answered": "question",
	"attention.raised": "attention",
	"attention.cleared": "attention",
	"run.started": "run",
	"run.completed": "run",
	"run.blocked": "run",
	"run.aborted": "run",
	"run.stalled": "run",
	"effect.failed": "effect",
	"delivery.push": "delivery",
	"pull-request.state": "delivery",
	"verification.finished": "verification",
	compaction: "compaction",
	"gate.decided": "gate",
	"events.suppressed": "limit",
	"openspec.task-progress": "progress",
};

export const WORKFLOW_EVENT_CATALOG: readonly WorkflowEventCatalogEntry[] =
	WORKFLOW_EVENT_IDS.map((id) => ({
		id,
		category: CATEGORY_OF[id],
		humanNeeded: isHumanNeededEvent(id),
		payload: WORKFLOW_EVENT_PAYLOAD_SCHEMAS[id],
	}));

const CATALOG_BY_ID = new Map(
	WORKFLOW_EVENT_CATALOG.map((entry) => [entry.id, entry]),
);

export function workflowEventCatalogEntry(
	id: WorkflowEventId,
): WorkflowEventCatalogEntry {
	const entry = CATALOG_BY_ID.get(id);
	if (!entry) throw new Error(`unknown workflow event id: ${id}`);
	return entry;
}

export function workflowEventCategoryOf(
	id: WorkflowEventId,
): WorkflowEventCategory {
	return workflowEventCatalogEntry(id).category;
}

/** The catalog order rank of one event id, so the events of one observation
 * are reported in a stable order. */
export function workflowEventOrder(id: WorkflowEventId): number {
	return WORKFLOW_EVENT_CATEGORIES.indexOf(workflowEventCategoryOf(id));
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How many events the server retains; the oldest are evicted and the sequence
 * never restarts. */
export const EVENT_LOG_CAPACITY = 500;
/** The largest page `read_events` and `GET /api/v1/workflow/events` return. */
export const MAX_EVENT_PAGE = 200;
/** At most this many subscriptions per store. */
export const MAX_EVENT_SUBSCRIPTIONS = 20;
export const MAX_FILTER_WORKFLOW_IDS = 20;
export const MAX_FILTER_REPOSITORIES = 8;
export const MAX_FILTER_EVENT_IDS = 32;
export const MAX_FILTER_CATEGORIES = WORKFLOW_EVENT_CATEGORIES.length;
export const MAX_SUBSCRIPTION_LABEL_CHARS = 40;
export const MAX_SUBSCRIPTION_REASON_CHARS = 200;
/** A subscription must expire: a day by default, a month at most. */
export const DEFAULT_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SUBSCRIPTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Delivery bounds: a note lists at most this many event lines, the pending
 * backlog holds at most this many events and a session receives at most this
 * many notes in a trailing hour. */
export const MAX_NOTE_LINES = 20;
export const MAX_EVENT_BACKLOG = 200;
export const MAX_NOTES_PER_HOUR = 20;
/** The delivery cadences an absent override means. */
export const DEFAULT_COALESCE_MS = 10_000;
export const DEFAULT_MIN_NOTE_INTERVAL_MS = 60_000;
export const DEFAULT_DIGEST_MINUTES = 5;
/** The bus's own rate limit: at most `DEFAULT_MAX_EVENTS_PER_WINDOW` of one
 * workflow's events are recorded inside one window, and the remainder are dropped
 * with a single `events.suppressed` event reporting how many. Human-needed events
 * (a waiting review, a pending question) are never dropped. The window is
 * generous on purpose: one transition legitimately produces a handful of events,
 * and a storm produces thousands per second. */
export const DEFAULT_MAX_EVENTS_PER_WINDOW = 120;
export const DEFAULT_EVENT_WINDOW_MS = 10_000;
/** The implicit subscription that reproduces today's behaviour. */
export const DEFAULT_SUBSCRIPTION_ID = "default";
export const DEFAULT_SUBSCRIPTION_EVENT_IDS = [
	"review.waiting",
	"question.pending",
	"question.routed",
	"attention.raised",
	"workflow.failed",
	"effect.failed",
	"workflow.completed",
] as const satisfies readonly WorkflowEventId[];
/** A task summary in a payload is bounded and control-character-stripped. */
export const MAX_TASK_SUMMARY_CHARS = 160;

/** Bound and sanitize a free-form summary before it is recorded: control
 * characters are collapsed, credential-shaped values are masked, and the text
 * is truncated to `max`. */
export function boundedSummary(
	value: string | undefined,
	max = MAX_TASK_SUMMARY_CHARS,
): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = redactSecrets(value)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned === "") return undefined;
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Bound every entry of an attention-required reason list the same way a
 * summary is bounded: at most `max` reasons, each masked and truncated, with
 * the empty ones dropped. */
export function boundedReasons(
	reasons: readonly string[],
	max = 5,
): readonly string[] {
	return reasons
		.slice(0, max)
		.map((reason) => boundedSummary(reason, 256))
		.filter((reason): reason is string => reason !== undefined);
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface WorkflowEventRecord {
	readonly sequence: number;
	readonly id: WorkflowEventId;
	readonly repository: string;
	readonly workflowId: string;
	/** Who started the workflow the event belongs to, so a consumer can scope
	 * itself to its own work without a second read. */
	readonly startedBy: StartedBy;
	readonly stepId: string;
	readonly stepLabel: string;
	readonly severity: WorkflowEventSeverity;
	readonly humanNeeded: boolean;
	/** ISO instant the event was recorded. */
	readonly at: string;
	readonly payload: WorkflowEventPayload;
}

export const workflowEventRecordSchema = Schema.Struct({
	sequence: Schema.Number,
	id: Schema.String,
	repository: Schema.String,
	workflowId: Schema.String,
	startedBy: Schema.Literal("developer", "orchestrator"),
	stepId: Schema.String,
	stepLabel: Schema.String,
	severity: Schema.Literal("info", "warning", "critical"),
	humanNeeded: Schema.Boolean,
	at: Schema.String,
	payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export const WORKFLOW_EVENT_DELIVERY_MODES = [
	"wake",
	"digest",
	"silent",
] as const;
export type WorkflowEventDeliveryMode =
	(typeof WORKFLOW_EVENT_DELIVERY_MODES)[number];

export function isWorkflowEventDeliveryMode(
	value: unknown,
): value is WorkflowEventDeliveryMode {
	return (
		typeof value === "string" &&
		(WORKFLOW_EVENT_DELIVERY_MODES as readonly string[]).includes(value)
	);
}

export interface WorkflowEventSubscriptionFilter {
	/** `mine` = the workflows the orchestrator started; `all` = every workflow
	 * the observation surface returns. Absent reads as `mine`, the documented
	 * default. */
	readonly scope?: "mine" | "all";
	readonly workflowIds?: readonly string[];
	readonly repositories?: readonly string[];
	readonly eventIds?: readonly string[];
	readonly categories?: readonly string[];
	/** Attention-required reason substrings (advisory: the attention list is
	 * free-form, so this is a substring match). */
	readonly reasons?: readonly string[];
	readonly roles?: readonly string[];
	readonly minSeverity?: WorkflowEventSeverity;
}

export const workflowEventSubscriptionFilterSchema = Schema.Struct({
	scope: Schema.optional(Schema.Literal("mine", "all")),
	workflowIds: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(128))),
	),
	repositories: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(4096))),
	),
	eventIds: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(64))),
	),
	categories: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(32))),
	),
	reasons: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(256))),
	),
	roles: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.maxLength(128))),
	),
	minSeverity: Schema.optional(Schema.Literal("info", "warning", "critical")),
});

export interface WorkflowEventSubscription {
	readonly id: string;
	readonly label: string;
	readonly reason: string;
	/** The orchestrator session the subscription belongs to. */
	readonly session: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly mode: WorkflowEventDeliveryMode;
	readonly filter: WorkflowEventSubscriptionFilter;
	readonly lastDeliveredAt?: string;
	readonly coalesceMs?: number;
	readonly minIntervalMs?: number;
	readonly digestMinutes?: number;
	/** Expiry condition: the subscription is pruned once this workflow is
	 * `closed` or `completed`. */
	readonly untilWorkflowClosed?: string;
	/** Expiry condition: pruned once this many matching events were recorded. */
	readonly remainingEvents?: number;
	/** True for the synthesised default subscription. Never stored. */
	readonly implicit?: boolean;
}

export const workflowEventSubscriptionSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	reason: Schema.String,
	session: Schema.String,
	createdAt: Schema.String,
	expiresAt: Schema.String,
	mode: Schema.Literal("wake", "digest", "silent"),
	filter: workflowEventSubscriptionFilterSchema,
	lastDeliveredAt: Schema.optional(Schema.String),
	coalesceMs: Schema.optional(Schema.Number),
	minIntervalMs: Schema.optional(Schema.Number),
	digestMinutes: Schema.optional(Schema.Number),
	untilWorkflowClosed: Schema.optional(Schema.String),
	remainingEvents: Schema.optional(Schema.Number),
	implicit: Schema.optional(Schema.Boolean),
});

/** The `subscribe_events` request body. Everything but the filter is optional:
 * a subscription always gets a label, a reason, a mode and an expiry. */
export const workflowEventSubscribeRequestSchema = Schema.Struct({
	filter: workflowEventSubscriptionFilterSchema,
	label: Schema.String.pipe(Schema.maxLength(MAX_SUBSCRIPTION_LABEL_CHARS)),
	reason: Schema.optional(
		Schema.String.pipe(Schema.maxLength(MAX_SUBSCRIPTION_REASON_CHARS)),
	),
	mode: Schema.optional(Schema.Literal("wake", "digest", "silent")),
	expiresAt: Schema.optional(Schema.String),
	untilWorkflowClosed: Schema.optional(Schema.String),
	remainingEvents: Schema.optional(Schema.Number),
	coalesceMs: Schema.optional(Schema.Number),
	minIntervalMs: Schema.optional(Schema.Number),
	digestMinutes: Schema.optional(Schema.Number),
});

export type WorkflowEventSubscribeRequest =
	typeof workflowEventSubscribeRequestSchema.Type;

export const workflowEventUnsubscribeRequestSchema = Schema.Struct({
	subscriptionId: Schema.String.pipe(Schema.maxLength(128)),
});

export type WorkflowEventUnsubscribeRequest =
	typeof workflowEventUnsubscribeRequestSchema.Type;

/** One contribution of a delivery frame: which subscription matched, with the
 * label a note names and the cadence overrides that subscription declared, so
 * the shell's planner honours them. */
export interface WorkflowEventDeliveryMatch {
	readonly id: string;
	readonly label: string;
	readonly mode: WorkflowEventDeliveryMode;
	readonly coalesceMs?: number;
	readonly minIntervalMs?: number;
	readonly digestMinutes?: number;
}

export interface WorkflowEventDeliveryFrame {
	readonly event: WorkflowEventRecord;
	readonly subscriptions: readonly WorkflowEventDeliveryMatch[];
}

export const workflowEventDeliveryFrameSchema = Schema.Struct({
	event: workflowEventRecordSchema,
	subscriptions: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			label: Schema.String,
			mode: Schema.Literal("wake", "digest", "silent"),
			coalesceMs: Schema.optional(Schema.Number),
			minIntervalMs: Schema.optional(Schema.Number),
			digestMinutes: Schema.optional(Schema.Number),
		}),
	),
});

/** The bounded page `read_events` and the read route answer with. */
export interface WorkflowEventReadResult {
	readonly events: readonly WorkflowEventRecord[];
	/** The cursor to resume from. */
	readonly nextCursor: number;
	/** The oldest sequence still retained, so a caller can re-baseline. */
	readonly oldestSequence: number;
	/** True when the cursor predates the retained window: the answer carries no
	 * events of the gap, and the caller must re-baseline. */
	readonly cursorExpired?: boolean;
}

/** The subscription listing route's answer. */
export const workflowEventSubscriptionsResponseSchema = Schema.Struct({
	subscriptions: Schema.Array(workflowEventSubscriptionSchema),
});

/** Removal is idempotent: `removed` says whether a record was there. */
export const workflowEventUnsubscribeResponseSchema = Schema.Struct({
	removed: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function stringField(payload: WorkflowEventPayload, key: string): string {
	const value = payload[key];
	return typeof value === "string" ? value : "";
}

function reasonText(payload: WorkflowEventPayload): string {
	const value = payload.reasons;
	const list = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
	return list.length > 0 ? list.join("; ") : "unspecified";
}

/** One human-readable line body for an event: what changed, for which target.
 * The one table the note format and the tools' description read, so a new
 * catalog id cannot be described in two places. */
export function describeWorkflowEvent(record: WorkflowEventRecord): string {
	const payload = record.payload;
	switch (record.id) {
		case "workflow.started":
			return "workflow started";
		case "workflow.completed":
			return "completed";
		case "workflow.closed":
			return "closed";
		case "workflow.failed":
			return `attention required: ${reasonText(payload)}`;
		case "attention.raised":
			return `attention required: ${reasonText(payload)}`;
		case "attention.cleared":
			return `attention cleared: ${reasonText(payload)}`;
		case "step.entered":
			return "step entered";
		case "step.completed":
			return `step completed → ${stringField(payload, "nextStepId")}`;
		case "review.waiting":
			return `${reviewLabel(stringField(payload, "review"))} waiting`;
		case "review.resolved":
			return `${reviewLabel(stringField(payload, "review"))} resolved`;
		case "question.pending":
			return "developer question pending";
		case "question.routed":
			return "developer question routed to you — answer or forward it";
		case "question.answered":
			return "developer question answered";
		case "effect.failed":
			return `effect failed: ${stringField(payload, "kind")}`;
		case "delivery.push":
			return `delivery ${stringField(payload, "kind")} ${stringField(payload, "status")}`;
		case "pull-request.state":
			return `pull request ${stringField(payload, "status")}`;
		case "run.started":
			return `run started: ${stringField(payload, "role")}`;
		case "run.completed":
			return `run ${stringField(payload, "status")}: ${stringField(payload, "role")}`;
		case "run.blocked":
			return `run blocked: ${stringField(payload, "role")}`;
		case "run.aborted":
			return `run aborted by developer: ${stringField(payload, "role")}`;
		case "run.stalled":
			return `no progress for ${numberField(payload, "minutes")}m`;
		case "verification.finished": {
			const counts = payload.counts as
				| { critical?: number; warning?: number; info?: number }
				| undefined;
			return `verification round ${numberField(payload, "round")}: ${counts?.critical ?? 0} critical, ${counts?.warning ?? 0} warning, ${counts?.info ?? 0} info`;
		}
		case "compaction":
			return `compaction (${stringField(payload, "role")})`;
		case "gate.decided":
			return `gate ${stringField(payload, "gateId")} ${stringField(payload, "decision")}`;
		case "events.suppressed":
			return `${numberField(payload, "count")} events suppressed (${stringField(payload, "workflowId")}, ${numberField(payload, "windowMs")}ms window)`;
		case "openspec.task-progress":
			return `tasks ${numberField(payload, "done")}/${numberField(payload, "total")}`;
	}
}

function numberField(payload: WorkflowEventPayload, key: string): number {
	const value = payload[key];
	return typeof value === "number" ? value : 0;
}

/** The three review step labels a note and the tools use. The kind comes from
 * the payload, so the rendering never guesses from a step id. */
export function reviewLabel(review: string): string {
	switch (review) {
		case "plan":
			return "plan approval";
		case "wiki":
			return "wiki approval";
		case "findings":
			return "findings review";
		default:
			return "developer review";
	}
}

/** The severity a payload carries, derived from the event itself so the
 * `minSeverity` filter has one source. */
export function workflowEventSeverity(
	id: WorkflowEventId,
	payload: WorkflowEventPayload,
): WorkflowEventSeverity {
	switch (id) {
		case "workflow.failed":
		case "attention.raised":
		case "run.blocked":
		case "run.aborted":
		case "run.stalled":
		case "events.suppressed":
			return "warning";
		case "effect.failed": {
			const attempts = payload.attempts;
			return typeof attempts === "number" && attempts >= 3
				? "critical"
				: "warning";
		}
		case "verification.finished": {
			const counts = payload.counts as { critical?: number } | undefined;
			return (counts?.critical ?? 0) > 0 ? "critical" : "warning";
		}
		case "review.waiting":
		case "question.pending":
			return "warning";
		default:
			return "info";
	}
}
