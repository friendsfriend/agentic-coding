import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import {
	definitionVersionForTriageRouting,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

// Replaces non-null assertions: fail loudly with a clear message instead of
// asserting away `undefined`.
function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function requireEffect(
	effects: ReturnType<WorkflowEngine["claimEffects"]>,
	kind: string,
) {
	return requireDefined(
		effects.find((effect) => effect.kind === kind),
		`${kind} effect`,
	);
}

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "fake",
};
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [
		"core.plan",
		"core.implementation",
		"core.triage",
		"core.verification",
		"core.wiki",
		"core.archive",
	].map((stepId) => ({ stepId, profile })),
};
function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	fs.mkdirSync(path.join(root, "openspec"));
	fs.writeFileSync(
		path.join(root, "openspec", "config.yaml"),
		"schema: spec-driven\n",
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: root },
	);
	return root;
}
function launchToken(
	engine: WorkflowEngine,
	root: string,
	runId: string,
): string {
	const effect = engine
		.claimEffects(root, 100)
		.find(
			(item) =>
				item.kind === "agent.launch" &&
				(item.payload as { runId?: string }).runId === runId,
		);
	if (!effect?.runToken) throw new Error(`missing launch token for ${runId}`);
	return effect.runToken;
}
function complete(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	role: string,
	payload: unknown,
	runToken?: string,
): WorkflowView {
	const summary = view.runs.find(
		(run) => run.role === role && ["pending", "working"].includes(run.status),
	);
	if (!summary) throw new Error(`missing ${role} run`);
	const run = engine.getRun(root, summary.id);
	const token = runToken ?? launchToken(engine, root, run.id);
	fs.mkdirSync(path.dirname(requireDefined(run.outputPath, "output path")), {
		recursive: true,
	});
	fs.writeFileSync(
		requireDefined(run.outputPath, "output path"),
		JSON.stringify({
			runId: run.id,
			schemaId: run.outputSchema?.id,
			schemaVersion: run.outputSchema?.version,
			payload,
		}),
	);
	return engine.dispatch(root, {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token,
		outcome: "complete",
		artifact: run.outputPath,
	}).view;
}
function action(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	actionId: string,
	input?: unknown,
): WorkflowView {
	return engine.dispatch(root, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision: view.revision,
		actionId,
		...(input === undefined ? {} : { input }),
	}).view;
}

