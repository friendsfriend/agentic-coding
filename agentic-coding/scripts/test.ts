#!/usr/bin/env bun
// Repository test runner.
//
// `bun test` runs test files sequentially unless `--parallel` is passed, and
// Bun's own worker pool intermittently stalls under this suite's real git/sh
// children (measured: multi-second per-test timeouts even at low concurrency).
// This runner instead executes each file in its own `bun test` process with a
// bounded pool, which keeps per-file process isolation (the OpenTUI renderer's
// process-global terminal state must not cross files — see `test.maxConcurrency`
// in bunfig.toml) while sidestepping the pool. Concurrency is half the available
// cores, capped at 3, leaving headroom for the subprocess-heavy files.
//
// Bun's default per-test timeout is 5000ms. The integration tests spawn real
// git/sh children and can exceed that under the pool on a loaded machine, so
// every invocation — focused and full — shares TEST_TIMEOUT_MS, and a focused
// test behaves exactly as it does in the suite. Bun cannot interrupt a
// synchronously-blocking test (it never yields), so each file also gets a
// wall-clock watchdog that SIGKILLs its process and frees the pool slot instead
// of hanging the whole run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_TIMEOUT_MS = 15_000;
const FILE_WATCHDOG_MS = 60_000;
const MAX_CAPTURED_BYTES = 1 << 20;

const root = path.resolve(import.meta.dir, "..");
process.chdir(root);

/** Match the files Bun itself discovers: `*.test.*` / `*.spec.*` with any
 * supported JS/TS extension. `_test.*` is excluded because Bun 1.4 does not
 * discover it either. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function discover(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...discover(full));
		else if (TEST_FILE.test(entry.name)) files.push(full);
	}
	return files;
}

/** Read a child stream but retain at most `limit` bytes, draining the rest so a
 * chatty test cannot block on a full pipe or spike runner memory. */
async function readCapped(
	stream: ReadableStream<Uint8Array> | undefined,
	limit: number,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let kept = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
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
	3,
	Math.max(1, Math.floor(os.availableParallelism() / 2)),
);
const queue = [...files];
const failures: Array<{ file: string; output: string }> = [];
let tests = 0;
let unparsed = 0;
let passed = 0;
const startedAt = performance.now();

async function runFile(file: string): Promise<void> {
	const started = performance.now();
	const proc = Bun.spawn(
		[process.execPath, "test", `--timeout=${TEST_TIMEOUT_MS}`, file],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const watchdog = setTimeout(() => proc.kill(9), FILE_WATCHDOG_MS);
	let stdout = "";
	let stderr = "";
	let code = 1;
	try {
		const captured = await Promise.all([
			readCapped(proc.stdout, MAX_CAPTURED_BYTES),
			readCapped(proc.stderr, MAX_CAPTURED_BYTES),
		]);
		[stdout, stderr] = captured;
		code = await proc.exited;
	} finally {
		clearTimeout(watchdog);
	}
	const output = `${stderr}${stdout}`;
	const elapsed = Math.round(performance.now() - started);
	const count = reportedTests(output);
	if (count === null) unparsed++;
	else tests += count;
	if (code === 0) {
		passed++;
		console.log(`ok   ${file} (${elapsed}ms)`);
		return;
	}
	failures.push({ file, output });
	console.log(`FAIL ${file} (${elapsed}ms)`);
}

async function worker(): Promise<void> {
	for (;;) {
		const file = queue.shift();
		if (!file) return;
		await runFile(file);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

for (const failure of failures) {
	console.error(`\n=== ${failure.file} ===\n${failure.output}`);
}

const seconds = ((performance.now() - startedAt) / 1000).toFixed(2);
const parts = [
	`${passed}/${files.length} test files`,
	`${tests} tests in ${seconds}s`,
];
if (failures.length > 0) parts.push(`${failures.length} failed`);
if (unparsed > 0) parts.push(`${unparsed} files with unparseable counts`);
console.log(
	`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${parts.join(", ")}`,
);
process.exit(failures.length > 0 ? 1 : 0);
