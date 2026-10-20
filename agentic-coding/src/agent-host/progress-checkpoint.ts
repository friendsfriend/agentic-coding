// The run-progress checkpoint (efficiency backlog item 19): a per-run
// supervisor that reads only the host's own turn and tool telemetry, and
// decides what — if anything — should happen to a long or stalled run.
//
// Two rules shape every line below:
//
// 1. A turn count never stops or blocks a run. The module produces a
//    *decision*; the host applies it. `escalate` is the only decision that can
//    lead to a stop, and only through a recorded developer question.
// 2. The decider is a pure function of a content-free digest. No file content,
//    path, tool argument, tool result, error text or message text is retained,
//    so the same digest always yields the same decision and a later classifier
//    can be compared against the rules on recorded data.
//
// The digest's vocabulary is closed: numbers, booleans, registered tool names,
// the five classes, the five actions, the four stall signals and the rule ids.

/** The checkpoint classes. `other` is every undeclared step, and it uses the
 * worker values (an undeclared run is usually a worker). */
export const CHECKPOINT_CLASSES = [
	"worker",
	"planner",
	"verifier",
	"mechanical",
	"other",
] as const;
export type CheckpointClass = (typeof CHECKPOINT_CLASSES)[number];

export interface CheckpointThresholds {
	/** The turn count that starts evaluation. It never stops anything. */
	softTurns: number;
	/** The turn count that decides `escalate` — still only a decision. */
	hardTurns: number;
}

/** The shipped per-class defaults, pinned by the D3 formula from the measured
 * distribution (`docs/efficiency/04b-run-progress-checkpoint.md`):
 * `softTurns` is the class p90 rounded up to 10, `hardTurns` is
 * `max(5 × soft, 1.2 × successful p99, 1.2 × all-runs p99)` rounded up to 50.
 * The efficiency queries carry the same table, and a test keeps them equal. */
export const DEFAULT_CHECKPOINT_THRESHOLDS: Readonly<
	Record<CheckpointClass, CheckpointThresholds>
> = {
	worker: { softTurns: 280, hardTurns: 1400 },
	planner: { softTurns: 60, hardTurns: 300 },
	verifier: { softTurns: 70, hardTurns: 350 },
	mechanical: { softTurns: 30, hardTurns: 250 },
	other: { softTurns: 280, hardTurns: 1400 },
};

/** Above the shipped 150,000-token compaction ceiling: the checkpoint's context
 * trigger only fires when ceiling compaction did not hold the context. */
export const DEFAULT_CHECKPOINT_CONTEXT_TOKENS = 200_000;

/** The decider's id, recorded on every decision. */
export const CHECKPOINT_DECIDER = "rules/v1";

/** The classifier-decision integration every checkpoint records under. */
export const CHECKPOINT_INTEGRATION = "progress-checkpoint";

/** The fixed decision vocabulary, in the order the question offers it. */
export const CHECKPOINT_ACTIONS = [
	"continue",
	"steer",
	"compact",
	"switch-model",
	"escalate",
] as const;
export type CheckpointAction = (typeof CHECKPOINT_ACTIONS)[number];

/** One line per action, used for the question options and the decision
 * record's `criteria`. Closed: no decider may add a label. */
export const CHECKPOINT_ACTION_SUMMARY: Readonly<
	Record<CheckpointAction, string>
> = {
	continue: "Keep the run going as it is.",
	steer: "Send one fixed nudge from the catalog at the next turn boundary.",
	compact: "Compact the conversation through the cost ceiling's admission.",
	"switch-model":
		"Move the run to another model (vocabulary only in this release).",
	escalate: "Ask the developer through a normal developer question.",
};

/** The stall signals a checkpoint can measure. `context` is a trigger, not a
 * signal: it is never answered with a nudge. */
export const CHECKPOINT_SIGNALS = [
	"failing-tool",
	"repeats",
	"no-progress",
	"cost-rising",
] as const;
export type CheckpointSignal = (typeof CHECKPOINT_SIGNALS)[number];

/** Why a checkpoint fired. Closed vocabulary, recorded in the digest. */
export const CHECKPOINT_TRIGGERS = [
	"soft",
	"interval",
	"hard",
	"context",
	"stall",
] as const;
export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

