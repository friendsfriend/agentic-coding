import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AgentAdapter,
	AgentObservation,
	LaunchContext,
} from "../src/workflow/adapters.ts";
import { cliTest } from "../src/workflow/cli.ts";
import type { AgentHandle } from "../src/workflow/contracts.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
	effectRunnerTest,
} from "../src/workflow/effect-runner.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";

class Adapter implements AgentAdapter {
	readonly id = "pi" as const;
	launches = 0;
	stops = 0;
	context?: LaunchContext;
	preflight() {}
	async launch(ctx: LaunchContext): Promise<AgentHandle> {
		this.launches++;
		this.context = ctx;
		return { runtime: "pi", name: ctx.name, paneId: ctx.paneId };
	}
	async prompt() {}
	async observe(handle: AgentHandle): Promise<AgentObservation> {
		return { status: "working", paneId: handle.paneId };
	}
	async stop() {
		this.stops++;
	}
}

test("serial runner renews a slow effect and does not preclaim later work", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-lease-runner-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const registry = registerBuiltins();
		let now = Date.now();
		const engine = new WorkflowEngine(registry, () => new Date(now));
		const profile = {
			name: "test",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "test-profile",
		};
		const started = engine.start({
			repo,
			workflowId: "slow-effect",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: profile.name,
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
			},
		});
		let executions = 0;
		let launchFailures = 0;
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				async execute() {
					executions++;
					await Bun.sleep(350);
					return { written: true };
				},
			},
			"agent.launch": {
				async execute() {
					launchFailures++;
					throw new Error("simulated long operation");
				},
			},
		});
		expect(started.view.effects[0]?.kind).toBe("artifact.write");
		await runner.drain(1, 100);
		expect(executions).toBe(1);
		for (const delay of [3_000, 5_000, 9_000, 17_000]) {
			now += delay;
			await runner.drain(1, 100_000);
		}
		expect(launchFailures).toBe(4);
		const view = engine.status(repo, started.view.workflowId);
		expect(
			view.effects.find((effect) => effect.kind === "artifact.write")?.status,
		).toBe("completed");
		expect(
			view.effects.find((effect) => effect.kind === "agent.launch")?.status,
		).toBe("failed");
		expect(
			view.effects.find((effect) => effect.kind === "agent.launch")?.attempts,
		).toBe(4);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("runner cancels a lost effect and a successor can reclaim it", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-lease-loss-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		fs.writeFileSync(path.join(repo, ".gitignore"), ".herdr-workflow\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const profile = {
			name: "test",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "test-profile",
		};
		const _started = engine.start({
			repo,
			workflowId: "lease-loss",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: profile.name,
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
			},
		});
		let cancelled = 0;
		const marker = path.join(repo, "effect-completed-before-crash");
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				async execute(effect) {
					fs.writeFileSync(marker, "done");
					await Bun.sleep(25);
					const db = new Database(canonicalStorePath(repo));
					db.query(
						"UPDATE workflow_outbox SET lease='successor', lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
					).run(effect.id);
					db.close();
					await Bun.sleep(50);
					return { written: true };
				},
				async cancel() {
					cancelled++;
				},
			},
		});
		await runner.drain(1, 100);
		expect(cancelled).toBe(1);
		const successor = engine.claimEffects(repo, 1, 100);
		expect(successor).toHaveLength(1);
		expect(successor[0]?.lease).not.toBe("successor");
		const db = new Database(canonicalStorePath(repo));
		db.query(
			"UPDATE workflow_outbox SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
		).run(successor[0]?.id);
		db.close();
		const recovery = new EffectRunner(repo, engine, {
			"artifact.write": {
				async observe() {
					return fs.existsSync(marker) ? { observed: true } : undefined;
				},
				async execute() {
					throw new Error("recovery should observe existing completion");
				},
			},
		});
		await recovery.drain(1, 100);
		expect(
			engine
				.status(repo, "lease-loss")
				.effects.find((effect) => effect.id === successor[0]?.id)?.status,
		).toBe("completed");
		fs.rmSync(marker, { force: true });
		engine.start({
			repo,
			workflowId: "repair-during-effect",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: profile.name,
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
			},
		});
		fs.writeFileSync(marker, "done");
		await new EffectRunner(repo, engine, {
			"agent.launch": {
				async execute() {
					return {};
				},
			},
		}).drain(1, 100);
		let repaired = false;
		const repairRunner = new EffectRunner(repo, engine, {
			"artifact.write": {
				async execute() {
					await Bun.sleep(25);
					const snapshot = engine.getSnapshot(repo, "repair-during-effect");
					engine.dispatch(repo, {
						type: "operator.repair",
						workflowId: "repair-during-effect",
						revision: snapshot.revision,
						targetStep: "core.implementation",
						reason: "lease test",
					});
					repaired = true;
					await Bun.sleep(50);
					return { written: true };
				},
				async cancel() {
					cancelled++;
				},
			},
		});
		await repairRunner.drain(1, 100);
		expect(repaired).toBe(true);
		expect(cancelled).toBe(2);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("research workspace setup launches and prompts the researcher", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-research-effects-"),
	);
	const previousWikiRoot = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
	try {
		const registry = registerBuiltins(undefined, 6);
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		const profile = {
			name: "research",
			runtime: "pi" as const,
			executable: "sh",
			tools: ["read", "web_search"],
			extensions: ["/tmp/research-extension.ts"],
			readOnly: false,
			capabilities: [
				"interactive",
				"prompt",
				"persistent-session",
				"run-environment",
				"observe",
				"read-only",
			] as const,
			digest: "research-profile",
		};
		engine.start({
			repo: researchWorkflowTarget(),
			workflowId: "research-effects",
			definitionId: "research",
			definitionVersion: definitionVersionForPolicy(6),
			metadata: {
				branch: "",
				baseBranch: "",
				baseCommit: "",
				task: "research",
			},
			routing: {
				defaultProfile: profile.name,
				routes: [{ stepId: "core.research", role: "researcher", profile }],
				diversity: [],
			},
		});
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "research-tab", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "research-workspace" } };
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const handlers = agentEffectHandlers(researchWorkflowTarget(), engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				return { paneId: "research-pane", owned: true };
			},
		});
		await new EffectRunner(researchWorkflowTarget(), engine, handlers).drain();
		expect(adapter.launches).toBe(1);
		expect(adapter.context?.assignment.role).toBe("researcher");
		expect(adapter.context?.profile.tools).toEqual(["read", "web_search"]);
		expect(adapter.context?.profile.extensions).toEqual([
			"/tmp/research-extension.ts",
		]);
		expect(
			engine.status(researchWorkflowTarget(), "research-effects").runs[0]
				?.status,
		).toBe("working");
	} finally {
		if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previousWikiRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki run's assignment carries the researcher's full recorded handoff verbatim", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-research-handoff-wiki-"),
	);
	const previousWikiRoot = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
	try {
		const registry = registerBuiltins(undefined, 6);
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		const researchProfile = {
			name: "research",
			runtime: "pi" as const,
			executable: "sh",
			tools: ["read"],
			extensions: [],
			readOnly: false,
			capabilities: [
				"interactive",
				"prompt",
				"persistent-session",
				"run-environment",
				"observe",
				"read-only",
			] as const,
			digest: "research-profile",
		};
		engine.start({
			repo: researchWorkflowTarget(),
			workflowId: "research-handoff-wiki",
			definitionId: "research",
			definitionVersion: definitionVersionForPolicy(6),
			metadata: {
				branch: "",
				baseBranch: "",
				baseCommit: "",
				task: "research task",
			},
			routing: {
				defaultProfile: researchProfile.name,
				routes: [
					{
						stepId: "core.research",
						role: "researcher",
						profile: researchProfile,
					},
					{
						stepId: "core.wiki",
						role: "research-wiki",
						profile: researchProfile,
					},
				],
				diversity: [],
			},
		});
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "research-tab", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "research-workspace" } };
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const handlers = agentEffectHandlers(researchWorkflowTarget(), engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				return { paneId: "research-pane", owned: true };
			},
		});
		await new EffectRunner(researchWorkflowTarget(), engine, handlers).drain();
		const view = engine.status(
			researchWorkflowTarget(),
			"research-handoff-wiki",
		);
		const researcherSummary = view.runs.find(
			(run) => run.role === "researcher",
		);
		if (!researcherSummary) throw new Error("expected researcher run");
		const researcher = engine.getRun(
			researchWorkflowTarget(),
			researcherSummary.id,
		);
		const token = engine.issueRunCapability(
			researchWorkflowTarget(),
			researcher.id,
		);
		// The researcher-initiated command records the handoff and transitions
		// to wiki drafting in one authenticated step; there is no separate
		// developer dashboard action.
		engine.dispatch(researchWorkflowTarget(), {
			type: "agent.research-handoff",
			workflowId: researcher.workflowId,
			runId: researcher.id,
			stepId: "core.research",
			role: "researcher",
			token,
			handoff: {
				subject: "widget subsystem",
				canonicalTarget: "projects/demo/widget-subsystem",
				findings: "open question: naming for the sub-assembly stage",
				directives: [
					{
						target: "projects/demo/widget-subsystem",
						intent: "update",
						claims: ["widgets are produced by the widget factory"],
						citations: ["src/widget.ts"],
					},
				],
				citations: ["src/widget.ts"],
				noSourcesUsed: false,
			},
		});
		await new EffectRunner(researchWorkflowTarget(), engine, handlers).drain();
		expect(adapter.launches).toBe(2);
		expect(adapter.context?.assignment.role).toBe("research-wiki");
		const inputs = adapter.context?.assignment.inputs ?? [];
		const combined = inputs.join("\n");
		expect(combined).toContain("Research handoff");
		expect(combined).toContain("Documentation directives");
		expect(combined).toContain("actionable starting point");
		// Directive-first: the wiki agent must be told to act on the recorded
		// directives immediately, not run a broad rediscovery pass first.
		expect(combined).toContain("Directive-first");
		expect(combined).toContain("do not run a broad open-ended rediscovery");
		expect(combined).toContain("targeted corroboration");
		const assignment = adapter.context?.assignment;
		expect(assignment?.objective).toContain("directive-first");
		expect(assignment?.permissions?.join("\n")).toContain(
			"do not perform broad rediscovery",
		);
		expect(combined).toContain("widget subsystem");
		expect(combined).toContain("projects/demo/widget-subsystem");
		expect(combined).toContain("widgets are produced by the widget factory");
		expect(combined).toContain(
			"open question: naming for the sub-assembly stage",
		);
		expect(combined).toContain("src/widget.ts");
	} finally {
		if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previousWikiRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runner drains workspace and agent effects, then stops stale run after repair", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-effects-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const adapter = new Adapter();
		const started = engine.start({
			repo,
			mode: "checkout",
			workflowId: "effects",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/effects",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: "pi",
				routes: [
					{
						stepId: "core.implementation",
						role: "worker",
						profile: {
							name: "pi",
							runtime: "pi",
							executable: "sh",
							tools: [],
							extensions: [],
							readOnly: false,
							capabilities: ["prompt", "run-environment", "observe"],
							digest: "profile",
						},
					},
				],
				diversity: [],
			},
		});
		expect(started.view.runs).toHaveLength(0);
		expect(started.view.effects.map((item) => item.kind)).toEqual([
			"workspace.setup",
		]);
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		await new EffectRunner(repo, engine, handlers).drain();
		const active = engine.status(repo, "effects");
		expect(active.runs[0]?.status).toBe("working");
		expect(active.runs[0]?.paneId).toBe("pane");
		expect(adapter.launches).toBe(1);
		// Launch publishes the per-agent pointer at the canonical name so the
		// telemetry bridge can recover this run's env.
		expect(
			fs.readFileSync(
				path.join(
					repo,
					".herdr-workflow",
					"runtime-bin",
					"by-agent",
					effectRunnerTest.canonicalAgentName("effects", "no-openspec", {
						stepId: "core.implementation",
						role: "worker",
						id: String(active.runs[0]?.id),
					}),
				),
				"utf8",
			),
		).toContain(String(active.runs[0]?.id));
		expect(adapter.context?.environment.HERDR_STEP_ID).toBe(
			"core.implementation",
		);
		expect(adapter.context?.environment.HERDR_TELEMETRY_PATH).toContain(
			"/effects/telemetry.jsonl",
		);
		expect(
			fs.readFileSync(
				engine.getRun(repo, active.runs[0]?.id).assignmentPath,
				"utf8",
			),
		).toContain("Task: task");
		engine.dispatch(repo, {
			type: "operator.repair",
			workflowId: active.workflowId,
			revision: active.revision,
			targetStep: "core.implementation",
			reason: "test repair",
		});
		await new EffectRunner(repo, engine, handlers).drain();
		expect(adapter.stops).toBe(1);
		expect(adapter.launches).toBe(2);
		expect(engine.status(repo, "effects").status).toBe("active");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("launch failure on a reused pane does not close it", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-launch-fail-reused-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		engine.start({
			repo,
			mode: "checkout",
			workflowId: "launch-fail-reused",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/launch-fail-reused",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: "pi",
				routes: [
					{
						stepId: "core.implementation",
						role: "worker",
						profile: {
							name: "pi",
							runtime: "pi",
							executable: "sh",
							tools: [],
							extensions: [],
							readOnly: false,
							capabilities: ["prompt", "run-environment", "observe"],
							digest: "profile",
						},
					},
				],
				diversity: [],
			},
		});
		const calls: string[][] = [];
		const herdr = {
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				if (args[0] === "pane" && args[1] === "close") return {};
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		class FailingAdapter implements AgentAdapter {
			readonly id = "pi" as const;
			preflight() {}
			async launch(): Promise<AgentHandle> {
				throw new Error("launch exploded");
			}
			async prompt() {}
			async observe(): Promise<AgentObservation> {
				return { status: "working", paneId: "n/a" };
			}
			async stop() {}
		}
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", new FailingAdapter()]]),
			herdr,
			async paneForRun() {
				// A live agent already resolved to this pane; the allocator did not
				// create it, so a launch failure must not close it.
				return { paneId: "reused-pane", owned: false };
			},
		});
		// Drain workspace.setup so the agent.launch effect becomes claimable.
		const setup = engine
			.claimEffects(repo, 10)
			.find((effect) => effect.kind === "workspace.setup");
		if (!setup) throw new Error("expected workspace.setup effect");
		const setupResult = await handlers["workspace.setup"]?.execute(setup);
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: setup.id,
			lease: setup.lease ?? "",
			outcome: "complete",
			data: setupResult,
		});
		const launch = engine
			.claimEffects(repo, 10)
			.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected agent.launch effect");
		const launchHandler = handlers["agent.launch"];
		if (!launchHandler) throw new Error("missing agent.launch handler");
		await expect(launchHandler.execute(launch)).rejects.toThrow(
			"launch exploded",
		);
		expect(
			calls.some((args) => args[0] === "pane" && args[1] === "close"),
		).toBe(false);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("launch failure on a newly created pane still cleans it up", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-launch-fail-created-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		engine.start({
			repo,
			mode: "checkout",
			workflowId: "launch-fail-created",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/launch-fail-created",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
			},
			routing: {
				defaultProfile: "pi",
				routes: [
					{
						stepId: "core.implementation",
						role: "worker",
						profile: {
							name: "pi",
							runtime: "pi",
							executable: "sh",
							tools: [],
							extensions: [],
							readOnly: false,
							capabilities: ["prompt", "run-environment", "observe"],
							digest: "profile",
						},
					},
				],
				diversity: [],
			},
		});
		const calls: string[][] = [];
		const herdr = {
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				if (args[0] === "pane" && args[1] === "close") return {};
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		class FailingAdapter implements AgentAdapter {
			readonly id = "pi" as const;
			preflight() {}
			async launch(): Promise<AgentHandle> {
				throw new Error("launch exploded");
			}
			async prompt() {}
			async observe(): Promise<AgentObservation> {
				return { status: "working", paneId: "n/a" };
			}
			async stop() {}
		}
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", new FailingAdapter()]]),
			herdr,
			async paneForRun() {
				// This allocation call created the pane itself (e.g. a fresh tab),
				// so a launch failure must still clean it up.
				return { paneId: "created-pane", owned: true };
			},
		});
		const setup = engine
			.claimEffects(repo, 10)
			.find((effect) => effect.kind === "workspace.setup");
		if (!setup) throw new Error("expected workspace.setup effect");
		const setupResult = await handlers["workspace.setup"]?.execute(setup);
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: setup.id,
			lease: setup.lease ?? "",
			outcome: "complete",
			data: setupResult,
		});
		const launch = engine
			.claimEffects(repo, 10)
			.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected agent.launch effect");
		const launchHandler = handlers["agent.launch"];
		if (!launchHandler) throw new Error("missing agent.launch handler");
		await expect(launchHandler.execute(launch)).rejects.toThrow(
			"launch exploded",
		);
		expect(calls).toContainEqual(["pane", "close", "created-pane"]);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("launch retry recovers stable Herdr agent without duplicating launch, minting a fresh capability that actually authorizes", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-launch-recover-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const profile = {
			name: "pi",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const routing = {
			defaultProfile: "pi",
			routes: [
				{ stepId: "core.implementation", role: "worker", profile },
				{ stepId: "core.triage", role: "triage", profile },
				{ stepId: "core.verification", profile },
			],
			diversity: [],
		};
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const started = engine.start({
			repo,
			workflowId: "recover",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing,
		});
		const claimed = engine.claimEffects(repo, 100);
		const launch = claimed.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected agent.launch effect");
		const pendingRun = engine.getRun(repo, started.view.runs[0]?.id);
		const hash = pendingRun.capabilityHash;
		fs.mkdirSync(path.dirname(pendingRun.assignmentPath), { recursive: true });
		fs.writeFileSync(pendingRun.assignmentPath, "truncated");
		const db = new Database(canonicalStorePath(repo));
		db.query(
			"UPDATE workflow_outbox SET lease_expires_at='2000-01-01T00:00:00Z' WHERE workflow_id=?",
		).run(started.view.workflowId);
		db.close();
		let prompts = 0;
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				if (args[0] === "agent" && args[1] === "get")
					return {
						agent: {
							pane_id: "recovered-pane",
							tab_id: "verification",
							agent_status: "working",
						},
					};
				if (args[0] === "agent" && args[1] === "prompt") {
					prompts++;
					return {};
				}
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = new Adapter();
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				throw new Error("must not create pane");
			},
		});
		await new EffectRunner(repo, engine, handlers).drain();
		const run = engine.getRun(repo, started.view.runs[0]?.id);
		expect(run.handle?.paneId).toBe("recovered-pane");
		expect(adapter.launches).toBe(0);
		expect(prompts).toBe(1);
		expect(launch.runToken).toBeTruthy();
		expect(fs.readFileSync(run.assignmentPath, "utf8")).toContain(
			"Write exactly this envelope shape:",
		);
		expect(fs.readFileSync(run.assignmentPath, "utf8")).not.toBe("truncated");
		// The expired lease discarded `launch`'s original plaintext token before
		// anything could deliver it (only its hash was ever persisted), so there
		// is no valid prior token left to preserve: this recovery *must* mint a
		// fresh one — reusing the stale hash would leave `run.env` carrying an
		// empty HERDR_RUN_TOKEN and the recovered run permanently unauthorizable
		// (the actual production failure this test now guards against).
		expect(run.capabilityHash).not.toBe(hash);
		const envFile = path.join(
			repo,
			".herdr-workflow",
			"runtime-bin",
			run.id,
			"run.env",
		);
		const refreshedToken = fs
			.readFileSync(envFile, "utf8")
			.split("\n")
			.find((line) => line.startsWith("HERDR_RUN_TOKEN="))
			?.slice("HERDR_RUN_TOKEN=".length);
		expect(refreshedToken).toBeTruthy();
		// The recovered run must actually be usable: an authenticated handoff
		// with the token written to run.env has to succeed.
		expect(
			engine.authorizeExactRunCapability(
				repo,
				run.workflowId,
				run.id,
				run.stepId,
				run.role,
				refreshedToken ?? "",
			).id,
		).toBe(run.id);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("review-comment loop reuses the planner agent by stable name instead of launching a new tab", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-plan-reuse-"));
	try {
		fs.mkdirSync(path.join(repo, "openspec"), { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		fs.writeFileSync(
			path.join(repo, "openspec", "config.yaml"),
			"schema: spec-driven\n",
		);
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const profile = {
			name: "pi",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const routing = {
			defaultProfile: "pi",
			routes: [{ stepId: "core.plan", role: "planner", profile }],
			diversity: [],
		};
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const started = engine.start({
			repo,
			workflowId: "plan-reuse",
			definitionId: "openspec-full",
			metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
			routing,
		});

		let agentLive = false;
		let prompts = 0;
		let paneForRunCalls = 0;
		const capturedNames: string[] = [];
		const promptTargets: string[] = [];
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				if (args[0] === "agent" && args[1] === "get") {
					capturedNames.push(String(args[2]));
					return agentLive
						? {
								agent: {
									pane_id: "planner-pane",
									tab_id: "plan",
									agent_status: "working",
								},
							}
						: { agent: { agent_status: "unknown" } };
				}
				if (args[0] === "agent" && args[1] === "prompt") {
					prompts++;
					promptTargets.push(String(args[2]));
					return {};
				}
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = new Adapter();
		const originalLaunch = adapter.launch.bind(adapter);
		adapter.launch = async (ctx) => {
			const handle = await originalLaunch(ctx);
			agentLive = true;
			return { ...handle, paneId: "planner-pane" };
		};
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				paneForRunCalls++;
				if (paneForRunCalls > 1)
					throw new Error("must not create a second pane");
				return { paneId: "planner-pane", owned: true };
			},
		});

		await new EffectRunner(repo, engine, handlers).drain();
		expect(adapter.launches).toBe(1);
		expect(paneForRunCalls).toBe(1);
		const firstRunId = started.view.runs[0]?.id;
		const firstName = adapter.context?.name;
		expect(firstName).toBe(
			effectRunnerTest.canonicalAgentName("plan-reuse", "openspec-full", {
				stepId: "core.plan",
				role: "planner",
				id: "irrelevant-for-persistent-roles",
			}),
		);

		const atGate = engine.dispatch(repo, {
			type: "operator.repair",
			workflowId: started.view.workflowId,
			revision: engine.status(repo, "plan-reuse").revision,
			targetStep: "core.plan-approval",
			reason: "operator confirmed evidence",
		});
		const reentered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: started.view.workflowId,
			revision: atGate.view.revision,
			actionId: "review-comments",
			input: {
				comments: [{ comment: "clarify scope", file: "proposal.md", line: 3 }],
			},
		});
		expect(reentered.view.currentStep.id).toBe("core.plan");
		const secondRun = reentered.view.runs.find(
			(item) => item.status === "pending" || item.status === "working",
		);
		expect(secondRun).toBeTruthy();
		expect(secondRun?.id).not.toBe(firstRunId);

		await new EffectRunner(repo, engine, handlers).drain();
		expect(adapter.launches).toBe(1);
		expect(paneForRunCalls).toBe(1);
		expect(prompts).toBe(1);
		// The reuse prompt is delivered to the adopted live pane (transport id),
		// while the persisted handle keeps the canonical name (identity).
		expect(promptTargets).toEqual(["planner-pane"]);
		// Reused-prompt delivery republishes the per-agent run-env pointer for the
		// new run, so the telemetry bridge recovers the right environment.
		expect(
			fs.readFileSync(
				path.join(
					repo,
					".herdr-workflow",
					"runtime-bin",
					"by-agent",
					String(firstName),
				),
				"utf8",
			),
		).toContain(secondRun?.id ?? "");
		if (!secondRun) throw new Error("expected second run");
		const run = engine.getRun(repo, secondRun.id);
		expect(run.handle?.paneId).toBe("planner-pane");

		// QV-001/QV-002: the reused planner process's own OS env is frozen at its
		// original `agent start` (still holding the first run's HERDR_RUN_ID/
		// GENERATION/TOKEN); only HERDR_WORKFLOW_ID/HERDR_STEP_ID/HERDR_ROLE stay
		// valid across generations. `resolveHandoffIdentity` must resolve the
		// *second* (current) run from that stable role identity, not the stale
		// run-scoped env, and the freshly minted token must actually authorize
		// handing off that run — proving the follow-up round is completable, not
		// just that a new tab was avoided.
		const saved = { ...process.env };
		try {
			process.env.HERDR_WORKFLOW_ID = started.view.workflowId;
			process.env.HERDR_STEP_ID = "core.plan";
			process.env.HERDR_ROLE = "planner";
			process.env.HERDR_RUN_ID = firstRunId;
			process.env.HERDR_RUN_GENERATION = "1";
			process.env.HERDR_RUN_TOKEN = "stale-token";
			const identity = cliTest.resolveHandoffIdentity(engine, repo);
			expect(identity.runId).toBe(secondRun?.id);
			expect(identity.runId).not.toBe(firstRunId);
			const handedOff = engine.dispatch(repo, {
				type: "agent.handoff",
				runId: identity.runId,
				generation: identity.generation,
				token: identity.token,
				outcome: "blocked",
				message: "refreshed role identity resolves the follow-up run",
			});
			expect(
				handedOff.view.runs.find((item) => item.id === secondRun?.id)?.status,
			).toBe("blocked");
			expect(handedOff.view.health.attention).toContain(
				"refreshed role identity resolves the follow-up run",
			);
		} finally {
			process.env = saved;
		}
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("canonical agent names stay within herdr limits and never collide across long change IDs", () => {
	const verifier = {
		role: "performance-verifier",
		id: "1234567890abcdef1234567890abcdef",
		stepId: "core.verification",
	} as Parameters<typeof effectRunnerTest.canonicalAgentName>[2];
	for (const changeId of [
		"test-123",
		"this-change-id-is-way-too-long-for-any-agent-name-limit",
	]) {
		const name = effectRunnerTest.canonicalAgentName(
			changeId,
			"openspec-full",
			verifier,
		);
		expect(name.length).toBeLessThanOrEqual(32);
		expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
	}
	// Change IDs sharing a long common prefix (legacy truncation width) must
	// still map to distinct live agent names.
	const worker = {
		role: "worker",
		id: "1234567890abcdef1234567890abcdef",
		stepId: "core.implementation",
	} as Parameters<typeof effectRunnerTest.canonicalAgentName>[2];
	const prefix = "rethink-agent-and-pane-identification-shared-prefix";
	const one = effectRunnerTest.canonicalAgentName(
		`${prefix}-one`,
		"openspec-full",
		worker,
	);
	const two = effectRunnerTest.canonicalAgentName(
		`${prefix}-two`,
		"openspec-apply",
		worker,
	);
	expect(one).not.toBe(two);
	expect(one.length).toBeLessThanOrEqual(32);
});

