// Durable runs' compaction policy (add-agent-compaction).
//
// One pure module owns the shape, the documented defaults, the accepted value
// forms (an absolute token count or `"N%"` of the model's context window), the
// validation the write path uses and the resolution the durable host uses for
// pi-durable's `CompactionPolicy`. Pure data and pure functions: the file
// readers (`src/agent-host/host-main.ts`, `src/server/config.ts`) pass the
// already-read sections in, so the same rules are reused by the host, by the
// Settings read and by the Settings write with no second implementation.
//
// Why these defaults (see `openspec/changes/add-agent-compaction/proposal.md`):
// `enabled` gates threshold/overflow compaction and never manual compaction, and
// a run that outgrows its window dies without it, so it defaults to on. The
// reserve is what decides *when* automatic compaction starts — the blocking
// threshold is `contextWindow - reserveTokens` — so it cannot be an absolute
// count: every model the presets actually run declares a 1M-token window
// (`opencode-go/deepseek-v4.1-flash` and `gpt-6-luna`, `kimi-coding/k3`, the
// Anthropic long-context models), where pi-durable's package default of 16384
// and our first default of 32000 put the trigger at 96.8% of the window and
// 936k-token backgrounds — a run reaches neither. The documented default is
// therefore window-relative, `max(32000, 30% of the window)`, i.e. a request
// above 70% of the model's window waits for a summary, with the absolute 32000
// as the fallback when no run's window is known (a percentage form with no
// window uses the same fallback). The reserve still bounds the summarizer's own
// output budget (0.8 × reserve), and the summarizer's *input* — the summarized
// range, below 70% of the window — always fits the window it summarizes for.
// `backgroundTokens` leads the blocking threshold by one large turn, which is an
// absolute quantity, so it stays 32000 (0 disables the background path).
// `keepRecentTokens` is the one value whose meaning drifts with the window (16%
// of 128k but 2% of 1M), so it is the value offered as a percentage; its
// absolute default keeps a workable verbatim tail on the 128k–200k windows in
// normal use.
//
// Those three values are all *overflow* guards: they decide when a request
// cannot fit the window any more. That is a safety net, not a cost control — on
// a 1M-token window the blocking threshold sits at 700,000 tokens, which a
// measured worker run (911,257 tokens) barely reached and the orchestrator
// (333,278) never did. The second half of a long run costs 1.87–2.9× the first
// because every turn re-reads the whole context, so the policy carries a second,
// independent mechanism: the **cost ceiling** (`ceilingTokens`, default 150,000).
// It is absolute by construction, because the thing it bounds is money per turn
// and not window occupancy, and it applies only when it sits *below* the
// overflow threshold — on a small window the overflow guard is the tighter of
// the two and a second, lower trigger would only fight it.

/** The token-valued fields of the policy, in Settings display order. */
export const COMPACTION_TOKEN_FIELDS = [
	"reserveTokens",
	"backgroundTokens",
	"keepRecentTokens",
	"ceilingTokens",
] as const;
export type CompactionTokenField = (typeof COMPACTION_TOKEN_FIELDS)[number];

/** The fields a Settings row can edit: the three token values and the switch. */
export type CompactionField = "enabled" | CompactionTokenField;

/** One field's written form: a whole number of tokens, or `"N%"` of the run's
 * context window. */

/** A whole number of tokens, or a percentage of the model's context window. */
export type CompactionTokenValue = number | string;

/** The `[agents.compaction]` section as it is written. Every key is optional;
 * an absent key falls back to the documented default. */
export interface CompactionConfig {
	enabled?: boolean;
	reserveTokens?: CompactionTokenValue;
	backgroundTokens?: CompactionTokenValue;
	keepRecentTokens?: CompactionTokenValue;
	/** The cost ceiling in absolute tokens; `0` disables it. */
	ceilingTokens?: CompactionTokenValue;
}

/** The resolved policy pi-durable receives: every field an absolute count. */
export interface CompactionPolicy {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	backgroundTokens: number;
}

/** Where the effective policy came from, so Settings can name it. */
export type CompactionSource = "agentHost" | "agents" | "default";

/** The documented defaults (proposal "Recommended defaults"). The token values
 * are the *absolute* defaults: what a field resolves to when nothing is
 * configured or when no run's context window is known. `reserveTokens` is
 * additionally window-relative (see {@link COMPACTION_WINDOW_DEFAULT_PERCENT}).
 */