/** The rule ids of `rules/v1`, in evaluation order. `steer-disabled` is the
 * rule a steer signal resolves to when the operator turned steering off. */
export const CHECKPOINT_RULE_IDS = [
	"hard-limit",
	"no-progress-twice",
	"steer-ignored",
	"context",
	"failing-tool",
	"repeats",
	"no-progress",
	"cost-rising",
	"steer-disabled",
	"default",
] as const;
export type CheckpointRuleId = (typeof CHECKPOINT_RULE_IDS)[number];

/** How many checkpoints of one run are recorded in the workflow's decision
 * history. The history is shared with every other integration (100 records), so
 * a run's own cap is smaller; later checkpoints stay telemetry-only. */
export const CHECKPOINT_RECORD_LIMIT = 12;

/** From this turn on a stall signal may fire a checkpoint between the scheduled
 * ones, so an early run is never interrupted by its own warm-up. */
export const CHECKPOINT_FIRST_STALL_TURN = 30;

/** The exact-repeat window: the share is measured over the last 20 calls. */
export const CHECKPOINT_REPEAT_WINDOW = 20;
/** Below this many calls-with-hash in the window the share is not measured: a
 * two-call run repeating itself is not a stall. */
export const CHECKPOINT_REPEAT_MIN_CALLS = 10;
/** The share of repeated calls that counts as the repeats signal. */
export const CHECKPOINT_REPEAT_SHARE = 0.6;

/** Consecutive failed calls of one tool that count as the failing-tool signal. */
export const CHECKPOINT_FAILING_TOOL_STREAK = 5;

/** Turns without a progress event that count as the no-progress signal. */
export const CHECKPOINT_NO_PROGRESS_TURNS = 40;

/** Cost-per-turn growth over the run's first half that counts as cost-rising. */
export const CHECKPOINT_COST_RISING_RATIO = 1.5;

/** The tools whose successful call is a progress event. */
export const CHECKPOINT_MUTATING_TOOLS: readonly string[] = ["edit", "write"];

/** A tool name is only admitted to the digest when it looks like a registered
 * tool name; anything else renders as "a tool". The host narrows this further
 * with the run's own tool surface. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,39}$/;

/** The class a step declares, or `other` for anything undeclared or unknown. */
export function checkpointClassOf(declared?: string): CheckpointClass {
	return (CHECKPOINT_CLASSES as readonly string[]).includes(declared ?? "")
		? (declared as CheckpointClass)
		: "other";
}

/** The roles the queries count as mechanical work. */
export const MECHANICAL_ROLES: readonly string[] = [
	"triage",
	"archive",
	"wiki",
	"git",
];

/** The class of a historical *role* name: the analysis fallback for recorded
 * runs that predate the step-declared class. A live run's class always comes
 * from `HERDR_CHECKPOINT_CLASS` (the step's registration), so this table is only
 * used offline — by the replay and by the efficiency queries' SQL, which this
 * function mirrors. */
export function checkpointClassOfRole(role?: string | null): CheckpointClass {
	if (role === null || role === undefined || role.length === 0) return "other";
	if (role === "worker") return "worker";
	if (role.startsWith("planner") || role === "consolidator") return "planner";
	if (role.endsWith("-verifier")) return "verifier";
	if (MECHANICAL_ROLES.includes(role)) return "mechanical";
	return "other";
}

/** The threshold row for a class, with `other` using the worker values. */
export function checkpointThresholdsFor(
	checkpointClass: CheckpointClass,
	overrides?: Partial<Record<CheckpointClass, Partial<CheckpointThresholds>>>,
): CheckpointThresholds {
	const base =
		checkpointClass === "other"
			? DEFAULT_CHECKPOINT_THRESHOLDS.worker
			: DEFAULT_CHECKPOINT_THRESHOLDS[checkpointClass];
	const override = overrides?.[checkpointClass];
	return {
		softTurns: override?.softTurns ?? base.softTurns,
		hardTurns: override?.hardTurns ?? base.hardTurns,
	};
}

/** The interval between scheduled checkpoints once the first one fired. */
export function checkpointInterval(softTurns: number): number {
	return Math.max(10, Math.floor(softTurns / 2));
}

