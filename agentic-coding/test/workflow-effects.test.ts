import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import type {
	AgentHandle,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
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
	TransientFailure,
} from "../src/workflow/effect-runner.ts";
import {
	LayaLocalClassifier,
	type LayaSidecar,
	setLayaLocalClassifier,
} from "../src/workflow/laya-local.ts";
import type { TelemetryEnvelope } from "../src/workflow/observability.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

class Adapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	launches = 0;
	stops = 0;
	context?: LaunchContext;
	preflight() {}
	launch(ctx: LaunchContext) {
		this.launches++;
		this.context = ctx;
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	prompt() {
		return Effect.void;
	}
	observe(_handle: AgentHandle) {
		return Effect.succeed({ status: "working" as const });
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
			runtime: "pi-durable" as const,
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
			runtime: "pi-durable" as const,
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
			runtime: "pi-durable" as const,
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
			runtime: "pi-durable" as const,
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
		const handlers = agentEffectHandlers(researchWorkflowTarget(), engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
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
							runtime: "pi-durable",
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
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		await new EffectRunner(repo, engine, handlers).drain();
		const active = engine.status(repo, "effects");
		expect(active.runs[0]?.status).toBe("working");
		expect(adapter.launches).toBe(1);
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
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
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

interface LocalLaunchHarness {
	readonly context: () => LaunchContext | undefined;
	readonly starts: () => number;
	dispose: () => void;
}

/** Drive one `core.implementation` launch through the engine with a stubbed
 * local classifier, returning what the launch handler produced. */
async function drainLaunchWithClassifier(options: {
	readonly runtime: "pi-durable";
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
		const adapter = new CapturingAdapter(options.runtime);
		const handlers = agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([[options.runtime, adapter]]),
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
		runtime: "pi-durable",
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
		expect(harness.context()?.jev?.endpoint).toBeDefined();
	} finally {
		harness.dispose();
	}
});

test("a hosted classifier selection never starts the local sidecar", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "pi-durable",
		pinnedProvider: "opencode-zen",
	});
	try {
		expect(harness.starts()).toBe(0);
		expect(harness.context()?.jev).toBeUndefined();
	} finally {
		harness.dispose();
	}
});

test("a sidecar that cannot start degrades the launch instead of failing it", async () => {
	const harness = await drainLaunchWithClassifier({
		runtime: "pi-durable",
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
