// The cost ceiling of the compaction policy (efficiency backlog item 6).
//
// The two purposes are tested apart: the window-relative reserve stays the
// last-resort overflow guard, and the absolute ceiling is the cost control. All
// of it is pure — resolution, validation, the floor and the loop guard — plus
// the Settings read/write round trip against a temporary configuration root.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	applyAgentsMutation,
	loadCompactionSettings,
} from "../src/server/config.ts";
import {
	COMPACTION_CEILING_DEFAULT,
	COMPACTION_CEILING_FLOOR_TOKENS,
	COMPACTION_CEILING_FLOOR_TURNS,
	COMPACTION_CEILING_KEPT_SHARE,
	COMPACTION_CEILING_LOOP_LIMIT,
	COMPACTION_CEILING_LOOP_TURNS,
	COMPACTION_CEILING_MINIMUM,
	COMPACTION_DEFAULTS,
	type CompactionCeilingState,
	evaluateCompactionCeiling,
	parseCompactionConfig,
	resolveCompactionCeiling,
	resolveCompactionPolicy,
	validateCompactionConfig,
	validateCompactionField,
} from "../src/workflow/compaction.ts";

/** One temporary configuration root, restored afterwards. */
function withConfigRoot<T>(run: (root: string) => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-ceiling-"));
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousWorkflow = process.env.HERDR_WORKFLOW_CONFIG;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	try {
		return run(root);
	} finally {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		if (previousWorkflow === undefined)
			delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousWorkflow;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function state(
	overrides: Partial<CompactionCeilingState> = {},
): CompactionCeilingState {
	return { turnIndex: 1, compactionTurns: [], ...overrides };
}

describe("cost ceiling resolution", () => {
	test("the documented default is absolute, 150000 tokens, and active on a 1M window", () => {
		const noWindow = resolveCompactionCeiling({});
		expect(noWindow.ceilingTokens).toBe(COMPACTION_CEILING_DEFAULT);
		expect(noWindow.ceilingTokens).toBe(150_000);
		expect(noWindow.active).toBe(true);
		expect(noWindow.inactive).toBeUndefined();
		expect(noWindow.floorTurns).toBe(COMPACTION_CEILING_FLOOR_TURNS);
		expect(noWindow.floorTokens).toBe(COMPACTION_CEILING_FLOOR_TOKENS);
		expect(noWindow.loopTurns).toBe(COMPACTION_CEILING_LOOP_TURNS);
		expect(noWindow.loopLimit).toBe(COMPACTION_CEILING_LOOP_LIMIT);

		// Every preset model declares a 1M window: the overflow guard fires at
		// 700,000, so the ceiling is the reachable trigger and stays active.
		const wide = resolveCompactionCeiling({}, 1_000_000);
		expect(wide.active).toBe(true);
		expect(wide.overflowTokens).toBe(700_000);
		// A configured value wins, in absolute tokens as written.
		expect(
			resolveCompactionCeiling({ ceilingTokens: 120_000 }).ceilingTokens,
		).toBe(120_000);
	});

	test("0 turns the ceiling off and automatic compaction off turns it off too", () => {
		const off = resolveCompactionCeiling({ ceilingTokens: 0 });
		expect(off.active).toBe(false);
		expect(off.inactive).toBe("off");
		expect(off.ceilingTokens).toBe(0);
		const disabled = resolveCompactionCeiling({
			ceilingTokens: 120_000,
			enabled: false,
		});
		expect(disabled.active).toBe(false);
		expect(disabled.inactive).toBe("disabled");
		expect(
			evaluateCompactionCeiling({
				ceiling: disabled,
				contextTokens: 900_000,
				state: state(),
			}),
		).toEqual({ kind: "quiet", reason: "inactive" });
	});

	test("a ceiling at or above the overflow threshold is ignored, with the threshold named", () => {
		// 128k window: reserve max(32000, 30%) = 38400, so the overflow guard
		// fires above 89600 — below the 150000 default ceiling.
		const narrow = resolveCompactionCeiling({}, 128_000);
		expect(narrow.active).toBe(false);
		expect(narrow.inactive).toBe("above-overflow");
		expect(narrow.overflowTokens).toBe(89_600);
		expect(
			evaluateCompactionCeiling({
				ceiling: narrow,
				contextTokens: 88_000,
				state: state(),
			}),
		).toEqual({ kind: "quiet", reason: "inactive" });
		// A ceiling below that threshold is the tighter trigger and applies.
		const low = resolveCompactionCeiling({ ceilingTokens: 60_000 }, 128_000);
		expect(low.active).toBe(true);
		expect(low.overflowTokens).toBe(89_600);
	});

	test("the kept-verbatim tail is capped at half an active ceiling", () => {
		const ceiling = resolveCompactionCeiling({ ceilingTokens: 100_000 });
		expect(ceiling.active).toBe(true);
		// The tail plus the summary has to stay under the ceiling, or the next
		// request is already over it and every turn compacts.
		const policy = resolveCompactionPolicy({
			ceilingTokens: 100_000,
			keepRecentTokens: 95_000,
		});
		expect(policy.keepRecentTokens).toBe(
			Math.floor(100_000 * COMPACTION_CEILING_KEPT_SHARE),
		);
		// A default-sized tail is under the cap and untouched.
		expect(resolveCompactionPolicy({}).keepRecentTokens).toBe(
			COMPACTION_DEFAULTS.keepRecentTokens,
		);
		// With the ceiling off, the operator's tail is used as written.
		expect(
			resolveCompactionPolicy({ ceilingTokens: 0, keepRecentTokens: 95_000 })
				.keepRecentTokens,
		).toBe(95_000);
		// The reserve and its overflow semantics are untouched by the ceiling.
		expect(resolveCompactionPolicy({}, 1_000_000).reserveTokens).toBe(300_000);
	});
});

describe("cost ceiling decision", () => {
	const ceiling = resolveCompactionCeiling({ ceilingTokens: 100_000 });

	test("the ceiling fires at the configured value and not one token earlier", () => {
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 99_999,
				state: state({ turnIndex: 3 }),
			}),
		).toEqual({ kind: "quiet", reason: "below-ceiling" });
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 100_000,
				state: state({ turnIndex: 3 }),
			}),
		).toEqual({ kind: "compact" });
	});

	test("the floor holds a second compaction back until enough new context accrued", () => {
		const after: CompactionCeilingState = state({
			turnIndex: 5,
			lastCompactionTurn: 5,
			lastCompactionTokens: 101_000,
			compactionTurns: [5],
		});
		// One turn and 3,000 tokens later: too soon on both counts.
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 104_000,
				state: { ...after, turnIndex: 6 },
			}),
		).toEqual({ kind: "quiet", reason: "floor" });
		// Enough turns, even with little growth.
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 104_000,
				state: { ...after, turnIndex: 5 + COMPACTION_CEILING_FLOOR_TURNS },
			}),
		).toEqual({ kind: "compact" });
		// Or enough new tokens inside fewer turns: one huge turn should not have to
		// wait for the turn floor.
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 101_000 + COMPACTION_CEILING_FLOOR_TOKENS + 1,
				state: { ...after, turnIndex: 6 },
			}),
		).toEqual({ kind: "compact" });
	});

	test("three compactions inside ten turns stop the ceiling and report the guard", () => {
		const guarded: CompactionCeilingState = state({
			turnIndex: 9,
			lastCompactionTurn: 8,
			lastCompactionTokens: 101_000,
			compactionTurns: [2, 5, 8],
		});
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 400_000,
				state: guarded,
			}),
		).toEqual({ kind: "quiet", reason: "loop-guard" });
		// A compaction older than the window no longer counts.
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 400_000,
				state: { ...guarded, compactionTurns: [-5, -3, 8] },
			}),
		).toEqual({ kind: "compact" });
		// Once suspended, the decision stays quiet even below the guard.
		expect(
			evaluateCompactionCeiling({
				ceiling,
				contextTokens: 400_000,
				state: { ...guarded, suspended: true, compactionTurns: [] },
			}),
		).toEqual({ kind: "quiet", reason: "suspended" });
	});
});

