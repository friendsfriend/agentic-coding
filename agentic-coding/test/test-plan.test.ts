// The runner's own shape. `planJobs` decides which files share a process, and a
// mistake there is invisible: a file dropped from every job would simply not run,
// and the suite would still report PASS. Discovery is imported rather than
// re-declared, so these assertions run against the runner's real file set instead
// of a copy of it — a copy would keep passing while the runner discovered
// something else.
import { describe, expect, test } from "bun:test";
import {
	decideJobOutcome,
	discover,
	FILE_WATCHDOG_MAX_MS,
	FILE_WATCHDOG_MS,
	planJobs,
	RENDER_SHARDS,
	RENDER_SUITE,
	watchdogBudgetMs,
} from "../scripts/test-plan.ts";

const discovered = discover("test").sort();

describe("test run planning", () => {
	test("every discovered file lands in exactly one job", () => {
		const jobs = planJobs(discovered);
		const planned = jobs.flatMap((job) => job.files);
		expect([...planned].sort()).toEqual(discovered);
		expect(new Set(planned).size).toBe(planned.length);
	});

	test("discovery finds the suite, not an empty or partial tree", () => {
		// Guards the shared definition itself: a broken regex or a wrong root would
		// make the invariant above trivially true over a smaller set.
		expect(discovered.length).toBeGreaterThan(150);
		expect(discovered.some((file) => file.startsWith("test/dash/"))).toBe(true);
		expect(
			discovered.every((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)),
		).toBe(true);
	});

	test("the real suite actually exercises both job shapes", () => {
		const jobs = planJobs(discovered);
		expect(jobs.some((job) => job.files.length === 1)).toBe(true);
		expect(jobs.some((job) => job.files.length > 1)).toBe(true);
	});

	test("only render files share a process", () => {
		for (const job of planJobs(discovered)) {
			if (job.files.length === 1) continue;
			for (const file of job.files) expect(file).toMatch(RENDER_SUITE);
		}
	});

	test("render files are spread across the shards, not bunched", () => {
		const shards = planJobs(discovered).filter((job) => job.files.length > 1);
		expect(shards).toHaveLength(RENDER_SHARDS);
		const sizes = shards.map((shard) => shard.files.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
	});

	test("the longest jobs are scheduled first", () => {
		// The shards run ~20 files each, so a tail of shards leaves the pool
		// draining with nothing to fill it.
		const weights = planJobs(discovered).map((job) => job.weight);
		expect(weights).toEqual([...weights].sort((left, right) => right - left));
	});

	test("planning is pure", () => {
		const input = [...discovered];
		const first = planJobs(input);
		planJobs(input);
		expect(input).toEqual(discovered);
		expect(planJobs(discovered)).toEqual(first);
	});
});

describe("job reporting", () => {
	test("a killed job is a timeout, not a failing assertion", () => {
		// A SIGKILLed process usually exits non-zero, so an exit-code check that
		// ran first would report an unattributable FAIL for a job whose remaining
		// files never ran at all.
		expect(
			decideJobOutcome({
				exitCode: 1,
				killedByWatchdog: true,
				budgetMs: 60_000,
			}),
		).toEqual({ kind: "timeout", budgetMs: 60_000 });
		expect(
			decideJobOutcome({
				exitCode: 0,
				killedByWatchdog: true,
				budgetMs: 120_000,
			}),
		).toEqual({ kind: "timeout", budgetMs: 120_000 });
	});

	test("an exit code decides only when the watchdog did not fire", () => {
		expect(
			decideJobOutcome({
				exitCode: 0,
				killedByWatchdog: false,
				budgetMs: 60_000,
			}),
		).toEqual({ kind: "ok" });
		expect(
			decideJobOutcome({
				exitCode: 1,
				killedByWatchdog: false,
				budgetMs: 60_000,
			}),
		).toEqual({ kind: "fail" });
	});

	test("the watchdog budget scales per file but stays bounded", () => {
		expect(watchdogBudgetMs(1)).toBe(FILE_WATCHDOG_MS);
		expect(watchdogBudgetMs(2)).toBe(FILE_WATCHDOG_MS * 2);
		// An uncapped multiple would let a wedged 20-file shard hold its pool slot
		// for twenty minutes.
		expect(watchdogBudgetMs(20)).toBe(FILE_WATCHDOG_MAX_MS);
		expect(watchdogBudgetMs(0)).toBe(FILE_WATCHDOG_MS);
	});
});
