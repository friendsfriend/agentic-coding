import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
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
	PermanentFailure,
	TransientFailure,
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
	launch(ctx: LaunchContext) {
		this.launches++;
		this.context = ctx;
		return Effect.succeed({
			runtime: "pi" as const,
			name: ctx.name,
			paneId: ctx.paneId,
		});
	}
	prompt() {
		return Effect.void;
	}
	observe(handle: AgentHandle) {
		return Effect.succeed({
			status: "working" as const,
			paneId: handle.paneId,
		});
	}
	stop() {
		return Effect.sync(() => {
			this.stops++;
		});
	}
}

/** `GIT_ALLOW_PROTOCOL=https:ssh:git` blocks real local-path pushes, so the
 * wiki delivery push is observed through a `git` shim that records pushes and
 * delegates every other subcommand to the real binary. */
function installGitPushShim(): { log: string; restore: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-git-shim-"));
	const log = path.join(dir, "push.log");
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("git is not available");
	fs.writeFileSync(
		path.join(dir, "git"),
		[
			"#!/bin/sh",
			'case " $* " in',
			'  *" push "*)',
			`    printf '%s\\n' "$*" >> "${log}"`,
			`    printf 'GIT_ALLOW_PROTOCOL=%s\\n' "$GIT_ALLOW_PROTOCOL" >> "${log}"`,
			"    exit 0",
			"    ;;",
			"esac",
			`exec "${realGit}" "$@"`,
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return {
		log,
		restore: () => {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
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
				execute: () =>
					Effect.gen(function* () {
						executions++;
						yield* Effect.sleep(350);
						return { written: true };
					}),
			},
			"agent.launch": {
				execute: () =>
					Effect.gen(function* () {
						launchFailures++;
						return yield* Effect.fail(
							new TransientFailure("simulated long operation"),
						);
					}),
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
				execute: (effect) =>
					Effect.gen(function* () {
						fs.writeFileSync(marker, "done");
						yield* Effect.sleep(25);
						const db = new Database(canonicalStorePath(repo));
						db.query(
							"UPDATE workflow_outbox SET lease='successor', lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
						).run(effect.id);
						db.close();
						yield* Effect.sleep(50);
						return { written: true };
					}),
				cancel: () =>
					Effect.sync(() => {
						cancelled++;
					}),
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
				observe: () =>
					Effect.sync(() =>
						fs.existsSync(marker) ? { observed: true } : undefined,
					),
				execute: () =>
					Effect.fail(new Error("recovery should observe existing completion")),
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
				execute: () => Effect.succeed({}),
			},
		}).drain(1, 100);
		let repaired = false;
		const repairRunner = new EffectRunner(repo, engine, {
			"artifact.write": {
				execute: () =>
					Effect.gen(function* () {
						yield* Effect.sleep(25);
						const snapshot = engine.getSnapshot(repo, "repair-during-effect");
						engine.dispatch(repo, {
							type: "operator.repair",
							workflowId: "repair-during-effect",
							revision: snapshot.revision,
							targetStep: "core.implementation",
							reason: "lease test",
						});
						repaired = true;
						yield* Effect.sleep(50);
						return { written: true };
					}),
				cancel: () =>
					Effect.sync(() => {
						cancelled++;
					}),
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
			readOnly: true,
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
			readOnly: true,
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

test("runner retains stale agent after repair", async () => {
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
		expect(adapter.stops).toBe(0);
		expect(adapter.launches).toBe(2);
		expect(engine.status(repo, "effects").status).toBe("active");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("workspace setup recognizes a dashboard tab carrying a status glyph", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-glyph-tab-"));
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
		engine.start({
			repo,
			mode: "checkout",
			workflowId: "glyph-tab",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/glyph-tab",
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
					return { tabs: [{ tab_id: "dash-tab", label: "● dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				if (args[0] === "tab" && args[1] === "create")
					return { root_pane: { pane_id: "git-pane", tab_id: "git-tab" } };
				if (args[0] === "pane" && args[1] === "run") return {};
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
		// The glyphed dashboard tab is recognized: no fallback pane scan and no
		// clobbering rename of an unrelated tab.
		expect(calls.some((args) => args[0] === "pane" && args[1] === "list")).toBe(
			false,
		);
		expect(
			calls.some(
				(args) =>
					args[0] === "tab" && args[1] === "rename" && args[2] === "dash-tab",
			),
		).toBe(false);
		expect(engine.status(repo, "glyph-tab").workspace).toBe("workspace");
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
			launch(): Effect.Effect<AgentHandle, Error> {
				return Effect.fail(new Error("launch exploded"));
			}
			prompt() {
				return Effect.void;
			}
			observe() {
				return Effect.succeed({ status: "working" as const, paneId: "n/a" });
			}
			stop() {
				return Effect.void;
			}
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
		const setupResult = await Effect.runPromise(
			handlers["workspace.setup"]?.execute(setup) ?? Effect.never,
		);
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
		const launched = await Effect.runPromise(
			launchHandler.execute(launch).pipe(Effect.either),
		);
		if (!Either.isLeft(launched)) throw new Error("expected launch failure");
		expect(launched.left.message).toContain("launch exploded");
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
			launch(): Effect.Effect<AgentHandle, Error> {
				return Effect.fail(new Error("launch exploded"));
			}
			prompt() {
				return Effect.void;
			}
			observe() {
				return Effect.succeed({ status: "working" as const, paneId: "n/a" });
			}
			stop() {
				return Effect.void;
			}
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
		const launched = await Effect.runPromise(
			launchHandler.execute(launch).pipe(Effect.either),
		);
		if (!Either.isLeft(launched)) throw new Error("expected launch failure");
		expect(launched.left.message).toContain("launch exploded");
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
				(refreshedToken ?? "")
					.replace(/^'(.*)'$/, "$1")
					.replaceAll("'\\''", "'"),
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
		adapter.launch = (ctx) =>
			originalLaunch(ctx).pipe(
				Effect.map((handle) => {
					agentLive = true;
					return { ...handle, paneId: "planner-pane" };
				}),
			);
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
		const result = await Effect.runPromise(
			handlers["workspace.setup"]?.execute(setup) ?? Effect.never,
		);
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
		await Effect.runPromise(close.execute(closeEffect));
		expect(
			await Effect.runPromise(cleanup.observe(closeEffect) ?? Effect.never),
		).toBe(true);
		expect(await Effect.runPromise(cleanup.execute(closeEffect))).toEqual({
			cleaned: true,
		});
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

test("wiki delivery commits and pushes the bundle on its current branch", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-wiki-git-"));
	let shim: ReturnType<typeof installGitPushShim> | undefined;
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: root });
		fs.writeFileSync(
			path.join(root, "index.md"),
			'---\nokf_version: "0.2"\n---\n',
		);
		// Operational workflow state shares the bundle root but is never knowledge.
		fs.mkdirSync(path.join(root, ".herdr-workflow", "w"), { recursive: true });
		fs.writeFileSync(path.join(root, ".herdr-workflow", "w", "state"), "one\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://example.invalid/wiki.git"],
			{ cwd: root },
		);
		fs.writeFileSync(
			path.join(root, "concept.md"),
			"---\ntype: concept\ntitle: T\ndescription: d\n---\nfact\n",
		);
		fs.writeFileSync(path.join(root, ".herdr-workflow", "w", "state"), "two\n");
		shim = installGitPushShim();
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki test"),
		);
		expect(result).toEqual({ committed: true, pushed: true });
		const message = execFileSync(
			"git",
			["-C", root, "log", "-1", "--pretty=%s"],
			{ encoding: "utf8" },
		).trim();
		expect(message).toBe("Update wiki test");
		const delivered = execFileSync(
			"git",
			["-C", root, "show", "--name-only", "--pretty=format:"],
			{ encoding: "utf8" },
		);
		expect(delivered).toContain("concept.md");
		expect(delivered).not.toContain(".herdr-workflow");
		const log = fs.readFileSync(shim.log, "utf8");
		expect(log).toContain("push --set-upstream -- origin main");
		expect(log).toContain("GIT_ALLOW_PROTOCOL=https:ssh:git");
	} finally {
		shim?.restore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki delivery pushes the tracked upstream without set-upstream", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-wiki-upstream-"),
	);
	let shim: ReturnType<typeof installGitPushShim> | undefined;
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: root });
		fs.writeFileSync(path.join(root, "index.md"), "base\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://example.invalid/wiki.git"],
			{ cwd: root },
		);
		execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
			cwd: root,
		});
		execFileSync("git", ["config", "branch.main.remote", "origin"], {
			cwd: root,
		});
		execFileSync("git", ["config", "branch.main.merge", "refs/heads/main"], {
			cwd: root,
		});
		fs.writeFileSync(path.join(root, "concept.md"), "fact\n");
		shim = installGitPushShim();
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki"),
		);
		expect(result).toEqual({ committed: true, pushed: true });
		const log = fs.readFileSync(shim.log, "utf8");
		expect(log).toContain(" push");
		expect(log).not.toContain("--set-upstream");
	} finally {
		shim?.restore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki delivery skips bundles that are not Git work trees", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-wiki-plain-"));
	try {
		fs.writeFileSync(path.join(root, "concept.md"), "fact\n");
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki"),
		);
		expect(result).toEqual({ committed: false, pushed: false });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki delivery commits without pushing when the bundle has no remote", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-wiki-noremote-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: root });
		fs.writeFileSync(path.join(root, "concept.md"), "fact\n");
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki"),
		);
		expect(result).toEqual({ committed: true, pushed: false });
		expect(
			execFileSync("git", ["-C", root, "log", "-1", "--pretty=%s"], {
				encoding: "utf8",
			}).trim(),
		).toBe("Update wiki");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki delivery commits without pushing on a detached HEAD", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-wiki-detached-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: root });
		fs.writeFileSync(path.join(root, "index.md"), "base\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://example.invalid/wiki.git"],
			{ cwd: root },
		);
		execFileSync("git", ["checkout", "-q", "--detach"], { cwd: root });
		fs.writeFileSync(path.join(root, "concept.md"), "fact\n");
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki"),
		);
		expect(result).toEqual({ committed: true, pushed: false });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("wiki delivery skips a bundle nested in a larger repository", async () => {
	const parent = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-wiki-parent-"),
	);
	const nested = path.join(parent, "wiki");
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: parent });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: parent,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: parent });
		fs.writeFileSync(path.join(parent, "index.md"), "base\n");
		execFileSync("git", ["add", "."], { cwd: parent });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: parent });
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "concept.md"), "fact\n");
		const result = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(nested, "Update wiki"),
		);
		expect(result).toEqual({ committed: false, pushed: false });
		expect(
			execFileSync("git", ["-C", parent, "log", "-1", "--pretty=%s"], {
				encoding: "utf8",
			}).trim(),
		).toBe("base");
		expect(
			execFileSync("git", ["-C", parent, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toContain("?? wiki/");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("wiki delivery rejects a non-allowlisted remote before committing", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-wiki-ext-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync("git", ["config", "user.email", "wiki@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "Wiki"], { cwd: root });
		fs.writeFileSync(path.join(root, "index.md"), "base\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		execFileSync(
			"git",
			["remote", "add", "origin", "ext::sh -c 'touch /tmp/pwned'"],
			{ cwd: root },
		);
		fs.writeFileSync(path.join(root, "concept.md"), "fact\n");
		const outcome = await Effect.runPromise(
			effectRunnerTest.commitAndPushWiki(root, "Update wiki").pipe(
				Effect.catchAllDefect((defect) =>
					Effect.fail(
						defect instanceof Error ? defect : new Error(String(defect)),
					),
				),
				Effect.either,
			),
		);
		expect(Either.isLeft(outcome)).toBe(true);
		if (Either.isLeft(outcome))
			expect(outcome.left).toBeInstanceOf(PermanentFailure);
		expect(
			execFileSync("git", ["-C", root, "log", "-1", "--pretty=%s"], {
				encoding: "utf8",
			}).trim(),
		).toBe("base");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
