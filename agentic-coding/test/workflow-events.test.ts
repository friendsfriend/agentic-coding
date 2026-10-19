// Workflow event catalog, derivation and filter matcher
// (add-orchestrator-event-subscriptions, tasks 1.1-1.5). Pure: synthetic
// projections in, catalog drafts out.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	DEFAULT_SUBSCRIPTION_DIGEST_MINUTES,
	DEFAULT_SUBSCRIPTION_EVENT_IDS,
	HUMAN_NEEDED_EVENT_IDS,
	isHumanNeededEvent,
	WORKFLOW_EVENT_CATALOG,
	WORKFLOW_EVENT_CATALOG_VERSION,
	WORKFLOW_EVENT_IDS,
	type WorkflowEventId,
	type WorkflowEventRecord,
	workflowEventCatalogEntry,
	workflowEventSeverity,
} from "../src/contracts/workflow-events.ts";
import {
	defaultSubscription,
	deriveWorkflowEvents,
	filterNamesEvent,
	matchesSubscriptionFilter,
	projectWorkflowEvents,
	type WorkflowEventDraft,
	type WorkflowEventEnrichment,
} from "../src/server/workflow-events.ts";

function view(overrides: {
	workflowId?: string;
	status?: WorkflowView["status"];
	step?: string;
	attempt?: number;
	startedBy?: WorkflowView["startedBy"];
	effects?: WorkflowView["effects"];
	runs?: WorkflowView["runs"];
	attention?: string[];
	pendingQuestions?: Array<{ id: string; role: string; kind?: string }>;
	orchestratorQuestions?: Array<{ id: string; role: string }>;
	developerDialogue?: Array<{
		id: string;
		role: string;
		status: string;
		targetRole?: string;
		answer?: { kind: string; value?: string };
	}>;
	gateDecisions?: WorkflowView["gateDecisions"];
	waiting?: WorkflowView["waiting"];
	task?: string;
}): WorkflowView {
	const step = overrides.step ?? "core.implementation";
	return {
		workflowId: overrides.workflowId ?? "wf-1",
		changeId: "a-change",
		status: overrides.status ?? "active",
		startedBy: overrides.startedBy ?? "orchestrator",
		currentStep: {
			id: step,
			label: step,
			attempt: overrides.attempt ?? 1,
			enteredAt: "",
		},
		task: overrides.task,
		runs: overrides.runs ?? [],
		effects: overrides.effects ?? [],
		health: { valid: true, attention: overrides.attention ?? [] },
		pendingQuestions: overrides.pendingQuestions ?? [],
		orchestratorQuestions: overrides.orchestratorQuestions ?? [],
		developerDialogue: overrides.developerDialogue ?? [],
		gateDecisions: overrides.gateDecisions ?? [],
		availableActions: [],
		...(overrides.waiting ? { waiting: overrides.waiting } : {}),
	} as unknown as WorkflowView;
}

const context = {
	repository: "/repo",
	workflowId: "wf-1",
	at: "2026-01-01T00:00:00.000Z",
};

function diff(
	previous: WorkflowView | undefined,
	next: WorkflowView,
	enrichment?: WorkflowEventEnrichment,
): WorkflowEventDraft[] {
	return deriveWorkflowEvents(
		previous ? projectWorkflowEvents(previous) : undefined,
		projectWorkflowEvents(next),
		{ ...context, ...(enrichment ? { enrichment } : {}) },
	);
}

function ids(drafts: readonly WorkflowEventDraft[]): WorkflowEventId[] {
	return drafts.map((draft) => draft.id);
}

function payload(
	drafts: readonly WorkflowEventDraft[],
	id: WorkflowEventId,
): Record<string, unknown> {
	const found = drafts.find((draft) => draft.id === id);
	if (!found) throw new Error(`no ${id} draft`);
	return found.payload as Record<string, unknown>;
}

