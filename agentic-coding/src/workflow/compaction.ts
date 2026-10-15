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
// reserve is naturally window-relative already (the blocking threshold is
// `contextWindow - reserveTokens`) and it also bounds the summarizer's own
// output budget (0.8 × reserve), so it is an absolute count — 32000 covers
// about two harness-bounded tool results. `backgroundTokens` leads the blocking
// threshold by one large turn, so the background summary usually lands before
// anybody blocks. `keepRecentTokens` is the one value whose meaning drifts with
// the window (16% of 128k but 2% of 1M), so it is the value offered as a
// percentage; its absolute default keeps a workable verbatim tail on the
// 128k–200k windows in normal use.

/** The token-valued fields of the policy, in Settings display order. */
export const COMPACTION_TOKEN_FIELDS = [
	"reserveTokens",
	"backgroundTokens",
	"keepRecentTokens",
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

/** The documented defaults (proposal "Recommended defaults"). */
export const COMPACTION_DEFAULTS: CompactionPolicy = {
	enabled: true,
	reserveTokens: 32000,
	keepRecentTokens: 20000,
	backgroundTokens: 32000,
};

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

/** Longest accepted `/compact` instruction text (durable-agent-compaction:
 * "Manual compaction outcomes"). Longer is refused as an invalid request rather
 * than truncated silently, so the summarizer never runs on text nobody wrote. */
export const COMPACTION_MAX_INSTRUCTIONS = 2000;

/** The smallest absolute value each token field accepts, so the validator, the
 * editor's bounds and the resolver agree. `backgroundTokens: 0` disables
 * background compaction, which is why it is the one field that accepts 0. */
export function compactionFieldMinimum(field: CompactionTokenField): number {
	return field === "backgroundTokens" ? 0 : COMPACTION_TOKEN_FLOOR;
}

/** The documented absolute default of one token field. */
export function compactionFieldDefault(field: CompactionTokenField): number {
	return COMPACTION_DEFAULTS[field];
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
	return compactionFieldDefault(field);
}

/**
 * Resolve the written section into the policy pi-durable receives. Every field
 * is absolute in the result: a percentage is resolved against `referenceWindow`
 * when one is known and falls back to that field's documented absolute default
 * when it is not. Floors and clamps are applied afterwards, so a bad
 * configuration can never produce a policy that selects no range:
 *
 * - `reserveTokens` and `keepRecentTokens` are at least 4096, and
 *   `backgroundTokens` at least 0 (0 disables background compaction);
 * - with a known window the reserve is clamped to half the window, and the
 *   kept-verbatim tail to `window - reserve - 1024` so a threshold compaction
 *   can still pick a range to summarize.
 */
export function resolveCompactionPolicy(
	config: CompactionConfig,
	referenceWindow?: number,
): CompactionPolicy {
	const window =
		typeof referenceWindow === "number" &&
		Number.isFinite(referenceWindow) &&
		referenceWindow > 0
			? Math.floor(referenceWindow)
			: undefined;
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
	return {
		enabled: config.enabled ?? COMPACTION_DEFAULTS.enabled,
		reserveTokens,
		keepRecentTokens,
		backgroundTokens,
	};
}

/** `32000` or `"15%"` as one line, for a Settings row or an error message. */
export function formatCompactionValue(
	value: boolean | CompactionTokenValue | undefined,
): string {
	if (value === undefined) return "unset";
	if (typeof value === "boolean") return value ? "on" : "off";
	return typeof value === "number" ? String(value) : value;
}
