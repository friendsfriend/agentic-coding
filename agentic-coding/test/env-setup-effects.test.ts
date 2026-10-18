// The env-setup effects (`add-environment-setup-workflow`): the write guard, the
// validation gate and the promotion, driven through the real handlers — the
// level at which the family's safety decisions are made.
//
// The step hooks only enqueue these effects and read their results; a test that
// stops at the hook cannot tell whether a live-configuration write still parks
// the workflow or whether a rolled-back promotion is still reported as success.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { EffectKind, JsonValue } from "../src/contracts/workflow.ts";
import {
	setupBackupDir,
	setupDraftsDir,
} from "../src/server/environment/setup-drafts.ts";
import { setupPromotionLockPath } from "../src/server/environment/setup-promote.ts";
import {
	publishEnvironmentDiscovery,
	removeEnvironmentDiscovery,
} from "../src/server/environment-discovery.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function track(cleanup: () => void): void {
	cleanups.push(cleanup);
}

/** A git checkout the start guard accepts (clean, on a named branch). */
function repo(): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "env-setup-effects-repo-"),
	);
	fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"init",
		],
		{ cwd: root },
	);
	track(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

const LIVE_COMPOSE = [
	"services:",
	"  shop:",
	"    image: shop:live",
	"    ports:",
	'      - "8090:8080"',
	"    environment:",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolates the injected OTel variable
	"      OTEL_EXPORTER_OTLP_ENDPOINT: ${AC_OTEL_ENDPOINT}",
	"",
].join("\n");

const DRAFT_COMPOSE = LIVE_COMPOSE.replace("shop:live", "shop:draft");

const WORKFLOW_ID = "wf-env-effects";
const GUARD: EffectKind = "environment.setup-guard";

const PROFILE = {
	name: "test",
	runtime: "pi-durable" as const,
	executable: "sh",
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: [
		"prompt",
		"run-environment",
		"observe",
		"shell",
		"edit",
	] as const,
	digest: "profile",
};

function environment(options: { configDir: string; repoRoot: string }) {
	const draftsDir = setupDraftsDir(options.configDir, WORKFLOW_ID);
	const engine = new WorkflowEngine(registerBuiltins());
	engine.start({
		repo: options.repoRoot,
		workflowId: WORKFLOW_ID,
		definitionId: "env-setup",
		// The family exists only from the tiers that pin exact step references.
		definitionVersion: definitionVersionForFamilyTraits(6),
		mode: "checkout",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			app: "shop",
			setupDraftsDir: draftsDir,
			// The promotion secret is pinned at start (`engine.ts`); the handlers
			// supply it to the base snapshot's authentication and to the journal, so
			// the tests below exercise that wiring rather than handing it in.
			setupPromotionSecret: "pinned-promotion-secret",
		},
		routing: {
			defaultProfile: "test",
			routes: [{ stepId: "setup.author", role: "env-setup", profile: PROFILE }],
			diversity: [],
		},
	} as never);
	return { engine, draftsDir };
}

function runner(engine: WorkflowEngine, root: string, kind: EffectKind) {
	return new EffectRunner(
		root,
		engine,
		agentEffectHandlers(root, engine, {
			registry: registerBuiltins(),
			adapters: new Map(),
		}),
		{ claimKind: kind },
	);
}

/** The outbox rows of one kind, in the order they were enqueued. */
function effectsOf(engine: WorkflowEngine, root: string, kind: EffectKind) {
	return engine
		.status(root, WORKFLOW_ID)
		.effects.filter((entry) => entry.kind === kind);
}

/** Execute one handler directly, so the effect's *result data* is assertable
 * (the durable view exposes the row's status, never its data). */
async function runHandler<T>(
	engine: WorkflowEngine,
	root: string,
	kind: EffectKind,
	payload: Record<string, unknown>,
): Promise<T> {
	const handlers = agentEffectHandlers(root, engine, {
		registry: registerBuiltins(),
		adapters: new Map(),
	});
	const handler = handlers[kind] as
		| {
				execute: (
					effect: unknown,
					signal?: AbortSignal,
				) => Effect.Effect<T, unknown>;
		  }
		| undefined;
	if (!handler) throw new Error(`no handler for ${kind}`);
	return await Effect.runPromise(
		handler.execute({
			id: `effect-${kind}`,
			workflowId: WORKFLOW_ID,
			kind,
			payload: payload as JsonValue,
		}),
	);
}

/** The failure message of a handler that rejects, so a permanent failure can be
 * asserted without the outbox's retry accounting in the way. */
async function handlerFailure(
	engine: WorkflowEngine,
	root: string,
	kind: EffectKind,
	payload: Record<string, unknown>,
): Promise<string> {
	try {
		await runHandler(engine, root, kind, payload);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`${kind} did not fail`);
}

