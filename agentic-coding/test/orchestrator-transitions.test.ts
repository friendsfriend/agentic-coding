// Pure workflow-monitor transition detector (add-orchestrator-workflow-
// monitoring, task 1.1). No gateway, no timers: a view in, typed transitions
// out, and the first observation of a workflow is always silent.

import { describe, expect, test } from "bun:test";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	describeTransition,
	detectTransitions,
	formatMonitorNote,
	isHumanNeeded,
	projectWorkflow,
	type WorkflowProjection,
} from "../src/tui/orchestrator/transitions.ts";

/** A view with only the state the monitor reads; everything else is the view
 * contract's own shape and is irrelevant here. */
function view(
	overrides: {
		status?: WorkflowView["status"];
		step?: string;
		label?: string;
		pendingQuestions?: number;
		orchestratorQuestions?: number;
		failedEffects?: Array<{
			id: string;
			kind: WorkflowView["effects"][number]["kind"];
		}>;
	} = {},
): WorkflowView {
	return {
		workflowId: "wf-1",
		status: overrides.status ?? "active",
		currentStep: {
			id: overrides.step ?? "core.implementation",
			label: overrides.label ?? overrides.step ?? "core.implementation",
			attempt: 1,
			enteredAt: "",
		},
		effects: (overrides.failedEffects ?? []).map((effect) => ({
			...effect,
			status: "failed" as const,
			attempts: 1,
		})),
		pendingQuestions: Array.from(
			{ length: overrides.pendingQuestions ?? 0 },
			(_, index) => ({ id: `q-${index}` }),
		),
		orchestratorQuestions: Array.from(
			{ length: overrides.orchestratorQuestions ?? 0 },
			(_, index) => ({ id: `oq-${index}` }),
		),
		availableActions: [],
	} as unknown as WorkflowView;
}

const project = (overrides: Parameters<typeof view>[0]): WorkflowProjection =>
	projectWorkflow(view(overrides));

describe("workflow projection", () => {
	test("reads the state the monitor cares about off the view", () => {
		expect(
			project({
				status: "attention-required",
				step: "core.developer-review",
				pendingQuestions: 2,
				failedEffects: [{ id: "e1", kind: "agent.launch" }],
			}),
		).toEqual({
			status: "attention-required",
			stepId: "core.developer-review",
			stepLabel: "core.developer-review",
			reviewPending: true,
			questionPending: true,
			orchestratorQuestionPending: false,
			failedEffects: [{ id: "e1", kind: "agent.launch" }],
			completed: false,
		});
	});

	test("a review step is one whose decision belongs to the developer", () => {
		for (const step of [
			"core.plan-approval",
			"core.developer-review",
			"core.findings-review",
			"core.wiki-approval",
		])
			expect(project({ step }).reviewPending).toBe(true);
		expect(project({ step: "core.implementation" }).reviewPending).toBe(false);
	});
});

