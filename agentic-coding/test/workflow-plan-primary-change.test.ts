// Focused verification for planner-owned change identity: the user supplies a
// workflow id at start; the planner declares the primary change id at plan
// handoff and the engine records it (plan-result contract), fusion
// consolidation records it the same way, and HERDR_CHANGE_ID is injected only
// after the primary is recorded.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import { clarificationSources } from "../src/server/clarification.ts";
import { decodePlanResult } from "../src/workflow/definitions/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import {
	validateChangeId,
	validateWorkflowId,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function repository(root: string): string {
	return createRepoFixture(root, {
		files: { "openspec/config.yaml": "schema: spec\n" },
	});
}
function profile(name = "fake"): ResolvedProfile {
	return {
		name,
		runtime: "pi-durable",
		executable: process.execPath,
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"],
		digest: "fake",
	};
}
function routing(): WorkflowRouting {
	return {
		defaultProfile: "fake",
		routes: ["core.plan", "core.implementation", "core.archive"].map(
			(stepId) => ({ stepId, profile: profile() }),
		),
	};
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
function runForRole(view: WorkflowView, role: string) {
	const summary = view.runs.find(
		(run) => run.role === role && ["pending", "working"].includes(run.status),
	);
	if (!summary) throw new Error(`missing ${role} run`);
	return summary;
}

/** Complete the plan-phase routing pass so the planner run exists. The pinned
 * routing is pre-seeded, so the no-answer result keeps it. */
function advanceRouting(
	engine: WorkflowEngine,
	repo: string,
	view: WorkflowView,
): WorkflowView {
	const classify = engine
		.claimEffects(repo, 100)
		.find((effect) => effect.kind === "model.classify");
	if (!classify) return view;
	if (!classify.lease) throw new Error("missing classify lease");
	const phase =
		(classify.payload as { phase?: string }).phase === "apply"
			? "apply"
			: "plan";
	return engine.dispatch(repo, {
		type: "effect.result",
		effectId: classify.id,
		lease: classify.lease,
		outcome: "complete",
		data: { integration: "routing", phase, answers: {} },
	}).view;
}
function handoff(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	role: string,
	payload: unknown,
	outcome: "complete" | "blocked" | "failed" = "complete",
): WorkflowView {
	const summary = runForRole(view, role);
	const run = engine.getRun(root, summary.id);
	const token = launchToken(engine, root, run.id);
	if (outcome === "complete") {
		if (!run.outputPath) throw new Error("run has no output path");
		fs.mkdirSync(path.dirname(run.outputPath), { recursive: true });
		fs.writeFileSync(
			run.outputPath,
			JSON.stringify({
				runId: run.id,
				schemaId: run.outputSchema?.id,
				schemaVersion: run.outputSchema?.version,
				payload,
			}),
		);
	}
	return engine.dispatch(root, {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token,
		outcome,
		...(outcome === "complete" ? { artifact: run.outputPath } : {}),
		...(outcome === "complete" ? {} : { message: "declined" }),
	}).view;
}
function seedChange(root: string, changeId: string): void {
	const change = path.join(root, "openspec", "changes", changeId);
	fs.mkdirSync(path.join(change, "specs", "feature"), { recursive: true });
	for (const file of ["proposal.md", "design.md", "tasks.md"])
		fs.writeFileSync(path.join(change, file), "- [x] task\n");
	fs.writeFileSync(
		path.join(change, "specs", "feature", "spec.md"),
		"#### Scenario: works\n",
	);
}
/** Plan/consolidate completion is gated on the openspec.validate effect; the
 * workflow advances only once that effect completes. */
function completeEffect(
	engine: WorkflowEngine,
	root: string,
	kind: "openspec.validate",
): WorkflowView {
	const validation = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === kind);
	if (!validation?.lease) throw new Error(`missing ${kind} effect`);
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: validation.id,
		lease: validation.lease,
		outcome: "complete",
	}).view;
}