describe("workflow event catalog", () => {
	test("every id declares a category, a human-needed flag and a payload schema", () => {
		expect(WORKFLOW_EVENT_CATALOG_VERSION).toBe(4);
		expect(WORKFLOW_EVENT_CATALOG).toHaveLength(WORKFLOW_EVENT_IDS.length);
		for (const id of WORKFLOW_EVENT_IDS) {
			const entry = workflowEventCatalogEntry(id);
			expect(entry.id).toBe(id);
			expect(typeof entry.category).toBe("string");
			expect(typeof entry.humanNeeded).toBe("boolean");
			expect(entry.payload).toBeDefined();
		}
	});

	test("the bus's own suppression warning is a bounded, non-human limit event", () => {
		const entry = workflowEventCatalogEntry("events.suppressed");
		expect(entry.category).toBe("limit");
		expect(entry.humanNeeded).toBe(false);
		const payload = { count: 1234, workflowId: "wf-1", windowMs: 10_000 };
		expect(Schema.decodeUnknownSync(entry.payload)(payload)).toEqual(payload);
		expect(workflowEventSeverity("events.suppressed", payload)).toBe("warning");
	});

	test("the developer-wait pair is a bounded, non-human workflow event", () => {
		// The wait boundary is derived from the view, so it must not notify: the
		// obligation itself already notifies as `question.pending` or
		// `review.waiting`, and a second notification per wait would double it.
		for (const id of ["workflow.waiting", "workflow.waiting.ended"] as const) {
			const entry = workflowEventCatalogEntry(id);
			expect(entry.category).toBe("workflow");
			expect(entry.humanNeeded).toBe(false);
		}
		const start = {
			kind: "handoff",
			subject: "run-1",
			stepId: "core.implementation",
		};
		expect(
			Schema.decodeUnknownSync(
				workflowEventCatalogEntry("workflow.waiting").payload,
			)({ ...start, since: "2026-01-01T00:00:00.000Z" }),
		).toEqual({ ...start, since: "2026-01-01T00:00:00.000Z" });
		expect(
			Schema.decodeUnknownSync(
				workflowEventCatalogEntry("workflow.waiting.ended").payload,
			)({ ...start, seconds: 180 }),
		).toEqual({ ...start, seconds: 180 });
		// The kind is a closed vocabulary, so a new blocking state has to name
		// itself here instead of arriving as an arbitrary string.
		expect(() =>
			Schema.decodeUnknownSync(
				workflowEventCatalogEntry("workflow.waiting").payload,
			)({ ...start, kind: "something-else" }),
		).toThrow();
	});

	test("the human-needed set is exactly review.waiting and question.pending", () => {
		expect([...HUMAN_NEEDED_EVENT_IDS]).toEqual([
			"review.waiting",
			"question.pending",
		]);
		const human = WORKFLOW_EVENT_IDS.filter((id) => isHumanNeededEvent(id));
		expect(human).toEqual(["review.waiting", "question.pending"]);
	});
});

describe("first observation and unchanged state", () => {
	test("the first observation of a workflow emits nothing", () => {
		expect(
			diff(undefined, view({ step: "core.plan-approval", status: "active" })),
		).toEqual([]);
	});

	test("an unchanged projection emits nothing", () => {
		const before = view({ step: "core.developer-review" });
		expect(diff(before, view({ step: "core.developer-review" }))).toEqual([]);
	});
});

