// The run-progress checkpoint's pure half (efficiency backlog item 19): the
// accumulator that measures a run from telemetry only, the content-free digest,
// the ordered `rules/v1` rule set, the closed steer catalog and the
// escalation text.
//
// The rule tests build a digest directly, so each rule is exercised by its
// minimal evidence; the accumulator tests drive the same class the host does.
// One test proves the developer's hard requirement: no turn count, on its own,
// ever produces anything but a decision — the escalation of a threshold is a
// question, and the module can only return it.
import { describe, expect, test } from "bun:test";
import { CHECKPOINT_THRESHOLDS } from "../scripts/efficiency/lib/queries.ts";
import {
	CHECKPOINT_ACTION_SUMMARY,
	CHECKPOINT_ACTIONS,
	CHECKPOINT_COST_RISING_RATIO,
	CHECKPOINT_FAILING_TOOL_STREAK,
	CHECKPOINT_NO_PROGRESS_TURNS,
	CHECKPOINT_RECORD_LIMIT,
	CHECKPOINT_REPEAT_MIN_CALLS,
	CHECKPOINT_RULE_IDS,
	CHECKPOINT_STEER_CATALOG_VERSION,
	type CheckpointDigest,
	type CheckpointSignal,
	checkpointAnswerMessage,
	checkpointClassOf,
	checkpointClassOfRole,
	checkpointDigestInput,
	checkpointInterval,
	checkpointQuestion,
	checkpointSignalState,
	checkpointSteerKind,
	checkpointSteerMessage,
	checkpointThresholdsFor,
	DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
	DEFAULT_CHECKPOINT_THRESHOLDS,
	decideCheckpoint,
	ProgressCheckpoint,
} from "../src/agent-host/progress-checkpoint.ts";

function baseDigest(
	overrides: Partial<CheckpointDigest> = {},
): CheckpointDigest {
	return {
		ordinal: 1,
		trigger: "soft",
		checkpointClass: "worker",
		readOnly: false,
		turns: 300,
		costUnits: 1.5,
		contextTokens: 10_000,
		peakContextTokens: 20_000,
		softTurns: 280,
		hardTurns: 1400,
		contextLimit: 200_000,
		compactionAdmissible: true,
		successfulCalls: 20,
		failingToolEligible: true,
		failingTool: null,
		failingToolStreak: 0,
		repeatCalls: 0,
		windowCalls: 20,
		turnsSinceProgress: 2,
		costRisingRatio: 1,
		window: { turns: 20, progress: 4 },
		diff: { files: 2, insertions: 30, deletions: 4 },
		tickedTasks: 3,
		previous: null,
		steeredSignals: [],
		...overrides,
	};
}

/** A digest carrying one stall signal, so a rule can be isolated. */
function withSignal(
	signal: CheckpointSignal,
	overrides: Partial<CheckpointDigest> = {},
): CheckpointDigest {
	if (signal === "failing-tool")
		return baseDigest({
			failingTool: "bash",
			failingToolStreak: CHECKPOINT_FAILING_TOOL_STREAK,
			...overrides,
		});
	if (signal === "repeats")
		return baseDigest({ repeatCalls: 16, windowCalls: 20, ...overrides });
	if (signal === "no-progress")
		return baseDigest({
			turnsSinceProgress: CHECKPOINT_NO_PROGRESS_TURNS,
			...overrides,
		});
	return baseDigest({
		costRisingRatio: CHECKPOINT_COST_RISING_RATIO,
		window: { turns: 20, progress: 0 },
		...overrides,
	});
}

