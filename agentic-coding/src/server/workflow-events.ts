// Pure workflow event derivation (add-orchestrator-event-subscriptions,
// task 1.3/1.4/1.5). No I/O, no timers, no store: one workflow view is
// projected to the small state the diff works on, two successive projections of
// the same workflow are diffed into catalog drafts, and a subscription filter is
// matched against a recorded event.
//
// The first observation of a workflow only records its projection (a workflow
// already waiting at plan approval when the server starts is the developer's
// situation, not news). Everything below compares two projections and keeps no
// history of its own, so an obligation that clears and returns produces a new
// event.
import {
	DEVELOPER_ABORT_MESSAGE,
	type EffectKind,
	type EffectStatus,
	type GateDecisionRecord,
	type RunStatus,
	type StartedBy,
	type WorkflowStatus,
	type WorkflowView,
} from "../contracts/workflow.ts";
import {
	boundedReasons,
	boundedSummary,
	DEFAULT_COALESCE_MS,
	DEFAULT_DIGEST_MINUTES,
	DEFAULT_MIN_NOTE_INTERVAL_MS,
	DEFAULT_SUBSCRIPTION_EVENT_IDS,
	DEFAULT_SUBSCRIPTION_ID,
	severityRank,
	type WorkflowEventCategory,
	type WorkflowEventId,
	type WorkflowEventPayload,
	type WorkflowEventRecord,
	type WorkflowEventSeverity,
	type WorkflowEventSubscription,
	type WorkflowEventSubscriptionFilter,
	type WorkflowReviewKind,
	workflowEventCategoryOf,
	workflowEventOrder,
	workflowEventSeverity,
} from "../contracts/workflow-events.ts";
import { reviewKindForStep } from "./orchestrator-policy.ts";

export interface WorkflowQuestionRef {
	readonly id: string;
	readonly role: string;
}

export interface WorkflowAnsweredQuestionRef extends WorkflowQuestionRef {
	readonly answeredBy: string;
	readonly kind: string;
}

export interface WorkflowRunRef {
	readonly id: string;
	readonly role: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly status: RunStatus;
	readonly model?: string;
}

export interface WorkflowEffectRef {
	readonly id: string;
	readonly kind: EffectKind;
	readonly status: EffectStatus;
	readonly attempts: number;
	readonly lastError?: string;
}

/** What a workflow looks like to the event diff. Deliberately small and fully
 * enumerable, so an event is a decision about two of these and nothing else. */
export interface WorkflowEventProjection {
	readonly status: WorkflowStatus;
	/** Who started the workflow, carried with the projection so an event the bus
	 * emits outside an observation (the stall tick) still reports the right
	 * owner. */
	readonly startedBy: StartedBy;
	/** The checkout the observation came from, carried so a consumer can release
	 * per-workflow state when the workflow disappears. */
	readonly worktree: string;
	readonly stepId: string;
	readonly stepLabel: string;
	readonly attempt: number;
	readonly review: WorkflowReviewKind | null;
	readonly attention: readonly string[];
	readonly pendingQuestions: readonly WorkflowQuestionRef[];
	readonly routedQuestions: readonly WorkflowQuestionRef[];
	readonly answeredQuestions: readonly WorkflowAnsweredQuestionRef[];
	readonly effects: readonly WorkflowEffectRef[];
	readonly runs: readonly WorkflowRunRef[];
	readonly gates: readonly GateDecisionRecord[];
	/** The OpenSpec progress last recorded for the workflow, when the artifact
	 * was readable. The one field carried across observations so a repeated read
	 * of an unchanged artifact emits nothing. */
	readonly openspec: { changeId: string; done: number; total: number } | null;
	/** How many compaction telemetry entries had been seen. */
	readonly compactionCount: number;
}

/** The optional enrichment of one observation: the bounded extra reads a few
 * events need (a committed verifier artifact, a run's own telemetry, the
 * change's tasks artifact). A missing or unreadable source yields nothing, so
 * the derivation emits no event instead of failing. */
