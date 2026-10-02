#!/usr/bin/env bun
// Repository test runner.
//
// `bun test` runs test files sequentially unless `--parallel` is passed, and
// Bun's own worker pool intermittently stalls under this suite's real git/sh
// children (measured: multi-second per-test timeouts even at low concurrency).
// This runner instead executes each job in its own `bun test` process with a
// bounded pool, sidestepping that pool. A job is either a single file or one
// render shard, so per-file process isolation — a fresh module registry, fresh
// `process.on` handlers, fresh timers and fresh `process.env` per file — holds
// for the single-file jobs only; a shard keeps sequential ordering. That trade is
// spelled out where it is made, in `scripts/test-plan.ts`.
//
// Concurrency is half the available cores, capped at 6: measured, the suite stops
// getting faster above that (6 gave 70.6s, 10 gave 74.4s, 16 gave 72.6s) because
// it is CPU-bound at the parallelism the machine actually delivers, not at the
// pool's width.
//
// Bun's default per-test timeout is 5000ms. The integration tests spawn real
// git/sh children and can exceed that under the pool on a loaded machine, so
// every invocation — focused and full — shares TEST_TIMEOUT_MS, and a focused
// test behaves exactly as it does in the suite. Bun cannot interrupt a
// synchronously-blocking test (it never yields), so each file also gets a
// wall-clock watchdog that SIGKILLs its process and frees the pool slot instead
// of hanging the whole run.
//
// Coverage gap, stated as the current fact rather than as a pending fix: there is
// no render coverage for the settings pages or the environment journey.
// `test/app/agentPresetsView.test.tsx`, `test/app/environmentJourney.test.tsx`
// and `test/app/settingsPages.test.tsx` are absent from both this worktree and
// HEAD, so nothing here can restore them; `src/tui/settings/AgentPresetsView.tsx`
// has no test referencing it. An earlier note in this file described them as
// "removed for runtime, restore with git show HEAD:<path>" and estimated them at
// 108s of a 136s suite, but that reasoning predates the render sharding below and
// the pruning of the suite's child-process cost (235s -> ~115s of CPU), so the
// estimate no longer holds either. Restoring them is a separate decision with its
// own measurement, not a deferred task in this runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	decideJobOutcome,
	discover,
	type Job,
	OUTPUT_DRAIN_GRACE_MS,
	planJobs,
	watchdogBudgetMs,
} from "./test-plan.ts";

const TEST_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_BYTES = 1 << 20;

const root = path.resolve(import.meta.dir, "..");
process.chdir(root);

/** Read a child stream but retain at most `limit` bytes, draining the rest so a
 * chatty test cannot block on a full pipe or spike runner memory.
 *
 * `stop` ends the read for the same reason `src/workflow/process.ts` settles on
 * the child's exit rather than on EOF: a test that spawns something which
 * inherits this pipe keeps the write end open after the test process is gone, and
 * a reader waiting for EOF then never resolves. That is not a hypothetical here —
 * it is exactly the shape of the hanging test the watchdog exists for, so a
 * reader that owned the job's liveness would defeat the watchdog on the one path
 * it was written for. Settling also cancels the stream so the read cannot keep
 * buffering behind the caller's back. */
async function readCapped(
	stream: ReadableStream<Uint8Array> | undefined,
	limit: number,
	stop?: Promise<void>,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let kept = 0;
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		void reader.cancel().catch(() => {
			/* the stream is already closed */
		});
	};
	void stop?.then(settle);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (settled) break;
		if (!value || kept >= limit) continue;
		text += decoder.decode(value, { stream: true });
		kept += value.byteLength;
	}
	return text;
}

/** `null` (not 0) when Bun's report shape is unrecognized, so an upgrade cannot
 * silently turn the summary into a false `0 tests`. */
function reportedTests(output: string): number | null {
	const match = output.match(/Ran (\d+) tests? across/);
	return match ? Number(match[1]) : null;
}

/** Skipped cases reported by the same summary block. Bun omits the line when
 * nothing was skipped, so `null` means "none reported" — except that a summary
 * with no recognizable block at all is a different (unparsed) problem, which
 * `reportedTests` already flags. Runtime smoke fixtures report skipped
 * prerequisites this way; an unexecuted check must never be counted as a
 * passing one. */
function reportedSkips(output: string): number {
	const match = output.match(/^\s*(\d+) skip(?:ped)?\s*$/m);
	return match ? Number(match[1]) : 0;
}

const explicit = Bun.argv.slice(2);

// Focused runs stay single-process (fast startup, direct file/flag arguments)
// but share the same timeout as the pool so a test cannot pass in one path and
// time out in the other. A user-supplied --timeout after ours still wins.
if (explicit.length > 0) {
	const result = Bun.spawnSync(
		[process.execPath, "test", `--timeout=${TEST_TIMEOUT_MS}`, ...explicit],
		{ stdio: ["inherit", "inherit", "inherit"] },
	);
	process.exit(result.exitCode ?? 1);
}

const files = discover("test").sort();
if (files.length === 0) {
	console.error(
		"no test files discovered under test/ (expected *.test.* / *.spec.*); " +
			"refusing to report a false green",
	);
	process.exit(1);
}

const concurrency = Math.min(
	6,
	Math.max(1, Math.floor(os.availableParallelism() / 2)),
);

