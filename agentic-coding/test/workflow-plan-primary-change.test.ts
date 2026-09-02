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
} from "../src/workflow/contracts.ts";
import { planResult } from "../src/workflow/definitions/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import {
	validateChangeId,
	validateWorkflowId,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";

function repository(root: string): string {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	fs.mkdirSync(path.join(root, "openspec"));
	fs.writeFileSync(
		path.join(root, "openspec", "config.yaml"),
		"schema: spec\n",
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
function profile(name = "fake"): ResolvedProfile {
	return {
		name,
		runtime: "pi",
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
		expect(() => planResult.parse({ validated: true })).toThrow(
			/primaryChangeId/,
		);
		expect(() => planResult.parse({})).toThrow(/primaryChangeId/);
		expect(planResult.parse({ primaryChangeId: "primary" })).toEqual({
			primaryChangeId: "primary",
		});
		expect(
			planResult.parse({
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
				definitionId: "openspec-full",
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
					definitionId: "openspec-full",
					metadata: {
						branch: "main",
						baseBranch: "main",
						baseCommit: "base",
					},
					routing: routing(),
				}),
			).toThrow(/workflow already exists: dup-guard/);
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
			let view = engine.start({
				repo,
				workflowId: "primary-recording",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			}).view;
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
			expect(engine.status(repo, "primary-recording").revision).toBe(0);
			// Primary points at a missing directory: rejected by the entry guard.
			expect(() => submit({ primaryChangeId: "missing-dir" })).toThrow(
				/planning artifact invalid: proposal.md/,
			);
			expect(engine.status(repo, "primary-recording").revision).toBe(0);
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
			let view = engine.start({
				repo,
				workflowId: "env-guard",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			}).view;
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
			const after = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "approve-plan",
			}).view;
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
});
