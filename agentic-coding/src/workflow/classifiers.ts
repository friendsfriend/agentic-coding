// The classifier integration protocol (classifier-driven-model-pools for the
// per-step model pools, classifier-driven-triage-routing for the per-round
// verifier-role questions, add-jev-stage-gating for the four configurable
// stage gates): pure domain knowledge for the TypeSafe question shapes, answer
// parsing, and the selections. The runtime I/O half lives in
// `classifier-runner.ts`; the reducer applies the result in
// `runtime/reducers/effect-result.ts`.
import { triageRolesFor } from "./steps/verification.ts";

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

/** Selector constants (not config): a single selection never consults
 * `confidence` and falls back to the pool default only for a genuinely
 * unusable answer; roster entries below the probability threshold are dropped;
 * the roster is clamped to [2,5] distinct profiles. Defined here (pure
 * protocol) and imported by `profiles.ts` for validation so the domain never
 * imports the runtime config module. */
export const ROSTER_PROBABILITY_THRESHOLD = 0.2;
export const ROSTER_MIN_PLANNERS = 2;
export const ROSTER_MAX_PLANNERS = 5;

/** The identifier a `model.classify` routing payload carries. */
export const ROUTING_INTEGRATION = "routing";

/** The identifier a `model.classify` verifier-role payload carries. Unlike
 * `routing` it resolves no model pool, profile, or preset entry. */
export const TRIAGE_INTEGRATION = "triage";

/** The identifier a `model.classify` stage-gate payload carries. It resolves
 * no model pool either: a gate asks one boolean-necessity question about the
 * change, never which model should run a step. */
export const GATE_INTEGRATION = "gate";

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
	/** The necessity value when the answer carried a finite number; absent
	 * means unanswered, never a usable zero. */
	readonly noul?: number;
}
export type ClassifierAnswer = ChoiceAnswer | NoulAnswer;

/** Content-free account of the routing that one completed pass applied. */
export interface RoutingDecisionStepSummary {
	readonly fallback: boolean;
	readonly label?: string;
	readonly confidence?: number;
	readonly profile?: string;
	readonly profiles?: string;
	readonly selectedCount?: number;
}
export interface RoutingDecisionSummary {
	readonly phase: "plan" | "apply";
	readonly askedStepCount: number;
	readonly appliedStepCount: number;
	readonly fallbackCount: number;
	readonly steps: Readonly<Record<string, RoutingDecisionStepSummary>>;
}

function reportedConfidence(answer: ClassifierAnswer): number | undefined {
	const confidence =
		answer.type === "choice"
			? (answer as { confidence?: unknown }).confidence
			: undefined;
	return typeof confidence === "number" && Number.isFinite(confidence)
		? confidence
		: undefined;
}

/** Build the telemetry-safe routing result from the same inputs used by the
 * reducer. Only validated pool vocabulary and scalar outcomes survive. */
export function buildRoutingDecisionSummary(
	phase: "plan" | "apply",
	specs: readonly RoutingQuestionSpec[],
	answers: Readonly<Record<string, ClassifierAnswer>>,
): RoutingDecisionSummary {
	const steps: Record<string, RoutingDecisionStepSummary> = {};
	let appliedStepCount = 0;
	let fallbackCount = 0;
	for (const spec of specs) {
		const answer = answers[spec.stepId] ?? { type: "noul" };
		const confidence = reportedConfidence(answer);
		if (spec.mode === "roster") {
			const selected = selectRosterEntries(spec.entries, answer);
			const fallback = selected.attention !== undefined;
			if (fallback) fallbackCount++;
			if (selected.profiles.length) appliedStepCount++;
			steps[spec.stepId] = {
				fallback,
				selectedCount: selected.profiles.length,
				...(selected.profiles.length
					? { profiles: selected.profiles.join(",") }
					: {}),
				...(confidence !== undefined ? { confidence } : {}),
			};
			continue;
		}
		const selected = selectSingleEntry(spec.entries, answer);
		const fallback = selected.attention !== undefined;
		const appliedEntry = fallback
			? spec.entries.find(
					(entry) =>
						entry.default === true && entry.profile === selected.profile,
				)
			: (spec.entries.find(
					(entry) =>
						answer.type === "choice" &&
						entry.label === answer.choice &&
						entry.profile === selected.profile,
				) ?? spec.entries.find((entry) => entry.profile === selected.profile));
		if (fallback) fallbackCount++;
		if (selected.profile) appliedStepCount++;
		steps[spec.stepId] = {
			fallback,
			...(answer.type === "choice" && appliedEntry
				? { label: appliedEntry.label }
				: {}),
			...(confidence !== undefined ? { confidence } : {}),
			...(selected.profile ? { profile: selected.profile } : {}),
		};
	}
	return {
		phase,
		askedStepCount: specs.length,
		appliedStepCount,
		fallbackCount,
		steps,
	};
}

