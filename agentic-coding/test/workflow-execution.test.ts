// Focused effect-runner/execution tests (migrate-workflow-execution-to-effect,

// tasks 1.3, 1.4, 2.1, 2.2, 2.3, 3.3): typed failure policy, scoped renewal
// behavior, the bounded process service, the Effect credential boundary, and
// explicit pinned wiki roots without process-wide environment mutation.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import { runGitWithCredentialsEffect } from "../src/workflow/credentials.ts";
import {
	BUILTIN_EFFECTS,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	classifyFailure,
	EffectRunner,
	PermanentFailure,
	TransientFailure,
} from "../src/workflow/effect-runner.ts";
import { runProcessEffect } from "../src/workflow/process.ts";
import { EFFECT_KINDS } from "../src/workflow/runtime/store.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	writeAtomicPrivateFile,
} from "../src/workflow/secure-fs.ts";
import {
	conceptPath,
	readConcept,
	verifyConcept,
	writeConcept,
} from "../src/workflow/wiki.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function initRepo(label: string): string {
	return createTempRepoFixture(`${label}-`, {
		files: { "README.md": "x\n", ".gitignore": ".herdr-workflow\n" },
	});
}

function profile() {
	return {
		name: "test",
		runtime: "pi-durable" as const,
		executable: "sh",
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"] as const,
		digest: "test-profile",
	};
}

function startWorkflow(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
) {
	return engine.start({
		repo,
		workflowId,
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
			defaultProfile: profile().name,
			routes: [
				{ stepId: "core.implementation", role: "worker", profile: profile() },
			],
		},
	});
}

test("every registered EffectKind has a migrated handler (coverage gate)", () => {
	for (const kind of BUILTIN_EFFECTS)
		expect(EFFECT_KINDS.has(kind), `missing runtime effect kind ${kind}`).toBe(
			true,
		);
	const registry = registerBuiltins();
	const engine = new WorkflowEngine(registry);
	const handlers = agentEffectHandlers(os.tmpdir(), engine, {
		registry,
		adapters: new Map(),
	});
	for (const kind of EFFECT_KINDS) {
		expect(handlers[kind], `missing handler for ${kind}`).toBeDefined();
		if (kind === "agent.stop") continue;
		expect(
			handlers[kind]?.execute,
			`${kind} must implement execute`,
		).toBeTypeOf("function");
	}
});

test("secure descriptor I/O still rejects escapes, follows no symlinks, and publishes atomically with permissions", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-securefs-"));
	try {
		// A component escaping the data root is rejected.
		expect(() =>
			openSecureDirectory(path.join(root, "..", "evil"), root),
		).toThrow(/escapes/);
		// No-follow traversal: a symlink component must never be dereferenced.
		fs.symlinkSync(path.join(root, "target"), path.join(root, "link"));
		expect(() => openSecureDirectory(path.join(root, "link"), root)).toThrow();
		// Atomic private publication keeps 0600 and stays inside the root.
		const dir = openSecureDirectory(path.join(root, "a", "b"), root);
		try {
			writeAtomicPrivateFile(dir, "secret.txt", "s3cret", 0o600);
		} finally {
			closeSecureDirectory(dir);
		}
		expect(
			fs.readFileSync(path.join(root, "a", "b", "secret.txt"), "utf8"),
		).toBe("s3cret");
		expect(
			fs.statSync(path.join(root, "a", "b", "secret.txt")).mode & 0o777,
		).toBe(0o600);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failure policy classifies typed, ownership, interruption, and unknown errors", () => {
	expect(classifyFailure(new TransientFailure("infra"), false)).toBe(
		"transient",
	);
	expect(classifyFailure(new PermanentFailure("config"), false)).toBe(
		"permanent",
	);
	expect(
		classifyFailure(
			{ _tag: "infrastructure", code: "unavailable", message: "down" },
			false,
		),
	).toBe("transient");
	expect(
		classifyFailure(
			{ _tag: "validation", code: "invalid-input", message: "bad" },
			false,
		),
	).toBe("permanent");
	expect(
		classifyFailure(
			{ _tag: "stale-ownership", code: "stale-effect", message: "lost" },
			false,
		),
	).toBe("ownership");
	expect(classifyFailure(new Error("effect ownership was lost"), false)).toBe(
		"interrupted",
	);
	expect(classifyFailure(new Error("effect lease is invalid"), false)).toBe(
		"ownership",
	);
	expect(classifyFailure(new Error("unknown boom"), false)).toBe("defect");
	expect(classifyFailure(new Error("unknown boom"), true)).toBe("interrupted");
});

