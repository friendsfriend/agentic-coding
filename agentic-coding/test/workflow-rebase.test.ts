// The rebase workflow family: one agent that rebases a selected branch onto a
// selected target in the repository checkout and resolves the conflicts. This
// pins the two things it exists for — the graph has no review, wiki, or
// delivery step, and the launch selects both refs instead of inheriting the
// checked-out branch — plus the checkout preflight (`workspace.setup`) that
// switches the branch, fetches the target remote once, and refuses a source or
// target that is not there.
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
import { discoverBranches } from "../src/server/operations/observations.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
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
/** The rebase graph's only classifiable step; a start pins its profile here. */
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [{ stepId: "core.rebase", role: "worker", profile }],
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

/** A repository with a `main`, a `feature/topic` branch, and a bare `origin`
 * whose `main` is one commit ahead of the local checkout. The test that proves
 * the start boundary fetches deletes the remote-tracking ref itself, so a
 * direct engine start still finds the target ref it validates. */
function rebaseRepo(): { root: string; originHead: string } {
	const root = createRepoFixture("rebase-", repoPreset.readme);
	const origin = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-origin-"));
	git(origin, ["init", "-q", "--bare", "-b", "main"]);
	git(root, ["remote", "add", "origin", origin]);
	git(root, ["push", "-q", "origin", "main"]);
	git(root, ["branch", "feature/topic"]);
	// Advance origin/main past the local checkout so a fetch has something to
	// bring back.
	git(root, ["checkout", "-q", "-b", "advance"]);
	fs.writeFileSync(path.join(root, "upstream.txt"), "upstream\n");
	git(root, ["add", "upstream.txt"]);
	git(root, [
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-qm",
		"upstream",
	]);
	git(root, ["push", "-q", "origin", "advance:main"]);
	git(root, ["checkout", "-q", "main"]);
	git(root, ["branch", "-D", "advance"]);
	return { root, originHead: git(origin, ["rev-parse", "main"]) };
}

/** A config whose one preset covers the rebase family's classifiable step, the
 * way a real start needs one. `remote` is the fetch target the rebase preflight
 * uses. */
function rebaseConfig(remote: string): string {
	return `${JSON.stringify({
		workflow: { remote },
		agents: {
			default_profile: "p",
			profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
			presets: {
				fixed: {
					default_profile: "p",
					pools: {
						"core.rebase": [{ label: "only", profile: "p", default: true }],
					},
				},
			},
		},
	})}\n`;
}

function startRebase(
	engine: WorkflowEngine,
	root: string,
	workflowId = "rebase-task",
): WorkflowView {
	return engine.start({
		repo: root,
		mode: "checkout",
		workflowId,
		definitionId: "rebase",
		// What the real start path resolves: the newest tier, where every
		// classifiable step selects its model immediately before it runs.
		definitionVersion: definitionVersionForStepRouting(6),
		metadata: {
			branch: "feature/topic",
			baseBranch: "origin/main",
			baseCommit: git(root, ["rev-parse", "HEAD"]),
		},
		routing,
	}).view;
}

/** Complete the per-step classifier pass so the graph reaches the agent. */
function advanceRouting(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): WorkflowView {
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (!classify) return view;
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: classify.id,
		lease: requireDefined(classify.lease, "classify lease"),
		outcome: "complete",
		data: { integration: "routing", phase: "apply", answers: {} },
	}).view;
}

test("the rebase definition is one agent plus lifecycle bookkeeping", () => {
	const registry = registerBuiltins();
	const version = definitionVersionForStepRouting(6);
	const definition = registry.definition("rebase", version);
	expect(definition.initial).toBe("core.route-rebase");
	expect([...definition.steps].sort()).toEqual([
		"core.closed",
		"core.completed",
		"core.rebase",
		"core.route-rebase",
	]);
	for (const absent of [
		"core.plan",
		"core.triage",
		"core.verification",
		"core.developer-review",
		"core.wiki",
		"core.archive",
		"core.delivery",
	])
		expect(definition.steps).not.toContain(absent);
	expect(definition.terminal).toEqual(["core.closed"]);
	// The checkout policy is deliberate: the workflow uses the repository
	// checkout (never a worktree) but selects its own branch, so start must not
	// demand the selected branch already be the checked-out one.
	expect(definition.policy).toEqual({
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	});
	// The legacy tiers carry the same family, so a pinned lookup still resolves
	// it (the catalog is the workflow-type authority for every version).
	expect(
		registry
			.definition("rebase", 1)
			.steps.filter((id) => id.startsWith("core.")),
	).toEqual(["core.rebase", "core.completed", "core.closed"]);
});