describe("workflow, step and review edges", () => {
	test("a step into developer review emits step.entered, step.completed and review.waiting in catalog order", () => {
		const drafts = diff(
			view({ step: "core.implementation" }),
			view({ step: "core.developer-review" }),
		);
		expect(ids(drafts)).toEqual([
			"step.entered",
			"step.completed",
			"review.waiting",
		]);
		expect(payload(drafts, "review.waiting").review).toBe("developer");
		expect(payload(drafts, "step.completed").nextStepId).toBe(
			"core.developer-review",
		);
	});

	test("a review kind is named for each human review step", () => {
		for (const [step, kind] of [
			["core.plan-approval", "plan"],
			["core.findings-review", "findings"],
			["core.wiki-approval", "wiki"],
		] as const) {
			const drafts = diff(
				view({ step: "core.implementation" }),
				view({ step }),
			);
			expect(payload(drafts, "review.waiting").review).toBe(kind);
		}
	});

	test("leaving a review emits review.resolved", () => {
		const drafts = diff(
			view({ step: "core.developer-review" }),
			view({ step: "core.implementation", attempt: 2 }),
		);
		expect(ids(drafts)).toContain("review.resolved");
		expect(payload(drafts, "review.resolved").nextStepId).toBe(
			"core.implementation",
		);
	});

	test("completion and closure are separate events", () => {
		expect(
			ids(
				diff(
					view({ step: "core.completed" }),
					view({ step: "core.completed", status: "completed" }),
				),
			),
		).toContain("workflow.completed");
		expect(
			ids(
				diff(
					view({ step: "core.completed", status: "completed" }),
					view({ step: "core.completed", status: "closed" }),
				),
			),
		).toContain("workflow.closed");
	});
});

describe("attention edges", () => {
	test("becoming attention-required emits workflow.failed with the reasons and no attention.raised", () => {
		const drafts = diff(
			view({ step: "core.implementation" }),
			view({
				step: "core.implementation",
				status: "attention-required",
				attention: ["run failed"],
			}),
		);
		expect(ids(drafts)).toContain("workflow.failed");
		expect(ids(drafts)).not.toContain("attention.raised");
		expect(payload(drafts, "workflow.failed").reasons).toEqual(["run failed"]);
	});

	test("attention gained without the status edge emits attention.raised, and losing it clears", () => {
		const raised = diff(
			view({ step: "core.implementation" }),
			view({
				step: "core.implementation",
				attention: ["aborted by the developer"],
			}),
		);
		expect(ids(raised)).toEqual(["attention.raised"]);
		const cleared = diff(
			view({
				step: "core.implementation",
				attention: ["aborted by the developer"],
			}),
			view({ step: "core.implementation" }),
		);
		expect(ids(cleared)).toEqual(["attention.cleared"]);
	});
});

describe("questions", () => {
	test("a pending developer question emits question.pending, and answering it is reported once", () => {
		const pending = diff(
			view({ step: "core.planning" }),
			view({
				step: "core.planning",
				pendingQuestions: [{ id: "q-1", role: "planner" }],
			}),
		);
		expect(ids(pending)).toEqual(["question.pending"]);
		expect(payload(pending, "question.pending").questionId).toBe("q-1");
		// A `stage_login` hand-off is told apart from a developer question by its
		// kind, so a subscriber can filter it out.
		expect(payload(pending, "question.pending").kind).toBeUndefined();
		const handoff = diff(
			view({ step: "core.planning" }),
			view({
				step: "core.planning",
				pendingQuestions: [
					{ id: "h-1", role: "worker", kind: "login-handoff" },
				],
			}),
		);
		expect(ids(handoff)).toEqual(["question.pending"]);
		expect(payload(handoff, "question.pending").kind).toBe("login-handoff");
		expect(payload(handoff, "question.pending").questionId).toBe("h-1");

		const answered = diff(
			view({
				step: "core.planning",
				pendingQuestions: [{ id: "q-1", role: "planner" }],
			}),
			view({
				step: "core.planning",
				developerDialogue: [
					{
						id: "q-1",
						role: "planner",
						status: "answered",
						answer: { kind: "custom", value: "yes" },
					},
				],
			}),
		);
		expect(ids(answered)).toEqual(["question.answered"]);
		expect(payload(answered, "question.answered").answeredBy).toBe("developer");
	});

	test("a question routed to the orchestrator emits question.routed", () => {
		const drafts = diff(
			view({ step: "core.planning" }),
			view({
				step: "core.planning",
				orchestratorQuestions: [{ id: "q-2", role: "planner" }],
			}),
		);
		expect(ids(drafts)).toEqual(["question.routed"]);
	});

	test("a cleared obligation that returns emits a new event", () => {
		const second = diff(
			view({
				step: "core.planning",
				developerDialogue: [
					{
						id: "q-1",
						role: "planner",
						status: "answered",
						answer: { kind: "custom" },
					},
				],
			}),
			view({
				step: "core.planning",
				pendingQuestions: [{ id: "q-3", role: "planner" }],
				developerDialogue: [
					{
						id: "q-1",
						role: "planner",
						status: "answered",
						answer: { kind: "custom" },
					},
				],
			}),
		);
		expect(ids(second)).toEqual(["question.pending"]);
	});
});