function subject(
	configDir: string,
	repoRoot: string,
	draftsDir: string,
	phase?: "baseline" | "check",
): Record<string, unknown> {
	return {
		workflowId: WORKFLOW_ID,
		app: "shop",
		repository: repoRoot,
		checkout: repoRoot,
		draftsDir,
		...(phase ? { phase } : {}),
		configDir,
	};
}

/** Run one test body with the process's configuration root pointed at a temp
 * directory, so `resolveConfigRoot()` resolves the fixture. */
function withConfigRoot<T>(
	configDir: string,
	body: () => Promise<T>,
): Promise<T> {
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
	return body().finally(() => {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
	});
}

function fixture(): { configDir: string; repoRoot: string } {
	const configDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "env-setup-effects-config-"),
	);
	track(() => fs.rmSync(configDir, { recursive: true, force: true }));
	writeFile(
		path.join(configDir, "apps", "compose", "shop-compose.yml"),
		LIVE_COMPOSE,
	);
	return { configDir, repoRoot: repo() };
}

/** Arm the baseline the way the workflow does: one durable effect row, run by
 * the runner, so the reducer persists the armed state into the snapshot. */
async function armBaseline(
	engine: WorkflowEngine,
	root: string,
	payload: Record<string, unknown>,
): Promise<void> {
	engine.enqueueEffect(
		root,
		WORKFLOW_ID,
		GUARD,
		`guard:baseline:${Date.now()}`,
		payload as never,
	);
	await runner(engine, root, GUARD).drain();
}

describe("the write guard effect", () => {
	test("arms a baseline, then accepts a turn that only wrote drafts", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			const armed = effectsOf(engine, repoRoot, GUARD)[0];
			expect(armed?.status).toBe("completed");
			// The armed baseline lives in the workflow's own snapshot: nothing the
			// authoring agent can write under the configuration root decides it.
			expect(fs.existsSync(path.join(configDir, ".backups"))).toBe(false);
			// A replay of the baseline reports itself armed already.
			const again = await runHandler<{
				alreadyArmed?: boolean;
				armed?: boolean;
			}>(
				engine,
				repoRoot,
				GUARD,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			expect(again.alreadyArmed).toBe(true);
			expect(again.armed).toBe(false);
			// The drafts directory is the one place the author may write.
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			const ok = await runHandler<{ ok?: boolean }>(
				engine,
				repoRoot,
				GUARD,
				subject(configDir, repoRoot, draftsDir, "check"),
			);
			expect(ok.ok).toBe(true);
		});
	});

	test("a server starting, restarting or stopping during the turn writes no live configuration", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			// The unified server publishes and later removes its discovery record in
			// the configuration root. That handoff is not a change to the
			// developer's configuration, so the guard must not park a correct
			// workflow (fix-env-tools-for-all-runs).
			publishEnvironmentDiscovery(configDir, {
				url: "http://127.0.0.1:4051",
				token: "instance-token-a",
				instance: "instance-a",
				pid: process.pid,
			});
			publishEnvironmentDiscovery(configDir, {
				url: "http://127.0.0.1:4051",
				token: "instance-token-b",
				instance: "instance-b",
				pid: process.pid,
			});
			removeEnvironmentDiscovery(configDir, "instance-token-b");
			const ok = await runHandler<{ ok?: boolean }>(
				engine,
				repoRoot,
				GUARD,
				subject(configDir, repoRoot, draftsDir, "check"),
			);
			expect(ok.ok).toBe(true);
		});
	});

	test("a live-configuration write parks the workflow in attention-required", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			// The baseline is armed first: the write must happen *after* it, which
			// is exactly the interval the guard exists to watch.
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			writeFile(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				`${LIVE_COMPOSE}# edited outside the drafts\n`,
			);
			engine.enqueueEffect(
				repoRoot,
				WORKFLOW_ID,
				GUARD,
				"guard:check",
				subject(configDir, repoRoot, draftsDir, "check") as never,
			);
			await runner(engine, repoRoot, GUARD).drain();
			const effects = effectsOf(engine, repoRoot, GUARD);
			expect(effects.map((entry) => entry.status)).toEqual([
				"completed",
				"failed",
			]);
			expect(effects[1]?.lastError).toContain("live configuration changed");
			// The spec scenario: the workflow neither validates nor promotes, it
			// waits for the developer.
			const status = engine.status(repoRoot, WORKFLOW_ID);
			expect(status.status).toBe("attention-required");
			// The attention text the TUI, the dashboard and the orchestrator status
			// show names what changed: "the live configuration changed" alone left the
			// cause to be found by hand.
			const attention = status.health.attention.join(" ");
			expect(attention).toContain("apps/compose/shop-compose.yml");
			expect(attention).toContain("1 definition changed");
			// ... and it does not blame a bound the scan never hit.
			expect(attention).not.toContain("could not be read completely");
		});
	});

	test("server-owned state and a browser install landing during the turn do not park the workflow", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			// The state the live run really mutated while the author worked, plus the
			// browser install the product itself performs (depth 19, well over the
			// walk's entry bound): neither is a change to the developer's
			// configuration, and failing closed on them parked every run.
			for (const relative of [
				"orchestrator/agent-host/harness.sqlite",
				"orchestrator/agent-host/host.log",
				"orchestrator/event-subscriptions.json",
				"tui.json",
				".agentic-coding-workflow/.herdr-workflow/agent-host/harness.sqlite-shm",
				"classifier/laya/state.json",
				"wiki/index.md",
			])
				writeFile(path.join(configDir, relative), "{}\n");
			for (let index = 0; index < 1_600; index++)
				writeFile(
					path.join(
						configDir,
						"browsers",
						"chromium-1248",
						`chrome-mac-arm64/level-${index % 19}/entry-${index}`,
					),
					"binary\n",
				);
			const ok = await runHandler<{ ok?: boolean }>(
				engine,
				repoRoot,
				GUARD,
				subject(configDir, repoRoot, draftsDir, "check"),
			);
			expect(ok.ok).toBe(true);
		});
	});

	test("a replayed baseline does not absorb a write made after the first arming", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			writeFile(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				`${LIVE_COMPOSE}# edited outside the drafts\n`,
			);
			// A second baseline row (a re-claim, a manual re-arm) must not re-record
			// the already-modified configuration.
			await armBaseline(
				engine,
				repoRoot,
				subject(configDir, repoRoot, draftsDir, "baseline"),
			);
			expect(
				await handlerFailure(
					engine,
					repoRoot,
					GUARD,
					subject(configDir, repoRoot, draftsDir, "check"),
				),
			).toContain("live configuration changed");
			// The armed baseline is the first one: nothing was re-recorded.
			const ok = await runHandler<{ ok?: boolean; alreadyArmed?: boolean }>(
				engine,
				repoRoot,
				GUARD,
				subject(configDir, repoRoot, draftsDir, "check"),
			).catch(() => undefined);
			expect(ok).toBeUndefined();
		});
	});

	test("a check with no baseline fails permanently", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			expect(
				await handlerFailure(
					engine,
					repoRoot,
					GUARD,
					subject(configDir, repoRoot, draftsDir, "check"),
				),
			).toContain("no baseline");
		});
	});
});