export const COMPACTION_DEFAULTS: CompactionPolicy = {
	enabled: true,
	reserveTokens: 32000,
	keepRecentTokens: 20000,
	backgroundTokens: 32000,
};

/** The share of the model's context window automatic compaction starts at (see
 * `openspec/specs/durable-agent-compaction`). The reserve is the room kept free
 * above that line, so the two add up to 100%. */
export const COMPACTION_DEFAULT_TRIGGER_PERCENT = 70;

/** The reserve's share of the window that puts the trigger at
 * {@link COMPACTION_DEFAULT_TRIGGER_PERCENT}. */
export const COMPACTION_DEFAULT_RESERVE_PERCENT =
	100 - COMPACTION_DEFAULT_TRIGGER_PERCENT;

/** The documented default *form* of each token field, for the fields whose
 * sensible value scales with the window: the field resolves to
 * `max(documented absolute default, this share of the reference window)`. A
 * field without an entry is absolute. Only the reserve is here, because only
 * the reserve moves the trigger point. */
export const COMPACTION_WINDOW_DEFAULT_PERCENT: Readonly<
	Partial<Record<CompactionTokenField, number>>
> = { reserveTokens: COMPACTION_DEFAULT_RESERVE_PERCENT };

/** Smallest accepted absolute value of a kept-verbatim field. Below this a
 * summary would drop so much context that the run cannot continue usefully. */
export const COMPACTION_TOKEN_FLOOR = 4096;

/** Largest accepted value of any field: a bound the numeric editor and the
 * validator share so a typo can never resolve to an absurd policy. */
export const COMPACTION_TOKEN_CEILING = 10_000_000;

/** Accepted percentage range. A percentage above this would leave the policy no
 * room to select a range, and 0% is not a policy at all. */
export const COMPACTION_PERCENT_MIN = 1;
export const COMPACTION_PERCENT_MAX = 90;

/**
 * The documented cost ceiling: once a request has carried this many tokens, the
 * host compacts at the next safe point even though the window is nowhere near
 * full. 150,000 is the line the efficiency analysis measured (213 of the
 * orchestrator's 570 turns sat above it, and capping there was worth $8.30 of
 * $48.13), and it is deliberately above the point where a summary's own cost
 * would exceed the re-reads it prevents: a summary costs roughly one pass over
 * the summarized range, so compacting much below ~100k trades a cheaper tail for
 * more summaries than it saves. The default is a starting point, not a
 * measurement — the per-run `peakContextTokens` telemetry and the `compactions`
 * analysis query exist so it can be re-measured after a week.
 */
export const COMPACTION_CEILING_DEFAULT = 150_000;
/** Stage reports and approved plans should remain usable across long tool flows. */
export const STAGE_TESTER_COMPACTION_CEILING_TOKENS = 50_000;

/** Smallest accepted *enabled* ceiling. Below it the summary plus a workable
 * kept tail would be most of the budget, which is the compaction loop the
 * floor and the loop guard exist to prevent; `0` is the documented way to turn
 * the ceiling off, and a value between it and this floor is refused. */
export const COMPACTION_CEILING_MINIMUM = 16_384;

/** Share of an active ceiling the kept-verbatim tail may occupy. The summary is
 * written on top of the tail, so the tail may not take the whole ceiling: half
 * leaves the same room again for the summary and for the turns that follow, and
 * the next request lands well under the ceiling instead of immediately above it
 * (a tail at the ceiling is exactly the loop the floors cannot break). */
export const COMPACTION_CEILING_KEPT_SHARE = 0.5;

/** The floor under a ceiling compaction: a second one waits for at least this
 * many turns **or** this many tokens of new context, so a conversation whose
 * reduced context is still close to the ceiling cannot compact on every turn. */
export const COMPACTION_CEILING_FLOOR_TURNS = 20;
export const COMPACTION_CEILING_FLOOR_TOKENS = 40_000;

/** The loop guard: once this many ceiling compactions have been admitted inside
 * this many turns, ceiling compaction stops for the rest of the conversation and
 * raises a visible warning event. Manual compaction stays available. */
export const COMPACTION_CEILING_LOOP_TURNS = 10;
export const COMPACTION_CEILING_LOOP_LIMIT = 3;

/** Fields that accept an absolute token count only. A percentage cannot express
 * a cost ceiling: the ceiling exists to bound absolute spend, and `"15%"` of a
 * 1M window would be a 150,000-token ceiling that silently becomes 19,200 on a
 * 128k model. */
export const COMPACTION_ABSOLUTE_ONLY_FIELDS: ReadonlySet<CompactionTokenField> =
	new Set(["ceilingTokens"]);