describe("cost ceiling validation", () => {
	test("the ceiling is absolute only, and a value between 1 and the minimum is refused", () => {
		expect(validateCompactionField("ceilingTokens", 150_000)).toBeUndefined();
		expect(validateCompactionField("ceilingTokens", 0)).toBeUndefined();
		expect(validateCompactionField("ceilingTokens", "15%")).toContain(
			"absolute",
		);
		expect(validateCompactionField("ceilingTokens", 10)).toContain(
			String(COMPACTION_CEILING_MINIMUM),
		);
		expect(validateCompactionField("ceilingTokens", -1)).toContain(
			"must not be negative",
		);
		// The percentage form still works for the window-relative fields.
		expect(validateCompactionField("keepRecentTokens", "15%")).toBeUndefined();
	});

	test("the kept tail must stay below the ceiling", () => {
		const errors = validateCompactionConfig({
			ceilingTokens: 100_000,
			keepRecentTokens: 120_000,
		});
		expect(errors.map((error) => error.field)).toEqual(["keepRecentTokens"]);
		expect(errors[0]?.message).toContain("ceilingTokens");
		expect(
			validateCompactionConfig({
				ceilingTokens: 100_000,
				keepRecentTokens: 20_000,
			}),
		).toEqual([]);
		// A disabled ceiling has nothing for the tail to stay below.
		expect(
			validateCompactionConfig({ ceilingTokens: 0, keepRecentTokens: 120_000 }),
		).toEqual([]);
	});

	test("parsing drops an unusable ceiling instead of failing a launch", () => {
		expect(parseCompactionConfig({ ceilingTokens: "wat" })).toEqual({});
		expect(parseCompactionConfig({ ceilingTokens: "15%" })).toEqual({});
		expect(parseCompactionConfig({ ceilingTokens: 90_000 })).toEqual({
			ceilingTokens: 90_000,
		});
	});
});