describe("the validation effect", () => {
	test("returns the failing report the step turns into the author loop", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			// A draft with no AC_OTEL_* wiring: the gate must fail structurally.
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				"services:\n  shop:\n    image: shop:draft\n",
			);
			const report = await runHandler<{
				ok?: boolean;
				findings?: Array<{ check?: string }>;
				targets?: Array<{ id?: string; drafted?: boolean }>;
			}>(
				engine,
				repoRoot,
				"environment.validate",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(report.ok).toBe(false);
			// The whole report shape: the drafted compose target is the one under
			// test, the only findings are the ones this draft actually earns (no
			// OTel wiring, and the start that no environment server can satisfy), and
			// a mis-wired collision or layout check would show up here.
			expect(report.targets).toHaveLength(1);
			expect(report.targets?.[0]?.drafted).toBe(true);
			expect(
				[...new Set(report.findings?.map((finding) => finding.check))]
					.filter((check) => check !== "no-test-target")
					.sort(),
			).toEqual(["otel", "start"]);
			expect(report.findings?.some((finding) => finding.check === "otel")).toBe(
				true,
			);
		});
	});

	test("refuses a draft whose app is not pinned", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			const { app, ...withoutApp } = subject(
				configDir,
				repoRoot,
				draftsDir,
			) as { app: string };
			expect(
				await handlerFailure(
					engine,
					repoRoot,
					"environment.validate",
					withoutApp,
				),
			).toContain("configured app");
		});
	});
});