test("canonical agent names are stable across generations and grouped rounds", () => {
	const name = (stepId: string, role: string, id: string) =>
		effectRunnerTest.canonicalAgentName("change-id", "openspec-full", {
			stepId,
			role,
			id,
		});
	// Persistent single-role steps keep one identity across every run/generation.
	expect(name("core.plan", "planner", "12345678")).toBe(
		name("core.plan", "planner", "fedcba09"),
	);
	expect(name("core.implementation", "worker", "12345678")).toBe(
		name("core.implementation", "worker", "fedcba09"),
	);
	expect(name("core.archive", "archive", "12345678")).toBe(
		name("core.archive", "archive", "fedcba09"),
	);
	// Grouped verifier roles keep one identity across every round.
	expect(name("core.verification", "quality-verifier", "12345678")).toBe(
		name("core.verification", "quality-verifier", "fedcba09"),
	);
	// Roles within the same round stay distinct even when abbreviated.
	const roles = [
		"quality-verifier",
		"security-verifier",
		"performance-verifier",
		"openspec-verifier",
		"usability-verifier",
		"test-verifier",
	];
	const roundNames = roles.map((role) =>
		name("core.verification", role, "12345678"),
	);
	for (const roleName of roundNames) {
		expect(roleName.length).toBeLessThanOrEqual(32);
		expect(roleName).toMatch(/^[a-z][a-z0-9_-]*$/);
	}
	expect(new Set(roundNames).size).toBe(roles.length);
	for (const value of [
		name("core.plan", "planner", "12345678"),
		...roundNames,
	]) {
		expect(value.length).toBeLessThanOrEqual(32);
		expect(value).toMatch(/^[a-z][a-z0-9_-]*$/);
	}
});