const queue = planJobs(files);
const jobs = queue.length;
const failures: Array<{ file: string; output: string }> = [];
let tests = 0;
let unparsedJobs = 0;
let unparsedFiles = 0;
let passed = 0;
let skipped = 0;
const startedAt = performance.now();

async function runJob(job: Job): Promise<void> {
	const started = performance.now();
	// Each job owns its configuration root. This is what makes the test
	// configuration isolation unconditional: the preload's fallback is skipped when
	// the variable is already set, so a shell that exports
	// AGENTIC_CODING_CONFIG_DIR — the variable this runner exports to the agents it
	// launches — would otherwise hand its own root to every test and reinstate the
	// ambient-classifier sidecar load the preload exists to prevent. The runner
	// owns the process, so the runner creates the root and removes it in the
	// `finally` after the child is reaped.
	const configRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "agentic-coding-test-config-"),
	);
	const proc = Bun.spawn(
		[process.execPath, "test", `--timeout=${TEST_TIMEOUT_MS}`, ...job.files],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, AGENTIC_CODING_CONFIG_DIR: configRoot },
		},
	);
	// The watchdog bounds the job, so a shard of N files gets N files' worth of
	// budget, capped. A single flat 60s was calibrated against one file, and an
	// uncapped multiple would let a wedged 20-file shard hold its pool slot for
	// twenty minutes while the header promised a per-file watchdog.
	const budgetMs = watchdogBudgetMs(job.files.length);
	// Readers must not own the job's liveness: see readCapped's `stop`. The window
	// is closed by the child exiting, or by the watchdog killing it — never by the
	// readers themselves, which is the deadlock this shape avoids.
	let closeDrainWindow: () => void = () => {};
	const drainWindowClosed = new Promise<void>((resolve) => {
		closeDrainWindow = resolve;
	});
	let killedByWatchdog = false;
	const watchdog = setTimeout(() => {
		killedByWatchdog = true;
		proc.kill(9);
		closeDrainWindow();
	}, budgetMs);
	let drainGrace: ReturnType<typeof setTimeout> | undefined;
	const exited = proc.exited.then((exitCode) => {
		drainGrace = setTimeout(closeDrainWindow, OUTPUT_DRAIN_GRACE_MS);
		return exitCode;
	});
	let stdout = "";
	let stderr = "";
	let code = 1;
	try {
		const captured = await Promise.all([
			readCapped(proc.stdout, MAX_CAPTURED_BYTES, drainWindowClosed),
			readCapped(proc.stderr, MAX_CAPTURED_BYTES, drainWindowClosed),
		]);
		[stdout, stderr] = captured;
		code = await exited;
	} finally {
		clearTimeout(watchdog);
		clearTimeout(drainGrace);
		closeDrainWindow();
		fs.rmSync(configRoot, { recursive: true, force: true });
	}
	const output = `${stderr}${stdout}`;
	const elapsed = Math.round(performance.now() - started);
	const count = reportedTests(output);
	if (count === null) {
		unparsedJobs++;
		unparsedFiles += job.files.length;
	} else tests += count;
	skipped += reportedSkips(output);
	const outcome = decideJobOutcome({
		exitCode: code,
		killedByWatchdog,
		budgetMs,
	});
	if (outcome.kind === "timeout") {
		// A killed job never ran its later files and its exit code means nothing,
		// so it is reported as a timeout rather than as failing assertions.
		failures.push({
			file: job.label,
			output: `runner watchdog killed this job after ${outcome.budgetMs}ms; its remaining files did not run
${output}`,
		});
		console.log(`TIMEOUT ${job.label} (${elapsed}ms)`);
		return;
	}
	if (outcome.kind === "ok") {
		passed++;
		console.log(`ok   ${job.label} (${elapsed}ms)`);
		return;
	}
	failures.push({ file: job.label, output });
	console.log(`FAIL ${job.label} (${elapsed}ms)`);
}

async function worker(): Promise<void> {
	for (;;) {
		const job = queue.shift();
		if (!job) return;
		await runJob(job);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

// Every job can legitimately report 2 MiB, so a fully broken run would retain
// hundreds of megabytes of diagnostics and the runner could die of the memory
// it was collecting. Keep the first failures readable and summarise the rest.
const FULL_FAILURE_REPORTS = 5;
const SUMMARY_FAILURE_BYTES = 64 * 1024;
let omittedBytes = 0;
for (const [index, failure] of failures.entries()) {
	const body =
		index < FULL_FAILURE_REPORTS
			? failure.output
			: failure.output.slice(0, SUMMARY_FAILURE_BYTES);
	if (body.length < failure.output.length)
		omittedBytes += failure.output.length - body.length;
	console.error(
		`\n=== ${failure.file} ===\n${body}${
			body.length < failure.output.length
				? `\n[truncated ${failure.output.length - body.length} bytes]`
				: ""
		}`,
	);
}
if (omittedBytes > 0)
	console.error(`\n[${omittedBytes} bytes of failure output omitted]`);

const seconds = ((performance.now() - startedAt) / 1000).toFixed(2);
const parts = [
	`${passed}/${jobs} test jobs (${files.length} files)`,
	`${tests - skipped} executed tests (${skipped} skipped) in ${seconds}s`,
];
if (failures.length > 0) parts.push(`${failures.length} failed`);
if (unparsedJobs > 0)
	parts.push(`${unparsedFiles} files with unparseable counts`);
console.log(
	`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${parts.join(", ")}`,
);
process.exit(failures.length > 0 ? 1 : 0);