/** Complete the pending classifier routing pass so the graph reaches its first
 * agent step. The pinned routing is pre-seeded, so the no-answer result keeps
 * it. */
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
		(classify.payload as { phase?: string }).phase === "apply"
			? "apply"
			: "plan";
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: classify.id,
		lease: requireDefined(classify.lease, "classify lease"),
		outcome: "complete",
		data: { integration: "routing", phase, answers: {} },
	}).view;
}
function drive(
	engine: WorkflowEngine,
	root: string,
	definitionId: "openspec" | "openspec-apply" | "no-openspec",
	policy = false,
): string[] {
	if (definitionId !== "no-openspec") {
		const change = path.join(root, "openspec", "changes", definitionId);
		fs.mkdirSync(path.join(change, "specs", "feature"), { recursive: true });
		fs.writeFileSync(path.join(change, "proposal.md"), "proposal\n");
		fs.writeFileSync(path.join(change, "design.md"), "design\n");
		fs.writeFileSync(
			path.join(change, "tasks.md"),
			definitionId === "openspec-apply" ? "- [ ] task\n" : "- [x] task\n",
		);
		fs.writeFileSync(
			path.join(change, "specs", "feature", "spec.md"),
			"#### Scenario: works\n",
		);
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"-qm",
				"plan",
			],
			{ cwd: root },
		);
	}
	let view = engine.start({
		repo: root,
		workflowId: definitionId,
		definitionId,
		...(policy ? { definitionVersion: 106 } : {}),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			...(definitionId === "no-openspec" ? { task: "task" } : {}),
		},
		routing,
	}).view;
	const visited = [view.currentStep.id];
	let archiveLaunchToken: string | undefined;
	if (definitionId !== "no-openspec") {
		view = advanceRouting(engine, root, view);
		visited.push(view.currentStep.id);
	}
	if (definitionId === "openspec") {
		view = complete(engine, root, view, "planner", {
			primaryChangeId: definitionId,
			validated: true,
		});
		const validation = requireEffect(
			engine.claimEffects(root, 100),
			"openspec.validate",
		);
		view = engine.dispatch(root, {
			type: "effect.result",
			effectId: validation.id,
			lease: requireDefined(validation.lease, "effect lease"),
			outcome: "complete",
		}).view;
		visited.push(view.currentStep.id);
		view = action(engine, root, view, "approve-plan");
		visited.push(view.currentStep.id);
		view = advanceRouting(engine, root, view);
		visited.push(view.currentStep.id);
	}
	if (definitionId === "openspec-apply")
		fs.writeFileSync(
			path.join(root, "openspec", "changes", definitionId, "tasks.md"),
			"- [x] task\n",
		);
	fs.writeFileSync(path.join(root, "implementation.txt"), "changed\n");
	view = complete(engine, root, view, "worker", { changed: true });
	visited.push(view.currentStep.id);
	view = complete(engine, root, view, "triage", {
		roles: [
			{
				role: "quality-verifier",
				reason: "code changed",
				files: ["implementation.txt"],
			},
		],
	});
	visited.push(view.currentStep.id);
	view = complete(engine, root, view, "quality-verifier", { findings: [] });
	expect(view.currentStep.id).toBe("core.verification");
	view = complete(engine, root, view, "test-verifier", { findings: [] });
	visited.push(view.currentStep.id);
	view = action(engine, root, view, "approve-review");
	visited.push(view.currentStep.id);
	if (policy) {
		view = complete(engine, root, view, "wiki", { touched: [] });
		visited.push(view.currentStep.id);
		view = action(engine, root, view, "review-comments", {
			comments: [
				{
					comment: "add the source citation",
					concept: "architecture",
					line: 1,
				},
			],
		});
		expect(view.currentStep.id).toBe("core.wiki");
		expect(engine.getSnapshot(root, view.workflowId).step.context).toEqual({
			comments: [
				{
					comment: "add the source citation",
					concept: "architecture",
					line: 1,
				},
			],
		});
		visited.push(view.currentStep.id);
		view = complete(engine, root, view, "wiki", {
			touched: ["architecture"],
		});
		visited.push(view.currentStep.id);
		view = action(engine, root, view, "approve-wiki");
		if (definitionId === "no-openspec") {
			const verification = requireEffect(
				engine.claimEffects(root, 1),
				"wiki.verify",
			);
			view = engine.dispatch(root, {
				type: "effect.result",
				effectId: verification.id,
				lease: requireDefined(verification.lease, "effect lease"),
				outcome: "complete",
			}).view;
		} else {
			const archiveRun = requireDefined(
				view.runs.find((run) => run.role === "archive"),
				"archive run",
			);
			const enteredEffects = engine.claimEffects(root, 100);
			expect(enteredEffects.map((effect) => effect.kind)).toEqual([
				"artifact.write",
				"agent.launch",
				"wiki.verify",
			]);
			const archiveArtifact = requireDefined(
				enteredEffects.find(
					(effect) =>
						effect.kind === "artifact.write" &&
						(effect.payload as { runId?: string }).runId === archiveRun.id,
				),
				"archive assignment effect",
			);
			const archiveLaunch = requireDefined(
				enteredEffects.find(
					(effect) =>
						effect.kind === "agent.launch" &&
						(effect.payload as { runId?: string }).runId === archiveRun.id,
				),
				"archive launch effect",
			);
			view = engine.dispatch(root, {
				type: "effect.result",
				effectId: archiveArtifact.id,
				lease: requireDefined(archiveArtifact.lease, "effect lease"),
				outcome: "complete",
			}).view;
			const verification = requireEffect(enteredEffects, "wiki.verify");
			view = engine.dispatch(root, {
				type: "effect.result",
				effectId: verification.id,
				lease: requireDefined(verification.lease, "effect lease"),
				outcome: "complete",
			}).view;
			visited.push(view.currentStep.id);
			// Launch effect is claimed before wiki verification, so handoff uses its
			// already-issued capability instead of claiming it a second time.
			archiveLaunchToken = requireDefined(
				archiveLaunch.runToken,
				"archive launch token",
			);
		}
		if (definitionId === "no-openspec") visited.push(view.currentStep.id);
	}
	if (definitionId !== "no-openspec") {
		const active = path.join(root, "openspec", "changes", definitionId);
		const archived = path.join(
			root,
			"openspec",
			"changes",
			"archive",
			definitionId,
		);
		fs.mkdirSync(path.dirname(archived), { recursive: true });
		fs.renameSync(active, archived);
		view = complete(
			engine,
			root,
			view,
			"archive",
			{ archived: true },
			archiveLaunchToken,
		);
		visited.push(view.currentStep.id);
	}
	const commit = requireEffect(
		engine.claimEffects(root, 100),
		"delivery.commit",
	);
	view = engine.dispatch(root, {
		type: "effect.result",
		effectId: commit.id,
		lease: requireDefined(commit.lease, "effect lease"),
		outcome: "complete",
	}).view;
	const push = requireEffect(engine.claimEffects(root, 100), "delivery.push");
	view = engine.dispatch(root, {
		type: "effect.result",
		effectId: push.id,
		lease: requireDefined(push.lease, "effect lease"),
		outcome: "complete",
	}).view;
	visited.push(view.currentStep.id);
	view = action(engine, root, view, "close");
	visited.push(view.currentStep.id);
	return visited;
}
for (const type of ["openspec", "openspec-apply", "no-openspec"] as const)
	test(`${type} definition reaches terminal through registered commands`, () => {
		const root = repo();
		try {
			const sequence = drive(
				new WorkflowEngine(registerBuiltins()),
				root,
				type,
			);
			expect(sequence.at(-1)).toBe("core.closed");
			if (type === "openspec") expect(sequence[0]).toBe("core.route-plan");
			else if (type === "openspec-apply")
				expect(sequence[0]).toBe("core.route-apply");
			else expect(sequence[0]).toBe("core.implementation");
			expect(sequence.includes("core.archive")).toBe(type !== "no-openspec");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
test("policy workflow returns wiki comments before approval and archive", () => {
	const root = repo();
	try {
		const sequence = drive(
			new WorkflowEngine(registerBuiltins()),
			root,
			"openspec-apply",
			true,
		);
		const wiki = sequence.indexOf("core.wiki");
		const approval = sequence.indexOf("core.wiki-approval");
		const archive = sequence.indexOf("core.archive");
		expect(wiki).toBeGreaterThan(-1);
		expect(approval).toBeGreaterThan(wiki);
		expect(archive).toBeGreaterThan(approval);
		expect(sequence.indexOf("core.delivery")).toBeGreaterThan(archive);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("no-openspec policy version documents and reviews before delivery without archive", () => {
	const root = repo();
	try {
		const sequence = drive(
			new WorkflowEngine(registerBuiltins()),
			root,
			"no-openspec",
			true,
		);
		const wiki = sequence.indexOf("core.wiki");
		const approval = sequence.indexOf("core.wiki-approval");
		const delivery = sequence.indexOf("core.delivery");
		expect(wiki).toBeGreaterThan(-1);
		expect(approval).toBeGreaterThan(wiki);
		expect(delivery).toBeGreaterThan(approval);
		expect(sequence.includes("core.archive")).toBe(false);
		expect(sequence.at(-1)).toBe("core.closed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("review-comments request-changes dispatch validates bounded comment entries", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = engine.start({
			repo: root,
			workflowId: "review-comments",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing,
		}).view;
		const worker = engine.getRun(
			root,
			requireDefined(
				view.runs.find((item) => item.role === "worker"),
				"worker run",
			).id,
		);
		let token = launchToken(engine, root, worker.id);
		fs.mkdirSync(
			path.dirname(requireDefined(worker.outputPath, "output path")),
			{ recursive: true },
		);
		fs.writeFileSync(
			requireDefined(worker.outputPath, "output path"),
			JSON.stringify({
				runId: worker.id,
				schemaId: worker.outputSchema?.id,
				schemaVersion: worker.outputSchema?.version,
				payload: { changed: true },
			}),
		);
		view = engine.dispatch(root, {
			type: "agent.handoff",
			runId: worker.id,
			generation: worker.generation,
			token,
			outcome: "complete",
			artifact: worker.outputPath,
		}).view;
		const triage = engine.getRun(
			root,
			requireDefined(
				view.runs.find((item) => item.role === "triage"),
				"triage run",
			).id,
		);
		token = launchToken(engine, root, triage.id);
		fs.mkdirSync(
			path.dirname(requireDefined(triage.outputPath, "output path")),
			{ recursive: true },
		);
		fs.writeFileSync(
			requireDefined(triage.outputPath, "output path"),
			JSON.stringify({
				runId: triage.id,
				schemaId: triage.outputSchema?.id,
				schemaVersion: triage.outputSchema?.version,
				payload: { roles: [] },
			}),
		);
		view = engine.dispatch(root, {
			type: "agent.handoff",
			runId: triage.id,
			generation: triage.generation,
			token,
			outcome: "complete",
			artifact: triage.outputPath,
		}).view;
		expect(view.currentStep.id).toBe("core.verification");
		const tester = view.runs.find(
			(item) =>
				item.role === "test-verifier" &&
				["pending", "working"].includes(item.status),
		);
		expect(tester).toBeTruthy();
		const testRun = engine.getRun(
			root,
			requireDefined(tester, "test-verifier run").id,
		);
		token = launchToken(engine, root, testRun.id);
		fs.mkdirSync(
			path.dirname(requireDefined(testRun.outputPath, "output path")),
			{ recursive: true },
		);
		fs.writeFileSync(
			requireDefined(testRun.outputPath, "output path"),
			JSON.stringify({
				runId: testRun.id,
				schemaId: testRun.outputSchema?.id,
				schemaVersion: testRun.outputSchema?.version,
				payload: { findings: [] },
			}),
		);
		view = engine.dispatch(root, {
			type: "agent.handoff",
			runId: testRun.id,
			generation: testRun.generation,
			token,
			outcome: "complete",
			artifact: testRun.outputPath,
		}).view;
		expect(view.currentStep.id).toBe("core.developer-review");
		expect(() =>
			engine.dispatch(root, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "review-comments",
				input: { comments: [{ body: "missing comment field" }] },
			}),
		).toThrow(/invalid review comment/);
		const reported = engine.dispatch(root, {
			type: "developer.action",
			workflowId: view.workflowId,
			revision: view.revision,
			actionId: "review-comments",
			input: { comments: [{ comment: "use const", file: "a.ts", line: 2 }] },
		}).view;
		expect(reported.currentStep.id).toBe("core.implementation");
		expect(engine.getSnapshot(root, reported.workflowId).step.mode).toBe(
			"review-fix",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Classifier-driven verifier-role routing (classifier-driven-triage-routing)
// ---------------------------------------------------------------------------

/** Start a workflow on the triage-routing tier, complete implementation, and
 * answer the routing classification with `data`. The pinned routing is
 * pre-seeded, so the result data is all the classification contributes. */
/** The roles the view launched at one step (a view also lists earlier runs). */
function stepRoles(view: WorkflowView, stepId: string): string[] {
	return view.runs
		.filter((run) => run.stepId === stepId)
		.map((run) => run.role);
}

function startRoutedRound(
	engine: WorkflowEngine,
	root: string,
	data: unknown,
	workflowId = "triage-routing",
): WorkflowView {
	const view = engine.start({
		repo: root,
		workflowId,
		definitionId: "no-openspec",
		definitionVersion: definitionVersionForTriageRouting(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: requireDefined(
				execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: root,
					encoding: "utf8",
				}).trim(),
				"base commit",
			),
			task: "task",
		},
		routing,
	}).view;
	fs.writeFileSync(path.join(root, "implementation.txt"), "changed\n");
	const implemented = complete(engine, root, view, "worker", { changed: true });
	expect(implemented.currentStep.id).toBe("core.triage-route");
	const classify = requireEffect(
		engine.claimEffects(root, 100),
		"model.classify",
	);
	expect((classify.payload as { integration?: string }).integration).toBe(
		"triage",
	);
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: classify.id,
		lease: requireDefined(classify.lease, "classify lease"),
		outcome: "complete",
		data,
	}).view;
}

test("a zero-role classification bypasses triage and runs the full suite only", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const routed = startRoutedRound(engine, root, {
			integration: "triage",
			roles: [],
		});
		// Triage is skipped entirely: the round goes straight to verification.
		expect(routed.currentStep.id).toBe("core.verification");
		expect(stepRoles(routed, "core.verification")).toEqual(["test-verifier"]);
		const passed = complete(engine, root, routed, "test-verifier", {
			findings: [],
		});
		expect(passed.currentStep.id).toBe("core.developer-review");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a selected classification locks the round's roles into triage", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const routed = startRoutedRound(engine, root, {
			integration: "triage",
			roles: ["quality-verifier", "security-verifier"],
		});
		expect(routed.currentStep.id).toBe("core.triage");
		// The locked set is the triage assignment's step input.
		expect(engine.getSnapshot(root, routed.workflowId).step.context).toEqual({
			roles: ["quality-verifier", "security-verifier"],
		});
		const scoped = complete(engine, root, routed, "triage", {
			roles: [
				{
					role: "quality-verifier",
					reason: "runner correctness",
					files: ["implementation.txt"],
				},
			],
		});
		expect(scoped.currentStep.id).toBe("core.verification");
		expect(stepRoles(scoped, "core.verification")).toEqual([
			"quality-verifier",
		]);
		// The engine still launches the full suite after the selected verifiers.
		const afterVerifier = complete(engine, root, scoped, "quality-verifier", {
			findings: [],
		});
		expect(
			stepRoles(afterVerifier, "core.verification").filter(
				(role) => role === "test-verifier",
			),
		).toEqual(["test-verifier"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a fail-open classification leaves triage unconstrained and records attention", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const routed = startRoutedRound(engine, root, {
			integration: "triage",
			failOpen: true,
			reason: "classifier triage requires OPENCODE_API_KEY",
		});
		expect(routed.currentStep.id).toBe("core.triage");
		expect(
			engine.getSnapshot(root, routed.workflowId).step.selectedRoles,
		).toEqual([]);
		expect(
			engine.getSnapshot(root, routed.workflowId).attention?.join(" "),
		).toContain("OPENCODE_API_KEY");
		// Unconstrained triage: a role the classifier never saw is still valid.
		const scoped = complete(engine, root, routed, "triage", {
			roles: [
				{
					role: "security-verifier",
					reason: "secret boundary",
					files: ["implementation.txt"],
				},
			],
		});
		expect(scoped.currentStep.id).toBe("core.verification");
		expect(stepRoles(scoped, "core.verification")).toEqual([
			"security-verifier",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a second verification round re-runs the classifier routing step", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		// Round 1 selects one role; its critical finding sends the round to fix.
		let view = startRoutedRound(
			engine,
			root,
			{ integration: "triage", roles: ["quality-verifier"] },
			"triage-routing-rounds",
		);
		view = complete(engine, root, view, "triage", {
			roles: [
				{
					role: "quality-verifier",
					reason: "runner correctness",
					files: ["implementation.txt"],
				},
			],
		});
		expect(view.currentStep.id).toBe("core.verification");
		view = complete(engine, root, view, "quality-verifier", {
			findings: [
				{
					id: "Q-1",
					severity: "critical",
					detail: "runner mishandles an empty input",
					path: "implementation.txt",
					line: 1,
				},
			],
		});
		// The round loops back through implementation into the routing step.
		expect(view.currentStep.id).toBe("core.implementation");
		fs.writeFileSync(path.join(root, "implementation.txt"), "changed again\n");
		view = complete(engine, root, view, "worker", { changed: true });
		expect(view.currentStep.id).toBe("core.triage-route");

		// A second `model.classify` must be enqueued: the step is re-entered
		// with the same attempt, so a per-attempt idempotency key would be
		// dropped by the outbox and strand the round here forever.
		const classify = requireEffect(
			engine.claimEffects(root, 100),
			"model.classify",
		);
		view = engine.dispatch(root, {
			type: "effect.result",
			effectId: classify.id,
			lease: requireDefined(classify.lease, "classify lease"),
			outcome: "complete",
			data: { integration: "triage", roles: ["security-verifier"] },
		}).view;
		expect(view.currentStep.id).toBe("core.triage");
		// The round's own selection is what triage is constrained by, not the
		// previous round's.
		expect(engine.getSnapshot(root, view.workflowId).step.context).toEqual({
			roles: ["security-verifier"],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
