// Specialized transcript views for the tools a durable run leans on
// (dashboard-agent-session-view). A tool row's generic shape — icon, name,
// primary argument — says little about what a `read`, `edit`, `write` or `bash`
// call actually did, so each of those gets a view built from the call's
// arguments and its result: the file and range a read covered, the diff an edit
// produced, the command a bash call ran and how it ended.
//
// Presentation only and pure: a block's structured tool data in, rows out. A
// tool without a specialized view here (a search, anything a future host adds)
// keeps the generic row.
import { resolveDeveloperQuestionOption } from "../../../contracts/workflow.ts";
import {
	type AgentSessionToolCall,
	formatDuration,
	toolIcon,
} from "../agent-session.ts";

/** One row of an expanded tool view, with the tone it is drawn in. A row may
 * carry a detail of its own — a codemode call is a whole tool call, so its row
 * folds open into that call's own view. */
export interface ToolViewRow {
	/** Stable identity for a row that folds, unique within its block. */
	readonly id?: string;
	readonly text: string;
	readonly tone: "base" | "muted" | "error" | "warning" | "success" | "info";
	/** The text is markdown, drawn rendered instead of as a line. It is the body
	 * of a fold — a question's context — not a header: a header stays a plain,
	 * truncated line. */
	readonly markdown?: boolean;
	/** The text is source in this tree-sitter filetype (a codemode script): drawn
	 * as one highlighted code block instead of a line. */
	readonly syntax?: string;
	readonly detail?: readonly ToolViewRow[];
}

/** One independently collapsible part of an expanded tool view. */
export interface ToolViewSection {
	readonly id: string;
	readonly label: string;
	readonly rows: readonly ToolViewRow[];
	/** The part starts folded: its header shows (`script (12 lines)`), its rows
	 * wait for a click. A script's source and output are reference material, so
	 * an expanded codemode row leads with the calls the script made. */
	readonly collapsed?: boolean;
}

/** A tool call's transcript view: the summary line, the hint beside it, the
 * rows under it (only visible once the row is expanded), and the sections a
 * long view splits into so its parts can be read one at a time. */
export interface ToolView {
	readonly icon: string;
	readonly summary: string;
	readonly hint?: string;
	readonly rows?: readonly ToolViewRow[];
	readonly sections?: readonly ToolViewSection[];
}

// Expanded views show everything the tool kept. The harness bounds a result
// (2000 lines / 50KB) and reports what it cut, so a second cut here would hide
// exactly the output a reader expanded the row to analyze.

function stringArg(
	args: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(
	args: Readonly<Record<string, unknown>>,
	key: string,
): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** The read tool's truncation diagnostic, as `40-120 of 512` or `+512 more`. */
function readRange(notes: readonly string[]): string | undefined {
	for (const note of notes) {
		const range = /lines (\d+)-(\d+) of (\d+)/.exec(note);
		if (range) return `${range[1]}-${range[2]} of ${range[3]}`;
		const more = /(\d+) more lines/.exec(note);
		if (more) return `+${more[1]} more`;
	}
	return undefined;
}

/** `+12 −4` for a diff body's rows. */
function diffRowCounts(rows: readonly ToolViewRow[]): string | undefined {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.text.startsWith("+")) added++;
		else if (row.text.startsWith("-")) removed++;
	}
	if (added === 0 && removed === 0) return undefined;
	return `+${added} −${removed}`;
}

/** A diff body as rows: additions and removals in their own tone, hunk headers
 * dim, context plain. */
function diffRows(diff: string): ToolViewRow[] {
	return diff.split("\n").map((line): ToolViewRow => {
		if (line.startsWith("+")) return { text: line, tone: "success" };
		if (line.startsWith("-")) return { text: line, tone: "error" };
		if (line.startsWith("@@")) return { text: line, tone: "info" };
		return { text: line, tone: "muted" };
	});
}

/** The change an edit's own arguments describe, for a host that did not compute
 * a diff: each edit's old text as removals and its new text as additions. */