/** Longest accepted `/compact` instruction text (durable-agent-compaction:
 * "Manual compaction outcomes"). Longer is refused as an invalid request rather
 * than truncated silently, so the summarizer never runs on text nobody wrote. */
export const COMPACTION_MAX_INSTRUCTIONS = 2000;

/** The smallest absolute value each token field accepts, so the validator, the
 * editor's bounds and the resolver agree. `backgroundTokens: 0` disables
 * background compaction, which is why it is the one field that accepts 0. */
export function compactionFieldMinimum(field: CompactionTokenField): number {
	return field === "backgroundTokens" || field === "ceilingTokens"
		? 0
		: COMPACTION_TOKEN_FLOOR;
}

/** The documented absolute default of one token field. */
export function compactionFieldDefault(field: CompactionTokenField): number {
	return field === "ceilingTokens"
		? COMPACTION_CEILING_DEFAULT
		: COMPACTION_DEFAULTS[field];
}

/** One field's documented default as a single line, for Settings and the docs:
 * `32000 tokens`, or `max(32000 tokens, 30% of the run's window)` for a field
 * whose default scales with the window. */
export function compactionFieldDefaultForm(
	field: CompactionTokenField,
): string {
	const absolute = `${compactionFieldDefault(field)} tokens`;
	const percent = COMPACTION_WINDOW_DEFAULT_PERCENT[field];
	return percent === undefined
		? absolute
		: `max(${absolute}, ${percent}% of the run's window)`;
}

/** One rejected field of a compaction section. `field` is the key path below
 * `agents.compaction`, so an error names exactly what to fix. */
