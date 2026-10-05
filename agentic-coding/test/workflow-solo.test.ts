// The solo workflow family: one implementation agent, start to finish. This
// pins the two things it exists for — the graph has no planning, verification,
// wiki, or delivery step, and a start in a repository without an OpenSpec
// project runs the worker to completion with nothing else in between.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import { validateStart } from "../src/workflow/startup.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

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
/** The solo graph's only classifiable step; a start pins its profile here. */
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [{ stepId: "core.implementation", profile }],
};

function repo(): string {
	return createTempRepoFixture("solo-", repoPreset.readme);
}

function start(engine: WorkflowEngine, root: string): WorkflowView {
	return engine.start({
		repo: root,
		workflowId: "solo-task",
		definitionId: "solo",
		// What the real start path resolves: the newest tier, where every
		// classifiable step selects its model immediately before it runs.
		definitionVersion: definitionVersionForStepRouting(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "add a flag",
		},
		routing,
	}).view;
}

/** Complete the per-step classifier pass so the graph reaches the worker. */
function advanceRouting(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): WorkflowView {
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (!classify) return view;
	const phase =
		(classify.payload as { phase?: string }).phase === "plan"
			? "plan"
			: "apply";
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: classify.id,
		lease: requireDefined(classify.lease, "classify lease"),
		outcome: "complete",
		data: { integration: "routing", phase, answers: {} },
	}).view;
}

/** Hand the worker's run off as `complete`, the way an agent would. */
function completeWorker(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): WorkflowView {
	const summary = view.runs.find(
		(run) =>
			run.role === "worker" && ["pending", "working"].includes(run.status),
	);
	if (!summary) throw new Error("missing worker run");
	const run = engine.getRun(root, summary.id);
	const launch = engine
		.claimEffects(root, 100)
		.find(
			(effect) =>
				effect.kind === "agent.launch" &&
				(effect.payload as { runId?: string }).runId === run.id,
		);
	if (!launch?.runToken) throw new Error("missing launch token");
	const outputPath = requireDefined(run.outputPath, "output path");
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		JSON.stringify({
			runId: run.id,
			schemaId: run.outputSchema?.id,
			schemaVersion: run.outputSchema?.version,
			payload: { done: true },
		}),
	);
	return engine.dispatch(root, {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token: launch.runToken,
		outcome: "complete",
		artifact: outputPath,
	}).view;
}

test("the solo definition is one implementation agent plus lifecycle bookkeeping", () => {
	const registry = registerBuiltins();
	const version = definitionVersionForStepRouting(6);
	const definition = registry.definition("solo", version);
	expect(definition.initial).toBe("core.route-implementation");
	expect([...definition.steps].sort()).toEqual([
		"core.closed",
		"core.completed",
		"core.implementation",
		"core.route-implementation",
	]);
	for (const absent of [
		"core.plan",
		"core.triage",
		"core.verification",
		"core.wiki",
		"core.archive",
		"core.delivery",
	])
		expect(definition.steps).not.toContain(absent);
	expect(definition.terminal).toEqual(["core.closed"]);
	// The legacy tiers carry the same family, so a pinned lookup still resolves
	// it (the catalog is the workflow-type authority for every version).
	expect(
		registry.definition("solo", 1).steps.filter((id) => id.startsWith("core.")),
	).toEqual(["core.implementation", "core.completed", "core.closed"]);
});

test("a solo workflow runs the worker and completes without verification", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		// No `openspec/config.yaml` in this fixture: a solo start does not need
		// one, unlike every spec-driven family.
		let view = start(engine, root);
		expect(view.currentStep.id).toBe("core.route-implementation");
		view = advanceRouting(engine, root, view);
		expect(view.currentStep.id).toBe("core.implementation");
		expect(view.runs.map((run) => run.role)).toEqual(["worker"]);

		view = completeWorker(engine, root, view);
		expect(view.currentStep.id).toBe("core.completed");
		expect(view.status).toBe("completed");

		// A solo workflow has no delivery step, so completion offers close and
		// not a pull request.
		expect(() =>
			engine.dispatch(root, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "create-pr",
			}),
		).toThrow();
		view = engine.dispatch(root, {
			type: "developer.action",
			workflowId: view.workflowId,
			revision: view.revision,
			actionId: "close",
		}).view;
		expect(view.currentStep.id).toBe("core.closed");
		expect(view.status).toBe("closed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the startup guard accepts solo without an OpenSpec project", () => {
	const root = repo();
	try {
		expect(() => validateStart(root, "solo-task", "solo")).toThrow(
			/solo workflow requires non-empty task/,
		);
		expect(() =>
			validateStart(root, "solo-task", "solo", "add a flag"),
		).not.toThrow();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a solo start requires a task and refuses an unclean worktree", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		expect(() =>
			engine.start({
				repo: root,
				workflowId: "solo-no-task",
				definitionId: "solo",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing,
			}),
		).toThrow(/solo requires non-empty task/);
		fs.writeFileSync(path.join(root, "dirty.txt"), "dirty\n");
		expect(() =>
			engine.start({
				repo: root,
				workflowId: "solo-dirty",
				definitionId: "solo",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "add a flag",
				},
				routing,
			}),
		).toThrow(/working tree must be clean/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