/** The digest: everything the decider may read, and nothing else. */
export interface CheckpointDigest {
	/** 1 for the run's first checkpoint. */
	ordinal: number;
	trigger: CheckpointTrigger;
	checkpointClass: CheckpointClass;
	/** A read-only run cannot change files: its nudges and its progress differ. */
	readOnly: boolean;
	turns: number;
	/** Cumulative cost in the provider's unit, rounded to four decimals. */
	costUnits: number;
	/** The last measured prompt size. */
	contextTokens: number;
	peakContextTokens: number;
	softTurns: number;
	hardTurns: number;
	contextLimit: number;
	/** Whether the cost ceiling's floor and loop guard admit a compaction now. */
	compactionAdmissible: boolean;
	/** Calls that succeeded at least once in this run. The failing-tool signal
	 * needs one: a run that never succeeded belongs to the fail-fast monitor. */
	successfulCalls: number;
	/** Whether the run's role may report the failing-tool signal at all. */
	failingToolEligible: boolean;
	/** The registered tool name of the failing streak, or the literal
	 * `a tool` when the name is not one — an unregistered name never enters the
	 * digest. `null` means no failing streak. */
	failingTool: string | null;
	failingToolStreak: number;
	repeatCalls: number;
	windowCalls: number;
	turnsSinceProgress: number;
	/** Mean cost per turn of the last interval over the run's first half; 0 when
	 * the first half has no cost to compare against. */
	costRisingRatio: number;
	/** Turns and progress events since the previous checkpoint. */
	window: { turns: number; progress: number };
	/** The sampled worktree diff, or null when the sample failed. */
	diff: { files: number; insertions: number; deletions: number } | null;
	/** The sampled ticked-task count, or null when the sample failed. */
	tickedTasks: number | null;
	previous: {
		decision: CheckpointAction;
		rule: CheckpointRuleId;
		progress: number;
	} | null;
	/** Signals already answered with a steer in this run. */
	steeredSignals: CheckpointSignal[];
}

export interface CheckpointDecision {
	action: CheckpointAction;
	rule: CheckpointRuleId;
	signal?: CheckpointSignal;
	/** Why a decision differs from what its rule alone implies (a disabled
	 * steer, a compaction that is not admissible). */
	attention?: string;
}

/** The signals present in a digest, in the rule set's evaluation order. */
export function checkpointSignalState(
	digest: CheckpointDigest,
): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	if (
		digest.failingToolEligible &&
		digest.successfulCalls > 0 &&
		digest.failingTool !== null &&
		digest.failingToolStreak >= CHECKPOINT_FAILING_TOOL_STREAK
	)
		signals.push("failing-tool");
	if (
		digest.windowCalls >= CHECKPOINT_REPEAT_MIN_CALLS &&
		digest.repeatCalls / digest.windowCalls >= CHECKPOINT_REPEAT_SHARE
	)
		signals.push("repeats");
	if (digest.turnsSinceProgress >= CHECKPOINT_NO_PROGRESS_TURNS)
		signals.push("no-progress");
	if (
		digest.window.turns > 0 &&
		digest.window.progress === 0 &&
		digest.costRisingRatio >= CHECKPOINT_COST_RISING_RATIO
	)
		signals.push("cost-rising");
	return signals;
}

/** `rules/v1`: an ordered rule set over the digest, first match wins. Pure: the
 * same digest and options always give the same decision. */
export function decideCheckpoint(
	digest: CheckpointDigest,
	options: { steer: boolean } = { steer: true },
): CheckpointDecision {
	// 1. The hard limit only decides an escalation; whether the run stops is the
	// developer's answer to that question, never this function's.
	if (digest.turns >= digest.hardTurns)
		return { action: "escalate", rule: "hard-limit" };
	// 2. Two consecutive windows without one progress event, after a `continue`,
	// is a stall no nudge has answered.
	if (
		digest.previous?.decision === "continue" &&
		digest.previous.progress === 0 &&
		digest.window.progress === 0
	)
		return { action: "escalate", rule: "no-progress-twice" };
	const signals = checkpointSignalState(digest);
	// 3. A signal the run already received a nudge for, still present, is a stall
	// the catalog cannot fix.
	if (options.steer)
		for (const signal of signals)
			if (digest.steeredSignals.includes(signal))
				return { action: "escalate", rule: "steer-ignored", signal };
	// 4. Context over the threshold compacts — but only when the ceiling admits
	// it. Context alone never escalates: it falls through to the signals below.
	if (digest.contextTokens >= digest.contextLimit)
		return digest.compactionAdmissible
			? { action: "compact", rule: "context" }
			: {
					action: "continue",
					rule: "default",
					attention: "context above limit, compaction not admissible",
				};
	// 5–8. One fixed nudge per signal, or a plain continue when steering is off.
	const signal = signals[0];
	if (signal !== undefined) {
		if (!options.steer)
			return {
				action: "continue",
				rule: "steer-disabled",
				signal,
				attention: "steer disabled",
			};
		return { action: "steer", rule: signal, signal };
	}
	// 9. Nothing is wrong.
	return { action: "continue", rule: "default" };
}