/** The classifier model used by the routing integration. The endpoint and the
 * transport are provider-owned (`classifier-providers.ts`); this module keeps
 * only the model id the hosted provider is asked for and the profile it is read
 * from. */
export const ROUTING_CLASSIFIER_MODEL = "opencode/jev-1.13-free";
export const ROUTING_CLASSIFIER_PROFILE = "jev-classifier";

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
 * rather than throw. A `noul` answer keeps a finite numeric necessity value;
 * a missing, non-numeric, or non-finite one parses as a value-less answer so
 * callers treat the question as unanswered. */
export function parseClassifierAnswer(value: unknown): ClassifierAnswer {
	if (!value || typeof value !== "object") return { type: "noul" };
	const answer = value as Record<string, unknown>;
	if (answer.type === "noul")
		return {
			type: "noul",
			...(typeof answer.noul === "number" && Number.isFinite(answer.noul)
				? { noul: answer.noul }
				: {}),
		};
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

/** Select a single pool entry: the entry the classifier explicitly named,
 * else the offered entry with the highest `probabilities` value, else the
 * tagged default. `confidence` is recorded but never consulted. Attention is
 * recorded only when the answer carries no usable decision. */
export function selectSingleEntry(
	entries: readonly PoolEntry[],
	answer: ClassifierAnswer,
): { profile: string; attention?: string } {
	const fallback = entries.find((entry) => entry.default === true);
	if (answer.type === "choice") {
		if (answer.choice !== undefined) {
			const chosen = entries.find((entry) => entry.label === answer.choice);
			if (chosen) return { profile: chosen.profile };
		}
		const mostProbable = entries.reduce<{
			profile: string;
			probability: number;
		} | null>((best, entry) => {
			const probability = answer.probabilities?.[entry.label];
			if (probability === undefined) return best;
			return best === null || probability > best.probability
				? { profile: entry.profile, probability }
				: best;
		}, null);
		if (mostProbable) return { profile: mostProbable.profile };
	}
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

// ---------------------------------------------------------------------------
// Verifier-role routing (classifier-driven-triage-routing)
// ---------------------------------------------------------------------------

/** The single inclusion gate for a per-role necessity answer. A `noul`
 * answer carries no confidence, so 0.5 is the only threshold. */
export const TRIAGE_NOUL_FLOOR = 0.5;

/** One independent necessity question asked for one eligible verifier role. */
export interface TriageRoleQuestion {
	readonly role: string;
	readonly questionId: string;
	readonly instructions: string;
}

/** One necessity question per role triage and the classifier may select. The
 * engine-owned full-suite role is absent by construction: it is never asked,
 * only launched. Exhaustive over `TRIAGE_ROLES` (asserted by the role-coverage
 * test) so a catalog change cannot silently leave a role unasked. */
export const TRIAGE_ROLE_QUESTIONS: readonly TriageRoleQuestion[] =
	Object.freeze([
		{
			role: "quality-verifier",
			questionId: "needs_quality_verifier",
			instructions:
				"Does this change require a correctness review: logic errors, error handling, and formatting/lint/type-check gates?",
		},
		{
			role: "security-verifier",
			questionId: "needs_security_verifier",
			instructions:
				"Does this change touch a trust boundary, credentials or secrets, injection, authorization, or permissions?",
		},
		{
			role: "performance-verifier",
			questionId: "needs_performance_verifier",
			instructions:
				"Does this change affect a hot path, resource use, or observable latency?",
		},
		{
			role: "openspec-verifier",
			questionId: "needs_openspec_verifier",
			instructions:
				"Does this change need conformance review against the approved OpenSpec proposal, design, tasks, and specs?",
		},
		{
			role: "usability-verifier",
			questionId: "needs_usability_verifier",
			instructions:
				"Does this change touch a user-facing UI/UX surface, accessibility, or interaction behaviour?",
		},
		{
			role: "concurrency-verifier",
			questionId: "needs_concurrency_verifier",
			instructions:
				"Does this change introduce races, ordering assumptions, reentrancy, or shared mutable state?",
		},
		{
			role: "migration-verifier",
			questionId: "needs_migration_verifier",
			instructions:
				"Does this change a persisted-state format or version, an upgrade path, atomicity, or rollback behaviour?",
		},
		{
			role: "test-quality-verifier",
			questionId: "needs_test_quality_verifier",
			instructions:
				"Does the changed test scope need a test-adequacy review: assertions that really fail when the logic breaks?",
		},
	] as const);

/** The questions a definition's round asks, in catalog order. */
export function triageRoleQuestions(
	definitionId: string,
): TriageRoleQuestion[] {
	return TRIAGE_ROLE_QUESTIONS.filter((question) =>
		triageRolesFor(definitionId).includes(question.role),
	);
}

/** The roles the round selected, or the reason the round failed open.
 *
 * A selection is trusted only when EVERY eligible question carries a usable
 * value: a truncated or evasive response is an outage, not a verdict. Without
 * this gate the failure is inverted — an answer-free response fails open and
 * runs the full eligible set, while a response answering one cheap question at
 * 0.0 would be trusted as an authoritative "no domain verifier is needed" and
 * silently disable every remaining one, security included. Narrowing a
 * verification gate therefore requires complete, positive evidence. */
export interface TriageSelection {
	readonly roles: readonly string[];
	readonly failOpen?: string;
}

export function selectTriageRoles(
	definitionId: string,
	answers: Readonly<Record<string, ClassifierAnswer>>,
	floor = TRIAGE_NOUL_FLOOR,
): TriageSelection {
	const questions = triageRoleQuestions(definitionId);
	const roles: string[] = [];
	let answered = 0;
	for (const question of questions) {
		const answer = answers[question.questionId];
		const noul = answer && answer.type === "noul" ? answer.noul : undefined;
		if (noul === undefined) continue;
		answered += 1;
		if (noul >= floor) roles.push(question.role);
	}
	if (answered < questions.length)
		return {
			roles: [],
			failOpen: `classifier answered ${answered} of ${questions.length} verifier-role questions`,
		};
	return { roles };
}

// ---------------------------------------------------------------------------
// Configurable stage gates (add-jev-stage-gating)
// ---------------------------------------------------------------------------

/** The stages a gate can decide, in a stable order. `verification` is the
 * single gate over triage *and* verification: they are inseparable, so it is
 * decided on the existing `core.triage-route` step rather than by a step of
 * its own. The remaining three carry their own `core.*-gate` system step. */
export const GATE_STAGES = [
	"planApproval",
	"verification",
	"developerReview",
	"wiki",
] as const;
export type GateStage = (typeof GATE_STAGES)[number];

/** The two gate policies. `always` is the default everywhere and is decided
 * locally (a forced run, no HTTP request); `auto` lets the classifier skip. */
export const GATE_POLICIES = ["always", "auto"] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];

/** One fixed necessity question per stage. The text is a constant (not
 * config) so the same stage always asks the same question. The `verification`
 * question travels inside the triage request (the gate is decided on the step
 * that already asks the role questions) and never as a standalone request. */
export const GATE_QUESTIONS: Readonly<Record<GateStage, string>> =
	Object.freeze({
		planApproval:
			"Should a developer review and approve this plan before implementation?",
		verification:
			"Does this change require independent verification before it is archived?",
		developerReview:
			"Should a developer review this change before it is archived and delivered?",
		wiki: "Does this change require a wiki documentation update?",
	});

/** The question key each stage's necessity answer arrives under. */
export const GATE_QUESTION_IDS: Readonly<Record<GateStage, string>> =
	Object.freeze({
		planApproval: "needs_plan_approval",
		verification: "needs_verification",
		developerReview: "needs_developer_review",
		wiki: "needs_wiki",
	});

/** Which stage each gate step guards. The step id is the source of truth for
 * the decision: an effect payload that names a different stage is treated as an
 * unusable decision rather than being resolved to some default stage. */
export const GATE_STAGE_BY_STEP: Readonly<Record<string, GateStage>> =
	Object.freeze({
		"core.plan-gate": "planApproval",
		"core.triage-route": "verification",
		"core.review-gate": "developerReview",
		"core.wiki-gate": "wiki",
	});

/** The outcome of one gate decision. `skip` is only ever reachable from an
 * answered `auto` gate. */
export type GateDecision = "run" | "skip";

export interface GateSelection {
	readonly decision: GateDecision;
	/** True when no usable answer was consulted: the policy was `always`, the
	 * request failed, or the answer carried no numeric necessity value. */
	readonly forced: boolean;
	/** The necessity answer, when one was obtained. */
	readonly noul?: number;
}

/** Decide one gate. `always` is forced locally and consults nothing; `auto`
 * runs the stage at or above the shared necessity floor and skips strictly
 * below it. A `noul` answer carries no confidence, so no other field and no
 * second threshold is consulted. An answer with no usable value is an outage,
 * not a verdict: it forces the run. */
export function selectGateDecision(
	stage: GateStage,
	policy: GatePolicy,
	answer: ClassifierAnswer | undefined,
	floor = TRIAGE_NOUL_FLOOR,
): GateSelection {
	// An unrecognized stage guards an unknown stage, so it runs: the only way
	// to skip a stage is a positively identified one.
	if (!(GATE_STAGES as readonly string[]).includes(stage))
		return { decision: "run", forced: true };
	if (policy === "always") return { decision: "run", forced: true };
	const noul = answer?.type === "noul" ? answer.noul : undefined;
	if (noul === undefined || !Number.isFinite(noul))
		return { decision: "run", forced: true };
	return {
		decision: noul >= floor ? "run" : "skip",
		forced: false,
		noul,
	};
}

/** The necessity answer of one stage, read from a whole-request answer map. */
export function gateAnswer(
	stage: GateStage,
	answers: Readonly<Record<string, ClassifierAnswer>> | undefined,
): ClassifierAnswer | undefined {
	return answers?.[GATE_QUESTION_IDS[stage]];
}
