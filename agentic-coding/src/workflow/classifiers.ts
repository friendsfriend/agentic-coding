// The pool-routing protocol (classifier-driven-model-pools): pure domain
// knowledge for per-step model pools, the TypeSafe question shape, and the
// mode-aware answer parsing/selection. The runtime I/O half lives in
// `classifier-runner.ts`; the reducer applies the result in
// `runtime/reducers/effect-result.ts`.
/** A labelled candidate profile in a per-step model pool. `criteria` is
 * opaque JSON passed through to the TypeSafe choice question; `default` marks
 * the fallback entry/entries for the step. */
export interface PoolEntry {
	label: string;
	profile: string;
	criteria?: unknown;
	default?: boolean;
}

/** Classification mode a classifiable step declares. */
export type ClassificationMode = "single" | "roster";

/** Selector constants (not config): a single choice below the confidence floor
 * falls back to the pool default; roster entries below the probability
 * threshold are dropped; the roster is clamped to [2,5] distinct profiles.
 * Defined here (pure protocol) and imported by `profiles.ts` for validation so
 * the domain never imports the runtime config module. */
export const SINGLE_CONFIDENCE_FLOOR = 0.5;
export const ROSTER_PROBABILITY_THRESHOLD = 0.2;
export const ROSTER_MIN_PLANNERS = 2;
export const ROSTER_MAX_PLANNERS = 5;

/** The identifier a `model.classify` routing payload carries. */
export const ROUTING_INTEGRATION = "routing";

/** The bounded, already-collected material handed to the classifier. */
export interface ClassifierInput {
	readonly task: string;
	readonly changeId: string;
	readonly artifacts: readonly {
		readonly path: string;
		readonly content: string;
	}[];
}

/** One classifiable step's question for a routing pass. */
export interface RoutingQuestionSpec {
	readonly stepId: string;
	readonly mode: ClassificationMode;
	readonly entries: readonly PoolEntry[];
}

/** Classifiable steps asked by the plan pass, in stable order. */
export const PLAN_PHASE_STEPS: readonly string[] = Object.freeze([
	"core.plan",
	"fusion.consolidate",
	"fusion.plan",
]);

/** Classifiable steps asked by the apply pass, in stable order. */
export const APPLY_PHASE_STEPS: readonly string[] = Object.freeze([
	"core.implementation",
	"core.triage",
	"core.verification",
	"core.wiki",
	"core.archive",
]);

/** A single entry as parsed from a `choice` answer. */
export interface ChoiceAnswer {
	readonly type: "choice";
	readonly choice?: string;
	readonly probabilities?: Readonly<Record<string, number>>;
	readonly confidence?: number;
}
export interface NoulAnswer {
	readonly type: "noul";
}
export type ClassifierAnswer = ChoiceAnswer | NoulAnswer;

/** The classifier model used by the routing integration. */
export const ROUTING_CLASSIFIER_MODEL = "opencode/jev-1.13-free";
export const ROUTING_CLASSIFIER_PROFILE = "jev-classifier";
export const ROUTING_ENDPOINT = "https://opencode.ai/zen/v1/systemone";

/** Rendering text for one routing question. The criteria are the pool entry
 * labels mapped to their (possibly structured) criteria. */
export function routingQuestionInstructions(
	stepId: string,
	mode: ClassificationMode,
): string {
	return mode === "roster"
		? `Choose the subset of profiles that should plan ${stepId} in parallel.`
		: `Choose the profile that should run the ${stepId} step.`;
}

/** Parse one System One answer object into the full answer shape. Missing or
 * malformed fields collapse to `{ type: "noul" }` so the router can fall back
 * rather than throw. */