describe("transition detection", () => {
	test("the first observation is silent", () => {
		expect(
			detectTransitions(
				undefined,
				project({ step: "core.plan-approval" }),
				"wf-1",
			),
		).toEqual([]);
	});

	test("an unchanged workflow produces nothing", () => {
		const before = project({ step: "core.implementation" });
		expect(
			detectTransitions(
				before,
				project({ step: "core.implementation" }),
				"wf-1",
			),
		).toEqual([]);
	});

	test("a review step entered yields exactly one transition", () => {
		const transitions = detectTransitions(
			project({ step: "core.implementation" }),
			project({ step: "core.developer-review", label: "Developer review" }),
			"wf-1",
		);
		expect(transitions).toEqual([
			{
				workflowId: "wf-1",
				kind: "review-pending",
				stepId: "core.developer-review",
				stepLabel: "Developer review",
			},
		]);
		expect(isHumanNeeded(transitions[0]?.kind ?? "completed")).toBe(true);
	});

	test("an orchestrator-routed question yields one non-human transition", () => {
		const transitions = detectTransitions(
			project({ step: "core.implementation" }),
			project({ step: "core.implementation", orchestratorQuestions: 1 }),
			"wf-1",
		);
		expect(transitions).toEqual([
			{
				workflowId: "wf-1",
				kind: "orchestrator-question-pending",
				stepId: "core.implementation",
				stepLabel: "core.implementation",
			},
		]);
		expect(isHumanNeeded(transitions[0]?.kind ?? "completed")).toBe(false);
	});

	test("a pending developer question yields one transition", () => {
		expect(
			detectTransitions(
				project({ step: "core.implementation" }),
				project({ step: "core.implementation", pendingQuestions: 1 }),
				"wf-1",
			),
		).toEqual([
			{
				workflowId: "wf-1",
				kind: "question-pending",
				stepId: "core.implementation",
				stepLabel: "core.implementation",
			},
		]);
	});

	test("becoming attention-required yields one transition", () => {
		expect(
			detectTransitions(
				project({ status: "active" }),
				project({ status: "attention-required" }),
				"wf-1",
			),
		).toEqual([
			{
				workflowId: "wf-1",
				kind: "attention-required",
				stepId: "core.implementation",
				stepLabel: "core.implementation",
			},
		]);
	});

	test("a newly failed effect yields one transition naming the effect kind", () => {
		const transitions = detectTransitions(
			project({ failedEffects: [{ id: "e1", kind: "agent.launch" }] }),
			project({
				failedEffects: [
					{ id: "e1", kind: "agent.launch" },
					{ id: "e2", kind: "artifact.write" },
				],
			}),
			"wf-1",
		);
		expect(transitions).toEqual([
			{
				workflowId: "wf-1",
				kind: "effect-failed",
				stepId: "core.implementation",
				stepLabel: "core.implementation",
				effects: [{ id: "e2", kind: "artifact.write" }],
			},
		]);
	});

	test("completion yields one transition", () => {
		expect(
			detectTransitions(
				project({ status: "active" }),
				project({ status: "completed", step: "core.completed" }),
				"wf-1",
			),
		).toEqual([
			{
				workflowId: "wf-1",
				kind: "completed",
				stepId: "core.completed",
				stepLabel: "core.completed",
			},
		]);
	});

	test("a cleared-then-returned obligation yields a new transition", () => {
		const away = project({ step: "core.implementation" });
		const waiting = project({ step: "core.plan-approval" });
		expect(detectTransitions(away, waiting, "wf-1")).toHaveLength(1);
		// Answered and moved on: nothing to report.
		expect(detectTransitions(waiting, away, "wf-1")).toEqual([]);
		// Waiting again is a new obligation, not a re-report of the same one.
		expect(detectTransitions(away, waiting, "wf-1")).toHaveLength(1);
	});

	test("several edges in one step change are reported in a stable order", () => {
		const transitions = detectTransitions(
			project({ status: "active" }),
			project({
				status: "attention-required",
				step: "core.developer-review",
				pendingQuestions: 1,
				failedEffects: [{ id: "e1", kind: "delivery.push" }],
			}),
			"wf-1",
		);
		expect(transitions.map((transition) => transition.kind)).toEqual([
			"review-pending",
			"question-pending",
			"attention-required",
			"effect-failed",
		]);
	});
});

describe("monitor note", () => {
	test("one line per transition, naming workflow, step and what changed", () => {
		const transitions = detectTransitions(
			project({ step: "core.implementation" }),
			project({
				step: "core.plan-approval",
				failedEffects: [{ id: "e1", kind: "workspace.setup" }],
			}),
			"wf-7",
		);
		const note = formatMonitorNote(transitions);
		expect(note.split("\n")[0]).toBe("[workflow-monitor]");
		expect(note).toContain(
			"- wf-7 → core.plan-approval (developer review waiting)",
		);
		expect(note).toContain(
			"- wf-7 → core.plan-approval (effect failed: workspace.setup)",
		);
	});

	test("only reviews and questions need the developer", () => {
		expect(isHumanNeeded("review-pending")).toBe(true);
		expect(isHumanNeeded("question-pending")).toBe(true);
		expect(isHumanNeeded("attention-required")).toBe(false);
		expect(isHumanNeeded("effect-failed")).toBe(false);
		expect(isHumanNeeded("completed")).toBe(false);
		expect(
			describeTransition({
				workflowId: "w",
				kind: "completed",
				stepId: "s",
				stepLabel: "s",
			}),
		).toBe("completed");
	});
});