export interface WorkflowEventEnrichment {
	readonly verification?: Readonly<
		Record<string, { critical: number; warning: number; info: number }>
	>;
	readonly compaction?: readonly {
		role: string;
		reason?: string;
		tokensBefore?: number;
		tokensAfter?: number;
	}[];
	readonly openspec?: { changeId: string; done: number; total: number } | null;
}

/** One derived event before the log gives it a sequence. */
export interface WorkflowEventDraft {
	readonly id: WorkflowEventId;
	readonly payload: WorkflowEventPayload;
}

export interface WorkflowEventDeriveContext {
	readonly repository: string;
	readonly workflowId: string;
	readonly at: string;
	readonly enrichment?: WorkflowEventEnrichment;
}

function questionRefs(
	records: readonly { id: string; role: string }[] | undefined,
): WorkflowQuestionRef[] {
	return (records ?? []).map((record) => ({
		id: record.id,
		role: record.role,
	}));
}

/** Project one workflow view. Pure: every field is read from the view, so two
 * views with the same relevant state project identically. */
export function projectWorkflowEvents(
	view: WorkflowView,
): WorkflowEventProjection {
	const stepId = view.currentStep?.id ?? "";
	return {
		status: view.status,
		startedBy: view.startedBy ?? "developer",
		worktree: view.worktree,
		stepId,
		stepLabel: view.currentStep?.label ?? stepId,
		attempt: view.currentStep?.attempt ?? 0,
		review: reviewKindForStep(stepId) ?? null,
		attention: [...(view.health?.attention ?? [])],
		pendingQuestions: questionRefs(view.pendingQuestions),
		routedQuestions: questionRefs(view.orchestratorQuestions),
		answeredQuestions: (view.developerDialogue ?? [])
			.filter((record) => record.status === "answered")
			.map((record) => ({
				id: record.id,
				role: record.role,
				answeredBy: record.targetRole ?? "developer",
				kind: record.answer?.kind ?? "custom",
			})),
		effects: (view.effects ?? []).map((effect) => ({
			id: effect.id,
			kind: effect.kind,
			status: effect.status,
			attempts: effect.attempts,
			...(effect.lastError ? { lastError: effect.lastError } : {}),
		})),
		runs: (view.runs ?? []).map((run) => ({
			id: run.id,
			role: run.role,
			stepId: run.stepId,
			attempt: run.attempt,
			status: run.status,
			...(run.model ? { model: run.model } : {}),
		})),
		gates: [...(view.gateDecisions ?? [])],
		openspec: null,
		compactionCount: 0,
	};
}

/** Apply what the enrichment learned to the projection, so the next diff sees
 * it as the baseline for that source. */
export function applyEnrichment(
	projection: WorkflowEventProjection,
	enrichment: WorkflowEventEnrichment | undefined,
): WorkflowEventProjection {
	if (!enrichment) return projection;
	return {
		...projection,
		openspec: enrichment.openspec ?? projection.openspec,
		compactionCount:
			enrichment.compaction?.length ?? projection.compactionCount,
	};
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
	"completed",
	"failed",
	"expired",
]);

const TERMINAL_EFFECT_STATUSES: ReadonlySet<EffectStatus> = new Set([
	"completed",
	"failed",
	"expired",
]);

const DELIVERY_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set([
	"delivery.commit",
	"delivery.push",
]);

function idsOf<T extends { id: string }>(items: readonly T[]): Set<string> {
	return new Set(items.map((item) => item.id));
}

/** The events from `previous` to `next`, in catalog order. An absent
 * `previous` is a first observation: the baseline is recorded, never reported. */