/** The closed steer catalog's message ids. */
export type CheckpointSteerKind =
	| "failing-tool"
	| "stop-rereading"
	| "make-the-change"
	| "conclude"
	| "converge";

export const CHECKPOINT_STEER_CATALOG_VERSION = 1;

/** Which catalog message a signal renders. A read-only run cannot make a file
 * change, so its no-progress nudge asks it to conclude instead. */
export function checkpointSteerKind(
	signal: CheckpointSignal,
	readOnly: boolean,
): CheckpointSteerKind {
	if (signal === "failing-tool") return "failing-tool";
	if (signal === "repeats") return "stop-rereading";
	if (signal === "no-progress")
		return readOnly ? "conclude" : "make-the-change";
	return "converge";
}

/** One fixed nudge from the closed catalog. The only variable parts are digest
 * numbers and one registered tool name, and nothing is appended to it. */
export function checkpointSteerMessage(
	signal: CheckpointSignal,
	digest: CheckpointDigest,
): string {
	const kind = checkpointSteerKind(signal, digest.readOnly);
	if (kind === "failing-tool") {
		const tool =
			digest.failingTool !== null && TOOL_NAME_PATTERN.test(digest.failingTool)
				? `\`${digest.failingTool}\``
				: "a tool";
		return `Progress checkpoint: the last ${digest.failingToolStreak} calls of ${tool} failed. Stop retrying it unchanged — read the error and change the approach, or hand off blocked naming the error.`;
	}
	if (kind === "stop-rereading") {
		const share =
			digest.windowCalls === 0
				? 0
				: Math.round((100 * digest.repeatCalls) / digest.windowCalls);
		return `Progress checkpoint: ${share} % of your recent calls repeat calls you already made. Stop re-reading and make the next concrete change now (write the code or the tests).`;
	}
	if (kind === "make-the-change")
		return `Progress checkpoint: no file change, commit or ticked task in the last ${digest.turnsSinceProgress} turns. Make the next concrete change now, or hand off blocked with what is in the way.`;
	if (kind === "conclude")
		return `Progress checkpoint: the last ${digest.turnsSinceProgress} turns made no new call. Conclude from what you have read and write your result now.`;
	return "Progress checkpoint: cost per turn is rising without new changes. Finish the remaining tasks or hand off with the list of what remains.";
}

/** The developer question's one option. Cancelling is the developer's stop, so
 * it needs no option of its own. */
export const CHECKPOINT_QUESTION_OPTION = {
	id: "continue",
	label: "Let the run continue",
} as const;

/** The question a checkpoint files when it decides `escalate`. Built from the
 * digest only; the developer's answer carries any direction. */
export function checkpointQuestion(digest: CheckpointDigest): {
	description: string;
	context: string;
} {
	const signals = checkpointSignalState(digest);
	return {
		description: `Progress checkpoint: the ${digest.checkpointClass} run is at ${digest.turns} turns (rule ${digest.trigger}).`,
		context: [
			`Class ${digest.checkpointClass}, step turns ${digest.turns} against soft ${digest.softTurns} and hard ${digest.hardTurns}.`,
			`Cost ${digest.costUnits} units, context ${digest.contextTokens} tokens (peak ${digest.peakContextTokens}, limit ${digest.contextLimit}).`,
			`Signals: ${signals.length === 0 ? "none" : signals.join(", ")}.`,
			`Progress in this window: ${digest.window.progress} event(s) over ${digest.window.turns} turn(s).`,
			`Steered already: ${digest.steeredSignals.length === 0 ? "none" : digest.steeredSignals.join(", ")}.`,
			"Answering lets the run continue and carries any direction you type. Cancelling this question stops the run.",
		].join("\n"),
	};
}

