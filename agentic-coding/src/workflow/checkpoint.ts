// The `[agents.checkpoint]` configuration section (run-progress checkpoint,
// efficiency backlog item 19): the shape it is written in, the documented
// defaults, the validation the configuration load applies and the resolution
// the durable host reads at every run start.
//
// One pure module owns all four, mirroring `src/workflow/compaction.ts`: the
// host receives the resolved section through a getter and never parses the
// file itself, and the settings write path validates with the same rules. The
// defaults are the measured ones — the class thresholds come from
// `src/agent-host/progress-checkpoint.ts`, which holds the numbers task 1 of the
// change pinned from the dataset by the design's D3 formula — so this module
// never restates a threshold.
import {
	CHECKPOINT_CLASSES,
	type CheckpointClass,
	type CheckpointThresholds,
	DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
	DEFAULT_CHECKPOINT_THRESHOLDS,
} from "../agent-host/progress-checkpoint.ts";

/** The keys of `[agents.checkpoint]`: the three scalars and one table per
 * checkpoint class. An absent key falls back to the documented default. */
export interface CheckpointConfig {
	/** `false` evaluates no checkpoint at all: the whole rollback. */
	enabled?: boolean;
	/** Whether a `steer` decision submits its catalog nudge. With `false` the
	 * steer rules decide `continue` and a steered signal can never escalate. */
	steer?: boolean;
	/** The measured-context threshold: at or above it the checkpoint may decide
	 * `compact`, never stop. */
	contextTokens?: number;
	worker?: Partial<CheckpointThresholds>;
	planner?: Partial<CheckpointThresholds>;
	verifier?: Partial<CheckpointThresholds>;
	mechanical?: Partial<CheckpointThresholds>;
	/** An undeclared class's own row; absent, it uses the worker's. */
	other?: Partial<CheckpointThresholds>;
}

/** The resolved section the host uses: every scalar an absolute value, and a
 * threshold row only for the classes the configuration actually overrode.
 * A class without a row uses the pinned default, so a hand-written table can
 * change one class without restating the others. */
export interface ResolvedCheckpointConfig {
	readonly enabled: boolean;
	readonly steer: boolean;
	readonly contextTokens: number;
	readonly thresholds: Readonly<
		Partial<Record<CheckpointClass, CheckpointThresholds>>
	>;
}

/** The smallest accepted soft threshold. Below this a checkpoint would watch a
 * run that has barely started, and the configuration load refuses it. */
export const CHECKPOINT_MIN_SOFT_TURNS = 10;

/** The invariant the hard limit has to keep: it is only useful as a backstop
 * above the soft threshold, so it is at least twice the soft value. */
export const CHECKPOINT_HARD_TURNS_RATIO = 2;

/** One validation problem of the section, named by the key that carries it. */
export interface CheckpointFieldError {
	readonly field: string;
	readonly message: string;
}

/** The documented defaults, exactly as shipped: on, steering on, and the pinned
 * context threshold with no class overridden. */