export function deriveWorkflowEvents(
	previous: WorkflowEventProjection | undefined,
	next: WorkflowEventProjection,
	context: WorkflowEventDeriveContext,
): WorkflowEventDraft[] {
	if (!previous) return [];
	const drafts: WorkflowEventDraft[] = [];
	const push = (id: WorkflowEventId, payload: WorkflowEventPayload): void => {
		drafts.push({ id, payload });
	};
	const step = { stepId: next.stepId, stepLabel: next.stepLabel };

	// -- workflow ------------------------------------------------------------
	if (previous.status !== next.status) {
		if (next.status === "attention-required")
			push("workflow.failed", {
				stepId: next.stepId,
				stepLabel: next.stepLabel,
				reasons: boundedReasons(next.attention),
			});
		else if (next.status === "completed")
			push("workflow.completed", { ...step });
		else if (next.status === "closed") push("workflow.closed", { ...step });
	}

	// -- attention -----------------------------------------------------------
	const statusEdge =
		previous.status !== "attention-required" &&
		next.status === "attention-required";
	const gained = next.attention.filter(
		(reason) => !previous.attention.includes(reason),
	);
	const lost = previous.attention.filter(
		(reason) => !next.attention.includes(reason),
	);
	// The status edge is reported as `workflow.failed` alone; the reasons ride
	// along there, so raising attention twice for one edge would be noise.
	if (!statusEdge && gained.length > 0)
		push("attention.raised", { reasons: boundedReasons(gained) });
	if (lost.length > 0)
		push("attention.cleared", { reasons: boundedReasons(lost) });

	// -- step ----------------------------------------------------------------
	if (previous.stepId !== next.stepId || previous.attempt !== next.attempt)
		push("step.entered", {
			stepId: next.stepId,
			stepLabel: next.stepLabel,
			attempt: next.attempt,
		});
	if (previous.stepId !== next.stepId)
		push("step.completed", {
			stepId: previous.stepId,
			stepLabel: previous.stepLabel,
			nextStepId: next.stepId,
			attempt: previous.attempt,
		});

	// -- review --------------------------------------------------------------
	if (previous.review === null && next.review !== null)
		push("review.waiting", {
			review: next.review,
			stepId: next.stepId,
			stepLabel: next.stepLabel,
		});
	if (previous.review !== null && next.review === null)
		push("review.resolved", {
			review: previous.review,
			stepId: previous.stepId,
			stepLabel: previous.stepLabel,
			nextStepId: next.stepId,
		});

	// -- questions -----------------------------------------------------------
	const pendingBefore = idsOf(previous.pendingQuestions);
	for (const question of next.pendingQuestions)
		if (!pendingBefore.has(question.id))
			push("question.pending", {
				questionId: question.id,
				role: question.role,
				stepId: next.stepId,
			});
	const routedBefore = idsOf(previous.routedQuestions);
	for (const question of next.routedQuestions)
		if (!routedBefore.has(question.id))
			push("question.routed", {
				questionId: question.id,
				role: question.role,
				stepId: next.stepId,
			});
	const answeredBefore = idsOf(previous.answeredQuestions);
	const stillPending = new Set([
		...next.pendingQuestions.map((question) => question.id),
		...next.routedQuestions.map((question) => question.id),
	]);
	for (const question of next.answeredQuestions) {
		if (answeredBefore.has(question.id) || stillPending.has(question.id))
			continue;
		// Only an obligation this observation saw earlier is "answered": a
		// question answered before the baseline is history, not news.
		const knownEarlier =
			pendingBefore.has(question.id) || routedBefore.has(question.id);
		if (!knownEarlier) continue;
		push("question.answered", {
			questionId: question.id,
			role: question.role,
			answeredBy: question.answeredBy,
			kind: question.kind,
		});
	}

	// -- runs ----------------------------------------------------------------
	const runsBefore = new Map(previous.runs.map((run) => [run.id, run]));
	for (const run of next.runs) {
		const before = runsBefore.get(run.id);
		if (!before) {
			push("run.started", {
				runId: run.id,
				role: run.role,
				stepId: run.stepId,
				attempt: run.attempt,
				...(run.model ? { model: run.model } : {}),
			});
			continue;
		}
		if (
			!TERMINAL_RUN_STATUSES.has(before.status) &&
			TERMINAL_RUN_STATUSES.has(run.status)
		)
			push("run.completed", {
				runId: run.id,
				role: run.role,
				stepId: run.stepId,
				status: run.status,
			});
		if (before.status !== "blocked" && run.status === "blocked")
			push(
				next.attention.includes(DEVELOPER_ABORT_MESSAGE)
					? "run.aborted"
					: "run.blocked",
				{ runId: run.id, role: run.role, stepId: run.stepId },
			);
		if (
			before.status !== "completed" &&
			run.status === "completed" &&
			run.stepId === "core.verification"
		) {
			const counts = context.enrichment?.verification?.[run.role] ?? {
				critical: 0,
				warning: 0,
				info: 0,
			};
			push("verification.finished", {
				role: run.role,
				round: run.attempt,
				counts,
			});
		}
	}

	// -- effects and delivery ------------------------------------------------
	const effectsBefore = new Map(
		previous.effects.map((effect) => [effect.id, effect]),
	);
	for (const effect of next.effects) {
		const before = effectsBefore.get(effect.id);
		if (!before || before.status === "failed" || effect.status !== "failed")
			continue;
		push("effect.failed", {
			effectId: effect.id,
			kind: effect.kind,
			attempts: effect.attempts,
			...(effect.lastError
				? { error: boundedSummary(effect.lastError, 256) }
				: {}),
		});
	}
	for (const effect of next.effects) {
		const before = effectsBefore.get(effect.id);
		if (
			!before ||
			TERMINAL_EFFECT_STATUSES.has(before.status) ||
			!TERMINAL_EFFECT_STATUSES.has(effect.status)
		)
			continue;
		if (DELIVERY_EFFECT_KINDS.has(effect.kind))
			push("delivery.push", {
				effectId: effect.id,
				kind: effect.kind,
				status: effect.status,
			});
		else if (effect.kind === "pull-request.create")
			push("pull-request.state", {
				effectId: effect.id,
				status: effect.status,
			});
	}

	// -- gates ---------------------------------------------------------------
	const gatesBefore = idsOf(previous.gates);
	for (const gate of next.gates) {
		if (gatesBefore.has(gate.id)) continue;
		push("gate.decided", {
			gateId: gate.id,
			stepId: gate.stepId,
			stage: gate.stage,
			policy: gate.policy,
			decision: gate.decision,
			forced: gate.forced,
		});
	}

	// -- compaction ----------------------------------------------------------
	const compaction = context.enrichment?.compaction ?? [];
	for (const entry of compaction.slice(previous.compactionCount))
		push("compaction", {
			// Both fields come from the run's own telemetry file, so both are bounded,
			// control-stripped and credential-masked before they are recorded.
			role: boundedSummary(entry.role, 64) ?? "",
			...(entry.reason ? { reason: boundedSummary(entry.reason, 128) } : {}),
			...(entry.tokensBefore !== undefined
				? { tokensBefore: entry.tokensBefore }
				: {}),
			...(entry.tokensAfter !== undefined
				? { tokensAfter: entry.tokensAfter }
				: {}),
		});

	// -- openspec progress ---------------------------------------------------
	const openspec = context.enrichment?.openspec;
	if (
		openspec &&
		(next.stepId !== previous.stepId || openspecChanged(previous, openspec))
	)
		push("openspec.task-progress", {
			changeId: openspec.changeId,
			done: openspec.done,
			total: openspec.total,
		});

	return orderDrafts(drafts);
}