describe("cost ceiling settings round trip", () => {
	test("a saved ceiling is written user-scope, read back and resolved", () => {
		withConfigRoot((root) => {
			const userFile = path.join(root, "config.json");
			writeJson(userFile, {
				agents: { compaction: { keepRecentTokens: 20000 } },
			});
			applyAgentsMutation({
				kind: "set-compaction",
				field: "ceilingTokens",
				value: 90_000,
			});
			const written = JSON.parse(fs.readFileSync(userFile, "utf8")) as {
				agents: { compaction: Record<string, unknown> };
			};
			expect(written.agents.compaction).toEqual({
				keepRecentTokens: 20000,
				ceilingTokens: 90000,
			});
			const read = loadCompactionSettings();
			expect(read.configured.ceilingTokens).toBe(90_000);
			expect(read.ceiling.ceilingTokens).toBe(90_000);
			expect(read.ceiling.active).toBe(true);
			// The resolved policy is unaffected apart from the tail cap.
			expect(read.effective.reserveTokens).toBe(
				COMPACTION_DEFAULTS.reserveTokens,
			);
			expect(read.effective.keepRecentTokens).toBe(20_000);
		});
	});

	test("the write path refuses a tail at or above the ceiling, and a ceiling below the tail", () => {
		withConfigRoot((root) => {
			const userFile = path.join(root, "config.json");
			writeJson(userFile, {
				agents: { compaction: { ceilingTokens: 90_000 } },
			});
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "keepRecentTokens",
					value: 90_000,
				}),
			).toThrow(/below ceilingTokens/);
			// A ceiling below the configured tail is refused as well, attributed to the
			// field being edited so the message names what to change.
			writeJson(userFile, {
				agents: { compaction: { keepRecentTokens: 50_000 } },
			});
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "ceilingTokens",
					value: 40_000,
				}),
			).toThrow(/below ceilingTokens/);
			// And a ceiling below the accepted minimum names the range instead.
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "ceilingTokens",
					value: 10_000,
				}),
			).toThrow(new RegExp(`at least ${COMPACTION_CEILING_MINIMUM}`));
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "ceilingTokens",
					value: "15%",
				}),
			).toThrow(/absolute/);
			const written = JSON.parse(fs.readFileSync(userFile, "utf8")) as {
				agents: { compaction: Record<string, unknown> };
			};
			expect(written.agents.compaction).toEqual({ keepRecentTokens: 50000 });
		});
	});

	test("turning the ceiling off is a plain 0 and resolves as off", () => {
		withConfigRoot((root) => {
			writeJson(path.join(root, "config.json"), {});
			applyAgentsMutation({
				kind: "set-compaction",
				field: "ceilingTokens",
				value: 0,
			});
			const read = loadCompactionSettings();
			expect(read.configured.ceilingTokens).toBe(0);
			expect(read.ceiling.active).toBe(false);
			expect(read.ceiling.inactive).toBe("off");
		});
	});
});