describe("runs, effects, gates and progress", () => {
	test("a run appearing and finishing emits run.started and run.completed", () => {
		const before = view({ step: "core.implementation" });
		const started = diff(
			before,
			view({
				step: "core.implementation",
				runs: [
					{
						id: "run-1",
						stepId: "core.implementation",
						role: "implementer",
						attempt: 1,
						status: "working",
					},
				] as WorkflowView["runs"],
			}),
		);
		expect(ids(started)).toEqual(["run.started"]);
		const finished = diff(
			view({
				step: "core.implementation",
				runs: [
					{
						id: "run-1",
						stepId: "core.implementation",
						role: "implementer",
						attempt: 1,
						status: "working",
					},
				] as WorkflowView["runs"],
			}),
			view({
				step: "core.implementation",
				runs: [
					{
						id: "run-1",
						stepId: "core.implementation",
						role: "implementer",
						attempt: 1,
						status: "completed",
					},
				] as WorkflowView["runs"],
			}),
		);
		expect(ids(finished)).toEqual(["run.completed"]);
	});

	test("a blocked run is aborted only with the developer-abort marker", () => {
		const blockedRuns = (status: "working" | "blocked") =>
			[
				{
					id: "run-1",
					stepId: "core.implementation",
					role: "implementer",
					attempt: 1,
					status,
				},
			] as WorkflowView["runs"];
		const plain = diff(
			view({ step: "core.implementation", runs: blockedRuns("working") }),
			view({ step: "core.implementation", runs: blockedRuns("blocked") }),
		);
		expect(ids(plain)).toEqual(["run.blocked"]);
		const aborted = diff(
			view({ step: "core.implementation", runs: blockedRuns("working") }),
			view({
				step: "core.implementation",
				runs: blockedRuns("blocked"),
				attention: ["aborted by the developer"],
			}),
		);
		expect(ids(aborted)).toContain("run.aborted");
		expect(ids(aborted)).not.toContain("run.blocked");
	});

	test("a failed effect, a delivery and a pull request each emit once", () => {
		const effects = (status: string, kind: string) =>
			[
				{ id: "e-1", kind, status, attempts: 2, lastError: "boom" },
			] as WorkflowView["effects"];
		const failed = diff(
			view({
				step: "core.implementation",
				effects: effects("pending", "artifact.write"),
			}),
			view({
				step: "core.implementation",
				effects: effects("failed", "artifact.write"),
			}),
		);
		expect(ids(failed)).toEqual(["effect.failed"]);
		expect(payload(failed, "effect.failed").attempts).toBe(2);

		const pushed = diff(
			view({
				step: "core.delivery",
				effects: effects("pending", "delivery.push"),
			}),
			view({
				step: "core.delivery",
				effects: effects("completed", "delivery.push"),
			}),
		);
		expect(ids(pushed)).toContain("delivery.push");
		const opened = diff(
			view({
				step: "core.delivery",
				effects: effects("pending", "pull-request.create"),
			}),
			view({
				step: "core.delivery",
				effects: effects("completed", "pull-request.create"),
			}),
		);
		expect(ids(opened)).toContain("pull-request.state");
	});

	test("a new gate decision emits gate.decided", () => {
		const gate = {
			id: "g-1",
			at: "2026-01-01T00:00:00.000Z",
			stepId: "core.planning",
			stage: "plan",
			policy: "always",
			decision: "run" as const,
			forced: false,
		};
		const drafts = diff(
			view({ step: "core.planning" }),
			view({
				step: "core.planning",
				gateDecisions: [gate] as WorkflowView["gateDecisions"],
			}),
		);
		expect(ids(drafts)).toEqual(["gate.decided"]);
		expect(payload(drafts, "gate.decided").gateId).toBe("g-1");
	});

	test("verification counts come from the enrichment and default to zero", () => {
		const verifierRuns = (status: string) =>
			[
				{
					id: "v-1",
					stepId: "core.verification",
					role: "verifier",
					attempt: 1,
					status,
				},
			] as WorkflowView["runs"];
		const withCounts = diff(
			view({ step: "core.verification", runs: verifierRuns("working") }),
			view({ step: "core.verification", runs: verifierRuns("completed") }),
			{ verification: { verifier: { critical: 2, warning: 1, info: 0 } } },
		);
		expect(payload(withCounts, "verification.finished").counts).toEqual({
			critical: 2,
			warning: 1,
			info: 0,
		});
		const withoutCounts = diff(
			view({ step: "core.verification", runs: verifierRuns("working") }),
			view({ step: "core.verification", runs: verifierRuns("completed") }),
		);
		expect(payload(withoutCounts, "verification.finished").counts).toEqual({
			critical: 0,
			warning: 0,
			info: 0,
		});
	});

	test("compaction and OpenSpec progress need the enrichment, and a missing source emits nothing", () => {
		// A real edge (the step moved) with no enrichment at all: neither event may
		// be invented from a source the derivation never read.
		const withoutEnrichment = diff(
			view({ step: "core.planning" }),
			view({ step: "core.implementation" }),
		);
		expect(ids(withoutEnrichment)).not.toContain("compaction");
		expect(ids(withoutEnrichment)).not.toContain("openspec.task-progress");
		// An enrichment that read nothing (an unreadable telemetry file, an
		// unreadable tasks artifact) is the same nothing.
		const emptySources = diff(
			view({ step: "core.planning" }),
			view({ step: "core.implementation" }),
			{ openspec: null },
		);
		expect(ids(emptySources)).not.toContain("compaction");
		expect(ids(emptySources)).not.toContain("openspec.task-progress");
		const enriched = diff(
			view({ step: "core.planning" }),
			view({ step: "core.implementation" }),
			{
				compaction: [{ role: "implementer", reason: "context" }],
				openspec: { changeId: "a-change", done: 2, total: 5 },
			},
		);
		expect(ids(enriched)).toContain("compaction");
		expect(ids(enriched)).toContain("openspec.task-progress");
		expect(payload(enriched, "openspec.task-progress")).toMatchObject({
			done: 2,
			total: 5,
		});
	});

	test("an unchanged compaction count emits no second compaction event", () => {
		const before = projectWorkflowEvents(view({ step: "core.implementation" }));
		const withOne = { ...before, compactionCount: 1, openspec: null };
		const drafts = deriveWorkflowEvents(withOne, withOne, {
			...context,
			enrichment: { compaction: [{ role: "implementer" }] },
		});
		expect(ids(drafts)).not.toContain("compaction");
	});
});