function openspecChanged(
	previous: WorkflowEventProjection,
	next: { done: number; total: number },
): boolean {
	return (
		previous.openspec === null ||
		previous.openspec.done !== next.done ||
		previous.openspec.total !== next.total
	);
}

/** Stable catalog order: the events of one observation are reported in the
 * category order the catalog declares. */
export function orderDrafts(
	drafts: readonly WorkflowEventDraft[],
): WorkflowEventDraft[] {
	return [...drafts].sort(
		(a, b) => workflowEventOrder(a.id) - workflowEventOrder(b.id),
	);
}

/** Turn a draft into the recorded shape the log stores. */
export function recordFromDraft(
	draft: WorkflowEventDraft,
	input: {
		sequence: number;
		repository: string;
		workflowId: string;
		startedBy: WorkflowEventRecord["startedBy"];
		stepId: string;
		stepLabel: string;
		at: string;
	},
): WorkflowEventRecord {
	return {
		sequence: input.sequence,
		id: draft.id,
		repository: input.repository,
		workflowId: input.workflowId,
		startedBy: input.startedBy,
		stepId: input.stepId,
		stepLabel: input.stepLabel,
		severity: workflowEventSeverity(draft.id, draft.payload),
		humanNeeded: isHumanNeeded(draft.id),
		at: input.at,
		payload: draft.payload,
	};
}

