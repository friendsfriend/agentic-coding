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
				[...new Set(report.findings?.map((finding) => finding.check))].sort(),
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