describe("the shipped defaults", () => {
	test("the queries and the host read one threshold table", () => {
		for (const [checkpointClass, thresholds] of Object.entries(
			DEFAULT_CHECKPOINT_THRESHOLDS,
		))
			expect(CHECKPOINT_THRESHOLDS[checkpointClass as "worker"]).toEqual(
				thresholds,
			);
	});

	test("every class has a row and `other` uses the worker values", () => {
		expect(checkpointThresholdsFor("other")).toEqual(
			DEFAULT_CHECKPOINT_THRESHOLDS.worker,
		);
		expect(checkpointThresholdsFor("mechanical")).toEqual(
			DEFAULT_CHECKPOINT_THRESHOLDS.mechanical,
		);
		expect(
			checkpointThresholdsFor("worker", { worker: { softTurns: 100 } }),
		).toEqual({
			softTurns: 100,
			hardTurns: DEFAULT_CHECKPOINT_THRESHOLDS.worker.hardTurns,
		});
	});

	test("every class's hard limit sits above its soft threshold and the interval is half of it", () => {
		for (const thresholds of Object.values(DEFAULT_CHECKPOINT_THRESHOLDS))
			expect(thresholds.hardTurns).toBeGreaterThanOrEqual(
				2 * thresholds.softTurns,
			);
		expect(checkpointInterval(280)).toBe(140);
		expect(checkpointInterval(10)).toBe(10);
		expect(checkpointInterval(30)).toBe(15);
	});

	test("an undeclared class is `other`, never a guess from the role", () => {
		expect(checkpointClassOf(undefined)).toBe("other");
		expect(checkpointClassOf("nonsense")).toBe("other");
		expect(checkpointClassOf("verifier")).toBe("verifier");
	});

	test("a historical role name maps to its class", () => {
		expect(checkpointClassOfRole("worker")).toBe("worker");
		expect(checkpointClassOfRole("planner")).toBe("planner");
		expect(checkpointClassOfRole("planner-review")).toBe("planner");
		// Only a prefix and a suffix match, exactly as the queries' SQL does.
		expect(checkpointClassOfRole("release-planner")).toBe("other");
		expect(checkpointClassOfRole("consolidator")).toBe("planner");
		expect(checkpointClassOfRole("doc-verifier")).toBe("verifier");
		expect(checkpointClassOfRole("triage")).toBe("mechanical");
		expect(checkpointClassOfRole("archive")).toBe("mechanical");
		expect(checkpointClassOfRole("git")).toBe("mechanical");
		expect(checkpointClassOfRole("orchestrator")).toBe("other");
		expect(checkpointClassOfRole(null)).toBe("other");
		expect(checkpointClassOfRole("")).toBe("other");
	});

	test("the context threshold sits above the compaction ceiling", () => {
		expect(DEFAULT_CHECKPOINT_CONTEXT_TOKENS).toBeGreaterThan(150_000);
	});
});

