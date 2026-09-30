import { describe, expect, test } from "bun:test";
import {
	FILE_JUDGMENT_THRESHOLDS,
	type FileJudgment,
	pruneFileJudgments,
	renderFileSignals,
} from "../src/workflow/classifiers.ts";
import { parseAgentsConfig } from "../src/workflow/profiles.ts";

const PROVENANCE = {
	provider: "opencode-zen",
	model: "opencode/jev-1.13",
	thresholds: FILE_JUDGMENT_THRESHOLDS,
};

function band(outcome: {
	flagged: readonly FileJudgment[];
	unsure: readonly FileJudgment[];
}) {
	return {
		flagged: outcome.flagged.map((entry) => entry.path),
		unsure: outcome.unsure.map((entry) => entry.path),
	};
}

describe("per-file judgment banding", () => {
	test("splits answers into flag, unsure, and clear at the code thresholds", () => {
		const outcome = pruneFileJudgments(
			[
				{ path: "flag.ts", noul: 0.94 },
				{ path: "boundary-flag.ts", noul: 0.7 },
				{ path: "unsure.ts", noul: 0.5 },
				{ path: "boundary-unsure.ts", noul: 0.25 },
				{ path: "clear.ts", noul: 0.05 },
			],
			[],
		);
		expect(band(outcome)).toEqual({
			flagged: ["flag.ts"],
			unsure: ["boundary-flag.ts", "unsure.ts", "boundary-unsure.ts"],
		});
		expect(outcome.cleared).toBe(1);
		expect(outcome.judged).toBe(5);
	});

	test("sorts each band by descending confidence", () => {
		const outcome = pruneFileJudgments(
			[
				{ path: "low.ts", noul: 0.72 },
				{ path: "high.ts", noul: 0.99 },
				{ path: "mid.ts", noul: 0.8 },
			],
			[],
		);
		expect(outcome.flagged.map((entry) => entry.path)).toEqual([
			"high.ts",
			"mid.ts",
			"low.ts",
		]);
	});

	test("an unanswerable question is a skip, never a clean file", () => {
		const outcome = pruneFileJudgments(
			[{ path: "silent.ts", noul: undefined }],
			[],
		);
		expect(outcome.cleared).toBe(0);
		expect(outcome.judged).toBe(0);
		expect(outcome.skipped).toEqual([
			{ path: "silent.ts", reason: "no usable answer" },
		]);
	});

	test("coverage always reconciles against the candidate count", () => {
		const answers = [
			{ path: "a.ts", noul: 0.9 },
			{ path: "b.ts", noul: 0.4 },
			{ path: "c.ts", noul: 0.01 },
			{ path: "d.ts", noul: undefined },
		];
		const skipped = [{ path: "e.ts", reason: "over the per-file budget" }];
		const outcome = pruneFileJudgments(answers, skipped);
		expect(outcome.judged + outcome.skipped.length).toBe(5);
		expect(outcome.skipped.map((entry) => entry.path)).toEqual([
			"e.ts",
			"d.ts",
		]);
	});

	test("a backend that flags nearly everything is reported as degenerate", () => {
		// The measured local-classifier failure mode: scores clustered at 0.83-0.91
		// across every file, including files with no resource handling at all.
		const clustered = Array.from({ length: 10 }, (_, index) => ({
			path: `file-${index}.ts`,
			noul: 0.83 + index * 0.008,
		}));
		const outcome = pruneFileJudgments(clustered, []);
		expect(outcome.flagged.length).toBe(10);
		expect(outcome.degenerate).toBe(true);
	});

	test("a discriminating backend is not degenerate", () => {
		const outcome = pruneFileJudgments(
			[
				...Array.from({ length: 4 }, (_, index) => ({
					path: `flag-${index}.ts`,
					noul: 0.95,
				})),
				...Array.from({ length: 16 }, (_, index) => ({
					path: `clear-${index}.ts`,
					noul: 0.05,
				})),
			],
			[],
		);
		expect(outcome.degenerate).toBe(false);
	});
});

