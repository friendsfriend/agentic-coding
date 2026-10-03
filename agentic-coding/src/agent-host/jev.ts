// The durable `ask_jev` tool's wire contract (durable-agent-tools: "In-session
// judgment tool"): the question schema, the state bounds, and the honesty rules
// that make an answer readable as a judgment rather than a verdict.
//
// A narrowed port of `agent-definitions/extensions/ask-jev.ts`, which cannot be
// imported here: that module registers itself against pi's own extension API and
// is materialized standalone into each worktree. The parts that must not drift
// are duplicated deliberately. The measured failure this prevents: a question
// block the classifier cannot parse comes back as `score: 0, confidence: 1` or
// an empty `choice`, which reads as a confident verdict unless validation
// refuses it first.

export const MAX_QUESTIONS = 12;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
export const MAX_PATHS_PER_CALL = 20;
export const MAX_FILE_BYTES = 96 * 1024;
export const MAX_OUTPUT_CHARS = 96 * 1024;
/** The agent's own note is for context, not for pasting content code can read. */
export const MAX_OWN_STATE_CHARS = 8_000;
/** Jev's shared budget for state plus questions is 64k tokens; at roughly four
 * characters per token this leaves room for the questions. */
export const MAX_STATE_CHARS = 240_000;
/** Below this, the classifier is telling us it does not know. */
const LOW_CONFIDENCE = 0.5;
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type QuestionsResult =
	| {
			readonly ok: true;
			readonly ids: string[];
			readonly questions: Record<string, unknown>;
	  }
	| { readonly ok: false; readonly error: string };

function instructionsOf(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	return isRecord(value);
}

/** Validate one question block before any transport, mirroring the pi
 * extension's rules so a request that would be answered with nonsense is
 * refused with a message that names what is missing. */
export function validateQuestions(raw: unknown): QuestionsResult {
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				ok: false,
				error:
					"questions is a string but not JSON. Pass an object keyed by question id.",
			};
		}
	}
	if (!isRecord(parsed) || Object.keys(parsed).length === 0)
		return {
			ok: false,
			error:
				'questions must be a non-empty object keyed by the ids you choose, for example {leak: {type: "noul", instructions: "...", criteria: {true: "...", false: "..."}}}.',
		};
	const ids = Object.keys(parsed);
	if (ids.length > MAX_QUESTIONS)
		return {
			ok: false,
			error: `questions has ${ids.length} entries; the most one call takes is ${MAX_QUESTIONS}.`,
		};
	const questions: Record<string, unknown> = {};
	for (const id of ids) {
		const question = parsed[id];
		if (!isRecord(question))
			return { ok: false, error: `question "${id}" must be an object.` };
		const type = question.type;
		if (typeof type !== "string" || !QUESTION_TYPES.has(type))
			return {
				ok: false,
				error: `question "${id}" needs a type of noul, choice, or score.`,
			};
		if (!instructionsOf(question.instructions))
			return {
				ok: false,
				error: `question "${id}" needs instructions: a non-blank string, or an object holding the question and the data it refers to.`,
			};
		if (type === "noul" && question.criteria !== undefined) {
			if (!isRecord(question.criteria))
				return {
					ok: false,
					error: `noul "${id}" criteria must be an object mapping true and false to descriptions.`,
				};
			for (const [key, value] of Object.entries(question.criteria))
				if (key !== "true" && key !== "false")
					return {
						ok: false,
						error: `noul "${id}" criteria may only describe true and false, and it describes "${key}".`,
					};
				else if (value !== undefined && typeof value !== "string")
					return {
						ok: false,
						error: `noul "${id}" criteria."${key}" must be a string.`,
					};
		}
		if (type === "choice") {
			if (!isRecord(question.criteria))
				return {
					ok: false,
					error: `choice "${id}" needs criteria mapping each option to its rubric, using null when an option needs no detail.`,
				};
			const options = Object.keys(question.criteria);
			if (options.length === 0)
				return {
					ok: false,
					error: `choice "${id}" has no options; a choice cannot pick from an empty list.`,
				};
			if (options.length > MAX_CHOICE_OPTIONS)
				return {
					ok: false,
					error: `choice "${id}" has ${options.length} options; the most the endpoint takes is ${MAX_CHOICE_OPTIONS}.`,
				};
			if (
				Object.values(question.criteria).some(
					(value) => value !== null && typeof value !== "string",
				)
			)
				return {
					ok: false,
					error: `choice "${id}" descriptions must be strings or null.`,
				};
		}
		if (type === "score") {
			if (!Array.isArray(question.criteria))
				return {
					ok: false,
					error: `score "${id}" needs criteria as an ordered array of level descriptions, low to high.`,
				};
			if (
				question.criteria.length < MIN_SCORE_LEVELS ||
				question.criteria.length > MAX_SCORE_LEVELS
			)
				return {
					ok: false,
					error: `score "${id}" needs between ${MIN_SCORE_LEVELS} and ${MAX_SCORE_LEVELS} levels; it has ${question.criteria.length}.`,
				};
			if (
				question.criteria.some(
					(level) => typeof level !== "string" || level.trim().length === 0,
				)
			)
				return {
					ok: false,
					error: `score "${id}" levels must be non-blank strings.`,
				};
		}
		questions[id] = question;
	}
	return { ok: true, ids, questions };
}