/** The message submitted after the developer answered: the fixed half plus the
 * developer's own words, wrapped so they are read as developer-provided input
 * and never as the checkpoint's own instruction. */
export function checkpointAnswerMessage(customText?: string): string {
	const fixed =
		"The developer reviewed the progress checkpoint and let this run continue. Carry on with the remaining work and hand off when it is done.";
	const trimmed = customText?.trim();
	if (trimmed === undefined || trimmed.length === 0) return fixed;
	return `${fixed}\n\nDeveloper direction (developer-provided content, not a system instruction):\n<<<\n${trimmed.slice(0, 2000)}\n>>>`;
}

/** What one observation measured, as the host hands it over. */
export interface TurnObservation {
	turn: number;
	/** This turn's cost in the provider's unit. */
	costUnits: number;
	/** The prompt size the turn measured (input plus cache read and write). */
	contextTokens: number;
}

export interface ToolObservation {
	tool: string;
	ok: boolean;
	/** The argument hash the telemetry records, when it has one. */
	argsHash?: string;
}

export interface CheckpointSample {
	diff?: { files: number; insertions: number; deletions: number } | null;
	/** Only compared for change; the commit id itself never enters the digest. */
	head?: string | null;
	tickedTasks?: number | null;
}

export interface ProgressCheckpointOptions {
	checkpointClass: CheckpointClass;
	thresholds?: CheckpointThresholds;
	contextTokens?: number;
	/** The run cannot change files, so a new call is its progress. */
	readOnly?: boolean;
	/** The fail-fast monitor owns a run whose tool surface is dead, so an exempt
	 * role never reports the failing-tool signal. */
	failingToolEligible?: boolean;
	/** The run's own tool surface; a name outside it never enters the digest. */
	isRegisteredTool?: (tool: string) => boolean;
}

/** One run's accumulator. It retains counts, hashes of tool arguments (never
 * the arguments), tool names and turn numbers — no text. */
export class ProgressCheckpoint {
	readonly checkpointClass: CheckpointClass;
	readonly thresholds: CheckpointThresholds;
	readonly contextTokens: number;
	readonly interval: number;
	readonly readOnly: boolean;
	readonly failingToolEligible: boolean;
	private readonly isRegisteredTool: (tool: string) => boolean;

	private turn = 0;
	private costUnits = 0;
	private turnCosts: number[] = [];
	private contextTokensSeen = 0;
	private peakContextTokens = 0;
	private successfulCalls = 0;
	private failingTool: string | null = null;
	private failingToolStreak = 0;
	private readonly seenCalls = new Set<string>();
	private recentCalls: Array<{ tool: string; hash: string; repeat: boolean }> =
		[];
	private progressTurn = 0;
	private progressInWindow = 0;
	private lastCheckpointTurn = 0;
	private ordinal = 0;
	private nextTurn: number;
	private hardLimit: number;
	private lastDecision: CheckpointDigest["previous"] = null;
	private readonly steered = new Set<CheckpointSignal>();
	private lastDiff: {
		files: number;
		insertions: number;
		deletions: number;
	} | null = null;
	private lastHead: string | null = null;
	private lastTickedTasks: number | null = null;
	private sampledDiff: CheckpointDigest["diff"] = null;
	private sampledTickedTasks: number | null = null;

	constructor(options: ProgressCheckpointOptions) {
		this.checkpointClass = options.checkpointClass;
		this.thresholds = options.thresholds ?? {
			...checkpointThresholdsFor(options.checkpointClass),
		};
		this.contextTokens =
			options.contextTokens ?? DEFAULT_CHECKPOINT_CONTEXT_TOKENS;
		this.interval = checkpointInterval(this.thresholds.softTurns);
		this.readOnly = options.readOnly ?? false;
		this.failingToolEligible = options.failingToolEligible ?? true;
		this.isRegisteredTool =
			options.isRegisteredTool ?? ((tool) => TOOL_NAME_PATTERN.test(tool));
		this.nextTurn = this.thresholds.softTurns;
		this.hardLimit = this.thresholds.hardTurns;
	}

	/** Turns observed so far. */
	get turns(): number {
		return this.turn;
	}