describe("the promotion effect", () => {
	test("promotes the approved drafts, backs up what it replaced and moves the drafts aside", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			const result = await runHandler<{
				ok?: boolean;
				draftsMoved?: boolean;
			}>(
				engine,
				repoRoot,
				"environment.promote",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(result.ok).toBe(true);
			expect(result.draftsMoved).toBe(true);
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(DRAFT_COMPOSE);
			expect(
				fs.readFileSync(
					path.join(
						setupBackupDir(configDir, WORKFLOW_ID),
						"apps",
						"compose",
						"shop-compose.yml",
					),
					"utf8",
				),
			).toBe(LIVE_COMPOSE);
			expect(fs.existsSync(draftsDir)).toBe(false);
		});
	});

	test("a failed write returns a rolled-back result instead of completing", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			// `<config>/apps/compose` becomes a file, so the atomic write cannot
			// land: the promotion must fail and report the rollback.
			fs.rmSync(path.join(configDir, "apps", "compose"), {
				recursive: true,
				force: true,
			});
			fs.writeFileSync(path.join(configDir, "apps", "compose"), "not a dir\n");
			const result = await runHandler<{
				ok?: boolean;
				rolledBack?: boolean;
				error?: string;
			}>(
				engine,
				repoRoot,
				"environment.promote",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(result.ok).toBe(false);
			expect(result.rolledBack).toBe(true);
			expect(result.error).toBeTruthy();
		});
	});

	test("a replay of a completed promotion reports it instead of re-backing-up", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			await runHandler(
				engine,
				repoRoot,
				"environment.promote",
				subject(configDir, repoRoot, draftsDir),
			);
			const backupPath = path.join(
				setupBackupDir(configDir, WORKFLOW_ID),
				"apps",
				"compose",
				"shop-compose.yml",
			);
			expect(fs.readFileSync(backupPath, "utf8")).toBe(LIVE_COMPOSE);
			const replay = await runHandler<{
				alreadyPromoted?: boolean;
				ok?: boolean;
			}>(
				engine,
				repoRoot,
				"environment.promote",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(replay.alreadyPromoted).toBe(true);
			expect(replay.ok).toBe(true);
			expect(fs.readFileSync(backupPath, "utf8")).toBe(LIVE_COMPOSE);
		});
	});
});

describe("effect failure channels", () => {
	test("a busy configuration root is retried by the outbox, not by the step loop", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			// Another promotion holds the root.
			const lockPath = setupPromotionLockPath(configDir);
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
			fs.writeFileSync(
				lockPath,
				`${JSON.stringify({
					workflowId: "other",
					token: "holder",
					at: Date.now(),
				})}\n`,
			);
			// The handler raises the *transient* channel for a busy root: the durable
			// outbox keeps the retry, with its own backoff, instead of the step's
			// bounded loop burning all three attempts on a lock that clears in
			// milliseconds. A plain `ok: false` result would take the step's loop.
			const handlers = agentEffectHandlers(repoRoot, engine, {
				registry: registerBuiltins(),
				adapters: new Map(),
			});
			const handler = handlers["environment.promote"] as {
				execute: (effect: unknown) => Effect.Effect<unknown, unknown>;
			};
			let failure: unknown;
			try {
				await Effect.runPromise(
					handler.execute({
						id: "effect-promote",
						workflowId: WORKFLOW_ID,
						kind: "environment.promote",
						payload: subject(configDir, repoRoot, draftsDir) as never,
					}),
				);
			} catch (error) {
				failure = error;
			}
			// Effect wraps a failed effect in its own fiber failure; the channel the
			// outbox classifies is carried in the failure's own type name.
			expect(String(failure)).toContain("TransientFailure");
			expect(String(failure)).toContain("owns");
			// Nothing was written, and the workflow is still working rather than
			// parked on a retry limit it should never have consumed.
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(LIVE_COMPOSE);
			expect(engine.status(repoRoot, WORKFLOW_ID).status).toBe("active");
		});
	});
});

