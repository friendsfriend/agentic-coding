import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AgentAdapter,
	AgentObservation,
	LaunchContext,
} from "../src/workflow/adapters.ts";
import {
	AGENT_EXTENSION_SUBCOMMANDS,
	cliTest,
	paneForRunFactory,
	REQUIRED_FLAGS,
	run,
	SUBCOMMANDS,
} from "../src/workflow/cli.ts";
import type { AgentHandle } from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
	effectRunnerTest,
} from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

class StubAdapter implements AgentAdapter {
	readonly id = "pi" as const;
	async launch(ctx: LaunchContext): Promise<AgentHandle> {
		return { runtime: "pi", name: ctx.name, paneId: "pane" };
	}
	preflight() {}
	async prompt() {}
	async observe(handle: AgentHandle): Promise<AgentObservation> {
		return { status: "working", paneId: handle.paneId };
	}
	async stop() {}
}
function stubHerdr() {
	return {
		call(...args: string[]) {
			if (args[0] === "tab" && args[1] === "list")
				return { tabs: [{ tab_id: "tab1", label: "dashboard" }] };
			if (args[0] === "workspace" && args[1] === "create")
				return { workspace: { workspace_id: "workspace" } };
			throw new Error(`unexpected ${args.join(" ")}`);
		},
	};
}