test("resolveLiveAgent reuses the live pane and recovers stale handles by identity", () => {
	const run = {
		stepId: "core.implementation",
		role: "worker",
		id: "1234567890abcdef",
	};
	const canonical = effectRunnerTest.canonicalAgentName(
		"change",
		"openspec-full",
		run,
	);
	const legacy = effectRunnerTest.legacyRunName("change", run);
	const herdrWith = (responses: Record<string, unknown>) => ({
		call(...args: string[]) {
			if (args[0] === "agent" && args[1] === "get") {
				if (!(args[2] in responses)) throw new Error(`not found: ${args[2]}`);
				return responses[args[2]];
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		},
	});

	// Stale stored pane id, live agent under the canonical name: adopt its pane.
	const stale = effectRunnerTest.resolveLiveAgent(
		herdrWith({
			[canonical]: {
				agent: {
					pane_id: "moved-pane",
					tab_id: "tab9",
					agent_status: "working",
				},
			},
		}),
		"change",
		"openspec-full",
		{ ...run, handle: { runtime: "pi", name: canonical, paneId: "dead-pane" } },
	);
	expect(stale?.paneId).toBe("moved-pane");
	expect(stale?.tabId).toBe("tab9");
	expect(stale?.name).toBe(canonical);

	// Live handle confirmed via its own pane id: reused as-is.
	const healthy = effectRunnerTest.resolveLiveAgent(
		herdrWith({
			"kept-pane": {
				agent: { pane_id: "kept-pane", agent_status: "idle" },
			},
		}),
		"change",
		"openspec-full",
		{ ...run, handle: { runtime: "pi", name: canonical, paneId: "kept-pane" } },
	);
	expect(healthy?.paneId).toBe("kept-pane");

	// Live agent reachable only under the legacy name: adopted and re-keyed.
	const migrated = effectRunnerTest.resolveLiveAgent(
		herdrWith({
			[legacy]: { agent: { pane_id: "legacy-pane", agent_status: "working" } },
		}),
		"change",
		"openspec-full",
		run,
	);
	expect(migrated?.paneId).toBe("legacy-pane");
	expect(migrated?.name).toBe(canonical);

	// No live agent anywhere: the only outcome allowed to spawn.
	expect(
		effectRunnerTest.resolveLiveAgent(
			herdrWith({}),
			"change",
			"openspec-full",
			run,
		),
	).toBeUndefined();
	// A dead tracked process reports 'unknown' and must not count as live.
	expect(
		effectRunnerTest.resolveLiveAgent(
			herdrWith({
				[canonical]: { agent: { pane_id: "p", agent_status: "unknown" } },
			}),
			"change",
			"openspec-full",
			run,
		),
	).toBeUndefined();
});

test("writeAgentEnvPointer atomically publishes the run env path keyed by agent name", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "env-pointer-"));
	try {
		effectRunnerTest.writeAgentEnvPointer(repo, "planner-ab12cd34", "run-1234");
		const pointer = path.join(
			repo,
			".herdr-workflow",
			"runtime-bin",
			"by-agent",
			"planner-ab12cd34",
		);
		expect(fs.readFileSync(pointer, "utf8")).toBe(
			".herdr-workflow/runtime-bin/run-1234/run.env\n",
		);
		// Republishing overwrites in place without leaving temp files behind.
		effectRunnerTest.writeAgentEnvPointer(repo, "planner-ab12cd34", "run-5678");
		expect(fs.readFileSync(pointer, "utf8")).toContain("run-5678");
		expect(fs.readdirSync(path.dirname(pointer))).toEqual(["planner-ab12cd34"]);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("proposal workspace setup stays on the dirty current checkout", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-proposal-workspace-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.mkdirSync(path.join(repo, "openspec"));
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		fs.writeFileSync(
			path.join(repo, "openspec", "config.yaml"),
			"schema: spec-driven\n",
		);
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		fs.writeFileSync(path.join(repo, "uncommitted.txt"), "allowed\n");
		const profile = {
			name: "pi",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const engine = new WorkflowEngine(registerBuiltins());
		const started = engine.start({
			repo,
			mode: "checkout",
			workflowId: "proposal-workspace",
			definitionId: "openspec-propose",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "main",
				task: "propose",
			},
			routing: {
				defaultProfile: "pi",
				routes: [{ stepId: "core.plan", role: "planner", profile }],
			},
		});
		const calls: string[][] = [];
		const herdr = {
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "workspace" && args[1] === "get")
					throw new Error("not found");
				if (args[0] === "workspace" && args[1] === "list")
					return { workspaces: [] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "proposal-workspace" } };
				if (args[0] === "workspace" && args[1] === "close") return {};
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab", label: "dashboard" }] };
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const handlers = agentEffectHandlers(repo, engine, {
			registry: registerBuiltins(),
			adapters: new Map(),
			herdr,
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		const setup = engine.claimEffects(repo, 10)[0];
		if (!setup) throw new Error("expected workspace setup effect");
		const result = await handlers["workspace.setup"]?.execute(setup);
		expect(result).toEqual({
			workspace: "proposal-workspace",
			worktree: fs.realpathSync(repo),
			branch: "main",
		});
		expect(
			calls.some(
				(args) => args.includes("switch") || args.includes("worktree"),
			),
		).toBe(false);
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: setup.id,
			lease: setup.lease ?? "",
			outcome: "complete",
			data: result,
		});
		const closeEffect = { ...setup, kind: "workspace.close" as const };
		const close = handlers["workspace.close"];
		const cleanup = handlers["workspace.cleanup"];
		if (!close || !cleanup?.observe)
			throw new Error("missing workspace handlers");
		await close.execute(closeEffect);
		expect(await cleanup.observe(closeEffect)).toBe(true);
		expect(await cleanup.execute(closeEffect)).toEqual({ cleaned: true });
		expect(calls).toContainEqual(["workspace", "close", "proposal-workspace"]);
		expect(fs.existsSync(repo)).toBe(true);
		expect(started.view.definition.id).toBe("openspec-propose");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("workspace retry recovers stable branch and workspace identity", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-workspace-recover-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
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
			{ cwd: repo },
		);
		const base = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		const profile = {
			name: "pi",
			runtime: "pi" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const routing = {
			defaultProfile: "pi",
			routes: [
				{ stepId: "core.implementation", role: "worker", profile },
				{ stepId: "core.triage", role: "triage", profile },
				{ stepId: "core.verification", profile },
			],
			diversity: [],
		};
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const started = engine.start({
			repo,
			mode: "checkout",
			workflowId: "workspace-recover",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/recover",
				baseBranch: "main",
				baseCommit: base,
				task: "task",
			},
			routing,
		});
		engine.claimEffects(repo, 1);
		execFileSync("git", ["switch", "-q", "-c", "feature/recover", base], {
			cwd: repo,
		});
		const db = new Database(canonicalStorePath(repo));
		db.query(
			"UPDATE workflow_outbox SET lease_expires_at='2000-01-01T00:00:00Z' WHERE workflow_id=?",
		).run(started.view.workflowId);
		db.close();
		let creates = 0;
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "get")
					return {
						workspace: { workspace_id: "recovered-workspace", status: "open" },
					};
				if (args[0] === "workspace" && args[1] === "create") {
					creates++;
					return { workspace: { workspace_id: "new" } };
				}
				if (args[0] === "agent" && args[1] === "get")
					throw new Error("not found");
				if (args[0] === "pane" && args[1] === "close") return {};
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = new Adapter();
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			herdr,
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		await new EffectRunner(repo, engine, handlers).drain();
		const view = engine.status(repo, "workspace-recover");
		expect(view.workspace).toBe("recovered-workspace");
		expect(view.worktree).toBe(fs.realpathSync(repo));
		expect(creates).toBe(0);
		expect(adapter.launches).toBe(1);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