function editArgRows(args: Readonly<Record<string, unknown>>): ToolViewRow[] {
	const edits = Array.isArray(args.edits) ? args.edits : [];
	const rows: ToolViewRow[] = [];
	for (const entry of edits) {
		if (!isRecord(entry)) continue;
		const oldText = typeof entry.oldText === "string" ? entry.oldText : "";
		const newText = typeof entry.newText === "string" ? entry.newText : "";
		for (const text of oldText.split("\n"))
			if (text.length > 0) rows.push({ text: `-${text}`, tone: "error" });
		for (const text of newText.split("\n"))
			if (text.length > 0) rows.push({ text: `+${text}`, tone: "success" });
	}
	return rows;
}

/** `read`: the file, the range that came back, and the text itself. Without a
 * result (a call inside a codemode script) the arguments still say the range. */
function readView(call: AgentSessionToolCall): ToolView {
	const path = stringArg(call.args, "path") ?? "file";
	const lines = call.result?.lines ?? [];
	const range = readRange(call.result?.notes ?? []);
	const limit = numberArg(call.args, "limit");
	const offset = numberArg(call.args, "offset");
	return {
		icon: "→",
		summary: path,
		hint:
			range ??
			(lines.length > 0
				? `${lines.length} lines`
				: limit !== undefined
					? `${limit} lines`
					: offset !== undefined
						? `from ${offset}`
						: undefined),
		rows: lines.map((text) => ({ text, tone: "muted" as const })),
	};
}

/** `edit`: the file, how much changed, and the diff it made. */
function editView(call: AgentSessionToolCall): ToolView {
	const path = stringArg(call.args, "path") ?? "file";
	const editCount = Array.isArray(call.args.edits) ? call.args.edits.length : 0;
	// The host's diff is the exact change. Without one, an edit that succeeded
	// still describes its own change through its arguments; a failed one has
	// nothing to show there, and its call row opens into the error instead.
	const diff = call.result?.details?.diff;
	let rows: ToolViewRow[] = [];
	if (typeof diff === "string") rows = diffRows(diff);
	else if (call.result !== undefined && call.result.isError !== true)
		rows = editArgRows(call.args);
	const counts = diffRowCounts(rows);
	const hint = [
		editCount > 0
			? `${editCount} edit${editCount === 1 ? "" : "s"}`
			: undefined,
		counts,
	].filter((part): part is string => part !== undefined);
	return {
		icon: "←",
		summary: path,
		...(hint.length > 0 ? { hint: hint.join(" · ") } : {}),
		...(rows.length > 0 ? { rows } : {}),
	};
}

/** `write`: the file and the content that was written. */
function writeView(call: AgentSessionToolCall): ToolView {
	const path = stringArg(call.args, "path") ?? "file";
	const content = stringArg(call.args, "content");
	const lines = content?.split("\n") ?? [];
	return {
		icon: "←",
		summary: path,
		...(lines.length > 0 ? { hint: `${lines.length} lines` } : {}),
		rows: lines.map((text) => ({ text, tone: "muted" as const })),
	};
}

/** `bash`: the command and what it printed. A failed command keeps its output
 * in the error tone, so the failing lines read as failures. */