test("known permanent failures stop immediately instead of consuming the retry budget", async () => {
	const repo = initRepo("workflow-permanent-");
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		const started = startWorkflow(engine, repo, "permanent-failure");
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				execute: () => Effect.fail(new PermanentFailure("not in allowed list")),
			},
			"agent.launch": {
				execute: () => Effect.succeed({}),
			},
		});
		await runner.drain(1, 5_000);
		const view = engine.status(repo, started.view.workflowId);
		const effect = view.effects.find((item) => item.kind === "artifact.write");
		expect(effect?.status).toBe("failed");
		expect(effect?.attempts).toBe(1);
		expect(effect?.lastError).toContain("not in allowed list");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("renewal exception interrupts the execution and never escapes as an unhandled error", async () => {
	const repo = initRepo("workflow-renewal-");
	try {
		const registry = registerBuiltins();
		class ThrowingRenewalEngine extends WorkflowEngine {
			override renewEffect(): boolean {
				throw new Error("renewal service exploded");
			}
		}
		const engine = new ThrowingRenewalEngine(registry);
		startWorkflow(engine, repo, "renewal-exception");
		let cancelled = 0;
		let executed = 0;
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				execute: (_effect, signal) =>
					Effect.gen(function* () {
						executed++;
						// Mimic a native child wait that aborts on lease loss.
						yield* Effect.tryPromise({
							try: () =>
								new Promise<void>((resolve, reject) => {
									const abort = () =>
										reject(new Error("effect ownership was lost"));
									if (signal?.aborted) {
										abort();
										return;
									}
									signal?.addEventListener("abort", abort, { once: true });
									setTimeout(() => {
										signal?.removeEventListener("abort", abort);
										resolve();
									}, 200);
								}),
							catch: (error) =>
								error instanceof Error ? error : new Error(String(error)),
						});
						return { written: true };
					}),
				cancel: () =>
					Effect.sync(() => {
						cancelled++;
					}),
			},
		});
		await runner.drain(1, 100);
		// The renewal fiber attempted, the renewal exception marked the lease
		// lost and aborted the external wait, so execution was canceled and
		// never published a completion under the dead lease.
		expect(executed).toBe(1);
		expect(cancelled).toBe(1);
		const view = engine.status(repo, "renewal-exception");
		expect(
			view.effects.find((item) => item.kind === "artifact.write")?.status,
		).toBe("running");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("outer cancellation during observation cancels owned work without executing", async () => {
	const repo = initRepo("workflow-observe-cancel-");
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		startWorkflow(engine, repo, "observe-cancel");
		let executed = 0;
		let cancelled = 0;
		// Abort once the observation window has actually opened. A wall-clock timer
		// races the 50ms observation and, under load, is coalesced past its end — the
		// effect then executes and the assertion measures the scheduler instead of the
		// cancellation path (measured: failed in a full run, passed in isolation).
		let markObserving: () => void = () => {};
		const observing = new Promise<void>((resolve) => {
			markObserving = resolve;
		});
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				observe: () =>
					Effect.gen(function* () {
						markObserving();
						yield* Effect.sleep(50);
						return undefined;
					}),
				execute: () =>
					Effect.sync(() => {
						executed++;
						return { written: true };
					}),
				cancel: () =>
					Effect.sync(() => {
						cancelled++;
					}),
			},
		});
		const controller = new AbortController();
		const draining = runner.drain(1, 100, controller.signal);
		await observing;
		controller.abort();
		await draining;
		expect(executed).toBe(0);
		expect(cancelled).toBe(1);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("cleanup failure stays observable and never commits false success", async () => {
	const repo = initRepo("workflow-cleanup-fail-");
	try {
		const registry = registerBuiltins();
		const engine = new WorkflowEngine(registry);
		startWorkflow(engine, repo, "cleanup-failure");
		const failures: string[] = [];
		const runner = new EffectRunner(repo, engine, {
			"artifact.write": {
				execute: (effect) =>
					Effect.gen(function* () {
						// Simulate an execution that completes externally then loses the
						// lease before the final validation: the completion must not be
						// published and the failing cleanup must be surfaced.
						const db = new Database(canonicalStorePath(repo));
						db.query(
							"UPDATE workflow_outbox SET lease='successor' WHERE id=?",
						).run(effect.id);
						db.close();
						yield* Effect.sleep(30);
						return { written: true };
					}),
				cancel: () => Effect.fail(new Error("cleanup exploded")),
			},
		});
		await runner.drain(1, 100, undefined, (workflowId, message) =>
			failures.push(`${workflowId}:${message}`),
		);
		expect(
			failures.some(
				(item) =>
					item.includes("cleanup exploded") ||
					item.includes("cancel cleanup failed"),
			),
		).toBe(true);
		// The lease was replaced, so no result was published; a successor can
		// claim and observe without re-executing external work.
		const successor = engine.claimEffects(repo, 1, 100);
		expect(successor).toHaveLength(1);
		expect(successor[0]?.lease).not.toBe("successor");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("bounded process service reports exit, timeout, cancel, and overflow distinctly", async () => {
	const exitFailure = await Effect.runPromise(
		runProcessEffect(["sh", "-c", "echo oops >&2; exit 3"]).pipe(Effect.either),
	);
	if (!Either.isLeft(exitFailure)) throw new Error("expected exit failure");
	expect(exitFailure.left._tag).toBe("exit");
	if (exitFailure.left._tag === "exit")
		expect(exitFailure.left.exitCode).toBe(3);

	const success = await Effect.runPromise(
		runProcessEffect(["sh", "-c", "printf hello"]),
	);
	expect(success.stdout).toBe("hello");
	expect(success.exitCode).toBe(0);

	const timeoutOutcome = await Effect.runPromise(
		runProcessEffect(["sh", "-c", "sleep 30"], { timeoutMs: 60 }).pipe(
			Effect.either,
		),
	);
	if (!Either.isLeft(timeoutOutcome)) throw new Error("expected timeout");
	expect(timeoutOutcome.left._tag).toBe("timeout");

	// The trailing descendant only has to outlive the drain window for this to
	// prove that the service terminates the child on overflow rather than waiting
	// for it to finish; a short one keeps the test from leaving an orphaned
	// `sleep` behind on every run, and the elapsed assertion below is what makes
	// the short one sufficient.
	const overflowStartedAt = Date.now();
	const overflowOutcome = await Effect.runPromise(
		runProcessEffect(["sh", "-c", "yes x | head -c 100000; sleep 3"], {
			maxOutputBytes: 1024,
		}).pipe(Effect.either),
	);
	if (!Either.isLeft(overflowOutcome)) throw new Error("expected overflow");
	expect(overflowOutcome.left._tag).toBe("overflow");
	expect(Date.now() - overflowStartedAt).toBeLessThan(2_000);

	// A descendant that inherits the pipe but writes nothing is not evidence that
	// the capture is short: the effect settles on the child's exit and the output
	// is complete. Failing here would retry a command that already succeeded.
	const silentDescendantStartedAt = Date.now();
	const silentDescendant = await Effect.runPromise(
		runProcessEffect(["sh", "-c", "echo early; sleep 3 &"]),
	);
	expect(silentDescendant.exitCode).toBe(0);
	expect(silentDescendant.stdout).toBe("early\n");
	expect(Date.now() - silentDescendantStartedAt).toBeLessThan(2_000);

	// A descendant that is still *writing* when the window closes can only yield a
	// prefix, and the callers of this service parse stdout as authoritative data
	// (a created PR/MR URL, a changed-file list). That is reported rather than
	// passed off as a complete read, and the effect still settles on the child's
	// exit instead of waiting out the descendant. The trailing `sleep` is what
	// keeps the pipe open past the window; without it EOF arrives inside the window
	// and the same command is complete, which is the case asserted above.
	const truncatedStartedAt = Date.now();
	const truncated = await Effect.runPromise(
		runProcessEffect([
			"sh",
			"-c",
			"echo early; (sleep 0.1; echo late; sleep 3) &",
		]).pipe(Effect.either),
	);
	if (!Either.isLeft(truncated)) throw new Error("expected a reported read");
	expect(truncated.left._tag).toBe("overflow");
	expect(truncated.left.detail).toContain("still being written");
	expect(Date.now() - truncatedStartedAt).toBeLessThan(2_000);

	// Interruption propagates to the real child promptly and reports cancellation
	// (the child is killed; the reader cleanup is bounded).
	const controller = new AbortController();
	const startedAt = Date.now();
	const cancelOutcomePromise = Effect.runPromise(
		runProcessEffect(["sh", "-c", "sleep 30"], {
			signal: controller.signal,
		}).pipe(Effect.either),
	);
	setTimeout(() => controller.abort(), 60);
	const cancelOutcome = await cancelOutcomePromise;
	if (!Either.isLeft(cancelOutcome)) throw new Error("expected cancel");
	expect(cancelOutcome.left._tag).toBe("canceled");
	expect(Date.now() - startedAt).toBeLessThan(3_000);

	// Cancellation outranks the state of a surviving descendant. The two are
	// correlated by construction — the abort kills the direct child while the
	// descendant keeps the pipe open — so an ownership abort must not be reported
	// as retryable infrastructure and retried against a lease that is already
	// gone.
	const abortedController = new AbortController();
	const abortedWithDescendant = Effect.runPromise(
		runProcessEffect(["sh", "-c", "sleep 3 & exit 0"], {
			signal: abortedController.signal,
		}).pipe(Effect.either),
	);
	setTimeout(() => abortedController.abort(), 60);
	const abortedOutcome = await abortedWithDescendant;
	if (!Either.isLeft(abortedOutcome)) throw new Error("expected cancel");
	expect(abortedOutcome.left._tag).toBe("canceled");
});

test("credential Effect boundary classifies no-UI as permanent and removes the shim afterwards", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-cred-effect-"));
	const file = path.join(dir, "fake-credential-git");
	fs.writeFileSync(
		file,
		[
			"#!/bin/sh",
			'answer="$("$SSH_ASKPASS" "Enter passphrase:")"',
			"printf '%s' \"$answer\"",
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	try {
		const before = new Set(
			fs
				.readdirSync(os.tmpdir())
				.filter((item) => item.startsWith("agentic-coding-askpass")),
		);
		const outcome = await Effect.runPromise(
			runGitWithCredentialsEffect(dir, ["x"], { executable: file }).pipe(
				Effect.either,
			),
		);
		if (!Either.isLeft(outcome))
			throw new Error("expected permanent credential failure");
		expect(outcome.left).toBeInstanceOf(PermanentFailure);
		// The askpass shim/FIFOs are scoped to the operation: no new dir remains
		// (secrets are never retained after the call).
		const after = fs
			.readdirSync(os.tmpdir())
			.filter((item) => item.startsWith("agentic-coding-askpass"));
		expect(after.filter((item) => !before.has(item)).length).toBe(0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("wiki operations pin their root explicitly and overlap without environment mutation", async () => {
	const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-root-a-"));
	const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-root-b-"));
	const prior = process.env.HERDR_WIKI_DIR;
	try {
		const inputA = {
			type: "concept",
			title: "Pinned A",
			description: "root A concept",
			sources: [{ id: "code", resource: "src/workflow/wiki.ts" }],
			body: "content a[^code]",
		};
		const inputB = {
			type: "concept",
			title: "Pinned B",
			description: "root B concept",
			sources: [{ id: "code", resource: "src/workflow/wiki.ts" }],
			body: "content b[^code]",
		};
		writeConcept("pinned/a", inputA, rootA);
		writeConcept("pinned/b", inputB, rootB);
		expect(fs.existsSync(conceptPath("pinned/a", rootA))).toBe(true);
		expect(fs.existsSync(conceptPath("pinned/a", rootB))).toBe(false);
		expect(readConcept("pinned/a", rootA).frontmatter.title).toBe("Pinned A");
		expect(readConcept("pinned/b", rootB).frontmatter.title).toBe("Pinned B");
		// Verify only the pinned root and never mutates the sibling root.
		verifyConcept("pinned/a", "human:tester", undefined, true, rootA);
		expect(readConcept("pinned/a", rootA).frontmatter.status).toBe("stable");
		expect(readConcept("pinned/b", rootB).frontmatter.status).not.toBe(
			"stable",
		);
		// No process-wide mutation happened anywhere in the overlap.
		expect(process.env.HERDR_WIKI_DIR).toBe(prior);
	} finally {
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	}
});