describe("subscription filter matcher", () => {
	const event = (
		overrides: Partial<WorkflowEventRecord> = {},
	): WorkflowEventRecord => ({
		sequence: 1,
		id: "attention.raised",
		repository: "/repo",
		workflowId: "wf-1",
		startedBy: "orchestrator",
		stepId: "core.implementation",
		stepLabel: "core.implementation",
		severity: "warning",
		humanNeeded: false,
		at: "2026-01-01T00:00:00.000Z",
		payload: { reasons: ["run failed"] },
		...overrides,
	});

	test("scope, ids, categories, repositories, roles, reasons and severity are conjunctive", () => {
		expect(matchesSubscriptionFilter({ scope: "mine" }, event())).toBe(true);
		expect(
			matchesSubscriptionFilter(
				{ scope: "mine" },
				event({ startedBy: "developer" }),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all" },
				event({ startedBy: "developer" }),
			),
		).toBe(true);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", eventIds: ["workflow.closed"] },
				event(),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", categories: ["attention"] },
				event(),
			),
		).toBe(true);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", workflowIds: ["wf-2"] },
				event(),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", repositories: ["/other"] },
				event(),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", reasons: ["run fail"] },
				event(),
			),
		).toBe(true);
		expect(
			matchesSubscriptionFilter({ scope: "all", reasons: ["other"] }, event()),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", roles: ["implementer"] },
				event({ id: "run.blocked", payload: { role: "implementer" } }),
			),
		).toBe(true);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", roles: ["verifier"] },
				event({ id: "run.blocked", payload: { role: "implementer" } }),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all", minSeverity: "critical" },
				event(),
			),
		).toBe(false);
		expect(
			matchesSubscriptionFilter({ scope: "all", minSeverity: "info" }, event()),
		).toBe(true);
	});

	test("the default subscription digests the events it always delivered", () => {
		const subscription = defaultSubscription({
			session: "orchestrator",
			now: Date.parse("2026-01-01T00:00:00.000Z"),
			expiresAt: "2026-01-02T00:00:00.000Z",
		});
		expect(subscription.implicit).toBe(true);
		// A short digest rather than an immediate wake per event; an immediate event
		// and a completion still ride the wake window, so nothing waits the interval.
		expect(subscription.mode).toBe("digest");
		expect(subscription.digestMinutes).toBe(
			DEFAULT_SUBSCRIPTION_DIGEST_MINUTES,
		);
		expect(subscription.minIntervalMs).toBe(60_000);
		expect(subscription.filter.eventIds).toEqual([
			...DEFAULT_SUBSCRIPTION_EVENT_IDS,
		]);
		expect([...DEFAULT_SUBSCRIPTION_EVENT_IDS]).toEqual([
			"review.waiting",
			"question.pending",
			"question.routed",
			"attention.raised",
			"workflow.failed",
			"effect.failed",
			"workflow.completed",
		]);
		for (const id of DEFAULT_SUBSCRIPTION_EVENT_IDS)
			expect(
				matchesSubscriptionFilter(subscription.filter, event({ id })),
			).toBe(true);
		expect(
			matchesSubscriptionFilter(
				subscription.filter,
				event({ id: "step.entered" }),
			),
		).toBe(false);
	});

	test("a subscription that named an event is explicit, a broad match is not", () => {
		// What the shell absorbs a no-op note by: an event the subscription named.
		expect(
			filterNamesEvent({ eventIds: ["workflow.completed"] }, event()),
		).toBe(false);
		expect(
			filterNamesEvent(
				{ eventIds: ["review.waiting"] },
				event({ id: "review.waiting" }),
			),
		).toBe(true);
		expect(
			filterNamesEvent({ categories: ["step"] }, event({ id: "step.entered" })),
		).toBe(true);
		expect(
			filterNamesEvent({ minSeverity: "info" }, event({ id: "step.entered" })),
		).toBe(false);
	});

	test("an absent scope reads as the documented `mine` default", () => {
		expect(matchesSubscriptionFilter({}, event())).toBe(true);
		expect(
			matchesSubscriptionFilter({}, event({ startedBy: "developer" })),
		).toBe(false);
		expect(
			matchesSubscriptionFilter(
				{ scope: "all" },
				event({ startedBy: "developer" }),
			),
		).toBe(true);
	});

	test("naming only ids cannot widen a read: the absent scope still scopes it to mine", () => {
		expect(
			matchesSubscriptionFilter(
				{ eventIds: ["attention.raised"] },
				event({ startedBy: "developer" }),
			),
		).toBe(false);
	});
});