function bashView(call: AgentSessionToolCall): ToolView {
	const command = stringArg(call.args, "command") ?? "";
	const lines = call.result?.lines ?? [];
	const failed = call.result?.isError === true;
	const exit = /exited with code (\d+)/.exec(lines.join("\n"));
	return {
		icon: "$",
		summary: command,
		hint: exit
			? `exit ${exit[1]}`
			: failed
				? "failed"
				: lines.length > 0
					? `${lines.length} lines`
					: undefined,
		rows: lines.map((text) => ({
			text,
			tone: failed ? ("error" as const) : ("muted" as const),
		})),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One question an ask_jev call asked: the agent's own text for it, and the
 * criteria a boolean or choice answer was judged against. */
interface JevQuestion {
	readonly id: string;
	readonly type?: string;
	readonly text?: string;
	readonly criteria?: readonly string[];
}

/** Collapse whitespace and bound one line, so a question's own text cannot push
 * the rest of the view around. */
function oneLine(value: string, max = 300): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The question text: the instructions string, or the question field of the
 * object form the tool also accepts. */
function questionText(value: unknown): string | undefined {
	if (typeof value === "string") return oneLine(value);
	if (!isRecord(value)) return undefined;
	for (const key of ["question", "instructions", "text"]) {
		const text = value[key];
		if (typeof text === "string" && text.trim().length > 0)
			return oneLine(text);
	}
	return undefined;
}

/** The questions an ask_jev call asked, in the order the agent wrote them,
 * whether it passed the record or its JSON string. */
function jevQuestions(value: unknown): JevQuestion[] {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!isRecord(parsed)) return [];
	return Object.entries(parsed).map(([id, entry]) => {
		const question = isRecord(entry) ? entry : {};
		const criteria = isRecord(question.criteria)
			? Object.entries(question.criteria).flatMap(([key, description]) =>
					typeof description === "string" && description.trim().length > 0
						? [`${key}: ${oneLine(description, 200)}`]
						: [],
				)
			: [];
		const text = questionText(question.instructions);
		return {
			id,
			...(typeof question.type === "string" ? { type: question.type } : {}),
			...(text === undefined ? {} : { text }),
			...(criteria.length > 0 ? { criteria } : {}),
		};
	});
}

/** One answer an ask_jev call came back with, as its result details record it:
 * a `noul` probability, a `choice`, or a `score` position, plus the classifier's
 * confidence in it. */
interface JevAnswer {
	readonly id: string;
	readonly value: string;
	readonly confidence?: number;
	/** The classifier's distribution over the question's labels, when it sent one. */
	readonly probabilities?: readonly (readonly [string, number])[];
	/** A score answer's levels, index to label. */
	readonly legend?: readonly (readonly [string, string])[];
}

function jevAnswers(
	details: Readonly<Record<string, unknown>> | undefined,
): JevAnswer[] {
	const answers = isRecord(details?.answers) ? details.answers : undefined;
	if (!answers) return [];
	return Object.entries(answers).map(([id, answer]) => {
		const record = isRecord(answer) ? answer : {};
		const confidence =
			typeof record.confidence === "number" ? record.confidence : undefined;
		const probabilities = isRecord(record.probabilities)
			? Object.entries(record.probabilities)
					.filter(
						(entry): entry is [string, number] => typeof entry[1] === "number",
					)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 6)
			: [];
		const legend = isRecord(record.legend)
			? Object.entries(record.legend).flatMap(([index, label]) =>
					typeof label === "string" ? [[index, label] as const] : [],
				)
			: [];
		const value =
			typeof record.noul === "number"
				? record.noul.toFixed(2)
				: typeof record.choice === "string"
					? record.choice
					: typeof record.score === "number"
						? record.score.toFixed(2)
						: "no answer";
		return {
			id,
			value,
			...(confidence === undefined ? {} : { confidence }),
			...(probabilities.length > 1 ? { probabilities } : {}),
			...(legend.length > 0 ? { legend } : {}),
		};
	});
}