	/** Cumulative cost units observed so far. */
	get cost(): number {
		return this.costUnits;
	}

	/** How many checkpoints have been evaluated. */
	get checkpoints(): number {
		return this.ordinal;
	}

	private noteProgress(): void {
		this.progressTurn = this.turn;
		this.progressInWindow += 1;
	}

	observeTurn(observation: TurnObservation): void {
		this.turn = Math.max(this.turn, observation.turn);
		const cost = Number.isFinite(observation.costUnits)
			? Math.max(0, observation.costUnits)
			: 0;
		this.costUnits += cost;
		this.turnCosts.push(cost);
		if (Number.isFinite(observation.contextTokens))
			this.contextTokensSeen = Math.max(0, observation.contextTokens);
		this.peakContextTokens = Math.max(
			this.peakContextTokens,
			this.contextTokensSeen,
		);
	}

	observeTool(observation: ToolObservation): void {
		if (observation.ok) this.successfulCalls += 1;
		// The streak is one tool's consecutive failures: another tool, or a
		// success, ends it.
		if (observation.ok) {
			this.failingToolStreak = 0;
			this.failingTool = null;
		} else if (observation.tool === this.failingTool) {
			this.failingToolStreak += 1;
		} else {
			this.failingTool = observation.tool;
			this.failingToolStreak = 1;
		}

		// A successful mutation is progress whether or not the call carried an
		// argument hash: the write happened either way.
		if (observation.ok && CHECKPOINT_MUTATING_TOOLS.includes(observation.tool))
			this.noteProgress();

		const hash = observation.argsHash;
		if (hash === undefined || hash.length === 0) {
			// Without a hash a call cannot be told apart from an earlier one, so a
			// read-only run counts it as new: missing data never manufactures a
			// stall.
			if (this.readOnly) this.noteProgress();
			return;
		}
		const key = `${observation.tool}\u0000${hash}`;
		const repeat = this.seenCalls.has(key);
		this.seenCalls.add(key);
		this.recentCalls.push({ tool: observation.tool, hash, repeat });
		if (this.recentCalls.length > CHECKPOINT_REPEAT_WINDOW)
			this.recentCalls.shift();
		// A read-only run's progress is a call it never made before.
		if (this.readOnly && !repeat) this.noteProgress();
	}

	/** Compare one sample with the previous one; only a change is progress, and
	 * only numbers leave this method. */
	noteSample(sample: CheckpointSample): void {
		if (sample.diff !== undefined && sample.diff !== null) {
			const previous = this.lastDiff;
			this.lastDiff = sample.diff;
			if (
				previous !== null &&
				(previous.files !== sample.diff.files ||
					previous.insertions !== sample.diff.insertions ||
					previous.deletions !== sample.diff.deletions)
			)
				this.noteProgress();
		}
		if (sample.head !== undefined && sample.head !== null) {
			if (this.lastHead !== null && this.lastHead !== sample.head)
				this.noteProgress();
			this.lastHead = sample.head;
		}
		if (sample.tickedTasks !== undefined && sample.tickedTasks !== null) {
			if (
				this.lastTickedTasks !== null &&
				sample.tickedTasks > this.lastTickedTasks
			)
				this.noteProgress();
			this.lastTickedTasks = sample.tickedTasks;
		}
		this.sampledDiff = this.lastDiff;
		this.sampledTickedTasks = this.lastTickedTasks;
	}

	private signalsNow(): CheckpointSignal[] {
		return checkpointSignalState(this.digestPreview());
	}

