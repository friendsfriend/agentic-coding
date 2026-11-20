import { Type } from "typebox";
import { digest } from "./config.ts";
import { ReviewFeedbackError } from "./review-feedback.ts";

export const QuestionParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ minLength: 1, maxLength: 4000 }),
			header: Type.String({ minLength: 1, maxLength: 16 }),
			multiSelect: Type.Optional(Type.Boolean()),
			options: Type.Array(
				Type.Object({
					label: Type.String({ minLength: 1, maxLength: 60 }),
					description: Type.String({ minLength: 1, maxLength: 4000 }),
					preview: Type.Optional(Type.String({ maxLength: 16000 })),
					recommended: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 2, maxItems: 4 },
			),
		}),
		{ minItems: 1, maxItems: 4 },
	),
});
export type Question = {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: {
		label: string;
		description: string;
		preview?: string;
		recommended?: boolean;
	}[];
};
export type QuestionDraft = {
	optionIndexes: number[];
	/** UI draft intent only; the submit boundary receives selected text explicitly. */
	customSelected?: boolean;
	text: string;
	notes: string;
};
export type QuestionSubmission = {
	id: string;
	revision: number;
	digest: string;
	requestId: string;
	answers: QuestionDraft[];
	globalNote: string;
};
export type QuestionReceipt = {
	requestId: string;
	fingerprint: string;
	revision: number;
	cancelled: false;
	answers: {
		questionIndex: number;
		question: string;
		kind: "multi" | "option" | "custom";
		answer: string | null;
		selected?: string[];
		notes?: string;
		preview?: string;
	}[];
	globalNote?: string;
};
export function validateQuestions(questions: Question[]) {
	if (
		questions.length < 1 ||
		questions.length > 4 ||
		Buffer.byteLength(JSON.stringify(questions)) > 100_000
	)
		throw new ReviewFeedbackError(
			"Questionnaire exceeds the 1–4 question / 100 KB limit",
		);
	if (
		new Set(questions.map((q) => q.question.trim())).size !== questions.length
	)
		throw new ReviewFeedbackError("Questions must be distinct");
	for (const q of questions) {
		if (
			q.options.some((o) =>
				["other", "type something.", "type something…", "next"].includes(
					o.label.trim().toLowerCase(),
				),
			)
		)
			throw new ReviewFeedbackError("Reserved question option label");
		if (new Set(q.options.map((o) => o.label.trim())).size !== q.options.length)
			throw new ReviewFeedbackError("Question options must be distinct");
	}
}
export function questionReceipt(
	questions: Question[],
	input: QuestionSubmission,
): QuestionReceipt {
	if (
		!Array.isArray(input.answers) ||
		input.answers.length !== questions.length ||
		typeof input.globalNote !== "string" ||
		input.globalNote.length > 16000 ||
		!input.requestId?.trim() ||
		input.requestId.length > 256
	)
		throw new ReviewFeedbackError("Invalid questionnaire submission");
	const answers = questions.map((q, questionIndex) => {
		const draft = input.answers[questionIndex];
		if (
			!draft ||
			!Array.isArray(draft.optionIndexes) ||
			typeof draft.text !== "string" ||
			typeof draft.notes !== "string" ||
			draft.text.length > 16000 ||
			draft.notes.length > 16000
		)
			throw new ReviewFeedbackError("Invalid question answer");
		const indexes = draft.optionIndexes;
		if (
			new Set(indexes).size !== indexes.length ||
			indexes.some(
				(i) => !Number.isInteger(i) || i < 0 || i >= q.options.length,
			)
		)
			throw new ReviewFeedbackError("Invalid question option identity");
		const text = draft.text.trim();
		if (
			(!text && !indexes.length) ||
			(!q.multiSelect && indexes.length + Number(!!text) !== 1)
		)
			throw new ReviewFeedbackError(
				"Answer every question before submitting; notes alone are not answers",
			);
		const selected = [...indexes]
			.sort((a, b) => a - b)
			.map((i) => q.options[i]?.label ?? "");
		const option = q.options[indexes[0] ?? -1];
		return {
			questionIndex,
			question: q.question,
			kind: q.multiSelect
				? ("multi" as const)
				: text
					? ("custom" as const)
					: ("option" as const),
			answer: text || (q.multiSelect ? null : (option?.label ?? null)),
			...(q.multiSelect ? { selected } : {}),
			...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
			...(!q.multiSelect && !text && option?.preview
				? { preview: option.preview }
				: {}),
		};
	});
	const globalNote = input.globalNote.trim();
	if (Buffer.byteLength(JSON.stringify({ answers, globalNote })) > 120000)
		throw new ReviewFeedbackError(
			"Encoded answers exceed 120 KB; draft retained",
		);
	return {
		requestId: input.requestId,
		revision: input.revision,
		cancelled: false,
		fingerprint: digest(
			JSON.stringify({
				id: input.id,
				digest: input.digest,
				revision: input.revision,
				answers,
				globalNote,
			}),
		),
		answers,
		...(globalNote ? { globalNote } : {}),
	};
}
