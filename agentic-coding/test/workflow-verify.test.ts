// The verify-only workflow family: verification of the current branch against
// the configured base branch, with no planning or implementation phase. This
// pins the two things it exists for — the change set is the whole branch
// (`merge-base(base, HEAD)..worktree`, committed work included, uncommitted
// work allowed), and every round's findings land on a developer review that
// selects what a worker fixes before verification runs again.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type {
	AgentHandle,
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import { loadDeveloperReviewFindings } from "../src/server/operations/observations.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { changedFilesIn, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	prepareWorkflowStart,
	validateStart,
} from "../src/workflow/startup.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
	execFileSync(
		"git",
		[
			"-c",
			"user.name=T",
			"-c",
			"user.email=t@example.com",
			"commit",
			"-qm",
			message,
		],
		{ cwd },
	);
}

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe", "shell", "edit"],
	digest: "fake",
};
/** Every agent step the verify graph runs; the pinned routing resolves each
 * run's profile from here (verifier roles included, as the shared loop does). */
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [
		{ stepId: "core.triage", profile },
		{ stepId: "core.verification", profile },
		{ stepId: "core.implementation", profile },
	],
};

class Adapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	contexts: LaunchContext[] = [];
	preflight() {}
	launch(ctx: LaunchContext) {
		this.contexts.push(ctx);
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		} satisfies AgentHandle);
	}
	prompt() {
		return Effect.void;
	}
	observe() {
		return Effect.succeed({ status: "working" } as const);
	}
	stop() {
		return Effect.void;
	}
}

/** A checkout on `main` with a `base` branch behind it: `base` is the fixture
 * commit, `main` carries one commit on top, and the worktree has one more
 * uncommitted file. Both are in the verify change set; only the committed one
 * is in `base..HEAD`. */
function verifyRepo(): { root: string; baseCommit: string } {
	const root = createRepoFixture("verify-", repoPreset.readme);
	git(root, ["branch", "base"]);
	const baseCommit = git(root, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(root, "committed.txt"), "committed\n");
	git(root, ["add", "committed.txt"]);
	commit(root, "branch work");
	fs.writeFileSync(path.join(root, "uncommitted.txt"), "uncommitted\n");
	return { root, baseCommit };
}

function startVerify(
	engine: WorkflowEngine,
	root: string,
	baseCommit: string,
	workflowId = "verify-task",
): WorkflowView {
	return engine.start({
		repo: root,
		mode: "checkout",
		workflowId,
		definitionId: "verify",
		// What the real start path resolves: the newest tier, where every
		// classifiable step selects its model immediately before it runs.
		definitionVersion: definitionVersionForStepRouting(6),
		metadata: {
			branch: git(root, ["branch", "--show-current"]),
			baseBranch: "base",
			baseCommit,
		},
		routing,
	}).view;
}

/** Complete a `model.classify` effect with the answer its integration reads. */
function classify(
	engine: WorkflowEngine,
	root: string,
	integration: "routing" | "triage",
	data: Record<string, unknown>,
): void {
	const effect = engine
		.claimEffects(root, 100)
		.find(
			(item) =>
				item.kind === "model.classify" &&
				(item.payload as { integration?: string }).integration === integration,
		);
	if (!effect) throw new Error(`missing ${integration} classification`);
	engine.dispatch(root, {
		type: "effect.result",
		effectId: effect.id,
		lease: requireDefined(effect.lease, "classify lease"),
		outcome: "complete",
		data: { integration, ...data },
	});
}

