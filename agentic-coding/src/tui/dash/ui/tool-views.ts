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
import type { AgentSessionToolCall } from "../agent-session.ts";

/** One row of an expanded tool view, with the tone it is drawn in. */
export interface ToolViewRow {
	readonly text: string;
	readonly tone: "base" | "muted" | "error" | "warning" | "success" | "info";
}

/** A tool call's transcript view: the summary line, the hint beside it, and the
 * rows that appear when the row is expanded. */
export interface ToolView {
	readonly icon: string;
	readonly summary: string;
	readonly hint?: string;
	readonly rows?: readonly ToolViewRow[];
}

/** Expanded rows kept per tool view: enough for a diff or a command's output
 * without letting one call own the transcript. */
const MAX_VIEW_ROWS = 40;

/** Script lines shown in a codemode view before the output would be pushed off
 * screen. */
const MAX_SCRIPT_ROWS = 12;

function stringArg(
	args: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
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
	return diff
		.split("\n")
		.slice(0, MAX_VIEW_ROWS)
		.map((line): ToolViewRow => {
			if (line.startsWith("+")) return { text: line, tone: "success" };
			if (line.startsWith("-")) return { text: line, tone: "error" };
			if (line.startsWith("@@")) return { text: line, tone: "info" };
			return { text: line, tone: "muted" };
		});
}

/** `read`: the file, the range that came back, and the text itself. */
function readView(call: AgentSessionToolCall): ToolView {
	const path = stringArg(call.args, "path") ?? "file";
	const lines = call.result?.lines ?? [];
	const range = readRange(call.result?.notes ?? []);
	return {
		icon: "→",
		summary: path,
		hint: range ?? (lines.length > 0 ? `${lines.length} lines` : undefined),
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
		rows: lines.slice(0, MAX_VIEW_ROWS).map((text) => ({
			text,
			tone: "muted" as const,
		})),
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

/** The ids an ask_jev call asked about: the question block's own keys, whether
 * the agent passed the record or its JSON string. */
function jevQuestions(value: unknown): string[] {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return [];
		}
	}
	return isRecord(parsed) ? Object.keys(parsed) : [];
}

/** One answer an ask_jev call came back with, as its result details record it:
 * a `noul` probability, a `choice`, or a `score` position, plus the classifier's
 * confidence in it. */
interface JevAnswer {
	readonly id: string;
	readonly value: string;
	readonly confidence?: number;
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
		const value =
			typeof record.noul === "number"
				? record.noul.toFixed(2)
				: typeof record.choice === "string"
					? record.choice
					: typeof record.score === "number"
						? record.score.toFixed(2)
						: "no answer";
		return { id, value, ...(confidence === undefined ? {} : { confidence }) };
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
	return {
		icon: "◆",
		summary:
			answers.length > 0
				? answers.map((answer) => `${answer.id} → ${answer.value}`).join(" · ")
				: questions.length > 0
					? questions.join(", ")
					: "judgment",
		...(hint.length > 0 ? { hint } : {}),
		rows: jevRows(call.result?.lines ?? []),
	};
}

/** One tool call a codemode script made, as its result line records it. */
interface CodemodeCall {
	readonly name: string;
	readonly status: string;
}

/** The calls a codemode result reports: its trailing `calls: a (ok), b (error)`
 * line, in the order the script made them. */
function codemodeCalls(lines: readonly string[]): CodemodeCall[] {
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

/** The first line of a script that says something: its own `// @options:` line
 * is configuration, not a headline. */
function codemodeHeadline(code: string): string {
	const line = code
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0 && !entry.startsWith("// @"));
	return line ?? "script";
}

/** The script's own source, bounded, as the first rows of its expanded view. */
function codemodeScriptRows(code: string): ToolViewRow[] {
	const lines = code.split("\n");
	const shown = lines.slice(0, MAX_SCRIPT_ROWS);
	return [
		...shown.map((text) => ({ text, tone: "base" as const })),
		...(lines.length > shown.length
			? [
					{
						text: `… ${lines.length - shown.length} more lines`,
						tone: "muted" as const,
					},
				]
			: []),
	];
}

/** `codemode`: the pipeline a script drove, and (expanded) the script itself
 * followed by what it produced. A script is its own program, so the collapsed
 * row names the tools it called — the shape of the work — and the expanded view
 * shows the source that did it. */
function codemodeView(call: AgentSessionToolCall): ToolView {
	const code = stringArg(call.args, "code") ?? "";
	const lines = call.result?.lines ?? [];
	const calls = codemodeCalls(lines);
	const failed = call.result?.isError === true;
	const errors = calls.filter((entry) => entry.status !== "ok").length;
	const hint = failed
		? "failed"
		: calls.length > 0
			? `${calls.length} calls${errors > 0 ? ` · ${errors} failed` : ""}`
			: undefined;
	return {
		icon: "λ",
		summary:
			calls.length > 0
				? calls.map((entry) => entry.name).join(" → ")
				: codemodeHeadline(code),
		...(hint === undefined ? {} : { hint }),
		rows:
			lines.length === 0
				? codemodeScriptRows(code)
				: [
						...codemodeScriptRows(code),
						{ text: "", tone: "muted" as const },
						...lines.map((text) => ({
							text,
							tone: failed ? ("error" as const) : ("muted" as const),
						})),
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
