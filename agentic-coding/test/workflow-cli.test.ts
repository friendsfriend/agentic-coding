import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { AgentHandle } from "../src/contracts/workflow.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { WorkflowApplication } from "../src/workflow/application.ts";
import {
	cliTest,
	REQUIRED_FLAGS,
	run,
	SUBCOMMANDS,
} from "../src/workflow/cli.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { QUESTION_WAIT_MS, WorkflowEngine } from "../src/workflow/runtime.ts";
import type { StepBehavior } from "../src/workflow/steps/types.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const _openspecFullDigest = registerBuiltins().definition("openspec", 1).digest;

class StubAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	launch(ctx: LaunchContext) {
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	preflight() {}
	prompt() {
		return Effect.void;
	}
	observe(_handle: AgentHandle) {
		return Effect.succeed({ status: "working" as const });
	}
	stop() {
		return Effect.void;
	}
}
// A step behavior with a shared constant group and no `groupByRole`. It drives
// the generic grid-split allocation path that verifier roles took before
// per-role tabs, so that path stays covered after the built-in verifiers moved
// to one tab per role.
const sharedGroupBehavior: StepBehavior = {
	roundScoped: true,
	paneGroup: "verification",
};
const sharedGroupDefinition = {
	id: "synthetic-shared",
	version: 1,
	digest: "synthetic-shared",
};
const _sharedGroupRegistry = {
	definition: () => sharedGroupDefinition,
	stepForDefinition: () => ({ behavior: sharedGroupBehavior }),
};

describe("breaking workflow CLI surface", () => {
	test("exports only typed lifecycle commands", () => {
		expect(SUBCOMMANDS).toEqual([
			"start",
			"define",
			"status",
			"drain",
			"action",
			"handoff",
			"question",
			"ask",
			"answer",
			"research-handoff",
			"repair",
			"repin",
			"migrate",
			"projects",
			"config",
			"agent-extension",
			"wiki",
			"sidebar",
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
		expect(REQUIRED_FLAGS.action).toEqual(["repo", "workflow-id", "revision"]);
		expect(REQUIRED_FLAGS.define).toEqual(["repo", "file"]);
		expect(REQUIRED_FLAGS.status).toEqual(["repo", "workflow-id"]);
		expect(REQUIRED_FLAGS.drain).toEqual(["repo"]);
		expect(REQUIRED_FLAGS.repin).toEqual(["repo", "workflow-id"]);
		expect(REQUIRED_FLAGS.question).toEqual(["description"]);
		expect(REQUIRED_FLAGS["research-handoff"]).toEqual([
			"subject",
			"directives",
		]);
	});

	test("question timeout accepts the 24-hour maximum and rejects invalid values", () => {
		expect(QUESTION_WAIT_MS).toBe(24 * 60 * 60_000);
		expect(() => cliTest.validateQuestionTimeout(1)).not.toThrow();
		expect(() =>
			cliTest.validateQuestionTimeout(QUESTION_WAIT_MS),
		).not.toThrow();
		for (const timeout of [0, -1, 1.5, Number.NaN, QUESTION_WAIT_MS + 1])
			expect(() => cliTest.validateQuestionTimeout(timeout)).toThrow(
				`question timeout must be an integer from 1 to ${QUESTION_WAIT_MS}`,
			);
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
			run(["action", "--repo", ".", "--workflow-id", "x", "--revision", "1"]),
		).rejects.toThrow("ACTION_ID is required");
		await expect(
			run([
				"action",
				"approve-plan",
				"extra",
				"--repo",
				".",
				"--workflow-id",
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
				"--workflow-id",
				"x",
				"--mode",
				"checkout",
				"--tiket",
				"42",
			]),
		).rejects.toThrow("unknown flag --tiket");
		await expect(
			run(["status", "--repo", ".", "--repo", ".", "--workflow-id", "x"]),
		).rejects.toThrow("duplicate flag --repo");
		// The rebase family's two refs are part of the start surface: the schema
		// accepts them, so a later rejection is about the repository or the refs
		// themselves, never about an unknown flag.
		const rebaseFailure = await run([
			"start",
			"--repo",
			".",
			"--workflow-id",
			"x",
			"--mode",
			"checkout",
			"--workflow",
			"rebase",
			"--branch",
			"feature/topic",
			"--onto",
			"origin/main",
		]).catch((error: unknown) => error);
		expect(
			rebaseFailure instanceof Error ? rebaseFailure.message : rebaseFailure,
		).not.toContain("unknown flag");
	});
	test("detached drain argv works in source-tree and compiled runners", () => {
		const source = cliTest.detachedDrainArgv("/abs/src/cli.ts", "/repo", "c1");
		expect(source[0]).toBe(process.execPath);
		expect(source.slice(1)).toEqual([
			"/abs/src/cli.ts",
			"workflow",
			"drain",
			"--repo",
			"/repo",
		]);
		const compiled = cliTest.detachedDrainArgv(undefined, "/repo", "c1");
		expect(compiled.slice(1)).toEqual(["workflow", "drain", "--repo", "/repo"]);
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
			createRepoFixture(repo, {
				files: {
					"README.md": "x\n",
				},
			});
			const profile = {
				name: "pi",
				runtime: "pi-durable" as const,
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
				workflowId: "handoff-identity",
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
				adapters: new Map([["pi-durable", new StubAdapter()]]),
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

			// The migrated application-root path resolves the same identity on
			// the CLI-invocation root (complete-workflow-effect-cutover): the
			// auth gate runs its programs through the root-owned layer/clock.
			const application = new WorkflowApplication();
			try {
				const rootIdentity = cliTest.resolveHandoffIdentity(
					workflowEngine,
					repo,
					application,
				);
				expect(rootIdentity.runId).toBe(activeRun.id);
				expect(rootIdentity.generation).toBe(activeRun.generation);
				expect(rootIdentity.token).toBe(process.env.HERDR_RUN_TOKEN);
			} finally {
				application.dispose();
			}

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
			createRepoFixture(repo, {
				files: {
					"README.md": "x\n",
				},
			});
			const profile = {
				name: "pi",
				runtime: "pi-durable" as const,
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
				workflowId: "repair-race",
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
				adapters: new Map([["pi-durable", new StubAdapter()]]),
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

	test("research-handoff CLI command requires --subject and --directives and is restricted to an authenticated active core.research researcher run", async () => {
		// Missing --directives is rejected by flag validation before any engine
		// or authentication call, regardless of caller identity.
		await expect(
			run(["research-handoff", "--subject", "widget subsystem"]),
		).rejects.toThrow(/--directives is required/);
		// A syntactically complete command dispatched without an authenticated
		// active core.research researcher run identity is rejected outright: it
		// never reaches (and therefore never performs) the record-and-transition
		// path. This matches the runtime-level guarantee (see
		// workflow-runtime.test.ts) that only a valid handoff dispatched by the
		// exact active researcher run can drive the core.research -> core.wiki
		// transition.
		await expect(
			run([
				"research-handoff",
				"--subject",
				"widget subsystem",
				"--directives",
				JSON.stringify([
					{
						target: "projects/demo/widget-subsystem",
						intent: "update",
						claims: ["widgets are produced by the widget factory"],
					},
				]),
				"--citations",
				"src/widget.ts",
			]),
		).rejects.toThrow();
	});
});