describe("bounded, secret-free payloads", () => {
	test("a long effect error is truncated, control-stripped and credential-masked", () => {
		const noisy = `token=supersecret\u0000 ${"x".repeat(1000)}`;
		const drafts = diff(
			view({
				step: "core.implementation",
				effects: [
					{ id: "e-1", kind: "artifact.write", status: "pending", attempts: 1 },
				] as WorkflowView["effects"],
			}),
			view({
				step: "core.implementation",
				effects: [
					{
						id: "e-1",
						kind: "artifact.write",
						status: "failed",
						attempts: 1,
						lastError: noisy,
					},
				] as WorkflowView["effects"],
			}),
		);
		const error = payload(drafts, "effect.failed").error as string;
		expect(error.length).toBeLessThanOrEqual(256);
		expect(error).not.toContain("supersecret");
		expect(error).toContain("<redacted>");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the strip is the point.
		expect(error).not.toMatch(/[\u0000-\u001f]/);
	});

	test("an attention reason is bounded, stripped and masked too", () => {
		const drafts = diff(
			view({ step: "core.implementation" }),
			view({
				step: "core.implementation",
				attention: [`Bearer abcdef\u0007 ${"y".repeat(500)}`],
			}),
		);
		const reasons = payload(drafts, "attention.raised").reasons as string[];
		expect(reasons).toHaveLength(1);
		expect((reasons[0] ?? "").length).toBeLessThanOrEqual(256);
		expect(reasons[0]).toContain("<redacted>");
	});
});