export function parseClassifierAnswer(value: unknown): ClassifierAnswer {
	if (!value || typeof value !== "object") return { type: "noul" };
	const answer = value as Record<string, unknown>;
	if (answer.type === "noul") return { type: "noul" };
	const choice =
		typeof answer.choice === "string" && answer.choice.trim()
			? answer.choice.trim()
			: undefined;
	const confidence =
		typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
			? answer.confidence
			: undefined;
	const probabilities: Record<string, number> = {};
	const raw = answer.probabilities;
	if (raw && typeof raw === "object" && !Array.isArray(raw))
		for (const [key, entry] of Object.entries(raw as Record<string, unknown>))
			if (typeof entry === "number" && Number.isFinite(entry))
				probabilities[key] = entry;
	if (choice === undefined && Object.keys(probabilities).length === 0)
		return { type: "noul" };
	return {
		type: "choice",
		...(choice !== undefined ? { choice } : {}),
		...(confidence !== undefined ? { confidence } : {}),
		...(Object.keys(probabilities).length ? { probabilities } : {}),
	};
}

/** True when the answer's `confidence` clears the single-select floor. A
 * `choice` without a numeric confidence never clears it. */
export function confidentChoice(
	answer: ClassifierAnswer,
	floor = SINGLE_CONFIDENCE_FLOOR,
): boolean {
	return (
		answer.type === "choice" &&
		typeof answer.confidence === "number" &&
		answer.confidence >= floor
	);
}

/** Select a single pool entry by label, or the tagged default. The choice is
 * applied only when `confidence` clears the floor; otherwise the tagged
 * default is kept and attention is recorded. */
export function selectSingleEntry(
	entries: readonly PoolEntry[],
	answer: ClassifierAnswer,
	floor = SINGLE_CONFIDENCE_FLOOR,
): { profile: string; attention?: string } {
	const fallback = entries.find((entry) => entry.default === true);
	if (!confidentChoice(answer, floor))
		return {
			profile: fallback?.profile ?? "",
			attention:
				answer.type === "choice"
					? "classifier confidence below floor; kept the pool default routing"
					: "classifier returned no usable choice; kept the pool default routing",
		};
	const chosen =
		answer.type === "choice" && answer.choice !== undefined
			? entries.find((entry) => entry.label === answer.choice)
			: undefined;
	if (chosen) return { profile: chosen.profile };
	return {
		profile: fallback?.profile ?? "",
		attention:
			"classifier returned no usable choice; kept the pool default routing",
	};
}

/** Sort probabilities descending, keep probabilities at or above the
 * threshold, de-duplicate profiles, clamp to [min,max], and fall back to the
 * tagged defaults when fewer than `min` distinct profiles survive. */
export function selectRosterEntries(
	entries: readonly PoolEntry[],
	answer: ClassifierAnswer,
	options: { threshold?: number; min?: number; max?: number } = {},
): { profiles: string[]; attention?: string } {
	const threshold = options.threshold ?? ROSTER_PROBABILITY_THRESHOLD;
	const min = options.min ?? ROSTER_MIN_PLANNERS;
	const max = options.max ?? ROSTER_MAX_PLANNERS;
	const defaults = entries
		.filter((entry) => entry.default === true)
		.map((entry) => entry.profile);
	const probabilities =
		answer.type === "choice" && answer.probabilities
			? Object.entries(answer.probabilities)
			: [];
	const ranked = probabilities
		.map(([label, probability]) => ({
			label,
			probability,
			profile: entries.find((entry) => entry.label === label)?.profile,
		}))
		.filter(
			(item): item is { label: string; probability: number; profile: string } =>
				item.profile !== undefined && item.probability >= threshold,
		)
		.sort((a, b) => b.probability - a.probability);
	const profiles: string[] = [];
	for (const item of ranked) {
		if (!profiles.includes(item.profile)) profiles.push(item.profile);
		if (profiles.length >= max) break;
	}
	const selected = profiles.slice(0, max);
	if (selected.length < min) {
		const fallback = defaults.slice(0, max);
		return fallback.length
			? {
					profiles: fallback,
					attention:
						"classifier roster collapsed below two profiles; kept the tagged defaults",
				}
			: {
					profiles: selected,
					attention:
						"classifier roster collapsed below two profiles and the pool has no usable defaults",
				};
	}
	return { profiles: selected };
}