/** What an ask_jev call judged, from the sources its arguments named. */
function jevSources(
	args: Readonly<Record<string, unknown>>,
): string | undefined {
	const parts: string[] = [];
	const reuse = stringArg(args, "reuse");
	if (reuse) parts.push(`reuse ${reuse}`);
	const paths = Array.isArray(args.paths) ? args.paths.length : 0;
	if (paths > 0) parts.push(`files (${paths})`);
	const command = stringArg(args, "command");
	if (command) parts.push(`$ ${command}`);
	if (parts.length === 0 && args.state !== undefined) parts.push("your state");
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** One answered question as its own rows: what was asked, the verdict with its
 * confidence, the distribution behind it, and the levels a score landed on. */
function jevQuestionRows(
	question: JevQuestion | undefined,
	answer: JevAnswer,
): ToolViewRow[] {
	const id = answer.id;
	const type = question?.type ? ` (${question.type})` : "";
	const rows: ToolViewRow[] = [];
	if (question?.text) rows.push({ text: question.text, tone: "muted" });
	rows.push({
		text: `${id}${type} · ${answer.value}${
			answer.confidence === undefined
				? ""
				: ` · confidence ${answer.confidence.toFixed(2)}`
		}`,
		tone: "base",
	});
	if (answer.probabilities)
		rows.push({
			text: answer.probabilities
				.map(([label, value]) => `${label} ${value.toFixed(2)}`)
				.join(" · "),
			tone: "muted",
		});
	if (answer.legend)
		rows.push({
			text: answer.legend
				.map(([index, label]) => `${index} ${label}`)
				.join(" · "),
			tone: "muted",
		});
	for (const criterion of question?.criteria ?? [])
		rows.push({ text: criterion, tone: "muted" });
	return rows;
}

/** The answer body of an ask_jev result, without its own header block; its
 * low-confidence cautions keep the warning tone. */
function jevRows(lines: readonly string[]): ToolViewRow[] {
	const body = lines[0]?.startsWith("## Jev") ? lines.slice(2) : lines;
	return body.map((text) => ({
		text,
		tone: text.startsWith("- ") ? ("warning" as const) : ("muted" as const),
	}));
}

/** `ask_jev`: the verdict it came back with and the state it judged. */
function jevView(call: AgentSessionToolCall): ToolView {
	const questions = jevQuestions(call.args.questions);
	const answers = jevAnswers(call.result?.details);
	const lowest = answers
		.flatMap((answer) =>
			answer.confidence === undefined ? [] : [answer.confidence],
		)
		.reduce<number | undefined>(
			(least, value) => (least === undefined ? value : Math.min(least, value)),
			undefined,
		);
	const sources = jevSources(call.args);
	const hint = [
		lowest === undefined ? undefined : `conf ${lowest.toFixed(2)}`,
		sources,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	// Expanded, each question reads as itself: what the agent asked, the verdict
	// with its confidence, and the distribution the classifier put behind it. A
	// call with no structured answers (a failed one) keeps its own text.
	const rows: ToolViewRow[] = [];
	for (const answer of answers) {
		rows.push(
			...jevQuestionRows(
				questions.find((question) => question.id === answer.id),
				answer,
			),
		);
	}
	for (const warning of jevRows(call.result?.lines ?? []).filter((row) =>
		row.text.startsWith("- "),
	))
		rows.push(warning);
	return {
		icon: "◆",
		summary:
			answers.length > 0
				? answers.map((answer) => `${answer.id} → ${answer.value}`).join(" · ")
				: questions.length > 0
					? questions.map((question) => question.id).join(", ")
					: "judgment",
		...(hint.length > 0 ? { hint } : {}),
		rows: rows.length > 0 ? rows : jevRows(call.result?.lines ?? []),
	};
}

/** One resolved option a dialogue call offered: the label the developer saw,
 * the value an answer matches, and the marker and detail the asking agent
 * attached to it. */
interface QuestionOption {
	readonly label: string;
	readonly value: string;
	readonly recommended: boolean;
	readonly description?: string;
}

/** One question a dialogue call asked, as the view reads it out of the call's
 * arguments and the CLI's result: the single form's record carries the text,
 * options, status and answer; the questionnaire form's items carry the text and
 * options while the group result carries only the answers. */
interface DialogueQuestion {
	readonly ident?: string;
	readonly text?: string;
	readonly context?: string;
	readonly options: readonly QuestionOption[];
	readonly status?: string;
	readonly answer?: {
		readonly kind: "option" | "custom" | "cancel";
		readonly value?: string;
	};
}

/** One option, narrowed from whatever the JSON carried and resolved through the
 * contract's own legacy `label`/`value` rules. */
function questionOption(value: unknown): QuestionOption | undefined {
	if (!isRecord(value)) return undefined;
	const resolved = resolveDeveloperQuestionOption({
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.label === "string" ? { label: value.label } : {}),
		...(typeof value.value === "string" ? { value: value.value } : {}),
		...(value.recommended === true ? { recommended: true } : {}),
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
	});
	if (resolved.label.length === 0) return undefined;
	return {
		label: resolved.label,
		value: resolved.value,
		recommended: resolved.recommended === true,
		...(resolved.description?.trim()
			? { description: resolved.description }
			: {}),
	};
}

function questionOptions(value: unknown): QuestionOption[] {
	return Array.isArray(value)
		? value.flatMap((entry) => questionOption(entry) ?? [])
		: [];
}

/** The question's own words: the questionnaire form's `question`, the single
 * form's `description`. */
function dialogueQuestionText(
	source: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const key of ["question", "description"]) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function questionAnswer(
	value: unknown,
): DialogueQuestion["answer"] | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.kind !== "option" &&
		value.kind !== "custom" &&
		value.kind !== "cancel"
	)
		return undefined;
	return {
		kind: value.kind,
		...(typeof value.value === "string" ? { value: value.value } : {}),
	};
}

