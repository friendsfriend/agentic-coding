// Specialized transcript views for the tools a durable run leans on
// (dashboard-agent-session-view). A tool row's generic shape — icon, name,
// primary argument — says little about what a `read`, `edit`, `write` or `bash`
// call actually did, so each of those gets a view built from the call's
// arguments and its result: the file and range a read covered, the diff an edit
// produced, the command a bash call ran and how it ended.
//
// Presentation only and pure: a block's structured tool data in, rows out. A
// tool without a specialized view here (the dialogue tools, anything a future
// host adds) keeps the generic row.
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
	readonly detail?: readonly ToolViewRow[];
}

/** One independently collapsible part of an expanded tool view. */
export interface ToolViewSection {
	readonly id: string;
	readonly label: string;
	readonly rows: readonly ToolViewRow[];
}

/** A tool call's transcript view: the summary line, the hint beside it, the
 * rows under it (always visible once the row is expanded), and the sections a
 * long view splits into so its parts can be read one at a time. */
export interface ToolView {
	readonly icon: string;
	readonly summary: string;
	readonly hint?: string;
	/** Rows that are part of the collapsed view: a script's call list says what
	 * the call did, so it is not a detail to expand into. */
	readonly alwaysRows?: readonly ToolViewRow[];
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

/** `+12 −4` for a diff body. */
function diffCounts(diff: string): string | undefined {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
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

/** `edit`: the file, how much changed, and the diff the tool computed. */
function editView(call: AgentSessionToolCall): ToolView {
	const path = stringArg(call.args, "path") ?? "file";
	const edits = Array.isArray(call.args.edits) ? call.args.edits.length : 0;
	const diff = call.result?.details?.diff;
	const hint = [
		edits > 0 ? `${edits} edit${edits === 1 ? "" : "s"}` : undefined,
		typeof diff === "string" ? diffCounts(diff) : undefined,
	].filter((part): part is string => part !== undefined);
	return {
		icon: "←",
		summary: path,
		...(hint.length > 0 ? { hint: hint.join(" · ") } : {}),
		...(typeof diff === "string" ? { rows: diffRows(diff) } : {}),
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

/** The script's own source, whole, as the first rows of its expanded view. */
function codemodeScriptRows(code: string): ToolViewRow[] {
	return code.split("\n").map((text) => ({ text, tone: "base" as const }));
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
 * a judgment came back with, the diff an edit produced, the text a read read. */
function codemodeCallDetail(call: CodemodeCall): readonly ToolViewRow[] {
	const args = call.args ?? {};
	const view = toolView({
		name: call.name,
		args,
		...(codemodeCallResult(call) ? { result: codemodeCallResult(call) } : {}),
	});
	return view?.rows ?? [];
}

/** `codemode`: the calls a script made, one line each, and — expanded — the
 * script that made them and what it produced, as parts that can be folded away
 * again to keep the call list in view. */
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
		alwaysRows: codemodeCallRows(calls),
		sections: [
			...(script.length > 0
				? [{ id: "script", label: "script", rows: script }]
				: []),
			...(output.length > 0
				? [{ id: "output", label: "output", rows: output }]
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
		case "codemode":
			return codemodeView(call);
		default:
			return undefined;
	}
}