describe("the staged-root effect lifecycle", () => {
	const STAGED_DRAFT = DRAFT_COMPOSE;

	/** The reviewed digests the validation gate records for a staged root: the
	 * content of every drafted file at approval time. */
	async function reviewedFor(
		draftsDir: string,
	): Promise<Record<string, string>> {
		const { listSetupDraftFiles, reviewedDigest } = await import(
			"../src/server/environment/setup-drafts.ts"
		);
		const reviewed: Record<string, string> = {};
		for (const relative of listSetupDraftFiles(draftsDir))
			reviewed[relative] = reviewedDigest(
				fs.readFileSync(
					path.join(draftsDir, "root", ...relative.split("/")),
					"utf8",
				),
			);
		return reviewed;
	}

	test("environment.setup-stage materializes the staged root under the workflow's draftsDir", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			const result = await runHandler<{
				ok?: boolean;
				staged?: boolean;
				entries?: number;
			}>(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(result.ok).toBe(true);
			expect(result.staged).toBe(true);
			// The complete copy is materialized at the state directory's `root/`,
			// with a base snapshot authenticated by the run's pinned secret.
			expect(
				fs.existsSync(
					path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				),
			).toBe(true);
			const base = fs.readFileSync(path.join(draftsDir, "base.json"), "utf8");
			expect(JSON.parse(base)).toMatchObject({ version: 1 });
			expect(base).toContain("mac");
		});
	});

	test("a configuration that cannot be materialized fails the effect permanently", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			// The state directory's parent cannot be created (a file stands where the
			// workflow's state family has to be): materialization cannot complete and
			// the effect fails permanently with a bounded message instead of looping.
			fs.mkdirSync(path.dirname(draftsDir), { recursive: true });
			fs.writeFileSync(draftsDir, "not a directory\n");
			const failure = await handlerFailure(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(failure).toContain(
				"the staged configuration root could not be materialized",
			);
			expect(failure).toContain("is not a directory");
		});
	});

	test("a promotion whose staged bytes changed after the review is refused", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				STAGED_DRAFT,
			);
			const reviewed = await reviewedFor(draftsDir);
			// The authored file is rewritten after the gate reviewed it: the window
			// between the gate and the developer's approval is unbounded, and the
			// promotion must not publish bytes nobody approved.
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				`${STAGED_DRAFT}# rewritten after the review\n`,
			);
			const result = await runHandler<{ ok?: boolean; conflicts?: string[] }>(
				engine,
				repoRoot,
				"environment.promote",
				{ ...subject(configDir, repoRoot, draftsDir), reviewed },
			);
			expect(result.ok).toBe(false);
			expect(result.conflicts).toEqual(["apps/compose/shop-compose.yml"]);
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(LIVE_COMPOSE);
		});
	});

	test("a reviewed promotion can be rolled back through the handlers, byte for byte", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				STAGED_DRAFT,
			);
			const reviewed = await reviewedFor(draftsDir);
			const promoted = await runHandler<{
				ok?: boolean;
				draftsMoved?: boolean;
			}>(engine, repoRoot, "environment.promote", {
				...subject(configDir, repoRoot, draftsDir),
				reviewed,
			});
			expect(promoted.ok).toBe(true);
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(STAGED_DRAFT);

			const rolledBack = await runHandler<{
				ok?: boolean;
				stagedRestored?: boolean;
			}>(
				engine,
				repoRoot,
				"environment.setup-rollback",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(rolledBack.ok).toBe(true);
			// The previous file comes back exactly, and the author's staged root is
			// where it left it so it can resume.
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(LIVE_COMPOSE);
			expect(rolledBack.stagedRestored).toBe(true);
		});
	});

	test("a smoke check with no environment server fails instead of reporting a pass", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			const failure = await handlerFailure(
				engine,
				repoRoot,
				"environment.setup-smoke",
				subject(configDir, repoRoot, draftsDir),
			);
			expect(failure).toContain("no environment server is attached");
			// The staged state is not deleted: nothing proved the live configuration
			// works, so a rollback still has something to restore.
			expect(fs.existsSync(path.join(draftsDir, "root"))).toBe(true);
		});
	});

	test("the close path removes the staged state and keeps the backup", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			fs.mkdirSync(setupBackupDir(configDir, WORKFLOW_ID), { recursive: true });
			const result = await runHandler<{
				workflowId?: string;
				removed?: string[];
			}>(engine, repoRoot, "environment.setup-cleanup", {
				workflowId: WORKFLOW_ID,
				draftsDir,
			});
			expect(result.workflowId).toBe(WORKFLOW_ID);
			expect(result.removed?.some((entry) => entry.endsWith("/root"))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(draftsDir, "root"))).toBe(false);
			expect(fs.existsSync(setupBackupDir(configDir, WORKFLOW_ID))).toBe(true);
		});
	});
});