/** The JSON the `developer_question`/`agent_ask` CLI prints: the question's own
 * record, or the group header the questionnaire form returns. Anything else —
 * an error the tool reported, a pending call — is not a record. */
function questionRecord(
	lines: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
	const text = lines.join("\n").trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The questions a call asked, paired with what came back: the questionnaire
 * form's items and the group result's responses are matched by `itemIndex` (a
 * response without one falls back to its position). */
function dialogueQuestions(
	args: Readonly<Record<string, unknown>>,
	record: Readonly<Record<string, unknown>> | undefined,
): DialogueQuestion[] {
	const items = Array.isArray(args.questions)
		? args.questions.filter(isRecord)
		: [];
	const status = typeof record?.status === "string" ? record.status : undefined;
	if (items.length > 0) {
		const responses = Array.isArray(record?.responses) ? record.responses : [];
		const byIndex = new Map<number, Readonly<Record<string, unknown>>>();
		responses.forEach((response, position) => {
			if (!isRecord(response)) return;
			byIndex.set(
				typeof response.itemIndex === "number" ? response.itemIndex : position,
				response,
			);
		});
		return items.map((item, index) => {
			const text = dialogueQuestionText(item);
			const answer = questionAnswer(byIndex.get(index)?.answer);
			return {
				...(typeof item.ident === "string" ? { ident: item.ident } : {}),
				...(text === undefined ? {} : { text }),
				...(typeof item.context === "string" ? { context: item.context } : {}),
				options: questionOptions(item.options),
				...(status === undefined ? {} : { status }),
				...(answer === undefined ? {} : { answer }),
			};
		});
	}
	// The single form: the result is the question's own record, so it carries
	// the text, the options, and the answer; a call without a result yet has
	// only its arguments. Its context is not part of the question — the view
	// hoists it above, so it is not drawn twice.
	const source = record ?? {};
	const text = dialogueQuestionText(source) ?? dialogueQuestionText(args);
	const options = questionOptions(
		Array.isArray(source.options) ? source.options : args.options,
	);
	const answer = questionAnswer(source.answer);
	return [
		{
			...(typeof source.ident === "string" ? { ident: source.ident } : {}),
			...(text === undefined ? {} : { text }),
			options,
			...(status === undefined ? {} : { status }),
			...(answer === undefined ? {} : { answer }),
		},
	];
}

function optionSelected(
	question: DialogueQuestion,
	option: QuestionOption,
): boolean {
	const answer = question.answer;
	if (answer?.kind !== "option") return false;
	return answer.value === option.value || answer.value === option.label;
}

/** What the question row says after the question itself: the chosen answer, or
 * why there is none. */
function answerSummary(question: DialogueQuestion): string | undefined {
	const answer = question.answer;
	if (!answer)
		return question.status === "pending"
			? "… pending"
			: question.status === "expired"
				? "⊘ expired"
				: question.status === "cancelled"
					? "⊘ cancelled"
					: undefined;
	if (answer.kind === "cancel")
		return question.status === "expired" ? "⊘ expired" : "⊘ cancelled";
	if (answer.kind === "custom") return `→ “${oneLine(answer.value ?? "", 80)}”`;
	const selected =
		question.options.find((option) => option.value === answer.value) ??
		question.options.find((option) => option.label === answer.value);
	return `→ ${oneLine(selected?.label ?? answer.value ?? "selected", 80)}`;
}

function questionTone(question: DialogueQuestion): "base" | "warning" {
	if (
		question.answer?.kind === "cancel" ||
		question.status === "pending" ||
		question.status === "expired" ||
		question.status === "cancelled"
	)
		return "warning";
	return "base";
}

/** One question's fold: the context it came with, rendered as the markdown it
 * is, then every option it offered, the chosen one marked. */
function questionDetail(
	question: DialogueQuestion,
	index: number,
): ToolViewRow[] {
	const rows: ToolViewRow[] = [];
	if (question.context?.trim())
		rows.push({ text: question.context, tone: "muted", markdown: true });
	question.options.forEach((option, position) => {
		const selected = optionSelected(question, option);
		rows.push({
			id: `question:${index}:option:${position}`,
			text: `${selected ? "●" : "○"}${option.recommended ? " ★" : "  "} ${option.label}`,
			tone: selected ? "success" : option.recommended ? "info" : "muted",
			...(option.description
				? {
						detail: [
							{
								text: option.description,
								tone: "muted" as const,
								markdown: true,
							},
						],
					}
				: {}),
		});
	});
	const custom =
		question.answer?.kind === "custom"
			? question.answer.value?.trim()
			: undefined;
	if (custom)
		rows.push({ text: `custom: ${oneLine(custom, 400)}`, tone: "base" });
	return rows;
}

function dialogueRows(
	questions: readonly DialogueQuestion[],
	context: string | undefined,
): ToolViewRow[] {
	const rows: ToolViewRow[] = [];
	if (context?.trim())
		rows.push({
			id: "context",
			text: "context",
			tone: "muted",
			detail: [{ text: context, tone: "muted", markdown: true }],
		});
	questions.forEach((question, index) => {
		// One blank line between the question groups, so a questionnaire reads as
		// groups rather than as one list.
		if (rows.length > 0) rows.push({ text: "", tone: "muted" });
		const detail = questionDetail(question, index);
		const summary = answerSummary(question);
		const prefix =
			question.ident ?? (questions.length > 1 ? String(index + 1) : undefined);
		rows.push({
			id: `question:${index}`,
			text: `${prefix === undefined ? "" : `[${prefix}] `}${oneLine(
				question.text ?? "question",
				200,
			)}${summary === undefined ? "" : `   ${summary}`}`,
			tone: questionTone(question),
			...(detail.length > 0 ? { detail } : {}),
		});
	});
	return rows;
}

/** `developer_question` / `agent_ask`: the question a run asked, the context
 * the developer needs, and every answer it could pick — the chosen one marked —
 * as folds, so a questionnaire stays readable without hiding its background.
 * A call that names no question at all keeps the generic row. */
function dialogueView(call: AgentSessionToolCall): ToolView | undefined {
	const lines = call.result?.lines ?? [];
	const record = questionRecord(lines);
	const questions = dialogueQuestions(call.args, record).filter(
		(question) =>
			question.text !== undefined ||
			question.options.length > 0 ||
			question.context !== undefined,
	);
	if (questions.length === 0) return undefined;
	const status = typeof record?.status === "string" ? record.status : undefined;
	const requester =
		call.name === "agent_ask"
			? `peer ${stringArg(call.args, "role") ?? "agent"}`
			: "developer";
	const headline =
		questions.length > 1
			? `${questions.length} questions`
			: (questions[0]?.text ?? "question");
	// A single question keeps its context at the top; a questionnaire's items
	// each carry their own inside the question's fold.
	const context =
		Array.isArray(call.args.questions) || questions.length !== 1
			? undefined
			: typeof record?.context === "string"
				? record.context
				: stringArg(call.args, "context");
	const rows = dialogueRows(questions, context);
	// A result that is not a question record — an error the tool reported, a
	// host without the dialogue — keeps its own words under the question.
	if (record === undefined && lines.length > 0)
		rows.push(
			...lines.map((text) => ({
				text,
				tone:
					call.result?.isError === true
						? ("error" as const)
						: ("muted" as const),
			})),
		);
	return {
		icon: "?",
		summary: oneLine(headline, 160),
		hint: `${status ?? "asking"} · ${requester}`,
		rows,
	};
}

/** One tool call a codemode script made: its name, how it ended, and — when the
 * host sent the structured record — what it asked for. */
interface CodemodeCall {
	readonly name: string;
	readonly status: string;
	readonly args?: Readonly<Record<string, unknown>>;
	readonly durationMs?: number;
	/** What the call returned, as the script received it. */
	readonly output?: string;
	readonly isError?: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}

/** The calls a codemode result reports. The host's structured `details.calls`
 * carry each call's arguments; the result's own `calls: a (ok), b (error)` line
 * is the fallback for a host that predates them. */
function codemodeCalls(
	details: Readonly<Record<string, unknown>> | undefined,
	lines: readonly string[],
): CodemodeCall[] {
	const structured = Array.isArray(details?.calls) ? details.calls : undefined;
	if (structured) {
		return structured.flatMap((entry) => {
			if (!isRecord(entry) || typeof entry.name !== "string") return [];
			return [
				{
					name: entry.name,
					status: typeof entry.status === "string" ? entry.status : "ok",
					...(isRecord(entry.args) ? { args: entry.args } : {}),
					...(typeof entry.durationMs === "number"
						? { durationMs: entry.durationMs }
						: {}),
					...(typeof entry.output === "string" ? { output: entry.output } : {}),
					...(entry.isError === true ? { isError: true } : {}),
					...(isRecord(entry.details) ? { details: entry.details } : {}),
				},
			];
		});
	}
	const line = lines.find((entry) => entry.startsWith("calls: "));
	if (!line) return [];
	return line
		.slice("calls: ".length)
		.split(", ")
		.flatMap((entry) => {
			const match = /^(.+) \((\w+)\)$/.exec(entry);
			return match ? [{ name: match[1] ?? "", status: match[2] ?? "" }] : [];
		});
}

/** The first argument worth naming, for a tool that has no view of its own. */
function primaryArg(
	args: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const value of Object.values(args))
		if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

/** One call line. With the call's arguments the line borrows the tool's own
 * specialized subject — a script's read names its file, its bash its command —
 * and a tool without a view keeps its type glyph and names its first argument. */
function codemodeCallText(call: CodemodeCall): string {
	const view = call.args
		? toolView({ name: call.name, args: call.args })
		: undefined;
	const primary = call.args ? primaryArg(call.args) : undefined;
	// The name is prefixed once, so a generic tool's subject is its argument.
	const subject = view ? view.summary : (primary ?? "");
	const hint = view?.hint ? ` · ${view.hint}` : "";
	// The name stays on the line: the glyph alone does not say which tool ran.
	const named = subject.length > 0 ? `${call.name} ${subject}` : call.name;
	return `${view?.icon ?? toolIcon(call.name)} ${named}${hint} (${call.status})`;
}

/** The first line of a script that says something: its own `// @options:` line
 * is configuration, not a headline. */
function codemodeHeadline(code: string): string {
	const line = code
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0 && !entry.startsWith("// @"));
	return line ?? "script";
}