describe("rules/v1", () => {
	test("nothing is wrong: a clean run past its soft threshold continues", () => {
		const decision = decideCheckpoint(baseDigest());
		expect(decision).toEqual({ action: "continue", rule: "default" });
	});

	test("the hard limit decides escalate and nothing else", () => {
		const digest = baseDigest({ turns: 1400 });
		expect(decideCheckpoint(digest)).toEqual({
			action: "escalate",
			rule: "hard-limit",
		});
		// With steering off it still escalates: the hard limit is not a nudge.
		expect(decideCheckpoint(digest, { steer: false }).rule).toBe("hard-limit");
	});

	test("two zero-progress windows after a continue escalate", () => {
		const digest = baseDigest({
			previous: { decision: "continue", rule: "default", progress: 0 },
			window: { turns: 140, progress: 0 },
		});
		expect(decideCheckpoint(digest)).toEqual({
			action: "escalate",
			rule: "no-progress-twice",
		});
		// One progress event in either window is enough to keep going.
		expect(
			decideCheckpoint({
				...digest,
				previous: { decision: "continue", rule: "default", progress: 1 },
			}).action,
		).toBe("continue");
		expect(
			decideCheckpoint({ ...digest, window: { turns: 140, progress: 1 } })
				.action,
		).toBe("continue");
	});

	test("a signal already steered escalates when it comes back", () => {
		for (const signal of [
			"failing-tool",
			"repeats",
			"no-progress",
			"cost-rising",
		] as const) {
			const digest = withSignal(signal, { steeredSignals: [signal] });
			expect(decideCheckpoint(digest)).toEqual({
				action: "escalate",
				rule: "steer-ignored",
				signal,
			});
		}
	});

	test("context over the threshold compacts when admissible, else continues", () => {
		const over = baseDigest({
			contextTokens: DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
		});
		expect(decideCheckpoint(over)).toEqual({
			action: "compact",
			rule: "context",
		});
		const blocked = decideCheckpoint({ ...over, compactionAdmissible: false });
		expect(blocked.action).toBe("continue");
		expect(blocked.attention).toContain("not admissible");
		// Context alone never escalates, even at the hard limit's cooldown.
		expect(blocked.rule).not.toBe("hard-limit");
	});

	test("each steer signal fires on its own minimal evidence", () => {
		expect(decideCheckpoint(withSignal("failing-tool"))).toEqual({
			action: "steer",
			rule: "failing-tool",
			signal: "failing-tool",
		});
		expect(decideCheckpoint(withSignal("repeats"))).toEqual({
			action: "steer",
			rule: "repeats",
			signal: "repeats",
		});
		expect(decideCheckpoint(withSignal("no-progress"))).toEqual({
			action: "steer",
			rule: "no-progress",
			signal: "no-progress",
		});
		expect(decideCheckpoint(withSignal("cost-rising"))).toEqual({
			action: "steer",
			rule: "cost-rising",
			signal: "cost-rising",
		});
	});

	test("one event below each signal's threshold fires nothing", () => {
		expect(
			decideCheckpoint(
				baseDigest({
					failingTool: "bash",
					failingToolStreak: CHECKPOINT_FAILING_TOOL_STREAK - 1,
				}),
			).rule,
		).toBe("default");
		// 60 % of 20 calls is 12: eleven is not the signal.
		expect(
			decideCheckpoint(baseDigest({ repeatCalls: 11, windowCalls: 20 })).rule,
		).toBe("default");
		// A share is only measured on enough calls to mean anything.
		expect(
			decideCheckpoint(
				baseDigest({
					repeatCalls: CHECKPOINT_REPEAT_MIN_CALLS - 1,
					windowCalls: CHECKPOINT_REPEAT_MIN_CALLS - 1,
				}),
			).rule,
		).toBe("default");
		expect(
			decideCheckpoint(
				baseDigest({ turnsSinceProgress: CHECKPOINT_NO_PROGRESS_TURNS - 1 }),
			).rule,
		).toBe("default");
		// Cost rising needs a zero-progress window to mean a stall.
		expect(
			decideCheckpoint(
				baseDigest({
					costRisingRatio: CHECKPOINT_COST_RISING_RATIO,
					window: { turns: 20, progress: 1 },
				}),
			).rule,
		).toBe("default");
	});

	test("the signals are ordered: failing tool before repeats before no progress", () => {
		const digest = baseDigest({
			failingTool: "bash",
			failingToolStreak: 6,
			repeatCalls: 16,
			windowCalls: 20,
			turnsSinceProgress: 90,
			costRisingRatio: 3,
			window: { turns: 20, progress: 0 },
		});
		expect(checkpointSignalState(digest)).toEqual([
			"failing-tool",
			"repeats",
			"no-progress",
			"cost-rising",
		]);
		expect(decideCheckpoint(digest).rule).toBe("failing-tool");
	});

	test("the same digest always decides the same thing", () => {
		const digest = withSignal("repeats");
		const first = decideCheckpoint(digest);
		for (let index = 0; index < 5; index += 1)
			expect(decideCheckpoint(digest)).toEqual(first);
	});

	test("steering off turns the steer rules into continue without escalations", () => {
		for (const signal of [
			"failing-tool",
			"repeats",
			"no-progress",
			"cost-rising",
		] as const) {
			const decision = decideCheckpoint(withSignal(signal), { steer: false });
			expect(decision.action).toBe("continue");
			// The rule keeps its own id: `steer-disabled` is not in the closed set.
			expect(decision.rule).toBe(signal);
			expect(CHECKPOINT_RULE_IDS).toContain(decision.rule);
			expect(decision.attention).toBe("steer disabled");
		}
		// steer-ignored cannot apply when nothing was steered.
		const ignored = withSignal("no-progress", {
			steeredSignals: ["no-progress"],
		});
		expect(decideCheckpoint(ignored, { steer: false }).rule).toBe(
			"no-progress",
		);
		// The context rule still compacts with steering off.
		expect(
			decideCheckpoint(
				baseDigest({ contextTokens: DEFAULT_CHECKPOINT_CONTEXT_TOKENS }),
				{ steer: false },
			).action,
		).toBe("compact");
	});

	test("a blocked compaction never shadows a signal", () => {
		// The context rule compacts only when the ceiling admits it; otherwise the
		// signal rules still decide, with the blocked context as attention.
		const digest = withSignal("repeats", {
			contextTokens: DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
			compactionAdmissible: false,
		});
		const decision = decideCheckpoint(digest);
		expect(decision.action).toBe("steer");
		expect(decision.rule).toBe("repeats");
		expect(decision.attention).toBe(
			"context above limit, compaction not admissible",
		);
		// Nothing else wrong: a continue that still states why it did not compact.
		expect(
			decideCheckpoint(
				baseDigest({
					contextTokens: DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
					compactionAdmissible: false,
				}),
			),
		).toEqual({
			action: "continue",
			rule: "default",
			attention: "context above limit, compaction not admissible",
		});
	});

	test("the shipped thresholds are the recorded distribution's, rounded up", () => {
		for (const row of Object.values(DEFAULT_CHECKPOINT_THRESHOLDS)) {
			expect(row.softTurns % 10).toBe(0);
			expect(row.hardTurns % 50).toBe(0);
			expect(row.hardTurns).toBeGreaterThanOrEqual(5 * row.softTurns);
		}
		// The D3 formula on the recorded mechanical distribution (p99 114):
		// max(5 x 30, 1.2 x 114, 1.2 x 114) = 150, rounded up to 50.
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.mechanical).toEqual({
			softTurns: 30,
			hardTurns: 150,
		});
	});

	test("every rule id is in the closed set", () => {
		const decision = decideCheckpoint(baseDigest());
		expect(CHECKPOINT_RULE_IDS).toContain(decision.rule);
		// The approved first-release set, exactly: no rule the design never named.
		expect([...CHECKPOINT_RULE_IDS]).toEqual([
			"hard-limit",
			"no-progress-twice",
			"steer-ignored",
			"context",
			"failing-tool",
			"repeats",
			"no-progress",
			"cost-rising",
			"default",
		]);
		expect(Object.keys(CHECKPOINT_ACTION_SUMMARY).sort()).toEqual(
			[...CHECKPOINT_ACTIONS].sort(),
		);
	});

	test("a turn count alone never produces anything but a decision", () => {
		// The requirement, stated as a property: for every turn count of a worker
		// run the module returns one of the five actions, and the only one that can
		// lead to a stop is `escalate`. It never returns a "stop", and nothing it
		// returns carries a stop instruction of its own.
		for (let turns = 0; turns <= 3000; turns += 50) {
			const digest = baseDigest({ turns, turnsSinceProgress: 1 });
			const decision = decideCheckpoint(digest);
			expect(CHECKPOINT_ACTIONS).toContain(decision.action);
			expect(decision.action).toBe(
				turns >= digest.hardTurns ? "escalate" : "continue",
			);
			// An escalation is a question for the developer, not a stop.
			expect(decision.rule).not.toMatch(/stop|abort|block/);
		}
	});
});

