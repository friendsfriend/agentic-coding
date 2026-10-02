import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import type {
	AgentHandle,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import { LuvusMultiplexer } from "../src/multiplexer/luvus/index.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { cliTest } from "../src/workflow/cli.ts";
import {
	definitionVersionForBehaviorPins,
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
	effectRunnerTest,
	PermanentFailure,
	resolveLiveAgentAsync,
	TransientFailure,
} from "../src/workflow/effect-runner.ts";
import {
	LayaLocalClassifier,
	type LayaSidecar,
	setLayaLocalClassifier,
} from "../src/workflow/laya-local.ts";
import {
	type TelemetryEnvelope,
	workflowTraceId,
} from "../src/workflow/observability.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import { asPort } from "./fakes.ts";
import { autoRemoveRepoFixtures, createRepoFixture } from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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

test("a lease lost while dispatching an unhandled effect is classified, not fatal", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-no-handler-"));
	try {
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
		const registry = registerBuiltins();
		// The clock advances on every read, so the drain's claim (leaseMs = 1) is
		// already expired by the time it dispatches the "no handler" outcome. That
		// is the same stale-effect the live runner hits when a lease is genuinely
		// stolen, without depending on machine load.
		let reads = 0;
		const base = Date.now();
		const engine = new WorkflowEngine(registry, () => {
			reads += 1;
			return new Date(base + reads);
		});
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
		engine.start({
			repo,
			workflowId: "no-handler-lease",
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
		const failures: string[] = [];
		// No handlers at all: the only path is the "no handler" classification.
		const drained = await new EffectRunner(repo, engine, {}).drain(
			1,
			2,
			undefined,
			(workflowId) => failures.push(workflowId),
		);
		// The drain program survives (a stale dispatch used to escape as a defect)
		// and the effect is left to its successor rather than published as failed.
		expect(drained).toBe(0);
		expect(failures).toEqual([]);
		expect(engine.status(repo, "no-handler-lease").effects[0]?.status).not.toBe(
			"failed",
		);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("runner cancels a lost effect and a successor can reclaim it", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-lease-loss-"));
	try {
		createRepoFixture(repo, {
			files: { "README.md": "x\n", ".gitignore": ".herdr-workflow\n" },
		});
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
		await runner.drain(1, 5_000);
		expect(cancelled).toBe(1);
		const successor = engine.claimEffects(repo, 1, 5_000);
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
		await recovery.drain(1, 5_000);
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
		}).drain(1, 5_000);
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
		await repairRunner.drain(1, 5_000);
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
			port: asPort(herdr),
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
			port: asPort(herdr),
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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(repo, {
			files: {
				"README.md": "x\n",
				"openspec/config.yaml": "schema: spec-driven\n",
			},
		});
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
			definitionId: "openspec",
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
		const handlers = {
			...agentEffectHandlers(repo, engine, {
				registry,
				adapters: new Map([["pi", adapter]]),
				port: asPort(herdr),
				async paneForRun() {
					paneForRunCalls++;
					if (paneForRunCalls > 1)
						throw new Error("must not create a second pane");
					return { paneId: "planner-pane", owned: true };
				},
			}),
			// The routing pass is exercised elsewhere; this test only needs the
			// graph to advance to core.plan without a network call.
			"model.classify": {
				execute: () =>
					Effect.succeed({
						integration: "routing",
						phase: "plan",
						answers: {},
					}),
			},
		};

		await new EffectRunner(repo, engine, handlers).drain();
		expect(adapter.launches).toBe(1);
		expect(paneForRunCalls).toBe(1);
		const firstRunId = engine.status(repo, "plan-reuse").runs[0]?.id;
		const firstName = adapter.context?.name;
		expect(firstName).toBe(
			effectRunnerTest.canonicalAgentName("plan-reuse", "openspec", {
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
			"openspec",
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
		"openspec",
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
		effectRunnerTest.canonicalAgentName("change-id", "openspec", {
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
		"concurrency-verifier",
		"migration-verifier",
		"test-quality-verifier",
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

test("resolveLiveAgent reuses the live pane and recovers stale handles by identity", async () => {
	const run = {
		stepId: "core.implementation",
		role: "worker",
		id: "1234567890abcdef",
	};
	const canonical = effectRunnerTest.canonicalAgentName(
		"change",
		"openspec",
		run,
	);
	const legacy = effectRunnerTest.legacyRunName("change", run);
	const portWith = (responses: Record<string, unknown>) =>
		asPort({
			call(...args: string[]) {
				if (args[0] === "agent" && args[1] === "get") {
					if (!(args[2] in responses)) throw new Error(`not found: ${args[2]}`);
					return responses[args[2]];
				}
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		});

	// Stale stored pane id, live agent under the canonical name: adopt its pane.
	const stale = await resolveLiveAgentAsync(
		portWith({
			[canonical]: {
				agent: {
					pane_id: "moved-pane",
					tab_id: "tab9",
					agent_status: "working",
				},
			},
		}),
		"change",
		"openspec",
		{ ...run, handle: { runtime: "pi", name: canonical, paneId: "dead-pane" } },
	);
	expect(stale?.paneId).toBe("moved-pane");
	expect(stale?.tabId).toBe("tab9");
	expect(stale?.name).toBe(canonical);

	// Live handle confirmed via its own pane id: reused as-is.
	const healthy = await resolveLiveAgentAsync(
		portWith({
			"kept-pane": {
				agent: { pane_id: "kept-pane", agent_status: "idle" },
			},
		}),
		"change",
		"openspec",
		{ ...run, handle: { runtime: "pi", name: canonical, paneId: "kept-pane" } },
	);
	expect(healthy?.paneId).toBe("kept-pane");

	// Live agent reachable only under the legacy name: adopted and re-keyed.
	const migrated = await resolveLiveAgentAsync(
		portWith({
			[legacy]: { agent: { pane_id: "legacy-pane", agent_status: "working" } },
		}),
		"change",
		"openspec",
		run,
	);
	expect(migrated?.paneId).toBe("legacy-pane");
	expect(migrated?.name).toBe(canonical);

	// No live agent anywhere: the only outcome allowed to spawn.
	expect(
		await resolveLiveAgentAsync(portWith({}), "change", "openspec", run),
	).toBeUndefined();
	// A dead tracked process reports 'unknown' and must not count as live.
	expect(
		await resolveLiveAgentAsync(
			portWith({
				[canonical]: { agent: { pane_id: "p", agent_status: "unknown" } },
			}),
			"change",
			"openspec",
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
		createRepoFixture(repo, {
			files: {
				"README.md": "x\n",
				"openspec/config.yaml": "schema: spec-driven\n",
			},
		});
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
			port: asPort(herdr),
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

test("workspace setup restores the developer's focused workspace", async () => {
	// Luvus's tab API is workspace-scoped (tab.new/tab.list ignore workspace_id),
	// so setup must focus the workflow workspace; it must put the developer's
	// workspace back instead of leaving the view on the workflow.
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-focus-"));
	try {
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
		engine.start({
			repo,
			mode: "checkout",
			workflowId: "focus-restore",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing,
		});
		const focuses: string[] = [];
		const port = new LuvusMultiplexer({
			socketPath: "/unused.sock",
			sleep: () => Effect.void,
			request: async (method, params) => {
				if (method === "workspace.list")
					return {
						type: "workspace_list",
						workspaces: [
							{
								workspace: "0",
								workspace_id: "developer",
								name: "developer",
								cwd: "/developer",
								active: true,
							},
						],
					};
				if (method === "workspace.get") {
					const id = String(params.workspace_id ?? params.workspace ?? "");
					// The workflow id has no workspace yet, so setup creates one; every
					// other id resolves (workspaceFocus re-resolves the target).
					if (id === "focus-restore")
						throw Object.assign(new Error("workspace not found"), {
							code: "not_found",
						});
					return { type: "workspace", workspace_id: id };
				}
				if (method === "workspace.open")
					return { type: "workspace", workspace: "workflow-ws" };
				if (method === "workspace.rename") return { type: "workspace_rename" };
				if (method === "workspace.focus") {
					focuses.push(String(params.workspace_id));
					return { type: "ok" };
				}
				if (method === "tab.list")
					return {
						type: "tab_list",
						tabs: [{ tab: "1", tab_id: "tab1", name: "root" }],
					};
				if (method === "tab.get")
					return typeof params.tab_id === "string"
						? { type: "tab", tab: "1", tab_id: params.tab_id, panes: ["2"] }
						: {
								type: "tab",
								tab: params.tab,
								tab_id: "tab2",
								workspace_id: "workflow-ws",
								panes: ["2"],
							};
				if (method === "tab.new") return { type: "tab", tab: "2" };
				if (method === "pane.get")
					return {
						type: "pane",
						pane: "2",
						tab_id: "tab1",
						workspace_id: "workflow-ws",
					};
				if (method === "pane.processes")
					return { type: "pane_processes", root_process: { pid: 1 } };
				if (["tab.rename", "pane.run", "workspace.close"].includes(method))
					return { type: "ok" };
				throw new Error(`unexpected ${method}`);
			},
		});
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map(),
			port,
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		const setup = engine
			.claimEffects(repo, 10)
			.find((effect) => effect.kind === "workspace.setup");
		if (!setup) throw new Error("expected workspace setup effect");
		const result = await Effect.runPromise(
			handlers["workspace.setup"]?.execute(setup) ?? Effect.never,
		);
		expect(result).toMatchObject({
			workspace: "workflow-ws",
			worktree: fs.realpathSync(repo),
		});
		expect(focuses).toContain("workflow-ws");
		expect(focuses.at(-1)).toBe("developer");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("workspace retry recovers stable branch and workspace identity", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-workspace-recover-"),
	);
	try {
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
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
			port: asPort(herdr),
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
		createRepoFixture(root, {
			identity: { name: "Wiki", email: "wiki@example.com" },
			unborn: true,
		});
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
		createRepoFixture(root, {
			identity: { name: "Wiki", email: "wiki@example.com" },
			unborn: true,
		});
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
		createRepoFixture(root, {
			identity: { name: "Wiki", email: "wiki@example.com" },
			unborn: true,
		});
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
		createRepoFixture(root, {
			identity: { name: "Wiki", email: "wiki@example.com" },
			unborn: true,
		});
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
		createRepoFixture(root, {
			identity: { name: "Wiki", email: "wiki@example.com" },
			unborn: true,
		});
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

test("adapter baseline telemetry emits launch, delivery, stop, and failure", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-adapter-telemetry-"),
	);
	try {
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const started = engine.start({
			repo,
			workflowId: "adapter-telemetry",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/x",
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
		const runSummary = started.view.runs[0];
		if (!runSummary) throw new Error("expected a worker run");
		const run = engine.getRun(repo, runSummary.id);
		const envelopes: Array<Record<string, unknown>> = [];
		let failLaunch = false;
		let launchEnvironment: Record<string, string> | undefined;
		const adapter: AgentAdapter = {
			id: "pi" as const,
			preflight() {},
			launch(ctx: LaunchContext) {
				launchEnvironment = ctx.environment;
				return failLaunch
					? Effect.fail(new PermanentFailure("launch failed"))
					: Effect.succeed({
							runtime: "pi" as const,
							name: "agent",
							paneId: "pane",
							sessionId: "session-1",
						});
			},
			prompt() {
				return Effect.void;
			},
			observe(handle) {
				return Effect.succeed({
					status: "working" as const,
					paneId: handle.paneId,
				});
			},
			stop() {
				return Effect.void;
			},
		};
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi", adapter]]),
			port: asPort({
				call() {
					throw new Error("unexpected herdr call");
				},
			}),
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
			telemetry: (_directory, envelope) => {
				envelopes.push(envelope as unknown as Record<string, unknown>);
			},
		});
		await new EffectRunner(repo, engine, handlers).drain();
		expect(
			envelopes.some(
				(envelope) =>
					envelope.event === "agent.launch.attempt" &&
					envelope.layer === "adapter",
			),
		).toBe(true);
		expect(
			envelopes.some(
				(envelope) =>
					envelope.event === "agent.launch" && envelope.outcome === "ok",
			),
		).toBe(true);
		// Adapter events and the launched agent share one workflow trace, so a
		// traceparent-based viewer groups the whole workflow into a single trace.
		const workflowTrace = workflowTraceId("adapter-telemetry");
		expect(envelopes.length).toBeGreaterThan(0);
		expect(
			envelopes.every(
				(envelope) =>
					String(envelope.traceparent).split("-")[1] === workflowTrace,
			),
		).toBe(true);
		expect(launchEnvironment?.TRACEPARENT?.split("-")[1]).toBe(workflowTrace);

		const db = new Database(canonicalStorePath(repo));
		const revision = (
			db
				.query("SELECT revision FROM workflow_instances WHERE id=?")
				.get("adapter-telemetry") as { revision: number }
		).revision;
		const insert = (kind: string, key: string, payload: unknown) =>
			db
				.query("INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
				.run(
					randomUUID(),
					"adapter-telemetry",
					revision,
					kind,
					key,
					JSON.stringify(payload),
					"pending",
					0,
					4,
					null,
					null,
					null,
					null,
				);
		insert("agent.prompt", `prompt:${run.id}`, {
			runId: run.id,
			message: "hello",
		});
		insert("agent.stop", `stop:${run.id}`, { runId: run.id });
		db.close();
		await new EffectRunner(repo, engine, handlers).drain();
		expect(
			envelopes.some(
				(envelope) =>
					envelope.event === "agent.assignment.delivered" &&
					envelope.outcome === "ok" &&
					envelope.runId === run.id,
			),
		).toBe(true);
		expect(
			envelopes.some(
				(envelope) =>
					envelope.event === "agent.stop" && envelope.outcome === "ok",
			),
		).toBe(true);

		const view = engine.status(repo, "adapter-telemetry");
		engine.dispatch(repo, {
			type: "operator.repair",
			workflowId: view.workflowId,
			revision: view.revision,
			targetStep: "core.implementation",
			reason: "test repair",
		});
		failLaunch = true;
		await new EffectRunner(repo, engine, handlers).drain();
		expect(
			envelopes.some(
				(envelope) =>
					envelope.event === "agent.launch" &&
					envelope.outcome === "error" &&
					typeof envelope["herdr.error.class"] === "string",
			),
		).toBe(true);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

function classifierHandlerFixture(
	telemetry: (directory: string, envelope: TelemetryEnvelope) => void,
): {
	repo: string;
	handler: NonNullable<
		ReturnType<typeof agentEffectHandlers>["model.classify"]
	>;
	effect: Parameters<
		NonNullable<
			ReturnType<typeof agentEffectHandlers>["model.classify"]
		>["execute"]
	>[0];
} {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "routing-telemetry-"));
	const registry = registerBuiltins();
	const definition = registry.definition(
		"openspec",
		definitionVersionForBehaviorPins(6),
	);
	const snapshot = {
		workflowId: "routing-telemetry",
		currentStep: "core.route-apply",
		definition: {
			id: definition.id,
			version: definition.version,
			digest: definition.digest,
		},
		metadata: {
			repository: repo,
			worktree: repo,
			changeId: "change",
			task: "private task text",
			// Pin the provider this fixture exercises. Without a pin the resolution
			// falls back to the layered configuration, so a developer machine whose
			// `[agents.classifier].provider` names the local sidecar sent the request
			// to 127.0.0.1 and the hosted-endpoint assertions read the wrong host.
			// The pin is what every real run carries, too.
			classifier: "opencode-zen",
		},
	} as unknown as WorkflowSnapshot;
	const engine = {
		getSnapshot: () => snapshot,
	} as unknown as WorkflowEngine;
	const handlers = agentEffectHandlers(repo, engine, {
		registry,
		adapters: new Map(),
		port: asPort({ call: () => ({}) }),
		paneForRun: async () => ({ paneId: "unused", owned: false }),
		telemetry,
	});
	const handler = handlers["model.classify"];
	if (!handler) throw new Error("expected model.classify handler");
	return {
		repo,
		handler,
		effect: {
			id: "classify-effect",
			workflowId: snapshot.workflowId,
			kind: "model.classify",
			payload: { integration: "routing", phase: "apply" },
		} as never,
	};
}

test("classifier provider telemetry reports bounded metadata and conditional usage", async () => {
	const originalFetch = globalThis.fetch;
	const originalApiKey = process.env.OPENCODE_API_KEY;
	process.env.OPENCODE_API_KEY = "test-key";
	const envelopes: TelemetryEnvelope[] = [];
	const fixture = classifierHandlerFixture((_directory, envelope) => {
		envelopes.push(envelope);
	});
	try {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					answers: {
						"core.implementation": {
							type: "choice",
							choice: "quick",
							confidence: 0.9,
						},
					},
					usage: { total_tokens: 42, cost: 0.125 },
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const result = (await Effect.runPromise(
			fixture.handler.execute(fixture.effect),
		)) as { answers?: unknown };
		expect(result.answers).toBeDefined();
		const request = envelopes.find((item) => item.event === "routing.request");
		const response = envelopes.find(
			(item) => item.event === "routing.response",
		);
		expect(request).toMatchObject({
			layer: "adapter",
			model: "opencode/jev-1.13-free",
			effectId: "classify-effect",
			"herdr.routing.integration": "routing",
			"herdr.routing.phase": "apply",
			"herdr.routing.steps.asked": 5,
			"herdr.routing.artifacts.count": 0,
			"herdr.routing.timeout.ms": 300000,
			"herdr.routing.endpoint.host": "opencode.ai",
		});
		expect(response).toMatchObject({
			outcome: "ok",
			"herdr.routing.status": 200,
			"herdr.routing.status.class": "2xx",
			tokens: 42,
			cost: 0.125,
		});
		expect(response?.["herdr.routing.answers.choice"]).toBe(1);
		expect(response?.["herdr.routing.answers.noul"]).toBe(4);
		expect(JSON.stringify(envelopes)).not.toContain("private task text");

		envelopes.length = 0;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: {} }), {
				status: 200,
			})) as unknown as typeof fetch;
		await Effect.runPromise(fixture.handler.execute(fixture.effect));
		const withoutUsage = envelopes.find(
			(item) => item.event === "routing.response",
		);
		expect(withoutUsage?.tokens).toBeUndefined();
		expect(withoutUsage?.cost).toBeUndefined();
	} finally {
		globalThis.fetch = originalFetch;
		if (originalApiKey === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = originalApiKey;
		fs.rmSync(fixture.repo, { recursive: true, force: true });
	}
});

test("classifier provider failures emit one content-free response and telemetry cannot change the result", async () => {
	const originalFetch = globalThis.fetch;
	const originalApiKey = process.env.OPENCODE_API_KEY;
	process.env.OPENCODE_API_KEY = "test-key";
	const envelopes: TelemetryEnvelope[] = [];
	const fixture = classifierHandlerFixture((_directory, envelope) => {
		envelopes.push(envelope);
	});
	try {
		globalThis.fetch = (async () =>
			new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
		await expect(
			Effect.runPromise(fixture.handler.execute(fixture.effect)),
		).rejects.toThrow();
		let responses = envelopes.filter(
			(item) => item.event === "routing.response",
		);
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			outcome: "error",
			"herdr.routing.status": 503,
			"herdr.routing.status.class": "5xx",
		});
		expect(responses[0]?.["herdr.routing.answers.choice"]).toBeUndefined();

		envelopes.length = 0;
		globalThis.fetch = (async () =>
			new Response("invalid", { status: 400 })) as unknown as typeof fetch;
		await expect(
			Effect.runPromise(fixture.handler.execute(fixture.effect)),
		).rejects.toThrow();
		responses = envelopes.filter((item) => item.event === "routing.response");
		expect(responses).toHaveLength(1);
		expect(responses[0]?.["herdr.routing.status.class"]).toBe("4xx");

		envelopes.length = 0;
		globalThis.fetch = (async () => {
			throw new Error("network unavailable");
		}) as unknown as typeof fetch;
		await expect(
			Effect.runPromise(fixture.handler.execute(fixture.effect)),
		).rejects.toThrow();
		responses = envelopes.filter((item) => item.event === "routing.response");
		expect(responses).toHaveLength(1);
		expect(responses[0]?.["herdr.routing.status.class"]).toBe("transport");

		envelopes.length = 0;
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((callback: TimerHandler) =>
			originalSetTimeout(callback, 0)) as unknown as typeof setTimeout;
		try {
			globalThis.fetch = ((_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					const abort = () => reject(new Error("aborted"));
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				})) as typeof fetch;
			await expect(
				Effect.runPromise(fixture.handler.execute(fixture.effect)),
			).rejects.toThrow();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
		responses = envelopes.filter((item) => item.event === "routing.response");
		expect(responses).toHaveLength(1);
		expect(responses[0]?.["herdr.routing.status.class"]).toBe("transport");

		envelopes.length = 0;
		process.env.OPENCODE_API_KEY = " ";
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("unexpected");
		}) as unknown as typeof fetch;
		await expect(
			Effect.runPromise(fixture.handler.execute(fixture.effect)),
		).rejects.toThrow();
		expect(fetchCalled).toBe(false);
		expect(envelopes).toHaveLength(0);
		process.env.OPENCODE_API_KEY = "test-key";

		const throwing = classifierHandlerFixture(() => {
			throw new Error("sink failed");
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: {} }), {
				status: 200,
			})) as unknown as typeof fetch;
		const result = (await Effect.runPromise(
			throwing.handler.execute(throwing.effect),
		)) as { answers?: Record<string, unknown> };
		expect(Object.keys(result.answers ?? {})).toHaveLength(5);
		fs.rmSync(throwing.repo, { recursive: true, force: true });
	} finally {
		globalThis.fetch = originalFetch;
		if (originalApiKey === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = originalApiKey;
		fs.rmSync(fixture.repo, { recursive: true, force: true });
	}
});

// ── local classifier on the launch path ─────────────────────────────────────
// The launch handler starts the engine-owned local sidecar before it builds the
// pane's classifier binding, so `ask_jev` can answer in a run that pinned
// `laya-local`. These tests drive the real handler with a stubbed classifier,
// which is the only place that wiring is observable: the predicate, the adapter
// merge and the settings reader are covered separately.

/** A capturing adapter for any runtime, so a launch test can assert what the
 * handler handed the adapter instead of only that it launched. */
class CapturingAdapter implements AgentAdapter {
	readonly id: AgentAdapter["id"];
	launches = 0;
	context?: LaunchContext;
	constructor(id: AgentAdapter["id"]) {
		this.id = id;
	}
	preflight() {}
	launch(ctx: LaunchContext) {
		this.launches++;
		this.context = ctx;
		return Effect.succeed({
			runtime: ctx.profile.runtime,
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
		return Effect.void;
	}
}

interface LocalLaunchHarness {
	readonly context: () => LaunchContext | undefined;
	readonly starts: () => number;
	dispose: () => void;
}

/** Drive one `core.implementation` launch through the engine with a stubbed
 * local classifier, returning what the launch handler produced. */
async function drainLaunchWithClassifier(options: {
	readonly runtime: "pi" | "opencode";
	readonly pinnedProvider: string;
	readonly start?: () => Promise<LayaSidecar>;
	readonly piDefaultTools?: Record<string, unknown>;
}): Promise<LocalLaunchHarness> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-localjev-"));
	const configRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-localjev-cfg-"),
	);
	const modelDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-localjev-model-"),
	);
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-localjev-pi-"),
	);
	const previousConfig = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	let starts = 0;
	try {
		createRepoFixture(repo, { files: { "README.md": "x\n" } });
		// The pinned classifier lives in the config the engine reads, and the
		// model file makes the install "already on disk" so the stub never
		// acquires anything.
		fs.writeFileSync(
			path.join(configRoot, "config.json"),
			JSON.stringify({
				agents: { classifier: { provider: options.pinnedProvider } },
			}),
		);
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify(options.piDefaultTools ?? {}),
		);
		fs.writeFileSync(path.join(modelDir, "model.onnx"), "model");
		process.env.AGENTIC_CODING_CONFIG_DIR = configRoot;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const classifier = new LayaLocalClassifier({
			paths: () => ({
				installDir: modelDir,
				cacheDir: modelDir,
				backend: "native",
				port: 4571,
			}),
			acquire: async () => ({
				path: path.join(modelDir, "model.onnx"),
				bytes: 1,
			}),
			totalBytes: () => 1,
			start: async () => {
				starts += 1;
				if (options.start) return await options.start();
				return { url: "http://127.0.0.1:4321", stop: async () => {} };
			},
		});
		setLayaLocalClassifier(classifier);
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const profile = {
			name: options.runtime,
			runtime: options.runtime,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		engine.start({
			repo,
			mode: "checkout",
			workflowId: "localjev",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/localjev",
				baseBranch: "main",
				baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: repo,
					encoding: "utf8",
				}).trim(),
				task: "task",
				classifier: options.pinnedProvider,
			},
			routing: {
				defaultProfile: options.runtime,
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
				diversity: [],
			},
		});
		const herdr = {
			call(...args: string[]) {
				if (args[0] === "tab" && args[1] === "list")
					return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
				if (args[0] === "workspace" && args[1] === "create")
					return { workspace: { workspace_id: "workspace" } };
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		};
		const adapter = new CapturingAdapter(options.runtime);
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([[options.runtime, adapter]]),
			port: asPort(herdr),
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		await new EffectRunner(repo, engine, handlers).drain();
		return {
			context: () => adapter.context,
			starts: () => starts,
			dispose: () => {
				setLayaLocalClassifier();
				if (previousConfig === undefined)
					delete process.env.AGENTIC_CODING_CONFIG_DIR;
				else process.env.AGENTIC_CODING_CONFIG_DIR = previousConfig;
				if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgent;
				for (const dir of [repo, configRoot, modelDir, agentDir])
					fs.rmSync(dir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		setLayaLocalClassifier();
		if (previousConfig === undefined)
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previousConfig;
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
		for (const dir of [repo, configRoot, modelDir, agentDir])
			fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

test("a launch with the local classifier starts the sidecar before it binds it", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "pi",
		pinnedProvider: "laya-local",
		piDefaultTools: { defaultTools: ["+codemode"] },
	});
	try {
		// Started here, not only by the server: without this the tool loads and
		// answers nothing.
		expect(harness.starts()).toBe(1);
		// Started *then* bound: the endpoint is the sidecar's own.
		expect(harness.context()?.jev?.endpoint).toBe(
			"http://127.0.0.1:4321/v1/systemone",
		);
		expect(harness.context()?.jevExtensionPath).toContain("ask-jev.ts");
		// The same launch also carries the user's globally configured tools.
		expect(harness.context()?.globalTools).toEqual([
			{ tool: "codemode", extension: "codemode" },
		]);
	} finally {
		harness.dispose();
	}
});

test("a hosted classifier selection never starts the local sidecar", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "pi",
		pinnedProvider: "opencode-zen",
	});
	try {
		expect(harness.starts()).toBe(0);
		expect(harness.context()?.jev).toBeUndefined();
		// The tool is still loaded for the run; it reports the missing binding.
		expect(harness.context()?.jevExtensionPath).toContain("ask-jev.ts");
	} finally {
		harness.dispose();
	}
});

test("a non-pi run never starts the local sidecar", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "opencode",
		pinnedProvider: "laya-local",
	});
	try {
		expect(harness.starts()).toBe(0);
		expect(harness.context()?.globalTools).toBeUndefined();
	} finally {
		harness.dispose();
	}
});

test("a sidecar that cannot start degrades the launch instead of failing it", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "pi",
		pinnedProvider: "laya-local",
		start: async () => {
			throw new Error("sidecar exploded");
		},
	});
	try {
		expect(harness.starts()).toBe(1);
		// The launch proceeded with no binding: the optional tool must never fail
		// a run.
		expect(harness.context()).toBeDefined();
		expect(harness.context()?.jev).toBeUndefined();
	} finally {
		harness.dispose();
	}
});