/** The script's own source, whole, as the one highlighted code row of its
 * section: the source is JavaScript, and the tree-sitter pass needs it whole to
 * highlight it. */
function codemodeScriptRows(code: string): ToolViewRow[] {
	return code.length === 0
		? []
		: [{ text: code, tone: "base" as const, syntax: "javascript" }];
}

/** One line per call a script made: its name and how it ended, failures in the
 * error tone. This is the collapsed view's whole content — the shape of the
 * work — and stays visible once expanded. */
function codemodeCallRows(calls: readonly CodemodeCall[]): ToolViewRow[] {
	return calls.map((entry, index) => {
		const detail = codemodeCallDetail(entry);
		return {
			id: `call:${index}`,
			text: codemodeCallText(entry),
			tone: entry.status === "ok" ? ("muted" as const) : ("error" as const),
			...(detail.length > 0 ? { detail } : {}),
		};
	});
}

/** The result a call reported, as the projection's own result shape, so a call
 * row can render through the same view its standalone transcript row would. */
function codemodeCallResult(
	call: CodemodeCall,
): AgentSessionToolCall["result"] | undefined {
	if (call.output === undefined && call.details === undefined) return undefined;
	return {
		lines: (call.output ?? "")
			.split("\n")
			.map((line) => line.replace(/\s+$/g, ""))
			.filter((line) => line.length > 0),
		isError: call.isError === true,
		...(call.details === undefined ? {} : { details: call.details }),
		notes: [],
	};
}