describe("the base snapshot's authentication and the smoke success path", () => {
	async function stage(
		engine: WorkflowEngine,
		repoRoot: string,
		configDir: string,
		draftsDir: string,
	) {
		await runHandler(
			engine,
			repoRoot,
			"environment.setup-stage",
			subject(configDir, repoRoot, draftsDir),
		);
	}

	test("a base snapshot this run did not authenticate is never adopted", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		await withConfigRoot(configDir, async () => {
			await stage(engine, repoRoot, configDir, draftsDir);
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			const { listSetupDraftFiles, reviewedDigest } = await import(
				"../src/server/environment/setup-drafts.ts"
			);
			const reviewed: Record<string, string> = {};
			for (const relative of listSetupDraftFiles(draftsDir))
				reviewed[relative] = reviewedDigest(
					fs.readFileSync(
						path.join(draftsDir, "root", ...relative.split("/")),
						"utf8",
					),
				);

			// (a) the tag is dropped: a hand-written snapshot is not adopted.
			const basePath = path.join(draftsDir, "base.json");
			const document = JSON.parse(fs.readFileSync(basePath, "utf8")) as {
				mac?: string;
			};
			delete document.mac;
			fs.writeFileSync(basePath, JSON.stringify(document));
			const withoutMac = await runHandler<{ ok?: boolean; error?: string }>(
				engine,
				repoRoot,
				"environment.promote",
				{ ...subject(configDir, repoRoot, draftsDir), reviewed },
			);
			expect(withoutMac.ok).toBe(false);
			expect(withoutMac.error).toContain("not authenticated");
			expect(
				fs.readFileSync(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					"utf8",
				),
			).toBe(LIVE_COMPOSE);

			// (b) a tag from another secret: same refusal.
			fs.writeFileSync(
				basePath,
				JSON.stringify({ ...document, mac: "0".repeat(64) }),
			);
			const foreignMac = await runHandler<{ ok?: boolean; error?: string }>(
				engine,
				repoRoot,
				"environment.promote",
				{ ...subject(configDir, repoRoot, draftsDir), reviewed },
			);
			expect(foreignMac.ok).toBe(false);
			expect(foreignMac.error).toContain("not authenticated");

			// The refusal is a property of the snapshot and not of the path: discarding
			// the tampered state and staging again produces a run-authenticated
			// snapshot, and the promotion then proceeds.
			fs.rmSync(path.join(draftsDir, "root"), { recursive: true, force: true });
			fs.rmSync(basePath, { force: true });
			await runHandler(engine, repoRoot, "environment.setup-stage", {
				...subject(configDir, repoRoot, draftsDir),
			});
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			const restagedReviewed: Record<string, string> = {};
			for (const relative of listSetupDraftFiles(draftsDir))
				restagedReviewed[relative] = reviewedDigest(
					fs.readFileSync(
						path.join(draftsDir, "root", ...relative.split("/")),
						"utf8",
					),
				);
			const restored = await runHandler<{ ok?: boolean; error?: string }>(
				engine,
				repoRoot,
				"environment.promote",
				{
					...subject(configDir, repoRoot, draftsDir),
					reviewed: restagedReviewed,
				},
			);
			expect(restored.error ?? "").toBe("");
			expect(restored.ok).toBe(true);
		});
	});

	test("a smoke check that starts the live target reports the gate's proof and removes the staged state", async () => {
		const { configDir, repoRoot } = fixture();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		const clientModule = await import("../src/server/client.ts");
		const configured = clientModule.configureBackendClient({
			baseUrl: "http://127.0.0.1:9",
			token: "test-token",
			ownerId: "test",
		});
		const original = configured.acquireSlots.bind(configured);
		const originalReload = configured.reloadEnvironmentConfig.bind(configured);
		configured.acquireSlots = (async () => ({
			outcome: "already-running",
		})) as typeof configured.acquireSlots;
		// A configured client makes the promotion reload the catalog through the
		// server; this test has no server, so the reload is a no-op here.
		configured.reloadEnvironmentConfig =
			(async () => {}) as typeof configured.reloadEnvironmentConfig;
		try {
			await withConfigRoot(configDir, async () => {
				await stage(engine, repoRoot, configDir, draftsDir);
				writeFile(
					path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
					DRAFT_COMPOSE,
				);
				const { listSetupDraftFiles, reviewedDigest } = await import(
					"../src/server/environment/setup-drafts.ts"
				);
				const reviewed: Record<string, string> = {};
				for (const relative of listSetupDraftFiles(draftsDir))
					reviewed[relative] = reviewedDigest(
						fs.readFileSync(
							path.join(draftsDir, "root", ...relative.split("/")),
							"utf8",
						),
					);
				const promoted = await runHandler<{ ok?: boolean }>(
					engine,
					repoRoot,
					"environment.promote",
					{ ...subject(configDir, repoRoot, draftsDir), reviewed },
				);
				expect(promoted.ok).toBe(true);
				// The staged root is gone (moved aside by the promotion), but the
				// reviewed digests are what the smoke check compares the promoted
				// bytes against.
				const smoke = await runHandler<{
					ok?: boolean;
					started?: string;
					build?: string;
					buildProvenIdentical?: boolean;
					stagedStateRemoved?: string[];
				}>(engine, repoRoot, "environment.setup-smoke", {
					...subject(configDir, repoRoot, draftsDir),
					reviewed,
				});
				expect(smoke.ok).toBe(true);
				expect(smoke.started).toBe("ready");
				expect(smoke.buildProvenIdentical).toBe(true);
				expect(smoke.build).toContain("proven identical by the gate");
				expect(smoke.stagedStateRemoved?.length).toBeGreaterThan(0);
				expect(fs.existsSync(path.join(draftsDir, "root"))).toBe(false);
				expect(fs.existsSync(setupBackupDir(configDir, WORKFLOW_ID))).toBe(
					true,
				);
			});
		} finally {
			configured.acquireSlots = original;
			configured.reloadEnvironmentConfig = originalReload;
			clientModule.clearBackendClient();
		}
	});
});