describe("the closed steer catalog", () => {
	const digest = baseDigest({
		turnsSinceProgress: 45,
		failingTool: "bash",
		failingToolStreak: 7,
		repeatCalls: 15,
		windowCalls: 20,
	});

	test("every message is fixed but for digest numbers and one tool name", () => {
		expect(checkpointSteerMessage("failing-tool", digest)).toContain(
			"the last 7 calls of `bash` failed",
		);
		expect(checkpointSteerMessage("repeats", digest)).toContain("75 %");
		expect(checkpointSteerMessage("no-progress", digest)).toContain(
			"last 45 turns",
		);
		expect(checkpointSteerMessage("cost-rising", digest)).toContain(
			"cost per turn is rising",
		);
		// A read-only run's no-progress nudge asks it to conclude.
		const readOnly = { ...digest, readOnly: true };
		expect(checkpointSteerKind("no-progress", true)).toBe("conclude");
		expect(checkpointSteerMessage("no-progress", readOnly)).toContain(
			"Conclude from what you have read",
		);
	});

	test("an unregistered tool name renders as a tool, never as itself", () => {
		const named = { ...digest, failingTool: "../../etc/passwd" };
		expect(checkpointSteerMessage("failing-tool", named)).toContain("a tool");
		expect(checkpointSteerMessage("failing-tool", named)).not.toContain(
			"etc/passwd",
		);
	});

	test("the catalog is versioned and each signal maps to one message", () => {
		expect(CHECKPOINT_STEER_CATALOG_VERSION).toBeGreaterThan(0);
		const kinds = new Set(
			CHECKPOINT_ACTIONS.length > 0
				? (
						["failing-tool", "repeats", "no-progress", "cost-rising"] as const
					).map((signal) => checkpointSteerKind(signal, false))
				: [],
		);
		expect([...kinds].sort()).toEqual([
			"converge",
			"failing-tool",
			"make-the-change",
			"stop-rereading",
		]);
	});
});