export const DEFAULT_CHECKPOINT_CONFIG: ResolvedCheckpointConfig = {
	enabled: true,
	steer: true,
	contextTokens: DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
	thresholds: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** One class table's problems: both values are whole turn counts, the soft one
 * is at least {@link CHECKPOINT_MIN_SOFT_TURNS}, and the hard one is at least
 * {@link CHECKPOINT_HARD_TURNS_RATIO} × the soft one. A table that sets only one
 * of them is checked against the other's resolved value, because that is what
 * the run will actually use. */
export function validateCheckpointThresholds(
	value: unknown,
	field: string,
	fallback: CheckpointThresholds,
): CheckpointFieldError[] {
	if (!isRecord(value)) return [{ field, message: `${field} must be a table` }];
	const errors: CheckpointFieldError[] = [];
	const soft = value.softTurns ?? fallback.softTurns;
	const hard = value.hardTurns ?? fallback.hardTurns;
	if (value.softTurns !== undefined && !isCount(value.softTurns))
		errors.push({
			field: `${field}.softTurns`,
			message: `${field}.softTurns must be a whole number of turns`,
		});
	else if (isCount(soft) && soft < CHECKPOINT_MIN_SOFT_TURNS)
		errors.push({
			field: `${field}.softTurns`,
			message: `${field}.softTurns must be at least ${CHECKPOINT_MIN_SOFT_TURNS}`,
		});
	if (value.hardTurns !== undefined && !isCount(value.hardTurns))
		errors.push({
			field: `${field}.hardTurns`,
			message: `${field}.hardTurns must be a whole number of turns`,
		});
	if (
		isCount(soft) &&
		isCount(hard) &&
		hard < CHECKPOINT_HARD_TURNS_RATIO * soft
	)
		errors.push({
			field: `${field}.hardTurns`,
			message: `${field}.hardTurns must be at least ${CHECKPOINT_HARD_TURNS_RATIO} × ${field}.softTurns (${soft})`,
		});
	return errors;
}

/** The problems of a whole section, in a stable order. An empty list is a
 * usable section. The hard-limit check uses the *resolved* soft value, so a
 * table that sets only `hardTurns` is measured against the default soft value
 * of its class rather than against nothing. */
export function validateCheckpointConfig(
	value: unknown,
): CheckpointFieldError[] {
	if (!isRecord(value))
		return [
			{ field: "checkpoint", message: "agents.checkpoint must be a table" },
		];
	const errors: CheckpointFieldError[] = [];
	if (value.enabled !== undefined && typeof value.enabled !== "boolean")
		errors.push({
			field: "enabled",
			message: "enabled must be true or false",
		});
	if (value.steer !== undefined && typeof value.steer !== "boolean")
		errors.push({ field: "steer", message: "steer must be true or false" });
	if (
		value.contextTokens !== undefined &&
		!(isCount(value.contextTokens) && value.contextTokens > 0)
	)
		errors.push({
			field: "contextTokens",
			message: "contextTokens must be a positive whole number of tokens",
		});
	for (const checkpointClass of CHECKPOINT_CLASSES) {
		const raw = value[checkpointClass];
		if (raw === undefined) continue;
		errors.push(
			...validateCheckpointThresholds(
				raw,
				`agents.checkpoint.${checkpointClass}`,
				defaultThresholdsOf(checkpointClass),
			),
		);
	}
	return errors;
}

/** The number a class's row starts from: the worker row for an undeclared
 * class, which is what the host uses for `other`. */
function defaultThresholdsOf(
	checkpointClass: CheckpointClass,
): CheckpointThresholds {
	return checkpointClass === "other"
		? DEFAULT_CHECKPOINT_THRESHOLDS.worker
		: DEFAULT_CHECKPOINT_THRESHOLDS[checkpointClass];
}

/** Whether a section sets anything, so a caller can name its source. */
export function checkpointConfigIsEmpty(section: CheckpointConfig): boolean {
	return (
		section.enabled === undefined &&
		section.steer === undefined &&
		section.contextTokens === undefined &&
		CHECKPOINT_CLASSES.every(
			(checkpointClass) => section[checkpointClass] === undefined,
		)
	);
}

/** Resolve one written section into the host's form. Never throws: a value of
 * an unexpected type, or a table that breaks the hard-vs-soft invariant, falls
 * back to the documented default for that key — the strict load already refused
 * the file, and the host's live reader must not fail a running conversation
 * because a hot edit was mistyped. */
export function resolveCheckpointConfig(
	value: unknown,
): ResolvedCheckpointConfig {
	if (!isRecord(value)) return DEFAULT_CHECKPOINT_CONFIG;
	const thresholds: Partial<Record<CheckpointClass, CheckpointThresholds>> = {};
	for (const checkpointClass of CHECKPOINT_CLASSES) {
		const raw = value[checkpointClass];
		if (!isRecord(raw)) continue;
		const fallback = defaultThresholdsOf(checkpointClass);
		const soft =
			isCount(raw.softTurns) && raw.softTurns >= CHECKPOINT_MIN_SOFT_TURNS
				? raw.softTurns
				: fallback.softTurns;
		const hard =
			isCount(raw.hardTurns) &&
			raw.hardTurns >= CHECKPOINT_HARD_TURNS_RATIO * soft
				? raw.hardTurns
				: Math.max(fallback.hardTurns, CHECKPOINT_HARD_TURNS_RATIO * soft);
		thresholds[checkpointClass] = { softTurns: soft, hardTurns: hard };
	}
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : true,
		steer: typeof value.steer === "boolean" ? value.steer : true,
		contextTokens:
			isCount(value.contextTokens) && value.contextTokens > 0
				? value.contextTokens
				: DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
		thresholds,
	};
}

/** The thresholds one class runs with under a resolved section: its own row, or
 * the worker row for a class the configuration left alone (and for `other`,
 * which is the class of every undeclared step). */
export function checkpointThresholdsForClass(
	config: ResolvedCheckpointConfig,
	checkpointClass: CheckpointClass,
): CheckpointThresholds {
	const own = config.thresholds[checkpointClass];
	if (own) return own;
	return checkpointClass === "other"
		? (config.thresholds.worker ?? DEFAULT_CHECKPOINT_THRESHOLDS.worker)
		: DEFAULT_CHECKPOINT_THRESHOLDS[checkpointClass];
}