/** Hand one role's run off as `complete`, the way its agent would. */
function complete(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	role: string,
	payload: unknown,
): WorkflowView {
	const summary = view.runs.find(
		(run) => run.role === role && ["pending", "working"].includes(run.status),
	);
	const run = engine.getRun(root, requireDefined(summary, `${role} run`).id);
	const launch = engine
		.claimEffects(root, 100)
		.find(
			(effect) =>
				effect.kind === "agent.launch" &&
				(effect.payload as { runId?: string }).runId === run.id,
		);
	if (!launch?.runToken) throw new Error(`missing ${role} launch token`);
	const outputPath = requireDefined(run.outputPath, `${role} output path`);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
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
		token: launch.runToken,
		outcome: "complete",
		artifact: outputPath,
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

/** Drive the graph from its initial step to the verifier round: the round's
 * classifier gate, the triage model pass, the triage plan, and the verification
 * model pass. */
function reachVerification(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): WorkflowView {
	classify(engine, root, "triage", { roles: ["quality-verifier"] });
	view = engine.status(root, view.workflowId);
	expect(view.currentStep.id).toBe("core.route-triage");
	classify(engine, root, "routing", { phase: "apply", answers: {} });
	view = engine.status(root, view.workflowId);
	expect(view.currentStep.id).toBe("core.triage");
	view = complete(engine, root, view, "triage", {
		roles: [
			{
				role: "quality-verifier",
				reason: "the branch changed",
				files: ["committed.txt"],
			},
		],
	});
	expect(view.currentStep.id).toBe("core.route-verification");
	classify(engine, root, "routing", { phase: "apply", answers: {} });
	view = engine.status(root, view.workflowId);
	expect(view.currentStep.id).toBe("core.verification");
	return view;
}

test("the verify definition is triage, verification, and a findings review", () => {
	const registry = registerBuiltins();
	const version = definitionVersionForStepRouting(6);
	const definition = registry.definition("verify", version);
	expect(definition.initial).toBe("core.triage-route");
	expect([...definition.steps].sort()).toEqual([
		"core.closed",
		"core.completed",
		"core.findings-review",
		"core.implementation",
		"core.route-implementation",
		"core.route-triage",
		"core.route-verification",
		"core.triage",
		"core.triage-route",
		"core.verification",
	]);
	for (const absent of [
		"core.plan",
		"core.plan-approval",
		"core.developer-review",
		"core.review-gate",
		"core.wiki",
		"core.archive",
		"core.delivery",
	])
		expect(definition.steps).not.toContain(absent);
	expect(definition.terminal).toEqual(["core.closed"]);
	// The checkout contract: the repository checkout, the branch it is already
	// on, and no clean-tree requirement (which `checkoutRequired` also switches
	// off in the engine's own start guard).
	expect(definition.policy).toEqual({
		targetKind: "repository",
		checkoutRequired: true,
		requiresReadOnlyResearcher: false,
	});
	// Every tier carries the family, so a pinned lookup still resolves it.
	expect(registry.definition("verify", 1).steps).toEqual([
		"core.triage-route",
		"core.triage",
		"core.verification",
		"core.findings-review",
		"core.implementation",
		"core.completed",
		"core.closed",
	]);
});

test("the startup boundary verifies the current branch from its merge base", () => {
	const { root, baseCommit } = verifyRepo();
	const config = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "verify-config-")),
		"config.json",
	);
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.HERDR_WORKFLOW_CONFIG = config;
	try {
		fs.writeFileSync(
			config,
			`${JSON.stringify({
				workflow: { base_branch: "base", remote: "origin" },
				agents: {
					default_profile: "p",
					profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
					presets: {
						fixed: {
							default_profile: "p",
							pools: Object.fromEntries(
								["core.triage", "core.verification", "core.implementation"].map(
									(stepId) => [
										stepId,
										[{ label: "only", profile: "p", default: true }],
									],
								),
							),
						},
					},
				},
			})}\n`,
		);
		// The worktree is dirty on purpose: verifying the current state is the
		// point, and neither boundary may refuse it.
		const prepared = prepareWorkflowStart({
			repo: root,
			workflowId: "verify-start",
			definitionId: "verify",
			mode: "checkout",
			preset: "fixed",
		});
		expect(prepared.input.metadata?.branch).toBe("main");
		expect(prepared.input.metadata?.baseBranch).toBe("base");
		// The branch's own change set starts at the merge base, not at HEAD: the
		// committed branch work is inside it.
		expect(prepared.input.metadata?.baseCommit).toBe(baseCommit);
		expect(prepared.input.mode).toBe("checkout");
		expect(() =>
			prepareWorkflowStart({
				repo: root,
				workflowId: "verify-worktree",
				definitionId: "verify",
				mode: "worktree",
				preset: "fixed",
			}),
		).toThrow(/checkout mode/);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the startup guard needs a resolvable base and tolerates a dirty tree", () => {
	const { root } = verifyRepo();
	try {
		// No base configured: nothing to measure the branch against.
		expect(() => validateStart(root, "verify-guard", "verify")).toThrow(
			/requires a base branch/,
		);
		expect(() =>
			validateStart(root, "verify-guard", "verify", undefined, {
				baseBranch: "absent",
			}),
		).toThrow(/base branch does not resolve/);
		expect(() =>
			validateStart(root, "verify-guard", "verify", undefined, {
				baseBranch: "base",
			}),
		).not.toThrow();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the change set is the whole branch, committed and uncommitted", () => {
	const { root, baseCommit } = verifyRepo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const view = startVerify(engine, root, baseCommit);
		const changed = changedFilesIn(engine.getSnapshot(root, view.workflowId));
		expect(changed).toContain("committed.txt");
		expect(changed).toContain("uncommitted.txt");
		// A file the base already had and the branch did not touch is not scope.
		expect(changed).not.toContain("README.md");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a failed round lands on the findings review, which selects the worker's fixes", async () => {
	const { root, baseCommit } = verifyRepo();
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		let view = startVerify(engine, root, baseCommit, "verify-round");
		const handlers = agentEffectHandlers(root, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		const runner = new EffectRunner(root, engine, handlers);
		// The workspace preflight only: the checkout is already on the branch, so
		// it is satisfied without switching anything.
		await runner.drain(1);
		expect(git(root, ["branch", "--show-current"])).toBe("main");
		view = reachVerification(
			engine,
			root,
			engine.status(root, view.workflowId),
		);

		// The verifier reports a critical finding: the round fails, and the
		// workflow hands the findings to the developer instead of looping.
		view = complete(engine, root, view, "quality-verifier", {
			findings: [
				{
					id: "Q-001",
					severity: "critical",
					detail: "committed work is broken",
					path: "committed.txt",
					line: 1,
				},
			],
		});
		expect(view.currentStep.id).toBe("core.findings-review");
		expect(view.status).toBe("active");
		// The findings review offers the developer review's decision.
		expect(view.availableActions?.map((item) => item.id)).toEqual([
			"approve-review",
			"review-comments",
		]);
		// The review popup's read includes the critical finding, which the
		// developer review of a passing change deliberately filters out.
		const findings = loadDeveloperReviewFindings(root, view.workflowId);
		expect(findings.map((item) => item.severity)).toEqual(["critical"]);
		expect(findings[0]?.path).toBe("committed.txt");

		// Requesting the fix hands the comments to the worker in review-fix mode.
		view = action(engine, root, view, "review-comments", {
			comments: [
				{
					comment: "restore the committed behavior",
					file: "committed.txt",
					line: 1,
					findingId: "Q-001",
				},
			],
		});
		expect(view.currentStep.id).toBe("core.route-implementation");
		classify(engine, root, "routing", { phase: "apply", answers: {} });
		view = engine.status(root, view.workflowId);
		expect(view.currentStep.id).toBe("core.implementation");
		const snapshot = engine.getSnapshot(root, view.workflowId);
		expect(snapshot.step.mode).toBe("review-fix");
		expect(snapshot.step.context).toEqual({
			comments: [
				{
					comment: "restore the committed behavior",
					file: "committed.txt",
					line: 1,
					findingId: "Q-001",
				},
			],
		});

		// The worker's completion re-enters the round at the classifier gate.
		view = complete(engine, root, view, "worker", { fixed: true });
		expect(view.currentStep.id).toBe("core.triage-route");

		// The second round runs the same way, so the developer reviews again.
		classify(engine, root, "triage", { roles: ["quality-verifier"] });
		view = engine.status(root, view.workflowId);
		classify(engine, root, "routing", { phase: "apply", answers: {} });
		view = engine.status(root, view.workflowId);
		expect(view.currentStep.id).toBe("core.triage");
		view = complete(engine, root, view, "triage", {
			roles: [
				{
					role: "quality-verifier",
					reason: "the branch changed",
					files: ["committed.txt"],
				},
			],
		});
		classify(engine, root, "routing", { phase: "apply", answers: {} });
		view = engine.status(root, view.workflowId);
		expect(view.currentStep.id).toBe("core.verification");
		view = complete(engine, root, view, "quality-verifier", { findings: [] });
		// No critical findings: the engine-owned full suite still runs before the
		// round can pass.
		expect(view.currentStep.id).toBe("core.verification");
		view = complete(engine, root, view, "test-verifier", { findings: [] });
		expect(view.currentStep.id).toBe("core.findings-review");

		// Approving the findings completes the workflow; there is no delivery or
		// documentation step to continue into.
		view = action(engine, root, view, "approve-review");
		expect(view.currentStep.id).toBe("core.completed");
		expect(view.status).toBe("completed");
		expect(() => action(engine, root, view, "create-pr")).toThrow();
		view = action(engine, root, view, "close");
		expect(view.currentStep.id).toBe("core.closed");
		expect(view.status).toBe("closed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