describe("the escalation is a developer question", () => {
	test("the summary names the class, the step, the role, the thresholds, the cost and the rule", () => {
		const digest = withSignal("failing-tool", { turns: 1400, trigger: "hard" });
		const question = checkpointQuestion(digest, {
			rule: "hard-limit",
			step: "implement-the-change",
			role: "worker",
		});
		expect(question.description).toContain("worker");
		expect(question.description).toContain("implement-the-change");
		expect(question.description).toContain("1400 turns");
		// The firing rule, not the trigger's label: `hard` is why it was taken.
		expect(question.description).toContain("rule hard-limit");
		expect(question.description).not.toContain("rule hard)");
		expect(question.context).toContain("role worker");
		expect(question.context).toContain("soft 280 and hard 1400");
		expect(question.context).toContain("failing-tool");
		expect(question.context).toContain("rule hard-limit");
		expect(question.context).toContain(
			"Cancelling this question stops the run",
		);
	});

	test("an answered escalation carries the developer's words as quoted input", () => {
		const fixed = checkpointAnswerMessage();
		expect(fixed).toContain("let this run continue");
		const answered = checkpointAnswerMessage("  focus on the failing test  ");
		expect(answered.startsWith(fixed)).toBe(true);
		expect(answered).toContain("<<<\nfocus on the failing test\n>>>");
		// Developer-provided, so it is marked as content and never as a system
		// instruction — and it is bounded.
		expect(answered).toContain("not a system instruction");
		const long = checkpointAnswerMessage("x".repeat(5000));
		expect(long).toContain("x".repeat(2000));
		expect(long).not.toContain("x".repeat(2001));
		// Blank direction adds nothing at all.
		expect(checkpointAnswerMessage("   ")).toBe(fixed);
		expect(checkpointAnswerMessage(undefined)).toBe(fixed);
	});

	test("the record cap is smaller than the shared decision history", () => {
		expect(CHECKPOINT_RECORD_LIMIT).toBeGreaterThan(0);
		expect(CHECKPOINT_RECORD_LIMIT).toBeLessThan(100);
	});
});

describe("the content-free digest", () => {
	test("tool arguments, paths and error text never reach the digest", () => {
		const checkpoint = new ProgressCheckpoint({ checkpointClass: "worker" });
		const secretHash = "9f8e7d6c5b4a";
		checkpoint.observeTurn({
			turn: 1,
			costUnits: 0.1,
			contextTokens: 1000,
		});
		checkpoint.observeTool({ tool: "read", ok: true, argsHash: secretHash });
		for (let index = 0; index < 6; index += 1)
			checkpoint.observeTool({
				tool: "bash",
				ok: false,
				argsHash: `hash-${index}`,
			});
		const input = checkpointDigestInput(checkpoint.takeDigest("soft"));
		expect(input).not.toContain(secretHash);
		expect(input).not.toContain("hash-0");
		expect(input).not.toContain("/");
		expect(input).not.toContain("sk-");
		// The only words are the closed vocabulary, the class and the tool name.
		expect(input).toContain('"failingTool":"bash"');
		expect(input).toContain('"failingToolStreak":6');
	});

	test("an unregistered tool name is replaced by `a tool`", () => {
		const checkpoint = new ProgressCheckpoint({ checkpointClass: "worker" });
		checkpoint.observeTool({ tool: "read", ok: true });
		checkpoint.observeTool({ tool: "../../etc/passwd", ok: false });
		const digest = checkpoint.takeDigest("stall");
		expect(digest.failingTool).toBe("a tool");
		expect(checkpointDigestInput(digest)).not.toContain("passwd");
	});

	test("the escalation text carries no digest-external content", () => {
		const digest = withSignal("repeats");
		const question = checkpointQuestion(digest, {
			rule: "repeats",
			step: "implement-the-change",
			role: "worker",
		});
		const text = `${question.description}\n${question.context}`;
		expect(text).not.toContain("/");
		expect(text).not.toContain("hash");
	});
});