/** A call's own view, as the rows it would show in the transcript: the answers
 * a judgment came back with, the diff an edit produced, the text a read read.
 * A call whose view has nothing to show still opens into the text it answered
 * with, so every call that produced something can be read in place. */
function codemodeCallDetail(call: CodemodeCall): readonly ToolViewRow[] {
	const result = codemodeCallResult(call);
	const view = toolView({
		name: call.name,
		args: call.args ?? {},
		...(result ? { result } : {}),
	});
	const rows = view?.rows ?? [];
	if (rows.length > 0) return rows;
	return (call.output ?? "")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.filter((line) => line.length > 0)
		.map((text) => ({ text, tone: "muted" as const }));
}

/** `codemode`: collapsed, the one-line script summary (`λ 11 calls · 0.5s`).
 * Expanded, the calls the script made — one line each, each folding into its
 * own tool view — with the script that made them and what it produced kept as
 * compact parts that open on demand, so the call list stays the whole view. */
function codemodeView(call: AgentSessionToolCall): ToolView {
	const code = stringArg(call.args, "code") ?? "";
	const lines = call.result?.lines ?? [];
	const calls = codemodeCalls(call.result?.details, lines);
	const failed = call.result?.isError === true;
	const errors = calls.filter((entry) => entry.status !== "ok").length;
	const script = codemodeScriptRows(code);
	const output: ToolViewRow[] = lines.map((text) => ({
		text,
		tone: failed ? ("error" as const) : ("muted" as const),
	}));
	// The row is the call's own metadata — how much it ran, what failed, how long
	// it spent in tools — and every call gets its own line below it.
	const spent = calls.reduce(
		(total, entry) => total + (entry.durationMs ?? 0),
		0,
	);
	const summary = [
		calls.length > 0 ? `${calls.length} calls` : undefined,
		errors > 0 ? `${errors} failed` : undefined,
		failed ? "script failed" : undefined,
		spent > 0 ? formatDuration(spent) : undefined,
	].filter((part): part is string => part !== undefined);
	return {
		icon: "λ",
		summary: summary.length > 0 ? summary.join(" · ") : codemodeHeadline(code),
		rows: codemodeCallRows(calls),
		sections: [
			...(script.length > 0
				? [{ id: "script", label: "script", rows: script, collapsed: true }]
				: []),
			...(output.length > 0
				? [{ id: "output", label: "output", rows: output, collapsed: true }]
				: []),
		],
	};
}

/** The specialized view of one tool call, or undefined when the tool keeps the
 * generic row (icon, name, primary argument). */
export function toolView(call: AgentSessionToolCall): ToolView | undefined {
	switch (call.name) {
		case "read":
			return readView(call);
		case "edit":
			return editView(call);
		case "write":
			return writeView(call);
		case "bash":
			return bashView(call);
		case "ask_jev":
			return jevView(call);
		case "developer_question":
		case "agent_ask":
			return dialogueView(call);
		case "codemode":
			return codemodeView(call);
		default:
			return undefined;
	}
}