function isHumanNeeded(id: WorkflowEventId): boolean {
	return id === "review.waiting" || id === "question.pending";
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function payloadStringArray(
	event: WorkflowEventRecord,
	key: string,
): readonly string[] {
	const value = event.payload[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function payloadString(event: WorkflowEventRecord, key: string): string {
	const value = event.payload[key];
	return typeof value === "string" ? value : "";
}

function includesAny(
	candidates: readonly string[],
	values: readonly string[],
): boolean {
	return candidates.some((candidate) => values.includes(candidate));
}

function reasonMatches(
	event: WorkflowEventRecord,
	reasons: readonly string[],
): boolean {
	const eventReasons = payloadStringArray(event, "reasons").map((reason) =>
		reason.toLowerCase(),
	);
	const error = payloadString(event, "error").toLowerCase();
	return reasons.some((wanted) => {
		const needle = wanted.toLowerCase();
		return (
			eventReasons.some((reason) => reason.includes(needle)) ||
			(error !== "" && error.includes(needle))
		);
	});
}

/** The event roles a role filter can name: the run role, or the role that asked
 * a question. */
function eventRoles(event: WorkflowEventRecord): readonly string[] {
	const role = payloadString(event, "role");
	return role === "" ? [] : [role];
}

/** Whether one recorded event satisfies a subscription filter. Filters are
 * conjunctive; an absent id/category/role list means "every event in scope". */
export function matchesSubscriptionFilter(
	filter: WorkflowEventSubscriptionFilter,
	event: WorkflowEventRecord,
): boolean {
	// An absent scope is the documented `mine` default, so a caller that narrows
	// only by ids can never widen itself into every workflow by accident.
	if ((filter.scope ?? "mine") === "mine" && event.startedBy !== "orchestrator")
		return false;
	if (filter.workflowIds && filter.workflowIds.length > 0) {
		if (!filter.workflowIds.includes(event.workflowId)) return false;
	}
	if (filter.repositories && filter.repositories.length > 0) {
		if (!filter.repositories.includes(event.repository)) return false;
	}
	if (filter.eventIds && filter.eventIds.length > 0) {
		if (!filter.eventIds.includes(event.id)) return false;
	}
	if (filter.categories && filter.categories.length > 0) {
		if (!filter.categories.includes(workflowEventCategoryOf(event.id)))
			return false;
	}
	if (filter.roles && filter.roles.length > 0) {
		if (!includesAny(eventRoles(event), filter.roles)) return false;
	}
	if (filter.reasons && filter.reasons.length > 0) {
		if (!reasonMatches(event, filter.reasons)) return false;
	}
	if (filter.minSeverity) {
		if (severityRank(event.severity) < severityRank(filter.minSeverity))
			return false;
	}
	return true;
}

/** The implicit subscription a session with no explicit one carries: exactly
 * the events the monitor delivered before this change, for the orchestrator's
 * own workflows, woken with the current cadence. */
export function defaultSubscription(input: {
	session: string;
	now: number;
	expiresAt: string;
}): WorkflowEventSubscription {
	return {
		id: DEFAULT_SUBSCRIPTION_ID,
		label: "default",
		reason: "the monitor's default delivery",
		session: input.session,
		createdAt: new Date(input.now).toISOString(),
		expiresAt: input.expiresAt,
		mode: "wake",
		filter: {
			scope: "mine",
			eventIds: [...DEFAULT_SUBSCRIPTION_EVENT_IDS],
		},
		coalesceMs: DEFAULT_COALESCE_MS,
		minIntervalMs: DEFAULT_MIN_NOTE_INTERVAL_MS,
		digestMinutes: DEFAULT_DIGEST_MINUTES,
		implicit: true,
	};
}

/** The catalog categories, re-exported so a filter validator can name them
 * without importing the contract table itself. */
export type { WorkflowEventCategory, WorkflowEventSeverity };