test("the startup boundary selects both refs and forces checkout mode", () => {
	const { root, originHead } = rebaseRepo();
	// Outside the checkout: an untracked file in the worktree would refuse the
	// start before the branch rules even run.
	const config = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "rebase-config-")),
		"config.json",
	);
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.HERDR_WORKFLOW_CONFIG = config;
	try {
		fs.writeFileSync(config, rebaseConfig("origin"));
		// The launch's branch list offered origin/main; the ref is gone locally
		// until the start boundary fetches it again.
		git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
		const prepared = prepareWorkflowStart({
			repo: root,
			workflowId: "rebase-start",
			definitionId: "rebase",
			mode: "checkout",
			preset: "fixed",
			sourceBranch: "feature/topic",
			targetBranch: "origin/main",
		});
		expect(prepared.input.metadata?.branch).toBe("feature/topic");
		expect(prepared.input.metadata?.baseBranch).toBe("origin/main");
		expect(prepared.input.metadata?.baseCommit).toBe(originHead);
		expect(prepared.input.mode).toBe("checkout");
		// The start boundary fetched the target remote before the branch rules
		// ran, so the remote-tracking ref the launch listed is current again.
		expect(git(root, ["rev-parse", "refs/remotes/origin/main"])).toBe(
			originHead,
		);
		// A worktree start is refused: the rebase must run in the checkout whose
		// branch it rewrites.
		expect(() =>
			prepareWorkflowStart({
				repo: root,
				workflowId: "rebase-worktree",
				definitionId: "rebase",
				mode: "worktree",
				preset: "fixed",
				sourceBranch: "feature/topic",
				targetBranch: "origin/main",
			}),
		).toThrow(/checkout mode/);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the startup guard refuses missing, unknown, and identical refs", () => {
	const { root } = rebaseRepo();
	try {
		expect(() =>
			validateStart(root, "rebase-guard", "rebase", undefined, {}),
		).toThrow(/requires a source branch and a target branch/);
		expect(() =>
			validateStart(root, "rebase-guard", "rebase", undefined, {
				sourceBranch: "feature/topic",
				targetBranch: "feature/topic",
			}),
		).toThrow(/same ref/);
		expect(() =>
			validateStart(root, "rebase-guard", "rebase", undefined, {
				sourceBranch: "feature/absent",
				targetBranch: "origin/main",
			}),
		).toThrow(/source branch does not exist/);
		expect(() =>
			validateStart(root, "rebase-guard", "rebase", undefined, {
				sourceBranch: "feature/topic",
				targetBranch: "origin/absent",
			}),
		).toThrow(/target branch does not resolve/);
		// A rebase needs no task and no OpenSpec project.
		expect(() =>
			validateStart(root, "rebase-guard", "rebase", undefined, {
				sourceBranch: "feature/topic",
				targetBranch: "origin/main",
			}),
		).not.toThrow();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("workspace setup switches the checkout to the source branch and rebases it", async () => {
	const { root } = rebaseRepo();
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		let view = startRebase(engine, root);
		expect(view.currentStep.id).toBe("core.route-rebase");
		expect(view.effects.map((effect) => effect.kind)).toContain(
			"workspace.setup",
		);
		const handlers = agentEffectHandlers(root, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		const runner = new EffectRunner(root, engine, handlers);
		// One effect only: the preflight, so the routing pass is still pending when
		// the classifier result is dispatched (a drain would try to classify).
		await runner.drain(1);
		// The checkout moved to the branch the launch selected, not the branch it
		// happened to be on.
		expect(git(root, ["branch", "--show-current"])).toBe("feature/topic");
		// Complete the per-step classifier pass the way the engine's own routing
		// reducer would, then let the agent launch.
		view = advanceRouting(engine, root, engine.status(root, "rebase-task"));
		await runner.drain();
		view = engine.status(root, "rebase-task");
		expect(view.currentStep.id).toBe("core.rebase");
		expect(view.runs.map((run) => run.role)).toEqual(["worker"]);
		expect(adapter.contexts).toHaveLength(1);
		// The assignment names both refs as facts, so the agent never has to
		// discover what it is rebasing onto.
		const rendered = adapter.contexts[0]?.rendered.prompt ?? "";
		expect(rendered).toContain("feature/topic");
		expect(rendered).toContain("origin/main");
		expect(rendered).toContain("Rebase");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a rebase whose target ref disappears parks the workflow instead of launching an agent", async () => {
	const { root } = rebaseRepo();
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		startRebase(engine, root, "rebase-missing-target");
		// The ref resolved when the workflow started and is gone by the time the
		// preflight runs: a permanent failure, not a retry.
		git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
		const handlers = agentEffectHandlers(root, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		await new EffectRunner(root, engine, handlers).drain();
		const view = engine.status(root, "rebase-missing-target");
		expect(adapter.contexts).toHaveLength(0);
		expect(view.status).toBe("attention-required");
		const setup = view.effects.find(
			(effect) => effect.kind === "workspace.setup",
		);
		expect(setup?.status).toBe("failed");
		expect(setup?.lastError ?? "").toContain("does not resolve");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a completed rebase offers close only and ends closed", async () => {
	const { root } = rebaseRepo();
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		let view = startRebase(engine, root, "rebase-complete");
		const handlers = agentEffectHandlers(root, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		const runner = new EffectRunner(root, engine, handlers);
		await runner.drain(1);
		view = advanceRouting(engine, root, engine.status(root, "rebase-complete"));
		view = engine.status(root, "rebase-complete");
		expect(view.currentStep.id).toBe("core.rebase");

		// The agent hands the run off the way the real one does.
		const summary = view.runs.find(
			(run) =>
				run.role === "worker" && ["pending", "working"].includes(run.status),
		);
		const run = engine.getRun(root, requireDefined(summary, "worker run").id);
		const launch = engine
			.claimEffects(root, 100)
			.find(
				(effect) =>
					effect.kind === "agent.launch" &&
					(effect.payload as { runId?: string }).runId === run.id,
			);
		if (!launch?.runToken) throw new Error("missing launch token");
		// The step's passthrough output contract is what the agent writes back.
		const outputPath = requireDefined(run.outputPath, "output path");
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(
			outputPath,
			JSON.stringify({
				runId: run.id,
				schemaId: run.outputSchema?.id,
				schemaVersion: run.outputSchema?.version,
				payload: { rebased: true },
			}),
		);
		view = engine.dispatch(root, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token: launch.runToken,
			outcome: "complete",
			artifact: outputPath,
		}).view;
		expect(view.currentStep.id).toBe("core.completed");
		expect(view.status).toBe("completed");
		// A rebase has no delivery step, so completion offers close and not a
		// pull request.
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
		// A checkout workflow owns no worktree, so closing never removed the
		// repository checkout and the branch is still the rebased one.
		expect(fs.existsSync(root)).toBe(true);
		expect(git(root, ["branch", "--show-current"])).toBe("feature/topic");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the branch observation offers local refs, remote refs, and a default target", () => {
	const { root } = rebaseRepo();
	try {
		const options = discoverBranches(root);
		expect(options.current).toBe("main");
		expect(options.local).toContain("main");
		expect(options.local).toContain("feature/topic");
		// Remote-tracking refs are offered by their full name, and the symbolic
		// `<remote>/HEAD` entry is not a branch.
		expect(options.remote).toContain("origin/main");
		expect(options.remote.some((name) => name.endsWith("/HEAD"))).toBe(false);
		expect(options.local.some((name) => name.startsWith("origin/"))).toBe(
			false,
		);
		// The default target is a literal entry of the list the picker offers.
		expect(options.remote).toContain(options.default);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the branch observation refuses a directory that is not a checkout", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rebase-plain-"));
	try {
		expect(() => discoverBranches(root)).toThrow(/not a Git repository/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a rebase start requires both refs and a clean worktree", () => {
	const { root } = rebaseRepo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const base = {
			repo: root,
			mode: "checkout" as const,
			definitionId: "rebase",
			definitionVersion: definitionVersionForStepRouting(6),
			routing,
		};
		expect(() =>
			engine.start({
				...base,
				workflowId: "rebase-no-refs",
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: git(root, ["rev-parse", "HEAD"]),
				},
			}),
		).toThrow(/requires a source branch and a target branch/);
		fs.writeFileSync(path.join(root, "dirty.txt"), "dirty\n");
		expect(() =>
			engine.start({
				...base,
				workflowId: "rebase-dirty",
				metadata: {
					branch: "feature/topic",
					baseBranch: "origin/main",
					baseCommit: git(root, ["rev-parse", "HEAD"]),
				},
			}),
		).toThrow(/working tree must be clean/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