describe("severity", () => {
	test("the mapping is the one the minSeverity filter reads", () => {
		expect(workflowEventSeverity("step.entered", {})).toBe("info");
		expect(workflowEventSeverity("attention.raised", { reasons: [] })).toBe(
			"warning",
		);
		expect(workflowEventSeverity("run.stalled", { minutes: 40 })).toBe(
			"warning",
		);
		expect(workflowEventSeverity("review.waiting", { review: "plan" })).toBe(
			"warning",
		);
		expect(workflowEventSeverity("effect.failed", { attempts: 2 })).toBe(
			"warning",
		);
		expect(workflowEventSeverity("effect.failed", { attempts: 3 })).toBe(
			"critical",
		);
		expect(
			workflowEventSeverity("verification.finished", {
				counts: { critical: 1, warning: 0, info: 0 },
			}),
		).toBe("critical");
	});
});

describe("payload bounds the catalog promises", () => {
	test("at most five attention reasons are recorded, each bounded and masked", () => {
		const many = Array.from(
			{ length: 8 },
			(_, index) => `reason ${index} token=secret-${index}`,
		);
		const drafts = diff(
			view({ step: "core.implementation" }),
			view({ step: "core.implementation", attention: many }),
		);
		const reasons = payload(drafts, "attention.raised").reasons as string[];
		expect(reasons).toHaveLength(5);
		for (const reason of reasons) {
			expect(reason).toContain("<redacted>");
			expect(reason).not.toContain("secret-");
			expect(reason.length).toBeLessThanOrEqual(256);
		}
	});

	test("a compaction reason read from telemetry is masked and bounded too", () => {
		const drafts = diff(
			view({ step: "core.planning" }),
			view({ step: "core.implementation" }),
			{
				compaction: [
					{
						role: "implementer",
						reason: `Bearer abcdef ${"z".repeat(400)}`,
					},
				],
			},
		);
		const compaction = payload(drafts, "compaction");
		expect(String(compaction.reason)).toContain("<redacted>");
		expect(String(compaction.reason).length).toBeLessThanOrEqual(128);
	});
});
