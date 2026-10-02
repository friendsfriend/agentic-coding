import fs from "node:fs";
import path from "node:path";

// Which test files share a process.
//
// Split out of `scripts/test.ts` so the invariant that decides the suite's
// shape is testable: every discovered file must land in exactly one job. A file
// dropped here would vanish from the suite silently rather than fail, so this is
// the one part of the runner that needs an assertion rather than a comment.

/** One pool job: either a single file, or a set of files that share one test
 * process. */
export interface Job {
	label: string;
	files: string[];
	/** Longest-first scheduling hint. Shard jobs run many files in sequence, so
	 * they are the longest work in the run and must not be scheduled last. */
	weight: number;
}

/** Files whose test process pays for the same large module graph: the OpenTUI
 * renderer plus whichever component tree the file mounts. Importing
 * `src/tui/dash/App.tsx` alone costs ~870ms before the first assertion, and the
 * suite has 78 such files, so that graph was loaded 78 times for one shared body
 * of code.
 *
 * Grouping trades process isolation for module-graph load time, and that trade
 * is real: a fresh process gives each file a fresh module registry, fresh
 * `process.on` handlers, fresh timers and fresh `process.env`, and a shard keeps
 * only the sequential ordering (`test.maxConcurrency = 1` in bunfig.toml bounds
 * concurrent *tests*, not files). Files matched here must therefore leave no
 * process-global state behind — a leaked renderer, interval or env override
 * would reach the files that follow it in its shard. Suites that carry
 * cross-file process state are deliberately excluded: all 47
 * `workflow-*.test.ts` files in one process produced ten real failures before
 * this rule existed.
 *
 * Round-robin dealing spreads each directory's module graphs across shards so no
 * shard is one directory's worth of near-identical imports. Shard counts of
 * 2/4/6 and pool widths of 3/4/6/8/10/16 were measured; 4 shards at 6 workers was
 * the optimum, and both fewer and more shards were slower. */
export const RENDER_SUITE = /^test\/(?:dash|otel|app)\//;
export const RENDER_SHARDS = 4;

/** Match the files Bun itself discovers: `*.test.*` / `*.spec.*` with any
 * supported JS/TS extension. `_test.*` is excluded because Bun 1.4 does not
 * discover it either.
 *
 * Discovery lives here, next to the planner, so the runner and the planner's test
 * share one definition. When the test declared its own copy, the invariant it
 * advertised — every discovered file reaches exactly one job — was checked against
 * a duplicate rather than against the runner's real file set. */
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function discover(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...discover(full));
		else if (TEST_FILE.test(entry.name)) files.push(full);
	}
	return files;
}

/** Single files first by cost class is not available, so a shard is weighted by
 * how many files it runs. */
const SINGLE_FILE_WEIGHT = 1;

export function planJobs(found: string[]): Job[] {
	const jobs: Job[] = [];
	const render = found.filter((file) => RENDER_SUITE.test(file));
	for (const file of found.filter((file) => !RENDER_SUITE.test(file)))
		jobs.push({ label: file, files: [file], weight: SINGLE_FILE_WEIGHT });
	for (let index = 0; index < RENDER_SHARDS; index++) {
		const shard = render.filter(
			(_, position) => position % RENDER_SHARDS === index,
		);
		if (shard.length === 0) continue;
		jobs.push({
			label: `render shard ${index + 1} (${shard.length} files)`,
			files: shard,
			weight: shard.length,
		});
	}
	// Longest-first: the four multi-second shards overlap the ~130 short jobs
	// instead of forming a tail that no later work can fill. MEASURED: scheduling
	// them last left the pool draining into a shard-bound tail.
	return jobs.sort((left, right) => right.weight - left.weight);
}

/** How a finished job is reported. Kept here, and pure, so the runner's own
 * false-green defence is an assertion rather than a comment: a job the watchdog
 * killed must never be scored on its exit code, because its later files never
 * ran. */
export type JobOutcome =
	| { kind: "ok" }
	| { kind: "fail" }
	| { kind: "timeout"; budgetMs: number };

export function decideJobOutcome(input: {
	exitCode: number;
	killedByWatchdog: boolean;
	budgetMs: number;
}): JobOutcome {
	// Checked first: a SIGKILLed process usually exits non-zero, so testing the
	// exit code first would report an unattributable FAIL for a job whose
	// remaining files never ran.
	if (input.killedByWatchdog)
		return { kind: "timeout", budgetMs: input.budgetMs };
	return input.exitCode === 0 ? { kind: "ok" } : { kind: "fail" };
}

/** Per-job watchdog budget: a fixed per-file allowance, bounded so a large shard
 * cannot turn the watchdog into a twenty-minute silent tail. */
export const FILE_WATCHDOG_MS = 60_000;
export const FILE_WATCHDOG_MAX_MS = 180_000;
/** How long the readers may keep draining after the test process exits before the
 * job settles on what was captured. */
export const OUTPUT_DRAIN_GRACE_MS = 500;

export function watchdogBudgetMs(fileCount: number): number {
	return Math.min(
		FILE_WATCHDOG_MS * Math.max(1, fileCount),
		FILE_WATCHDOG_MAX_MS,
	);
}