test("a promoted definition that differs from the reviewed one is rebuilt and reported", async () => {
	const { configDir, repoRoot } = (() => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "env-setup-smoke-diverge-"),
		);
		track(() => fs.rmSync(configDir, { recursive: true, force: true }));
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			LIVE_COMPOSE,
		);
		return { configDir, repoRoot: repo() };
	})();
	const { engine, draftsDir } = environment({ configDir, repoRoot });
	const clientModule = await import("../src/server/client.ts");
	const configured = clientModule.configureBackendClient({
		baseUrl: "http://127.0.0.1:9",
		token: "test-token",
		ownerId: "test",
	});
	const originalAcquire = configured.acquireSlots.bind(configured);
	const originalReload = configured.reloadEnvironmentConfig.bind(configured);
	const originalAction = configured.runOwnerAction.bind(configured);
	configured.acquireSlots = (async () => ({
		outcome: "already-running",
	})) as typeof configured.acquireSlots;
	configured.reloadEnvironmentConfig =
		(async () => {}) as typeof configured.reloadEnvironmentConfig;
	const built: string[] = [];
	configured.runOwnerAction = (async (request: { action: string }) => {
		built.push(request.action);
		return {
			status: "completed",
			targetId: "app/shop/action/build/shell",
			runtime: "shell",
			exitCode: 0,
			output: "built-again",
			truncated: false,
		};
	}) as typeof configured.runOwnerAction;
	try {
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			writeFile(
				path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
				DRAFT_COMPOSE,
			);
			const reviewed = await (async () => {
				const { listSetupDraftFiles, reviewedDigest } = await import(
					"../src/server/environment/setup-drafts.ts"
				);
				const map: Record<string, string> = {};
				for (const relative of listSetupDraftFiles(draftsDir))
					map[relative] = reviewedDigest(
						fs.readFileSync(
							path.join(draftsDir, "root", ...relative.split("/")),
							"utf8",
						),
					);
				return map;
			})();
			const promoted = await runHandler<{ ok?: boolean }>(
				engine,
				repoRoot,
				"environment.promote",
				{ ...subject(configDir, repoRoot, draftsDir), reviewed },
			);
			expect(promoted.ok).toBe(true);
			// The live file is changed after the promotion (the divergence the
			// conditional rebuild exists for).
			writeFile(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				`${DRAFT_COMPOSE}# changed after the promotion\n`,
			);
			const smoke = await runHandler<{
				ok?: boolean;
				build?: string;
				buildProvenIdentical?: boolean;
				buildLogTail?: string;
			}>(engine, repoRoot, "environment.setup-smoke", {
				...subject(configDir, repoRoot, draftsDir),
				reviewed,
			});
			expect(smoke.buildProvenIdentical).toBe(false);
			expect(smoke.build).toContain("rebuilt");
			expect(smoke.ok).toBe(true);
			expect(built).toEqual(["build"]);
			expect(smoke.buildLogTail).toBe("built-again");
		});
	} finally {
		configured.acquireSlots = originalAcquire;
		configured.reloadEnvironmentConfig = originalReload;
		configured.runOwnerAction = originalAction;
		clientModule.clearBackendClient();
	}
});

test("a live default that is not the one the gate validated fails the smoke check", async () => {
	// The promoted configuration resolves a *different* default build than the one
	// the gate validated (the motivating defect: the live Dockerfile beside the
	// promoted shell target). The smoke check must fail with the drift named — the
	// developer gets the rollback offer — instead of starting and reporting a
	// target nobody validated.
	const { configDir, repoRoot } = fixture();
	const { engine, draftsDir } = environment({ configDir, repoRoot });
	const clientModule = await import("../src/server/client.ts");
	const configured = clientModule.configureBackendClient({
		baseUrl: "http://127.0.0.1:9",
		token: "test-token",
		ownerId: "test",
	});
	const originalAcquire = configured.acquireSlots.bind(configured);
	const started: unknown[] = [];
	configured.acquireSlots = (async (request: unknown) => {
		started.push(request);
		return { outcome: "already-running" };
	}) as typeof configured.acquireSlots;
	try {
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			const smoke = await runHandler<{
				ok?: boolean;
				started?: string;
				build?: string;
				detail?: string;
				defaultDrift?: Array<{
					action?: string;
					validated?: string;
					live?: string;
				}>;
			}>(engine, repoRoot, "environment.setup-smoke", {
				...subject(configDir, repoRoot, draftsDir),
				// The gate validated a build target the fixture's live configuration
				// does not have (its only definition is the compose run target).
				defaults: { build: "app/shop/build/shell" },
			});
			expect(smoke.ok).toBe(false);
			expect(smoke.started).toBe("failed");
			expect(smoke.build).toContain("not attempted");
			expect(smoke.detail).toContain(
				"does not resolve the defaults the gate validated",
			);
			expect(smoke.defaultDrift?.[0]?.action).toBe("build");
			expect(smoke.defaultDrift?.[0]?.validated).toBe("app/shop/build/shell");
			// Nothing was started: an unvalidated live target is never run, and the
			// staged state stays so the rollback can put it back.
			expect(started).toEqual([]);
			expect(fs.existsSync(path.join(draftsDir, "root"))).toBe(true);
		});
	} finally {
		configured.acquireSlots = originalAcquire;
		clientModule.clearBackendClient();
	}
});