	/** The digest as it would be taken now, without advancing the schedule. */
	digestPreview(): CheckpointDigest {
		const windowTurns = Math.max(0, this.turn - this.lastCheckpointTurn);
		const windowCosts = this.turnCosts.slice(
			Math.max(0, this.turnCosts.length - Math.max(1, this.interval)),
		);
		const half = Math.floor(this.turnCosts.length / 2);
		const firstHalf = this.turnCosts.slice(0, half);
		const windowMean =
			windowCosts.length === 0
				? 0
				: windowCosts.reduce((total, value) => total + value, 0) /
					windowCosts.length;
		const firstHalfMean =
			firstHalf.length === 0
				? 0
				: firstHalf.reduce((total, value) => total + value, 0) /
					firstHalf.length;
		const repeats = this.recentCalls.filter((call) => call.repeat).length;
		return {
			ordinal: this.ordinal + 1,
			trigger: "soft",
			checkpointClass: this.checkpointClass,
			readOnly: this.readOnly,
			turns: this.turn,
			costUnits: Math.round(this.costUnits * 10_000) / 10_000,
			contextTokens: this.contextTokensSeen,
			peakContextTokens: this.peakContextTokens,
			softTurns: this.thresholds.softTurns,
			hardTurns: this.hardLimit,
			contextLimit: this.contextTokens,
			compactionAdmissible: false,
			successfulCalls: this.successfulCalls,
			failingToolEligible: this.failingToolEligible,
			failingTool:
				this.failingTool !== null && this.isRegisteredTool(this.failingTool)
					? this.failingTool
					: this.failingTool === null
						? null
						: "a tool",
			failingToolStreak: this.failingToolStreak,
			repeatCalls: repeats,
			windowCalls: this.recentCalls.length,
			turnsSinceProgress: Math.max(0, this.turn - this.progressTurn),
			costRisingRatio:
				firstHalfMean > 0 && windowMean > 0
					? Math.round((windowMean / firstHalfMean) * 100) / 100
					: 0,
			window: { turns: windowTurns, progress: this.progressInWindow },
			diff: this.sampledDiff,
			tickedTasks: this.sampledTickedTasks,
			previous: this.lastDecision,
			steeredSignals: [...this.steered],
		};
	}

	/** Why a checkpoint is due at this turn, if one is. `hard` and the scheduled
	 * triggers share one cooldown, so a checkpoint never fires twice in an
	 * interval. */
	due(turn = this.turn): CheckpointTrigger | undefined {
		const cooldownElapsed =
			this.ordinal === 0 || turn - this.lastCheckpointTurn >= this.interval;
		if (!cooldownElapsed) return undefined;
		if (turn >= this.hardLimit) return "hard";
		if (turn >= this.nextTurn) return this.ordinal === 0 ? "soft" : "interval";
		if (turn < CHECKPOINT_FIRST_STALL_TURN) return undefined;
		if (this.contextTokensSeen >= this.contextTokens) return "context";
		return this.signalsNow().length === 0 ? undefined : "stall";
	}

	/** Take the digest for one checkpoint and advance the schedule. The window
	 * (turns and progress since the previous checkpoint) is read here and reset,
	 * so the next checkpoint measures its own window. */
	takeDigest(
		trigger: CheckpointTrigger,
		extra: { compactionAdmissible?: boolean } = {},
	): CheckpointDigest {
		const digest = this.digestPreview();
		this.ordinal += 1;
		this.lastCheckpointTurn = this.turn;
		this.nextTurn = this.turn + this.interval;
		this.progressInWindow = 0;
		return {
			...digest,
			ordinal: this.ordinal,
			trigger,
			compactionAdmissible: extra.compactionAdmissible ?? false,
		};
	}

	/** Record what was decided and applied, so the next digest can see it. */
	noteDecision(decision: CheckpointDecision, digest: CheckpointDigest): void {
		this.lastDecision = {
			decision: decision.action,
			rule: decision.rule,
			progress: digest.window.progress,
		};
		if (decision.action === "steer" && decision.signal !== undefined)
			this.steered.add(decision.signal);
	}

	/** Re-arm after the developer answered an escalation: the hard limit moves
	 * to the current turn plus the class's soft threshold, and the no-progress
	 * counter starts again from here. */
	rearmAfterEscalation(): void {
		this.hardLimit = Math.max(
			this.hardLimit,
			this.turn + this.thresholds.softTurns,
		);
		this.progressTurn = this.turn;
	}
}

/** The bounded input the checkpoint record is written with: the digest exactly,
 * as compact JSON. */
export function checkpointDigestInput(digest: CheckpointDigest): string {
	return JSON.stringify(digest);
}

/** The classifier-decision answer for one decision: the chosen action, one-hot
 * probabilities, and no confidence (a rule set has none). */
export function checkpointAnswer(decision: CheckpointDecision): {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
} {
	const probabilities: Record<string, number> = {};
	for (const action of CHECKPOINT_ACTIONS)
		probabilities[action] = action === decision.action ? 1 : 0;
	return {
		type: "choice",
		choice: decision.action,
		probabilities,
	};
}