describe("per-file judgment configuration", () => {
	test("a configuration that says nothing leaves the sweep disabled", () => {
		const agents = parseAgentsConfig({ profiles: {} });
		expect(agents.file_judgment).toBeUndefined();
	});

	test("accepts an enabled sweep with explicit bounds", () => {
		const agents = parseAgentsConfig({
			profiles: {},
			file_judgment: {
				enabled: true,
				threshold: 0.75,
				unsure: 0.3,
				concurrency: 2,
			},
		});
		expect(agents.file_judgment).toEqual({
			enabled: true,
			threshold: 0.75,
			unsure: 0.3,
			concurrency: 2,
		});
	});

	test("rejects a table without an explicit enabled flag", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				file_judgment: { threshold: 0.5 },
			}),
		).toThrow(/enabled must be a boolean/);
	});

	test("rejects an ambiguity floor above the flag threshold", () => {
		// An `unsure` floor above `threshold` would empty the band, which is the one
		// configuration that looks like it works while losing the band's purpose.
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				file_judgment: { enabled: true, threshold: 0.4, unsure: 0.6 },
			}),
		).toThrow(/unsure must not be above/);
	});

	test("rejects an out-of-range probability and a zero concurrency", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				file_judgment: { enabled: true, threshold: 1.5 },
			}),
		).toThrow(/probability between 0 and 1/);
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				file_judgment: { enabled: true, concurrency: 0 },
			}),
		).toThrow(/concurrency must be a positive integer/);
	});
});

describe("rendered file signals", () => {
	test("carries provenance, thresholds, coverage, and the evidence caveat", () => {
		const outcome = pruneFileJudgments(
			[
				{ path: "src/a.ts", noul: 0.93 },
				{ path: "src/b.ts", noul: 0.6 },
				{ path: "src/c.ts", noul: 0.02 },
			],
			[{ path: "src/d.ts", reason: "unreadable" }],
		);
		const rendered = renderFileSignals(outcome, PROVENANCE);
		expect(rendered).toContain("provider=opencode-zen model=opencode/jev-1.13");
		expect(rendered).toContain(`flag>${FILE_JUDGMENT_THRESHOLDS.flag}`);
		expect(rendered).toContain(
			"judged 3, cleared 1, flagged 1, unsure 1, not judged 1",
		);
		expect(rendered).toContain("flagged (1): src/a.ts (0.93)");
		expect(rendered).toContain("unsure (1): src/b.ts (0.60)");
		expect(rendered).toContain("not judged: unreadable 1");
		expect(rendered).toContain("A verdict is not evidence");
		// The cleared band is a count, never a list: the whole point is that a
		// clean file's verdict does not re-enter the context.
		expect(rendered).not.toContain("src/c.ts");
	});

	test("names how much of the sweep came from the cache", () => {
		// A reader has to know when a verdict is about bytes that have not changed
		// since an earlier round rather than about what the classifier just saw.
		const cached = pruneFileJudgments(
			[
				{ path: "src/a.ts", noul: 0.93, cached: true },
				{ path: "src/b.ts", noul: 0.02 },
			],
			[],
		);
		expect(renderFileSignals(cached, PROVENANCE)).toContain(
			"judged 2 (1 from cache)",
		);
		const allFresh = pruneFileJudgments([{ path: "src/a.ts", noul: 0.93 }], []);
		expect(renderFileSignals(allFresh, PROVENANCE)).not.toContain("from cache");
	});

	test("caps the listed paths and reports the remainder", () => {
		const outcome = pruneFileJudgments(
			Array.from({ length: 12 }, (_, index) => ({
				path: `src/p${index}.ts`,
				noul: 0.9 - index * 0.001,
			})),
			[],
		);
		const rendered = renderFileSignals(outcome, PROVENANCE, 5);
		expect(rendered).toContain("flagged (12):");
		expect(rendered).toContain("... and 7 more");
		expect(rendered).not.toContain("src/p9.ts");
	});

	test("omits an empty band", () => {
		const empty = pruneFileJudgments([{ path: "src/only.ts", noul: 0.02 }], []);
		const renderedEmpty = renderFileSignals(empty, PROVENANCE);
		expect(renderedEmpty).not.toContain("flagged (");
		expect(renderedEmpty).not.toContain("unsure (");
		expect(renderedEmpty).not.toContain("degenerate share");
	});

	test("warns on a degenerate sweep", () => {
		const degenerate = pruneFileJudgments(
			Array.from({ length: 6 }, (_, index) => ({
				path: `src/q${index}.ts`,
				noul: 0.88,
			})),
			[],
		);
		const renderedDegenerate = renderFileSignals(degenerate, PROVENANCE);
		expect(renderedDegenerate).toContain(
			"flagged 6 of 6 judged files, which is at or above the degenerate share",
		);
		expect(renderedDegenerate).toContain("Treat these signals as unusable");
	});
});
