// The checkpoint class a step declares (efficiency backlog item 19): the class
// lives in the registered step behavior — never in a role table inside the host
// or the runner — and reaches a run only as `HERDR_CHECKPOINT_CLASS`.
import { expect, test } from "bun:test";
import {
	CHECKPOINT_CLASSES,
	checkpointClassOf,
} from "../src/agent-host/progress-checkpoint.ts";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import { STEP_BEHAVIORS } from "../src/workflow/steps/index.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "fake",
};

const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [{ stepId: "core.implementation", profile }],
};

test("the registered behaviors declare the four classes and leave the rest undeclared", () => {
	expect(STEP_BEHAVIORS["core.implementation"]?.checkpointClass).toBe("worker");
	expect(STEP_BEHAVIORS["core.rebase"]?.checkpointClass).toBe("worker");
	expect(STEP_BEHAVIORS["core.research"]?.checkpointClass).toBe("worker");
	expect(STEP_BEHAVIORS["debug.investigate"]?.checkpointClass).toBe("worker");
	expect(STEP_BEHAVIORS["core.plan"]?.checkpointClass).toBe("planner");
	expect(STEP_BEHAVIORS["fusion.plan"]?.checkpointClass).toBe("planner");
	expect(STEP_BEHAVIORS["fusion.consolidate"]?.checkpointClass).toBe("planner");
	expect(STEP_BEHAVIORS["core.verification"]?.checkpointClass).toBe("verifier");
	expect(STEP_BEHAVIORS["core.triage"]?.checkpointClass).toBe("mechanical");
	expect(STEP_BEHAVIORS["core.wiki"]?.checkpointClass).toBe("mechanical");
	expect(STEP_BEHAVIORS["core.archive"]?.checkpointClass).toBe("mechanical");
	// A developer gate and the lifecycle bookkeeping have no run to supervise.
	expect(
		STEP_BEHAVIORS["core.developer-review"]?.checkpointClass,
	).toBeUndefined();
	expect(STEP_BEHAVIORS["core.completed"]?.checkpointClass).toBeUndefined();
	// The host's vocabulary and the steps' declarations are one set.
	for (const behavior of Object.values(STEP_BEHAVIORS)) {
		if (behavior.checkpointClass === undefined) continue;
		expect(CHECKPOINT_CLASSES).toContain(behavior.checkpointClass);
	}
	expect(checkpointClassOf(undefined)).toBe("other");
});

test("a worker run's environment carries its step's class", () => {
	const root = createTempRepoFixture("checkpoint-class-", repoPreset.readme);
	const engine = new WorkflowEngine(registerBuiltins());
	const started = engine.start({
		repo: root,
		workflowId: "checkpoint-class",
		definitionId: "solo",
		definitionVersion: definitionVersionForStepRouting(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "add a flag",
		},
		routing,
	}).view;
	const view: WorkflowView = (() => {
		const classify = engine
			.claimEffects(root, 100)
			.find((effect) => effect.kind === "model.classify");
		if (!classify?.lease) return started;
		return engine.dispatch(root, {
			type: "effect.result",
			effectId: classify.id,
			lease: classify.lease,
			outcome: "complete",
			data: {
				integration: "routing",
				phase: "apply",
				answers: {},
			},
		}).view;
	})();
	const summary = view.runs.find(
		(run) =>
			run.role === "worker" && ["pending", "working"].includes(run.status),
	);
	if (!summary) throw new Error("missing worker run");
	const assignment = effectRunnerTest.renderedAssignment(
		engine,
		root,
		registerBuiltins(),
		summary.id,
		"token",
	).assignment;
	expect(assignment.environment.HERDR_CHECKPOINT_CLASS).toBe("worker");
});