describe("breaking workflow CLI surface", () => {
	test("exports only typed lifecycle commands", () => {
		expect(SUBCOMMANDS).toEqual([
			"start",
			"status",
			"action",
			"handoff",
			"question",
			"repair",
			"repin",
			"projects",
			"config",
			"agent-extension",
			"wiki",
		]);
		for (const removed of [
			"planner",
			"apply",
			"verify",
			"dispatch-verifiers",
			"verification-result",
			"finish-review",
			"archive",
			"git-operations",
			"phase",
			"override-phase",
			"message",
			"plugin",
		])
			expect(SUBCOMMANDS).not.toContain(removed as never);
		expect(AGENT_EXTENSION_SUBCOMMANDS).toEqual([
			"list",
			"install",
			"install-local",
		]);
		expect(REQUIRED_FLAGS.action).toEqual(["repo", "change", "revision"]);
		expect(REQUIRED_FLAGS.question).toEqual(["description"]);
	});
	test("help needs no config, database, or runtime", async () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (value) => lines.push(String(value));
		try {
			await run([]);
			for (const command of SUBCOMMANDS) await run([command, "--help"]);
		} finally {
			console.log = original;
		}
		expect(lines.join("\n")).toContain("agent-extension");
		expect(lines.join("\n")).toContain("handoff --outcome");
	});
	test("mode and action positionals fail at CLI boundary", async () => {
		expect(cliTest.parseMode("checkout")).toBe("checkout");
		expect(() => cliTest.parseMode("typo")).toThrow(
			"--mode must be worktree or checkout",
		);
		await expect(
			run(["action", "--repo", ".", "--change", "x", "--revision", "1"]),
		).rejects.toThrow("ACTION_ID is required");
		await expect(
			run([
				"action",
				"approve-plan",
				"extra",
				"--repo",
				".",
				"--change",
				"x",
				"--revision",
				"1",
			]),
		).rejects.toThrow("unexpected positional argument");
		await expect(
			run([
				"start",
				"--repo",
				".",
				"--change",
				"x",
				"--mode",
				"checkout",
				"--tiket",
				"42",
			]),
		).rejects.toThrow("unknown flag --tiket");
		await expect(
			run(["status", "--repo", ".", "--repo", ".", "--change", "x"]),
		).rejects.toThrow("duplicate flag --repo");
	});
	test("detached drain argv works in source-tree and compiled runners", () => {
		const source = cliTest.detachedDrainArgv("/abs/src/cli.ts", "/repo", "c1");
		expect(source[0]).toBe(process.execPath);
		expect(source.slice(1)).toEqual([
			"/abs/src/cli.ts",
			"workflow",
			"status",
			"--repo",
			"/repo",
			"--change",
			"c1",
		]);
		const compiled = cliTest.detachedDrainArgv(undefined, "/repo", "c1");
		expect(compiled.slice(1)).toEqual([
			"workflow",
			"status",
			"--repo",
			"/repo",
			"--change",
			"c1",
		]);
		expect(compiled[0]).toBe(process.execPath);
	});
	test("verification position counts the run itself, not all pending siblings", () => {
		const round = [{ id: "triage" }, { id: "qv" }, { id: "uv" }]; // qv launches before uv's launch effect runs, but uv's run already exists
		expect(cliTest.verificationPosition(round, "qv")).toEqual({ k: 2, n: 3 });
		expect(cliTest.verificationPosition(round, "uv")).toEqual({ k: 3, n: 3 });
		expect(cliTest.verificationPosition([{ id: "triage" }], "triage")).toEqual({
			k: 1,
			n: 1,
		});
		expect(cliTest.verificationPosition(round, "missing")).toEqual({
			k: 0,
			n: 3,
		});
	});
	test("legacy command is rejected without translation", async () => {
		await expect(
			run(["verify", "--repo", ".", "--change", "x"]),
		).rejects.toThrow("unknown command: verify");
	});
	test("handoff identity resolves this process's own (workflow, step, role) run, ignoring stale run-scoped env", async () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-cli-handoff-"),
		);
		const saved = { ...process.env };
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
			};
			const registry = registerBuiltins();
			const workflowEngine = new WorkflowEngine(registry);
			const started = workflowEngine.start({
				repo,
				changeId: "handoff-identity",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing,
			});
			const handlers = agentEffectHandlers(repo, workflowEngine, {
				registry,
				adapters: new Map([["pi", new StubAdapter()]]),
				herdr: stubHerdr(),
				async paneForRun() {
					return { paneId: "pane" };
				},
			});
			await new EffectRunner(repo, workflowEngine, handlers).drain();
			const activeRun = workflowEngine.getRun(repo, started.view.runs[0]?.id);
			expect(activeRun.status).toBe("working");

			// The subprocess must present the exact run identity and its launch-bound
			// token; sibling run.env files are never consulted for resolution.
			process.env.HERDR_WORKFLOW_ID = started.view.workflowId;
			process.env.HERDR_STEP_ID = "core.implementation";
			process.env.HERDR_ROLE = "worker";
			process.env.HERDR_RUN_ID = activeRun.id;
			process.env.HERDR_RUN_GENERATION = String(activeRun.generation);
			process.env.HERDR_RUN_TOKEN = workflowEngine.issueRunCapability(
				repo,
				activeRun.id,
			);

			const identity = cliTest.resolveHandoffIdentity(workflowEngine, repo);
			expect(identity.runId).toBe(activeRun.id);
			expect(identity.generation).toBe(activeRun.generation);
			expect(identity.outputPath).toBe(activeRun.outputPath);
			expect(identity.token).toBe(process.env.HERDR_RUN_TOKEN);

			delete process.env.HERDR_STEP_ID;
			expect(() =>
				cliTest.resolveHandoffIdentity(workflowEngine, repo),
			).toThrow("exact launch-bound run environment");

			// A sibling process cannot borrow another role's run just by knowing
			// its own workflow/step: resolution is scoped to its own role, and no
			// run is pending/working for a role that was never assigned one.
			process.env.HERDR_STEP_ID = "core.implementation";
			process.env.HERDR_ROLE = "someone-else-role";
			expect(() =>
				cliTest.resolveHandoffIdentity(workflowEngine, repo),
			).toThrow();
		} finally {
			process.env = saved;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
	test("handoff identity resolution rejects a stale process racing a not-yet-launched repaired run (QV-001)", async () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-cli-repair-race-"),
		);
		const saved = { ...process.env };
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
			};
			const registry = registerBuiltins();
			const workflowEngine = new WorkflowEngine(registry);
			const started = workflowEngine.start({
				repo,
				changeId: "repair-race",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing,
			});
			const handlers = agentEffectHandlers(repo, workflowEngine, {
				registry,
				adapters: new Map([["pi", new StubAdapter()]]),
				herdr: stubHerdr(),
				async paneForRun() {
					return { paneId: "pane" };
				},
			});
			await new EffectRunner(repo, workflowEngine, handlers).drain();
			const staleRun = workflowEngine.getRun(repo, started.view.runs[0]?.id);
			expect(staleRun.status).toBe("working");

			// Operator repairs back into the same step/role while that agent is
			// still mid-conversation: the old run is expired and a fresh `pending`
			// run is created for the same (workflowId, stepId, role) in the same
			// transaction, but its `agent.launch` effect has not been drained yet
			// — the still-alive stale process was never re-prompted.
			const repaired = workflowEngine.dispatch(repo, {
				type: "operator.repair",
				workflowId: started.view.workflowId,
				revision: workflowEngine.status(repo, "repair-race").revision,
				targetStep: "core.implementation",
				reason: "operator confirmed stale",
			});
			const freshRun = repaired.view.runs.find(
				(item) => item.status === "pending",
			);
			expect(freshRun).toBeTruthy();
			expect(freshRun?.id).not.toBe(staleRun.id);
			expect(workflowEngine.getRun(repo, staleRun.id).status).toBe("expired");

			// The stale process (still holding its original, now-expired identity)
			// must not be able to resolve — let alone hand off — the fresh,
			// not-yet-launched run just by sharing its (workflowId, stepId, role).
			process.env.HERDR_WORKFLOW_ID = started.view.workflowId;
			process.env.HERDR_STEP_ID = "core.implementation";
			process.env.HERDR_ROLE = "worker";
			process.env.HERDR_RUN_ID = staleRun.id;
			process.env.HERDR_RUN_GENERATION = String(staleRun.generation);
			process.env.HERDR_RUN_TOKEN = "whatever-the-stale-process-still-has";
			expect(() =>
				cliTest.resolveHandoffIdentity(workflowEngine, repo),
			).toThrow();

			// Once the repaired run's `agent.launch` effect actually drains (the
			// pane gets re-prompted and reaches `working`), resolution is legitimate again.
			await new EffectRunner(repo, workflowEngine, handlers).drain();
			if (!freshRun) throw new Error("expected relaunched run");
			const relaunched = workflowEngine.getRun(repo, freshRun.id);
			expect(relaunched.status).toBe("working");
			process.env.HERDR_RUN_ID = relaunched.id;
			process.env.HERDR_RUN_GENERATION = String(relaunched.generation);
			process.env.HERDR_RUN_TOKEN = workflowEngine.issueRunCapability(
				repo,
				relaunched.id,
			);
			const identity = cliTest.resolveHandoffIdentity(workflowEngine, repo);
			expect(identity.runId).toBe(freshRun?.id);
		} finally {
			process.env = saved;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("persistent roles reuse the resolved pane; tab create fires only on the no-agent outcome", async () => {
		const snapshot = {
			metadata: { workspace: "ws", worktree: "/tmp/wt", changeId: "change" },
			definition: { id: "standard", version: 1, digest: "d" },
		};
		const run = {
			id: "run-worker",
			workflowId: "wf",
			stepId: "core.implementation",
			role: "worker",
			attempt: 1,
			status: "pending",
		};
		const fakeEngine = {
			getRun: (_repo: string, id: string) => (id === run.id ? run : undefined),
			getSnapshot: () => snapshot,
			status: () => ({ runs: [run] }),
		} as unknown as WorkflowEngine;
		const canonical = effectRunnerTest.canonicalAgentName(
			"change",
			"standard",
			{
				stepId: run.stepId,
				role: run.role,
				id: run.id,
			},
		);
		const calls: string[][] = [];
		const herdrWithLive = (live: boolean) => ({
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "agent" && args[1] === "get") {
					if (live && args[2] === canonical)
						return {
							agent: { pane_id: "live-pane", agent_status: "working" },
						};
					throw new Error(`not found: ${args[2]}`);
				}
				if (args[0] === "tab" && args[1] === "create")
					return { root_pane: { pane_id: "new-pane", tab_id: "new-tab" } };
				return {};
			},
		});

		// Live agent under the canonical name: adopt its pane, never create a tab.
		calls.length = 0;
		const reused = await paneForRunFactory(
			fakeEngine,
			"/repo",
			herdrWithLive(true),
		)(run.id);
		expect(reused).toEqual({ paneId: "live-pane" });
		expect(
			calls.some((args) => args[0] === "tab" && args[1] === "create"),
		).toBe(false);

		// No live agent anywhere: only now may a new tab be created.
		calls.length = 0;
		const spawned = await paneForRunFactory(
			fakeEngine,
			"/repo",
			herdrWithLive(false),
		)(run.id);
		expect(spawned).toEqual({ paneId: "new-pane", tabId: "new-tab" });
		expect(
			calls.filter((args) => args[0] === "tab" && args[1] === "create"),
		).toHaveLength(1);
	});

	test("verifier runs reuse a live canonical-name pane before creating a tab", async () => {
		const snapshot = {
			metadata: { workspace: "ws", worktree: "/tmp/wt", changeId: "change" },
			definition: { id: "standard", version: 1, digest: "d" },
		};
		const run = {
			id: "qv",
			workflowId: "wf",
			stepId: "core.verification",
			role: "quality-verifier",
			attempt: 1,
			status: "pending",
		};
		const fakeEngine = {
			getRun: (_repo: string, id: string) => (id === run.id ? run : undefined),
			getSnapshot: () => snapshot,
			status: () => ({ runs: [run] }),
		} as unknown as WorkflowEngine;
		const canonical = effectRunnerTest.canonicalAgentName(
			"change",
			"standard",
			{ stepId: run.stepId, role: run.role, id: run.id },
		);
		const calls: string[][] = [];
		const herdr = {
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "agent" && args[1] === "get") {
					if (args[2] === canonical)
						return {
							agent: { pane_id: "verifier-live", agent_status: "working" },
						};
					throw new Error(`not found: ${args[2]}`);
				}
				if (args[0] === "tab" && args[1] === "create")
					return { root_pane: { pane_id: "new-pane", tab_id: "new-tab" } };
				return {};
			},
		};

		expect(await paneForRunFactory(fakeEngine, "/repo", herdr)(run.id)).toEqual(
			{
				paneId: "verifier-live",
			},
		);
		expect(
			calls.some((args) => args[0] === "tab" && args[1] === "create"),
		).toBe(false);
	});

	test("verification layout anchors on siblings confirmed live by canonical name, not stored pane ids", async () => {
		const snapshot = {
			metadata: { workspace: "ws", worktree: "/tmp/wt", changeId: "change" },
			definition: { id: "standard", version: 1, digest: "d" },
		};
		const qv = {
			id: "qv",
			workflowId: "wf",
			stepId: "core.verification",
			role: "quality-verifier",
			attempt: 1,
			status: "working",
		};
		const sibling = {
			id: "sv",
			workflowId: "wf",
			stepId: "core.verification",
			role: "security-verifier",
			attempt: 1,
			status: "working",
		};
		const fakeEngine = {
			getRun: (_repo: string, id: string) =>
				[qv, sibling].find((r) => r.id === id),
			getSnapshot: () => snapshot,
			status: () => ({ runs: [qv, sibling] }),
		} as unknown as WorkflowEngine;
		const siblingCanonical = effectRunnerTest.canonicalAgentName(
			"change",
			"standard",
			{ stepId: sibling.stepId, role: sibling.role, id: sibling.id },
		);
		const calls: string[][] = [];
		const herdr = {
			call(...args: string[]) {
				calls.push(args);
				if (args[0] === "agent" && args[1] === "get") {
					if (args[2] === siblingCanonical)
						return {
							agent: { pane_id: "sibling-live", agent_status: "working" },
						};
					throw new Error(`not found: ${args[2]}`);
				}
				if (args[0] === "pane" && args[1] === "layout")
					return {
						layout: { panes: [{ pane_id: "sibling-live", rect: { y: 0 } }] },
					};
				if (args[0] === "pane" && args[1] === "split")
					return { pane: { pane_id: "split-pane", tab_id: "tab-split" } };
				return {};
			},
		};
		const pane = await paneForRunFactory(fakeEngine, "/repo", herdr)(qv.id);
		// The sibling had no persisted handle: the split targets its live pane
		// found via the canonical name instead of falling through to tab creation.
		expect(
			calls.some((args) => args[0] === "pane" && args.includes("dead-pane")),
		).toBe(false);
		expect(calls).toContainEqual([
			"pane",
			"split",
			"sibling-live",
			"--direction",
			"down",
			"--ratio",
			"0.5",
		]);
		expect(pane).toEqual({ paneId: "split-pane", tabId: "tab-split" });
	});
});