test("a smoke check whose live start never comes up fails and keeps the staged state", async () => {
	const { configDir, repoRoot } = fixture();
	const { engine, draftsDir } = environment({ configDir, repoRoot });
	const clientModule = await import("../src/server/client.ts");
	const configured = clientModule.configureBackendClient({
		baseUrl: "http://127.0.0.1:9",
		token: "test-token",
		ownerId: "test",
	});
	const originalAcquire = configured.acquireSlots.bind(configured);
	configured.acquireSlots = (async () => ({
		outcome: "deadlock",
		message: "shop is held by workflow:other and waiting for it",
	})) as typeof configured.acquireSlots;
	try {
		await withConfigRoot(configDir, async () => {
			await runHandler(
				engine,
				repoRoot,
				"environment.setup-stage",
				subject(configDir, repoRoot, draftsDir),
			);
			const smoke = await runHandler<{
				ok?: boolean;
				started?: string;
				detail?: string;
				stagedStateRemoved?: string[];
			}>(engine, repoRoot, "environment.setup-smoke", {
				...subject(configDir, repoRoot, draftsDir),
				reviewed: {},
			});
			expect(smoke.ok).toBe(false);
			expect(smoke.started).toBe("failed");
			expect(smoke.detail ?? "").toContain("held by workflow:other");
			expect(smoke.stagedStateRemoved ?? []).toEqual([]);
			expect(fs.existsSync(path.join(draftsDir, "root"))).toBe(true);
		});
	} finally {
		configured.acquireSlots = originalAcquire;
		clientModule.clearBackendClient();
	}
});

test("a rebuild that fails, and one that cannot run, are reported as smoke failures", async () => {
	for (const stub of [
		async () => {
			throw new Error("the environment server refused the rebuild");
		},
		async () => ({
			status: "completed",
			targetId: "app/shop/action/build/shell",
			runtime: "shell",
			exitCode: 1,
			output: "make: *** [Makefile:3: build] Error 2",
			truncated: false,
		}),
	]) {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "env-setup-rebuild-fail-"),
		);
		track(() => fs.rmSync(configDir, { recursive: true, force: true }));
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			LIVE_COMPOSE,
		);
		const repoRoot = repo();
		const { engine, draftsDir } = environment({ configDir, repoRoot });
		const clientModule = await import("../src/server/client.ts");
		const configured = clientModule.configureBackendClient({
			baseUrl: "http://127.0.0.1:9",
			token: "test-token",
			ownerId: "test",
		});
		const originalAcquire = configured.acquireSlots.bind(configured);
		const originalReload = configured.reloadEnvironmentConfig.bind(configured);
		const originalAction = configured.runOwnerAction.bind(configured);
		configured.acquireSlots = (async () => ({
			outcome: "already-running",
		})) as typeof configured.acquireSlots;
		configured.reloadEnvironmentConfig =
			(async () => {}) as typeof configured.reloadEnvironmentConfig;
		configured.runOwnerAction =
			stub as unknown as typeof configured.runOwnerAction;
		try {
			await withConfigRoot(configDir, async () => {
				await runHandler(
					engine,
					repoRoot,
					"environment.setup-stage",
					subject(configDir, repoRoot, draftsDir),
				);
				writeFile(
					path.join(draftsDir, "root", "apps", "compose", "shop-compose.yml"),
					DRAFT_COMPOSE,
				);
				const { listSetupDraftFiles, reviewedDigest } = await import(
					"../src/server/environment/setup-drafts.ts"
				);
				const reviewed: Record<string, string> = {};
				for (const relative of listSetupDraftFiles(draftsDir))
					reviewed[relative] = reviewedDigest(
						fs.readFileSync(
							path.join(draftsDir, "root", ...relative.split("/")),
							"utf8",
						),
					);
				const promoted = await runHandler<{ ok?: boolean }>(
					engine,
					repoRoot,
					"environment.promote",
					{ ...subject(configDir, repoRoot, draftsDir), reviewed },
				);
				expect(promoted.ok).toBe(true);
				writeFile(
					path.join(configDir, "apps", "compose", "shop-compose.yml"),
					`${DRAFT_COMPOSE}# diverged\n`,
				);
				const smoke = await runHandler<{
					ok?: boolean;
					buildFailure?: string;
					stagedStateRemoved?: string[];
				}>(engine, repoRoot, "environment.setup-smoke", {
					...subject(configDir, repoRoot, draftsDir),
					reviewed,
				});
				expect(smoke.ok).toBe(false);
				expect(smoke.buildFailure ?? "").not.toBe("");
				// A failed check keeps the staged state, so the rollback the developer
				// is offered still has something to restore.
				expect(smoke.stagedStateRemoved ?? []).toEqual([]);
				// The promotion moved the state directory aside; a failed smoke check
				// leaves that state where the rollback can still restore it.
				expect(fs.existsSync(path.join(`${draftsDir}.promoted`, "root"))).toBe(
					true,
				);
			});
		} finally {
			configured.acquireSlots = originalAcquire;
			configured.reloadEnvironmentConfig = originalReload;
			configured.runOwnerAction = originalAction;
			clientModule.clearBackendClient();
		}
	}
});