describe("the accumulator", () => {
	function worker(overrides: {
		softTurns?: number;
		hardTurns?: number;
		contextTokens?: number;
		readOnly?: boolean;
		failingToolEligible?: boolean;
	}): ProgressCheckpoint {
		return new ProgressCheckpoint({
			checkpointClass: "worker",
			thresholds: {
				softTurns: overrides.softTurns ?? 10,
				hardTurns: overrides.hardTurns ?? 50,
			},
			contextTokens: overrides.contextTokens ?? 100_000,
			readOnly: overrides.readOnly,
			failingToolEligible: overrides.failingToolEligible,
		});
	}

	function observe(
		checkpoint: ProgressCheckpoint,
		turns: number,
		contextTokens = 1000,
	): void {
		for (let turn = 1; turn <= turns; turn += 1)
			checkpoint.observeTurn({ turn, costUnits: 0.01, contextTokens });
	}

	test("the first checkpoint fires at the soft threshold, then every interval", () => {
		const checkpoint = worker({ softTurns: 10, hardTurns: 50 });
		observe(checkpoint, 9);
		expect(checkpoint.due()).toBeUndefined();
		observe(checkpoint, 10);
		expect(checkpoint.due()).toBe("soft");
		const digest = checkpoint.takeDigest("soft");
		expect(digest.ordinal).toBe(1);
		expect(digest.turns).toBe(10);
		checkpoint.noteDecision(decideCheckpoint(digest), digest);
		// The interval is max(10, soft / 2); the next checkpoint is due after it.
		observe(checkpoint, 19);
		expect(checkpoint.due()).toBeUndefined();
		observe(checkpoint, 20);
		expect(checkpoint.due()).toBe("interval");
	});

	test("the hard limit is due even when a scheduled checkpoint is not", () => {
		const checkpoint = worker({ softTurns: 10, hardTurns: 50 });
		observe(checkpoint, 10);
		checkpoint.takeDigest("soft");
		observe(checkpoint, 50);
		expect(checkpoint.due()).toBe("hard");
	});

	test("a context above the limit fires between scheduled checkpoints", () => {
		const checkpoint = worker({ softTurns: 280, contextTokens: 5000 });
		observe(checkpoint, 29, 1000);
		expect(checkpoint.due()).toBeUndefined();
		observe(checkpoint, 30, 5000);
		expect(checkpoint.due()).toBe("context");
	});

	test("a stall signal fires from turn 30 and at most once per interval", () => {
		const checkpoint = worker({ softTurns: 280 });
		observe(checkpoint, 30);
		expect(checkpoint.due()).toBeUndefined();
		observe(checkpoint, 40);
		// 40 turns without one progress event is the no-progress signal.
		expect(checkpoint.due()).toBe("stall");
		const digest = checkpoint.takeDigest("stall");
		checkpoint.noteDecision(decideCheckpoint(digest), digest);
		observe(checkpoint, 50);
		expect(checkpoint.due()).toBeUndefined();
	});

	test("a successful edit resets the no-progress clock, a read does not", () => {
		const checkpoint = worker({ softTurns: 280, hardTurns: 1000 });
		for (let turn = 1; turn <= 60; turn += 1) {
			checkpoint.observeTurn({ turn, costUnits: 0.01, contextTokens: 1000 });
			checkpoint.observeTool({ tool: "read", ok: true, argsHash: `r${turn}` });
		}
		expect(checkpoint.due()).toBe("stall");
		checkpoint.observeTurn({ turn: 61, costUnits: 0.01, contextTokens: 1000 });
		checkpoint.observeTool({ tool: "edit", ok: true, argsHash: "e1" });
		expect(checkpoint.digestPreview().turnsSinceProgress).toBe(0);
		// A mutation counts even when the call carries no argument hash.
		const anonymous = worker({ softTurns: 280, hardTurns: 1000 });
		observe(anonymous, 61);
		anonymous.observeTool({ tool: "write", ok: true });
		expect(anonymous.digestPreview().turnsSinceProgress).toBe(0);
	});

	test("a changed diff, a new commit and a ticked task are progress; the first sample is not", () => {
		const checkpoint = worker({ softTurns: 280 });
		observe(checkpoint, 50);
		checkpoint.noteSample({
			diff: { files: 1, insertions: 2, deletions: 0 },
			head: "aaa",
			tickedTasks: 1,
		});
		expect(checkpoint.digestPreview().window.progress).toBe(0);
		checkpoint.noteSample({
			diff: { files: 1, insertions: 2, deletions: 0 },
			head: "aaa",
			tickedTasks: 1,
		});
		expect(checkpoint.digestPreview().window.progress).toBe(0);
		checkpoint.noteSample({
			diff: { files: 1, insertions: 5, deletions: 0 },
			head: "aaa",
			tickedTasks: 1,
		});
		expect(checkpoint.digestPreview().window.progress).toBe(1);
		checkpoint.noteSample({ head: "bbb", tickedTasks: 1 });
		expect(checkpoint.digestPreview().window.progress).toBe(2);
		checkpoint.noteSample({ head: "bbb", tickedTasks: 2 });
		expect(checkpoint.digestPreview().window.progress).toBe(3);
		// A failed sample is unknown, never a change.
		checkpoint.noteSample({ diff: null, head: null, tickedTasks: null });
		expect(checkpoint.digestPreview().window.progress).toBe(3);
	});

	test("a read-only run's progress is a call it never made before", () => {
		const checkpoint = worker({ softTurns: 280, readOnly: true });
		observe(checkpoint, 10);
		checkpoint.observeTool({ tool: "read", ok: true, argsHash: "a" });
		checkpoint.observeTool({ tool: "read", ok: true, argsHash: "a" });
		expect(checkpoint.digestPreview().window.progress).toBe(1);
		checkpoint.observeTool({ tool: "read", ok: true, argsHash: "b" });
		expect(checkpoint.digestPreview().window.progress).toBe(2);
		// A call without a hash cannot be shown to be a repeat, so it is progress
		// rather than a stall the data cannot support.
		checkpoint.observeTool({ tool: "read", ok: true });
		expect(checkpoint.digestPreview().window.progress).toBe(3);
	});

	test("the failing-tool streak needs a success and one tool, and is off for exempt roles", () => {
		const checkpoint = worker({ softTurns: 280 });
		for (let index = 0; index < CHECKPOINT_FAILING_TOOL_STREAK; index += 1)
			checkpoint.observeTool({ tool: "bash", ok: false });
		expect(checkpointSignalState(checkpoint.digestPreview())).not.toContain(
			"failing-tool",
		);
		checkpoint.observeTool({ tool: "read", ok: true });
		for (let index = 0; index < CHECKPOINT_FAILING_TOOL_STREAK; index += 1)
			checkpoint.observeTool({ tool: "bash", ok: false });
		expect(checkpointSignalState(checkpoint.digestPreview())).toContain(
			"failing-tool",
		);
		// Another tool between the failures ends the streak.
		checkpoint.observeTool({ tool: "bash", ok: false });
		checkpoint.observeTool({ tool: "read", ok: false });
		checkpoint.observeTool({ tool: "bash", ok: false });
		expect(checkpoint.digestPreview().failingToolStreak).toBe(1);
		const exempt = worker({ softTurns: 280, failingToolEligible: false });
		exempt.observeTool({ tool: "read", ok: true });
		for (let index = 0; index < CHECKPOINT_FAILING_TOOL_STREAK + 2; index += 1)
			exempt.observeTool({ tool: "bash", ok: false });
		expect(checkpointSignalState(exempt.digestPreview())).not.toContain(
			"failing-tool",
		);
	});

	test("a later failed sample reports unknown, not the last numbers", () => {
		const checkpoint = worker({ softTurns: 280 });
		observe(checkpoint, 50);
		checkpoint.noteSample({
			diff: { files: 2, insertions: 3, deletions: 1 },
			head: "aaa",
			tickedTasks: 4,
		});
		expect(checkpoint.digestPreview().diff).toEqual({
			files: 2,
			insertions: 3,
			deletions: 1,
		});
		checkpoint.noteSample({ diff: null, head: null, tickedTasks: null });
		expect(checkpoint.digestPreview().diff).toBeNull();
		expect(checkpoint.digestPreview().tickedTasks).toBeNull();
	});

	test("a decision is remembered for the next digest", () => {
		const checkpoint = worker({ softTurns: 10, hardTurns: 50 });
		observe(checkpoint, 10);
		const digest = checkpoint.takeDigest("soft");
		const decision = decideCheckpoint(digest);
		expect(decision.action).toBe("continue");
		checkpoint.noteDecision(decision, digest);
		expect(checkpoint.digestPreview().previous).toEqual({
			decision: "continue",
			rule: "default",
			progress: 0,
		});
		expect(checkpoint.digestPreview().steeredSignals).toEqual([]);
		// A steer records the signal it answered, which is what escalates when the
		// same signal comes back.
		const steered = worker({ softTurns: 280 });
		observe(steered, 40);
		const stall = steered.takeDigest("stall");
		const steer = decideCheckpoint(stall);
		expect(steer.action).toBe("steer");
		steered.noteDecision(steer, stall);
		expect(steered.digestPreview().steeredSignals).toEqual([
			steer.signal as CheckpointSignal,
		]);
	});

	test("a decision that failed open keeps its decision and drops only the nudge", () => {
		// A steer the harness refused was never delivered: remembering it as
		// delivered would escalate the same signal as `steer-ignored` on a nudge the
		// developer never received.
		const checkpoint = worker({ softTurns: 280 });
		observe(checkpoint, 40);
		const digest = checkpoint.takeDigest("stall");
		const steer = decideCheckpoint(digest);
		expect(steer.action).toBe("steer");
		checkpoint.noteDecision(steer, digest, { applied: false });
		expect(checkpoint.digestPreview().steeredSignals).toEqual([]);
		// The decision itself is what was taken, not what happened to it: a later
		// checkpoint reports the steer it decided and the rule it decided it under,
		// so the recorded history matches the decision the run acted out.
		expect(checkpoint.digestPreview().previous).toEqual({
			decision: "steer",
			rule: steer.rule,
			progress: 0,
		});
		// The counterpart: a delivered steer is remembered, so the signal it
		// answered escalates when it comes back.
		const delivered = worker({ softTurns: 280 });
		observe(delivered, 40);
		const stall = delivered.takeDigest("stall");
		const nudge = decideCheckpoint(stall);
		delivered.noteDecision(nudge, stall, { applied: true });
		expect(delivered.digestPreview().steeredSignals).toEqual([
			nudge.signal as CheckpointSignal,
		]);
		expect(delivered.digestPreview().previous?.decision).toBe("steer");
	});

	test("the repeats share counts calls with an argument hash only", () => {
		const checkpoint = worker({ softTurns: 280 });
		observe(checkpoint, 10);
		for (let index = 0; index < 13; index += 1)
			checkpoint.observeTool({ tool: "read", ok: true, argsHash: "same" });
		for (let index = 0; index < 7; index += 1)
			checkpoint.observeTool({
				tool: "read",
				ok: true,
				argsHash: `new-${index}`,
			});
		// 12 of the 13 identical calls are repeats: 60 % of the 20-call window.
		const digest = checkpoint.digestPreview();
		expect(digest.windowCalls).toBe(20);
		expect(digest.repeatCalls).toBe(12);
		expect(checkpointSignalState(digest)).toContain("repeats");
	});

	test("the cost-rising ratio compares the last interval with the run's first half", () => {
		const checkpoint = worker({ softTurns: 280 });
		for (let turn = 1; turn <= 40; turn += 1)
			checkpoint.observeTurn({
				turn,
				costUnits: 0.01,
				contextTokens: 1000,
			});
		for (let turn = 41; turn <= 60; turn += 1)
			checkpoint.observeTurn({
				turn,
				costUnits: 0.1,
				contextTokens: 1000,
			});
		const digest = checkpoint.digestPreview();
		// The run's first half (30 turns) averages 0.01 and the last interval (all
		// 60 turns) averages (40 × 0.01 + 20 × 0.1) / 60: four times as much.
		expect(digest.costRisingRatio).toBe(4);
		expect(digest.costUnits).toBe(2.4);
	});

	test("answering an escalation re-arms the hard limit and the progress clock", () => {
		const checkpoint = worker({ softTurns: 100, hardTurns: 300 });
		observe(checkpoint, 300);
		const digest = checkpoint.takeDigest("hard");
		expect(decideCheckpoint(digest).rule).toBe("hard-limit");
		checkpoint.noteDecision(decideCheckpoint(digest), digest);
		checkpoint.rearmAfterEscalation();
		expect(checkpoint.digestPreview().hardTurns).toBe(400);
		expect(checkpoint.digestPreview().turnsSinceProgress).toBe(0);
		// The window since the previous checkpoint is what the next digest reports.
		observe(checkpoint, 320);
		expect(checkpoint.due()).toBeUndefined();
	});
});