describe("planner-owned change identity (allow-planners-to-create-multiple-proposals)", () => {
	test("workflow ids and planner change ids share one bounded shape", () => {
		expect(validateWorkflowId("safe-workflow")).toBe("safe-workflow");
		expect(validateChangeId("safe-change")).toBe("safe-change");
		for (const value of ["../escape", "a/b", "UPPER", "", `a${"b".repeat(80)}`])
			for (const validate of [validateWorkflowId, validateChangeId])
				expect(() => validate(value)).toThrow(/1-80 lowercase/);
	});

	test("plan-result contract requires the declared primary change id", () => {
		expect(() => decodePlanResult({ validated: true })).toThrow(
			/primaryChangeId/,
		);
		expect(() => decodePlanResult({})).toThrow(/primaryChangeId/);
		expect(decodePlanResult({ primaryChangeId: "primary" })).toEqual({
			primaryChangeId: "primary",
		});
		expect(
			decodePlanResult({
				primaryChangeId: "primary",
				summary: "plan",
				artifacts: ["a.md"],
				risks: ["r"],
				openQuestions: ["q"],
			}),
		).toEqual({
			primaryChangeId: "primary",
			summary: "plan",
			artifacts: ["a.md"],
			risks: ["r"],
			openQuestions: ["q"],
		});
	});

	test("start keys on the workflow id: duplicate ids are rejected and change id stays empty pre-plan", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-primary-start-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				workflowId: "dup-guard",
				definitionId: "openspec",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			expect(started.snapshot.workflowId).toBe("dup-guard");
			expect(started.snapshot.metadata.changeId).toBe("");
			expect(engine.status(repo, "dup-guard").workflowId).toBe("dup-guard");
			// The store lives inside the repository; ignore and commit it so the
			// duplicate attempt passes the clean-tree guard and reaches the id guard.
			fs.writeFileSync(path.join(repo, ".gitignore"), ".herdr-workflow\n");
			execFileSync("git", ["add", ".gitignore"], { cwd: repo });
			execFileSync(
				"git",
				[
					"-c",
					"user.email=test@example.com",
					"-c",
					"user.name=Test",
					"commit",
					"-qm",
					"ignore workflow store",
				],
				{ cwd: repo },
			);
			expect(() =>
				engine.start({
					repo,
					workflowId: "dup-guard",
					definitionId: "openspec",
					metadata: {
						branch: "main",
						baseBranch: "main",
						baseCommit: "base",
					},
					routing: routing(),
				}),
			).toThrow(/workflow already exists: dup-guard \(status: [a-z-]+\)/);
			// The status is the part the developer needs to act on: the orchestrator
			// relays this refusal, and "already exists" alone does not say whether
			// that id is finished, waiting on them, or still running.
			expect(() =>
				engine.start({
					repo,
					workflowId: "dup-guard",
					definitionId: "openspec",
					metadata: {
						branch: "main",
						baseBranch: "main",
						baseCommit: "base",
					},
					routing: routing(),
				}),
			).toThrow(`status: ${engine.status(repo, "dup-guard").status}`);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("plan completion records the declared primary and advances; undeclared or incomplete primaries reject without recording", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "plan-primary-recording-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = advanceRouting(
				engine,
				repo,
				engine.start({
					repo,
					workflowId: "primary-recording",
					definitionId: "openspec",
					metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
					routing: routing(),
				}).view,
			);
			const run = runForRole(view, "planner");
			const token = launchToken(engine, repo, run.id);
			const outputPath = engine.getRun(repo, run.id).outputPath;
			if (!outputPath) throw new Error("run has no output path");
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			const submit = (payload: unknown) => {
				fs.writeFileSync(
					outputPath,
					JSON.stringify({
						runId: run.id,
						schemaId: "core.json",
						schemaVersion: 1,
						payload,
					}),
				);
				return engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: engine.getRun(repo, run.id).generation,
					token,
					outcome: "complete",
					artifact: outputPath,
				});
			};
			// No primary declared: completion rejected; nothing recorded or advanced.
			expect(() => submit({ planned: true })).toThrow(/primary change id/);
			expect(engine.status(repo, "primary-recording").revision).toBe(
				view.revision,
			);
			// Primary points at a missing directory: rejected by the entry guard.
			expect(() => submit({ primaryChangeId: "missing-dir" })).toThrow(
				/planning artifact invalid: proposal.md/,
			);
			expect(engine.status(repo, "primary-recording").revision).toBe(
				view.revision,
			);
			// Valid primary: recorded and the workflow advances once the
			// plan-gated openspec.validate effect completes.
			seedChange(repo, "primary");
			view = submit({ primaryChangeId: "primary", planned: true }).view;
			expect(engine.getSnapshot(repo, view.workflowId).metadata.changeId).toBe(
				"primary",
			);
			// The plan-gated openspec.validate effect targets the recorded primary.
			const validation = engine
				.claimEffects(repo, 100)
				.find((effect) => effect.kind === "openspec.validate");
			expect(validation).toBeDefined();
			if (!validation) throw new Error("missing openspec.validate effect");
			expect((validation.payload as { changeId?: unknown }).changeId).toBe(
				"primary",
			);
			if (!validation.lease) throw new Error("missing openspec.validate lease");
			view = engine.dispatch(repo, {
				type: "effect.result",
				effectId: validation.id,
				lease: validation.lease,
				outcome: "complete",
			}).view;
			expect(view.currentStep.id).toBe("core.plan-approval");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("HERDR_CHANGE_ID is absent during planning and equals the recorded primary afterwards", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-primary-env-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = advanceRouting(
				engine,
				repo,
				engine.start({
					repo,
					workflowId: "env-guard",
					definitionId: "openspec",
					metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
					routing: routing(),
				}).view,
			);
			const registry = registerBuiltins();
			const plannerRun = runForRole(view, "planner");
			const plannerAssignment = effectRunnerTest.renderedAssignment(
				engine,
				repo,
				registry,
				plannerRun.id,
				"token",
			).assignment;
			expect(plannerAssignment.environment.HERDR_WORKFLOW_ID).toBe("env-guard");
			expect(plannerAssignment.environment.HERDR_CHANGE_ID).toBeUndefined();
			seedChange(repo, "env-primary");
			view = handoff(engine, repo, view, "planner", {
				primaryChangeId: "env-primary",
			});
			view = completeEffect(engine, repo, "openspec.validate");
			expect(view.currentStep.id).toBe("core.plan-approval");
			const after = advanceRouting(
				engine,
				repo,
				engine.dispatch(repo, {
					type: "developer.action",
					workflowId: view.workflowId,
					revision: view.revision,
					actionId: "approve-plan",
				}).view,
			);
			const workerRun = runForRole(after, "worker");
			const workerAssignment = effectRunnerTest.renderedAssignment(
				engine,
				repo,
				registry,
				workerRun.id,
				"token",
			).assignment;
			expect(workerAssignment.environment.HERDR_CHANGE_ID).toBe("env-primary");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("session content capture reaches the run environment only when opted in", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-content-capture-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const view = advanceRouting(
				engine,
				repo,
				engine.start({
					repo,
					workflowId: "content-capture",
					definitionId: "openspec",
					metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
					routing: routing(),
				}).view,
			);
			const registry = registerBuiltins();
			const run = runForRole(view, "planner");
			// Off by default: the bridges stay metadata-only without the opt-in.
			const off = effectRunnerTest.renderedAssignment(
				engine,
				repo,
				registry,
				run.id,
				"token",
			).assignment;
			expect(off.environment.HERDR_CAPTURE_CONTENT).toBeUndefined();
			// The same flag the engine uses for its own payloads is forwarded to the
			// run environment the runtime bridges read.
			const on = effectRunnerTest.renderedAssignment(
				engine,
				repo,
				registry,
				run.id,
				"token",
				true,
			).assignment;
			expect(on.environment.HERDR_CAPTURE_CONTENT).toBe("1");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("the plan's file list reaches the implementation assignment", () => {
	/** Drive the openspec family from start to the worker run the approved plan
	 * launches, with the planner's own payload. */
	function toWorker(
		repo: string,
		payload: Record<string, unknown>,
		workflowId: string,
	): { engine: WorkflowEngine; repo: string; view: WorkflowView } {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = advanceRouting(
			engine,
			repo,
			engine.start({
				repo,
				workflowId,
				definitionId: "openspec",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			}).view,
		);
		seedChange(repo, "scope-change");
		view = handoff(engine, repo, view, "planner", payload);
		view = completeEffect(engine, repo, "openspec.validate");
		view = advanceRouting(
			engine,
			repo,
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "approve-plan",
			}).view,
		);
		return { engine, repo, view };
	}

	function workerPrompt(
		engine: WorkflowEngine,
		repo: string,
		view: WorkflowView,
	): string {
		const registry = registerBuiltins();
		const run = runForRole(view, "worker");
		return effectRunnerTest.renderedAssignment(
			engine,
			repo,
			registry,
			run.id,
			launchToken(engine, repo, run.id),
		).rendered.prompt;
	}

	test("operator plan approval pins immutable design bytes, not later live edits, across engine reopen", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approved-design-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const { view } = toWorker(
				repo,
				{ primaryChangeId: "scope-change" },
				"approved-design",
			);
			expect(view.approvedDesign?.content).toBe("- [x] task\n");
			const agreed = clarificationSources(view).find(
				(source) => source.kind === "design" && source.eligible,
			);
			expect(agreed?.id).toBe(
				`approved-design:${view.approvedDesign?.revision}`,
			);
			expect(agreed?.digest).toBe(view.approvedDesign?.digest);
			fs.writeFileSync(
				path.join(view.worktree, "openspec/changes/scope-change/design.md"),
				"Unapproved later edit\n",
			);
			const reopened = new WorkflowEngine(registerBuiltins()).status(
				repo,
				view.workflowId,
			);
			expect(
				clarificationSources(reopened).find(
					(source) => source.kind === "design" && source.eligible,
				),
			).toEqual(agreed);
			expect(
				clarificationSources(reopened).find(
					(source) => source.id === "design.md",
				),
			).toMatchObject({ content: "Unapproved later edit\n", eligible: false });
			const liveFile = path.join(
				view.worktree,
				"openspec/changes/scope-change/design.md",
			);
			fs.writeFileSync(liveFile, "x".repeat(128 * 1024 + 1));
			expect(
				clarificationSources(reopened).some(
					(source) => source.id === "design.md",
				),
			).toBe(false);
			const outside = path.join(tmp, "outside-design.md");
			fs.writeFileSync(outside, "Not worktree evidence");
			fs.unlinkSync(liveFile);
			fs.symlinkSync(outside, liveFile);
			expect(
				clarificationSources(reopened).some(
					(source) => source.id === "design.md",
				),
			).toBe(false);
			expect(
				clarificationSources(reopened).find(
					(source) => source.kind === "design" && source.eligible,
				),
			).toEqual(agreed);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("the declared artifacts are rendered as the plan's file list", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const { engine, view } = toWorker(
				repo,
				{
					primaryChangeId: "scope-change",
					artifacts: [
						"openspec/changes/scope-change/proposal.md",
						"src/workflow/assignment.ts",
					],
				},
				"plan-files",
			);
			const prompt = workerPrompt(engine, repo, view);
			expect(prompt).toContain(
				"Plan files: openspec/changes/scope-change/proposal.md src/workflow/assignment.ts",
			);
			// The tool surface is in the first lines, before the objective, so a
			// follow-up attempt that re-sends the dynamic envelope carries it.
			expect(prompt.indexOf("## Tool surface")).toBeLessThan(
				prompt.indexOf("## Objective"),
			);
			expect(prompt).toContain("Emit every independent call");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("a plan without a file list forwards none, and a lost artifact degrades", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-absent-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const { engine, view } = toWorker(
				repo,
				{ primaryChangeId: "scope-change" },
				"plan-files-absent",
			);
			expect(workerPrompt(engine, repo, view)).not.toContain("Plan files:");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}

		const lost = fs.mkdtempSync(path.join(os.tmpdir(), "plan-files-lost-"));
		try {
			const repo = repository(path.join(lost, "repo"));
			const { engine, view } = toWorker(
				repo,
				{ primaryChangeId: "scope-change", artifacts: ["src/a.ts"] },
				"plan-files-lost",
			);
			// The recorded plan artifact was removed between the handoff and this
			// render: the assignment is rendered without the list, and the launch
			// is not failed.
			const run = runForRole(view, "worker");
			const planArtifact = engine
				.getSnapshot(repo, view.workflowId)
				.evidence.find((entry) => entry.kind === "core.plan:planner");
			if (!planArtifact) throw new Error("missing recorded plan artifact");
			fs.rmSync(planArtifact.path, { force: true });
			const prompt = workerPrompt(engine, repo, view);
			expect(prompt).not.toContain("Plan files:");
			expect(prompt).toContain(`Run: ${run.id}`);
		} finally {
			fs.rmSync(lost, { recursive: true, force: true });
		}
	});
});