/** The agent's own state: plain text stays text, a JSON object or array keeps
 * its field names so a question can name them. */
export function parseOwnState(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === "") return {};
	if (isRecord(raw)) return { ...raw };
	if (Array.isArray(raw)) return { items: raw };
	if (typeof raw !== "string") return { text: String(raw) };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed)) return { ...parsed };
		if (Array.isArray(parsed)) return { items: parsed };
	} catch {
		/* not JSON: the agent's own prose */
	}
	return { text: raw };
}

function confidenceOf(answer: Record<string, unknown>): number | undefined {
	const value = answer.confidence;
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function probabilityLine(
	probabilities: Record<string, unknown>,
	chosen: string,
): string {
	const ranked = Object.entries(probabilities)
		.filter((entry): entry is [string, number] => typeof entry[1] === "number")
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5);
	if (ranked.length < 2) return "";
	return ` [${ranked.map(([label, value]) => `${label === chosen ? "*" : ""}${label} ${value.toFixed(2)}`).join(", ")}]`;
}

/** One line per answer, plus the warning a low-confidence answer earns: a
 * verdict the classifier is guessing at is reported as a guess, never as a
 * verdict. */
export function renderAnswers(
	answers: Record<string, unknown>,
	ids: readonly string[],
): { readonly text: string; readonly warnings: readonly string[] } {
	const lines: string[] = [];
	const warnings: string[] = [];
	for (const id of ids) {
		const answer = answers[id];
		if (!isRecord(answer)) {
			lines.push(`${id}: no answer came back.`);
			warnings.push(
				`the classifier returned no answer for "${id}"; nothing was decided for it.`,
			);
			continue;
		}
		const confidence = confidenceOf(answer);
		const confidenceText =
			confidence !== undefined ? ` confidence ${confidence.toFixed(2)}` : "";
		const probabilities = isRecord(answer.probabilities)
			? answer.probabilities
			: {};
		if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
			lines.push(`${id} (noul): ${answer.noul.toFixed(2)}${confidenceText}`);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" came back ${answer.noul.toFixed(2)} at confidence ${confidence.toFixed(2)}, which is a coin flip. Do not branch on it; narrow the state or judge it yourself.`,
				);
			continue;
		}
		if (typeof answer.choice === "string") {
			lines.push(
				`${id} (choice): ${answer.choice}${confidenceText}${probabilityLine(probabilities, answer.choice)}`,
			);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" picked ${answer.choice} at confidence ${confidence.toFixed(2)}: the pick is plausible, the confidence is not. The options may not cover the state; resolve it before you act on it.`,
				);
			continue;
		}
		if (typeof answer.score === "number" && Number.isFinite(answer.score)) {
			// A score is a position on the question's own scale, not a 0..1
			// fraction: with three levels it runs 0..2.
			const legend = isRecord(answer.legend) ? answer.legend : {};
			const levels = Object.keys(legend).length;
			const index = Math.min(
				Math.max(Math.round(answer.score), 0),
				Math.max(levels - 1, 0),
			);
			const nearest =
				levels > 0 ? ` (nearest "${String(legend[String(index)] ?? "")}")` : "";
			lines.push(
				`${id} (score): ${answer.score.toFixed(2)} of ${Math.max(levels - 1, 0)}${nearest}${confidenceText}${probabilityLine(probabilities, "")}`,
			);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" scored ${answer.score.toFixed(2)} at confidence ${confidence.toFixed(2)}; the position is not settled. Treat it as a range, not a level.`,
				);
			continue;
		}
		lines.push(
			`${id}: unrecognised answer shape ${JSON.stringify(answer).slice(0, 200)}`,
		);
	}
	return { text: lines.join("\n"), warnings };
}

/** The classifier's own token/cost report, when it sent one. */
export function usageLine(usage: unknown): string {
	if (!isRecord(usage)) return "";
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const cost = usage.cost;
	const bits = [
		typeof input === "number" ? `${input} in` : "",
		typeof output === "number" ? `${output} out` : "",
		typeof cost === "number" ? `$${cost.toFixed(6)}` : "",
	].filter((bit) => bit.length > 0);
	return bits.length ? `jev ${bits.join(" / ")}` : "";
}