export interface CompactionFieldError {
	readonly field: CompactionField;
	readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The percentage a `"N%"` value carries, or undefined for any other form. */
export function parseCompactionPercent(value: string): number | undefined {
	const match = /^(\d{1,3})%$/.exec(value.trim());
	if (!match) return undefined;
	const percent = Number(match[1]);
	return Number.isInteger(percent) ? percent : undefined;
}

function isWholeTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** Whether a value has the accepted *form* of a token field: a whole count in
 * range, or the bounded percentage form. The floors (which are applied at
 * resolution) are deliberately not part of this check, so a hand-written value
 * below the floor is floored rather than dropped. */
function compactionFieldFormProblem(
	field: CompactionTokenField,
	value: unknown,
): string | undefined {
	if (typeof value === "string") {
		if (COMPACTION_ABSOLUTE_ONLY_FIELDS.has(field))
			return `${field}: expected a whole number of tokens (an absolute cost ceiling; 0 turns it off)`;
		const percent = parseCompactionPercent(value);
		if (percent === undefined)
			return `${field}: expected a whole number of tokens or a percentage like "15%"`;
		if (percent < COMPACTION_PERCENT_MIN || percent > COMPACTION_PERCENT_MAX)
			return `${field}: percentage must be between ${COMPACTION_PERCENT_MIN}% and ${COMPACTION_PERCENT_MAX}%`;
		return undefined;
	}
	if (!isWholeTokenCount(value))
		return `${field}: expected a whole number of tokens or a percentage like "15%"`;
	if (value < 0) return `${field}: must not be negative`;
	if (value > COMPACTION_TOKEN_CEILING)
		return `${field}: must be at most ${COMPACTION_TOKEN_CEILING}`;
	return undefined;
}

/** One field's accept/reject decision for the write path and the editor, so an
 * input is judged the same way wherever it is entered. */
export function validateCompactionField(
	field: CompactionTokenField,
	value: unknown,
): string | undefined {
	const form = compactionFieldFormProblem(field, value);
	if (form) return form;
	if (typeof value === "number" && value < compactionFieldMinimum(field))
		return `${field}: must be at least ${compactionFieldMinimum(field)}`;
	if (
		field === "ceilingTokens" &&
		typeof value === "number" &&
		value > 0 &&
		value < COMPACTION_CEILING_MINIMUM
	)
		return `${field}: must be 0 (off) or at least ${COMPACTION_CEILING_MINIMUM}`;
	return undefined;
}

/** The cross-field rule of the two values that meet at the ceiling: the
 * verbatim tail has to stay below it, or the next request is already over the
 * line and every turn compacts. A percentage tail (or an absent one) cannot be
 * compared without a window, so it is not checked here; resolution clamps it.
 */
export function compactionKeepRecentBelowCeiling(section: {
	readonly keepRecentTokens?: unknown;
	readonly ceilingTokens?: unknown;
}): string | undefined {
	const keep = section.keepRecentTokens;
	if (typeof keep !== "number" || !Number.isFinite(keep)) return undefined;
	const rawCeiling = section.ceilingTokens;
	const ceilingTokens =
		typeof rawCeiling === "number" && Number.isFinite(rawCeiling)
			? Math.max(0, Math.round(rawCeiling))
			: COMPACTION_CEILING_DEFAULT;
	// A disabled ceiling has nothing for the tail to stay below.
	if (ceilingTokens === 0) return undefined;
	if (keep >= ceilingTokens)
		return `keepRecentTokens: must be below ceilingTokens (${ceilingTokens}) so the summary and the kept tail fit under the cost ceiling`;
	return undefined;
}

/** Per-field validation of a compaction section. An empty result accepts the
 * section; the write path refuses the change and names the offending field
 * otherwise (centralized-application-settings: "Invalid value rejected"). */
export function validateCompactionConfig(
	value: unknown,
): CompactionFieldError[] {
	if (!isRecord(value))
		return [{ field: "enabled", message: "agents.compaction must be a table" }];
	const errors: CompactionFieldError[] = [];
	if (value.enabled !== undefined && typeof value.enabled !== "boolean")
		errors.push({ field: "enabled", message: "enabled must be true or false" });
	for (const field of COMPACTION_TOKEN_FIELDS) {
		const raw = value[field];
		if (raw === undefined) continue;
		const problem = validateCompactionField(field, raw);
		if (problem) errors.push({ field, message: problem });
	}
	const crossField = compactionKeepRecentBelowCeiling(value);
	if (crossField)
		errors.push({ field: "keepRecentTokens", message: crossField });
	return errors;
}

/** The usable section: unknown keys are ignored (the section may carry a
 * hand-written note) and a value of an unexpected type is left out so the
 * resolver uses the documented default. Never throws: resolution must not fail
 * a durable launch because the operator mistyped a key. */
export function parseCompactionConfig(value: unknown): CompactionConfig {
	if (!isRecord(value)) return {};
	const config: CompactionConfig = {};
	if (typeof value.enabled === "boolean") config.enabled = value.enabled;
	for (const field of COMPACTION_TOKEN_FIELDS) {
		const raw = value[field];
		// The form, not the floor: a value below the floor is floored at
		// resolution instead of being silently dropped here.
		if (compactionFieldFormProblem(field, raw) === undefined)
			config[field] = raw as CompactionTokenValue;
	}
	return config;
}

/** Whether a section actually sets anything, so `source` can be reported. */
export function compactionConfigIsEmpty(config: CompactionConfig): boolean {
	return (
		config.enabled === undefined &&
		COMPACTION_TOKEN_FIELDS.every((field) => config[field] === undefined)
	);
}

/** The precedence rule between the two configuration sources: a present,
 * non-empty `agentHost.compaction` (the hand-written escape hatch) wins over
 * `[agents.compaction]`, which wins over the documented defaults. */
export function resolveCompactionSection(
	agentsSection: unknown,
	agentHostSection: unknown,
): { config: CompactionConfig; source: CompactionSource } {
	const agents = parseCompactionConfig(agentsSection);
	const override = parseCompactionConfig(agentHostSection);
	if (!compactionConfigIsEmpty(override))
		return { config: override, source: "agentHost" };
	if (!compactionConfigIsEmpty(agents))
		return { config: agents, source: "agents" };
	return { config: agents, source: "default" };
}

function resolveField(
	field: CompactionTokenField,
	config: CompactionConfig,
	window: number | undefined,
): number {
	const raw = config[field];
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
	if (typeof raw === "string") {
		const percent = parseCompactionPercent(raw);
		if (percent !== undefined)
			return window !== undefined
				? Math.round((window * percent) / 100)
				: compactionFieldDefault(field);
	}
	// Nothing configured: the documented default applies, and for a field whose
	// default scales with the window it is the *larger* of the two forms — so a
	// 1M-token window does not inherit a reserve sized for a 128k one.
	const percent = COMPACTION_WINDOW_DEFAULT_PERCENT[field];
	if (percent !== undefined && window !== undefined)
		return Math.max(
			compactionFieldDefault(field),
			Math.round((window * percent) / 100),
		);
	return compactionFieldDefault(field);
}

/** A usable reference window, or undefined when none is known. */
function resolveWindow(
	referenceWindow: number | undefined,
): number | undefined {
	return typeof referenceWindow === "number" &&
		Number.isFinite(referenceWindow) &&
		referenceWindow > 0
		? Math.floor(referenceWindow)
		: undefined;
}

/** The resolved cost ceiling. `active` is the only field a caller has to read to
 * know whether it may compact; `inactive` says why not, so Settings and the
 * warning event can name the reason instead of a silent off. */
export interface CompactionCeiling {
	/** The ceiling in absolute tokens; `0` when it is off. */
	readonly ceilingTokens: number;
	readonly active: boolean;
	readonly inactive?: "disabled" | "off" | "above-overflow";
	/** The overflow threshold the ceiling is compared against
	 * (`window - reserveTokens`), when the window is known. */
	readonly overflowTokens?: number;
	readonly floorTurns: number;
	readonly floorTokens: number;
	readonly loopTurns: number;
	readonly loopLimit: number;
}

function resolveCeilingFrom(
	config: CompactionConfig,
	enabled: boolean,
	window: number | undefined,
	reserveTokens: number,
): CompactionCeiling {
	const raw = resolveField("ceilingTokens", config, window);
	// `0` is the documented off switch; anything else below the minimum is a
	// typo, and resolution floors it rather than refusing to launch.
	const ceilingTokens =
		raw <= 0 ? 0 : Math.max(COMPACTION_CEILING_MINIMUM, Math.round(raw));
	const overflowTokens =
		window !== undefined ? window - reserveTokens : undefined;
	const base = {
		ceilingTokens,
		...(overflowTokens !== undefined ? { overflowTokens } : {}),
		floorTurns: COMPACTION_CEILING_FLOOR_TURNS,
		floorTokens: COMPACTION_CEILING_FLOOR_TOKENS,
		loopTurns: COMPACTION_CEILING_LOOP_TURNS,
		loopLimit: COMPACTION_CEILING_LOOP_LIMIT,
	};
	// `enabled` gates every automatic path, the ceiling included: a session with
	// automatic compaction off compacts only when the developer asks for it.
	if (!enabled) return { ...base, active: false, inactive: "disabled" };
	if (ceilingTokens === 0) return { ...base, active: false, inactive: "off" };
	// The ceiling is a *lower* trigger than the overflow guard by definition. On a
	// small window the overflow guard is already the tighter of the two, so the
	// ceiling is ignored (and reported) instead of compacting twice in a row.
	if (overflowTokens !== undefined && ceilingTokens >= overflowTokens)
		return { ...base, active: false, inactive: "above-overflow" };
	return { ...base, active: true };
}

/** The cost ceiling of a configuration section, resolved against the same
 * reference window the policy is. */
export function resolveCompactionCeiling(
	config: CompactionConfig,
	referenceWindow?: number,
): CompactionCeiling {
	const window = resolveWindow(referenceWindow);
	const enabled = config.enabled ?? COMPACTION_DEFAULTS.enabled;
	let reserveTokens = Math.max(
		COMPACTION_TOKEN_FLOOR,
		resolveField("reserveTokens", config, window),
	);
	if (window !== undefined)
		reserveTokens = Math.min(reserveTokens, Math.floor(window / 2));
	return resolveCeilingFrom(config, enabled, window, reserveTokens);
}

/** The most of an active ceiling the kept-verbatim tail may take. */
export function compactionCeilingKeptTailCap(ceilingTokens: number): number {
	return Math.max(
		COMPACTION_TOKEN_FLOOR,
		Math.floor(ceilingTokens * COMPACTION_CEILING_KEPT_SHARE),
	);
}

/**
 * Resolve the written section into the policy pi-durable receives. Every field
 * is absolute in the result: a percentage is resolved against `referenceWindow`
 * when one is known and falls back to that field's documented absolute default
 * when it is not, and a field whose documented default scales with the window
 * ({@link COMPACTION_WINDOW_DEFAULT_PERCENT}) uses the larger of its two
 * default forms. Floors and clamps are applied afterwards, so a bad
 * configuration can never produce a policy that selects no range:
 *
 * - `reserveTokens` and `keepRecentTokens` are at least 4096, and
 *   `backgroundTokens` at least 0 (0 disables background compaction);
 * - with a known window the reserve is clamped to half the window, and the
 *   kept-verbatim tail to `window - reserve - 1024` so a threshold compaction
 *   can still pick a range to summarize;
 * - with an *active* cost ceiling the kept-verbatim tail is additionally capped
 *   at {@link COMPACTION_CEILING_KEPT_SHARE} of it, so the request after a
 *   ceiling compaction starts well below the ceiling again.
 */
export function resolveCompactionPolicy(
	config: CompactionConfig,
	referenceWindow?: number,
): CompactionPolicy {
	const window = resolveWindow(referenceWindow);
	const enabled = config.enabled ?? COMPACTION_DEFAULTS.enabled;
	let reserveTokens = Math.max(
		COMPACTION_TOKEN_FLOOR,
		resolveField("reserveTokens", config, window),
	);
	let keepRecentTokens = Math.max(
		COMPACTION_TOKEN_FLOOR,
		resolveField("keepRecentTokens", config, window),
	);
	const backgroundTokens = Math.max(
		0,
		resolveField("backgroundTokens", config, window),
	);
	if (window !== undefined) {
		reserveTokens = Math.min(reserveTokens, Math.floor(window / 2));
		keepRecentTokens = Math.min(
			keepRecentTokens,
			Math.max(COMPACTION_TOKEN_FLOOR, window - reserveTokens - 1024),
		);
	}
	// The summary is written on top of the kept tail, so an active ceiling caps
	// the tail at half of itself: the request after the compaction then lands well
	// under the ceiling instead of immediately above it.
	const ceiling = resolveCeilingFrom(config, enabled, window, reserveTokens);
	if (ceiling.active)
		keepRecentTokens = Math.min(
			keepRecentTokens,
			compactionCeilingKeptTailCap(ceiling.ceilingTokens),
		);
	return { enabled, reserveTokens, keepRecentTokens, backgroundTokens };
}

/** Why a ceiling compaction did not run: the reasons are reported, so a session
 * that never compacts says which condition held instead of looking inert. */
export type CompactionCeilingQuietReason =
	| "inactive"
	| "suspended"
	| "below-ceiling"
	| "floor"
	| "loop-guard";

/** What the host remembers about one conversation's ceiling compactions. */
export interface CompactionCeilingState {
	/** Monotonic turn index of the measured turn (pi-durable's `turn_start`
	 * counter), so the floors are counted in turns and not in wall time. */
	readonly turnIndex: number;
	readonly lastCompactionTurn?: number;
	/** The context size measured at that compaction, so "new context since" is a
	 * token difference and not a guess. */
	readonly lastCompactionTokens?: number;
	/** The turns ceiling compactions were admitted at, oldest first. */
	readonly compactionTurns: readonly number[];
	readonly suspended?: boolean;
}

export type CompactionCeilingDecision =
	| { readonly kind: "compact" }
	| { readonly kind: "quiet"; readonly reason: CompactionCeilingQuietReason };

/**
 * Decide whether a measured turn should be compacted for cost. Pure, so the
 * whole rule — the ceiling, the floor and the loop guard — is testable without a
 * provider. A `compact` verdict is admitted at the next safe point by the host;
 * `quiet` reports the condition that held.
 */
export function evaluateCompactionCeiling(input: {
	readonly ceiling: CompactionCeiling;
	readonly contextTokens: number;
	readonly state: CompactionCeilingState;
}): CompactionCeilingDecision {
	const { ceiling, contextTokens, state } = input;
	if (!ceiling.active) return { kind: "quiet", reason: "inactive" };
	if (state.suspended) return { kind: "quiet", reason: "suspended" };
	if (!(contextTokens >= ceiling.ceilingTokens))
		return { kind: "quiet", reason: "below-ceiling" };
	const recent = state.compactionTurns.filter(
		(turn) => state.turnIndex - turn < ceiling.loopTurns,
	);
	if (recent.length >= ceiling.loopLimit)
		return { kind: "quiet", reason: "loop-guard" };
	if (state.lastCompactionTurn !== undefined) {
		const turns = state.turnIndex - state.lastCompactionTurn;
		const tokens = contextTokens - (state.lastCompactionTokens ?? 0);
		// Either floor is enough to admit the next compaction: 20 turns of small
		// growth will not reach the ceiling on its own, and one huge turn should not
		// have to wait for twenty.
		if (turns < ceiling.floorTurns && tokens < ceiling.floorTokens)
			return { kind: "quiet", reason: "floor" };
	}
	return { kind: "compact" };
}

/** `32000` or `"15%"` as one line, for a Settings row or an error message. */
export function formatCompactionValue(
	value: boolean | CompactionTokenValue | undefined,
): string {
	if (value === undefined) return "unset";
	if (typeof value === "boolean") return value ? "on" : "off";
	return typeof value === "number" ? String(value) : value;
}
