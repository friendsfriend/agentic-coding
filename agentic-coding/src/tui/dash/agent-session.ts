// Dashboard agent session view for one `pi-durable` run
// (add-pi-durable-runtime, dashboard-agent-session-view). The route owns the
// `HostClient.watch()` subscription and hands each watch frame here; this
// module turns one defensively-parsed conversation snapshot into the blocks
// the session view renders. Presentation only — no host, no I/O — so a shape
// drift in the experimental pi-durable package degrades to fewer blocks
// instead of throwing in the dashboard.
//
// The block vocabulary and its visual language mirror opencode v2's session
// transcript (user prompt block, indented assistant text, tool rows with a
// two-cell icon gutter, muted result output, red error rows); the renderer in
// `ui/AgentSessionView.tsx` owns the actual styling.
import type { SubmitWorkflowState } from "../../agent-host/protocol.ts";

/** Semantic color role of one block; the view maps it to a theme color. */
export type AgentSessionTone =
	| "base"
	| "muted"
	| "error"
	| "warning"
	| "success"
	| "info"
	| "accent";

export type AgentSessionKind =
	| "user"
	| "assistant"
	| "reasoning"
	| "tool"
	| "result"
	| "notice"
	| "error"
	| "compaction"
	| "summary";

/** What a tool call asked for and what came back, as the source recorded it:
 * the transcript's specialized tool views read this instead of re-parsing the
 * summary line. */
export interface AgentSessionToolCall {
	readonly name: string;
	/** The call's arguments. A result without its call carries none. */
	readonly args: Readonly<Record<string, unknown>>;
	/** The call's own id, so a result pairs with the call it answers. */
	readonly callId?: string;
	/** The result, once the call has one. */
	readonly result?: AgentSessionToolResult;
}

export interface AgentSessionToolResult {
	/** The result's text lines, before the harness diagnostics were folded in. */
	readonly lines: readonly string[];
	readonly isError: boolean;
	/** Tool-specific details: `edit`'s diff and patch, `read`'s truncation. */
	readonly details?: Readonly<Record<string, unknown>>;
	/** Harness diagnostics, one message each (truncation, spilled output). */
	readonly notes: readonly string[];
}

export interface AgentSessionBlock {
	/** Stable identity of the source this block came from: a committed entry's
	 * id and its position inside it, or the slot a live block occupies. The
	 * view keys its expansion state and its newest-output marker by it, so both
	 * survive content changes and repeated identical messages elsewhere in the
	 * transcript. */
	readonly id: string;
	readonly kind: AgentSessionKind;
	readonly text: string;
	readonly tone: AgentSessionTone;
	/** Two-cell glyph for tool/notice rows (opencode v2's icon gutter). */
	readonly icon?: string;
	/** A tool call still in flight: rendered in the warning color. */
	readonly pending?: boolean;
	/** A tool call whose generation was aborted before it ever ran: the call
	 * keeps its own row, marked as aborted rather than looking finished. */
	readonly aborted?: boolean;
	/** The block is still being produced (an in-flight generation or a running
	 * tool): its text grows with every watch frame. */
	readonly live?: boolean;
	/** Extra, dimmer lines under the block (tool output, error detail). */
	readonly detail?: readonly string[];
	/** Measured wall-clock duration, when the host recorded one: a thinking
	 * block's reasoning time, or an assistant footer's generation time. */
	readonly durationMs?: number;
	/** When the block's source began, epoch ms, as the host recorded it: a
	 * message's generation start, or — for a tool call — the moment the call was
	 * issued (generation start plus the measured generation time). Absent for a
	 * live block and for an entry that carries no time. */
	readonly startedAt?: number;
	/** When a tool result was recorded, epoch ms. A call's own duration is this
	 * minus its `startedAt`, worked out when the two rows merge. */
	readonly endedAt?: number;
	/** Canonical tool name, so a call and its result can be paired. */
	readonly tool?: string;
	/** The call and result behind a tool row, for the specialized tool views. */
	readonly toolCall?: AgentSessionToolCall;
	/** A merged tool block's request line (icon + name + args), shown when the
	 * answer is expanded. */
	readonly request?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and bound one line so a multi-line model answer cannot
 * push the rest of the transcript out of the view. */
function oneLine(value: unknown, max = 400): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Strip ANSI SGR/CSI runs, with or without their ESC prefix: the durable
 * transcript has already lost the ESC byte for tool output, so a bash result
 * arrives as literal `[0m[31m…` runs that would otherwise render as text. */
function stripAnsi(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point; it is the ANSI prefix.
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
			.replace(/\[[0-9;]*m/g, "")
	);
}

/** pi-durable appends a tool's diagnostics as a `<harness>[error] …</harness>`
 * block (harnessError). The tags are transport detail, not tool output. */
function stripHarness(value: string): string {
	return value
		.replace(/<\/?harness>\s*/g, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/** Split tool output into display lines, newest kept.
 *
 * The harness already bounds what a tool may keep (2000 lines / 50KB, with a
 * diagnostic when it cut something), so the transcript keeps all of it: the
 * expanded tool views are where a result gets read, and a second cut here would
 * hide the part being analyzed. `MAX_OUTPUT_LINES` is only a memory guard for a
 * host that keeps more than the harness does. */
const MAX_OUTPUT_LINES = 2000;

function outputLines(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const lines = stripHarness(stripAnsi(value))
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.filter((line) => line.length > 0);
	return lines.length > MAX_OUTPUT_LINES
		? lines.slice(lines.length - MAX_OUTPUT_LINES)
		: lines;
}

/** Keep a block's text with its line structure (assistant output is rendered
 * as markdown) while bounding how much one block can carry. */
function rawText(value: string, max = 8000): string {
	const text = value.replace(/\r\n?/g, "\n").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Concatenate the text blocks of a serialized pi message content field with
 * their newlines preserved (the markdown-rendered assistant output). */
function contentRaw(content: unknown): string {
	if (typeof content === "string") return rawText(content);
	if (!Array.isArray(content)) return "";
	return rawText(
		content
			.flatMap((block) =>
				isRecord(block) &&
				block.type === "text" &&
				typeof block.text === "string"
					? [block.text]
					: [],
			)
			.join("\n"),
	);
}

/** Concatenate the thinking blocks of a serialized pi message content field,
 * newest character last, the way the committed transcript's reasoning blocks
 * read them. Bounded the same way (one committed reasoning block keeps 4000). */
function contentThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text = content
		.flatMap((block) =>
			isRecord(block) &&
			block.type === "thinking" &&
			typeof block.thinking === "string"
				? [block.thinking]
				: [],
		)
		.join("\n");
	return rawText(text, 4000);
}

/** opencode v2's tool icon gutter, mapped onto pi's tool names. */
const TOOL_ICONS: Record<string, string> = {
	read: "→",
	write: "←",
	edit: "←",
	apply_patch: "←",
	patch: "←",
	glob: "✱",
	grep: "✱",
	find: "✱",
	bash: "$",
	shell: "$",
	execute: "▶",
	task: "✓",
	subagent: "✓",
	webfetch: "%",
	websearch: "◈",
	codemode: "{}",
	developer_question: "?",
	agent_ask: "?",
};
/** The glyph that marks a tool's type in the transcript (shared with the tool
 * views' call lines, so one tool looks the same wherever it appears). */
export function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "•";
}

/** The harness diagnostics a tool result entry carries, one message each. */
function diagnosticsOf(entry: unknown): string[] {
	if (!isRecord(entry) || !isRecord(entry.data)) return [];
	const diagnostics = entry.data.diagnostics;
	if (!Array.isArray(diagnostics)) return [];
	return diagnostics.flatMap((diagnostic) =>
		isRecord(diagnostic) && typeof diagnostic.message === "string"
			? [diagnostic.message]
			: [],
	);
}

/** The reason a compaction ran, as the transcript words it: pi-durable's
 * `manual` is the developer's `/compact`, and both automatic reasons
 * (`threshold` and `overflow`) are the harness's own decision. */
export function compactionReasonLabel(reason: string | undefined): string {
	switch (reason) {
		case "manual":
			return "manual";
		case "threshold":
			return "automatic, threshold";
		case "overflow":
			return "automatic, overflow";
		default:
			return "automatic";
	}
}

/** One committed compaction entry's label, with the measured token movement
 * when it can be measured: pi-durable records no counters for a compaction, so
 * the movement is read from the conversation's own assistant usage around it and
 * omitted rather than invented when either side is missing. */
export function compactionLabel(
	reason: string | undefined,
	before?: number,
	after?: number,
): string {
	const base = `Compaction (${compactionReasonLabel(reason)})`;
	if (before !== undefined && after !== undefined)
		return `${base} · ${formatTokenCount(before)} → ${formatTokenCount(after)} tokens`;
	if (after !== undefined)
		return `${base} · ${formatTokenCount(after)} tokens after`;
	return base;
}

/** Prompt tokens one committed assistant entry's request carried, i.e. the
 * context size at that point of the conversation. */
function entryPromptTokens(entry: unknown): number | undefined {
	if (!isRecord(entry) || entry.kind !== "pi.assistant") return undefined;
	const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
	if (!isRecord(message)) return undefined;
	const usage = isRecord(message.usage) ? message.usage : undefined;
	if (!usage) return undefined;
	const total =
		(finiteNumber(usage.input) ?? 0) +
		(finiteNumber(usage.cacheRead) ?? 0) +
		(finiteNumber(usage.cacheWrite) ?? 0);
	return total > 0 ? total : undefined;
}

/** Full labels of every `pi.compaction` entry of one transcript, keyed by the
 * entry's block key. */
function compactionEntryLabels(
	entries: readonly unknown[],
): ReadonlyMap<string, string> {
	const labels = new Map<string, string>();
	entries.forEach((entry, index) => {
		if (!isRecord(entry) || entry.kind !== "pi.compaction") return;
		const data = isRecord(entry.data) ? entry.data : undefined;
		const reason = typeof data?.reason === "string" ? data.reason : undefined;
		let before: number | undefined;
		for (let cursor = index - 1; cursor >= 0; cursor--) {
			before = entryPromptTokens(entries[cursor]);
			if (before !== undefined) break;
		}
		let after: number | undefined;
		for (let cursor = index + 1; cursor < entries.length; cursor++) {
			after = entryPromptTokens(entries[cursor]);
			if (after !== undefined) break;
		}
		labels.set(entryId(entry, index), compactionLabel(reason, before, after));
	});
	return labels;
}

/** The primary argument of a tool call, chosen the way opencode v2 picks the
 * headline of an inline tool row. */
const PRIMARY_ARGS = [
	"command",
	"path",
	"filePath",
	"file_path",
	"pattern",
	"url",
	"query",
	"description",
	"prompt",
];
function argsSummary(value: unknown): string {
	if (!isRecord(value)) return "";
	const entries = Object.entries(value).filter(([, entry]) =>
		["string", "number", "boolean"].includes(typeof entry),
	);
	if (entries.length === 0) return "";
	const primary =
		PRIMARY_ARGS.map((key) => entries.find(([name]) => name === key)).find(
			(entry) => entry !== undefined,
		) ?? entries[0];
	if (!primary) return "";
	const [key, entry] = primary;
	return oneLine(`${key}=${String(entry)}`, 160);
}

/** A tool call's arguments as the transcript reads them: the record the source
 * recorded, or the JSON string a streaming partial may still be carrying (a
 * provider that streams the raw payload before it parses). */
function toolArgs(value: unknown): Readonly<Record<string, unknown>> {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			/* a partial JSON string mid-stream: the name is known, the arguments are not */
		}
	}
	return {};
}

/** Render one committed transcript entry as zero or more blocks. Unknown entry
 * kinds are skipped rather than guessed at. */
function entryBlocks(
	entry: unknown,
	timings: Readonly<Record<string, EntryTiming>>,
	entryKey: string,
	/** Full labels of this frame's compaction entries, keyed by block key: the
	 * measurement needs the whole entry list, which a single entry does not have. */
	compactionLabels: ReadonlyMap<string, string> = new Map(),
): AgentSessionBlock[] {
	if (!isRecord(entry)) return [];
	const model = Array.isArray(entry.model) ? entry.model : [];
	const timing = typeof entry.id === "string" ? timings[entry.id] : undefined;
	switch (entry.kind) {
		case "pi.user":
			return (
				model
					.map((message) => ({
						text: oneLine(isRecord(message) ? message.content : ""),
						at: isRecord(message) ? finiteNumber(message.timestamp) : undefined,
					}))
					.filter((message) => message.text)
					// The user's own prompt is the accent-colored box, distinct from the
					// model's neutral messages.
					.map(
						({ text, at }, index): AgentSessionBlock => ({
							id: `${entryKey}:${index}`,
							kind: "user",
							text,
							tone: "accent",
							...(at !== undefined ? { startedAt: at } : {}),
						}),
					)
			);
		case "pi.assistant": {
			const blocks: AgentSessionBlock[] = [];
			for (const message of model) {
				if (!isRecord(message) || !Array.isArray(message.content)) continue;
				// The message's timestamp is the generation's start. A tool call is
				// issued when the generation ends, so its own start adds the measured
				// generation time — without it the call carries no start rather than
				// one that would count the model's thinking as the tool's time.
				const generationStart = finiteNumber(message.timestamp);
				const callStart =
					generationStart !== undefined && timing?.generationMs !== undefined
						? generationStart + timing.generationMs
						: undefined;
				for (const block of message.content) {
					if (!isRecord(block)) continue;
					const id = `${entryKey}:${blocks.length}`;
					if (block.type === "text" && typeof block.text === "string") {
						// Assistant output keeps its line structure: the view renders it
						// as markdown, not as a collapsed one-liner.
						const text = rawText(block.text);
						if (text)
							blocks.push({ id, kind: "assistant", text, tone: "base" });
					} else if (
						block.type === "thinking" &&
						typeof block.thinking === "string"
					) {
						const text = rawText(block.thinking, 4000);
						if (text)
							blocks.push({
								id,
								kind: "reasoning",
								text,
								tone: "muted",
								...(timing?.thinkingMs !== undefined
									? { durationMs: timing.thinkingMs }
									: {}),
								...(generationStart !== undefined
									? { startedAt: generationStart }
									: {}),
							});
					} else if (
						block.type === "toolCall" &&
						typeof block.name === "string"
					) {
						const args = argsSummary(block.arguments);
						// An aborted generation commits its partial with `stopReason:
						// "aborted"`: the call never ran, so its row is marked rather than
						// read as a finished call.
						const aborted = message.stopReason === "aborted";
						blocks.push({
							id,
							kind: "tool",
							text: `${block.name}${args ? ` ${args}` : ""}`,
							tone: aborted ? "warning" : "muted",
							icon: toolIcon(block.name),
							tool: block.name,
							...(aborted ? { aborted: true } : {}),
							...(callStart !== undefined ? { startedAt: callStart } : {}),
							toolCall: {
								name: block.name,
								args: toolArgs(block.arguments),
								...(typeof block.id === "string" ? { callId: block.id } : {}),
							},
						});
					}
				}
				// A failed generation commits an empty assistant entry with the
				// provider error; without this the run looks idle with no explanation.
				if (
					message.stopReason === "error" &&
					typeof message.errorMessage === "string"
				)
					blocks.push({
						id: `${entryKey}:${blocks.length}`,
						kind: "error",
						text: oneLine(message.errorMessage, 400),
						tone: "error",
					});
			}
			return blocks;
		}
		case "pi.tool-result":
			return model.flatMap((message, index): AgentSessionBlock[] => {
				if (!isRecord(message)) return [];
				const notes = diagnosticsOf(entry);
				const name =
					typeof message.toolName === "string" ? message.toolName : "tool";
				const failed = message.isError === true;
				const endedAt = finiteNumber(message.timestamp);
				const lines = outputLines(
					typeof message.content === "string"
						? message.content
						: Array.isArray(message.content)
							? message.content
									.filter((part) => isRecord(part) && part.type === "text")
									.map((part) => (isRecord(part) ? part.text : ""))
									.join("\n")
							: "",
				);
				const [first] = lines;
				return [
					{
						id: `${entryKey}:${index}`,
						toolCall: {
							name,
							args: {},
							...(typeof message.toolCallId === "string"
								? { callId: message.toolCallId }
								: {}),
							result: {
								lines,
								isError: failed,
								...(isRecord(message.details)
									? { details: message.details }
									: {}),
								notes,
							},
						},
						kind: "result",
						text: first
							? `${name}: ${oneLine(first, 2000)}`
							: `${name} ${failed ? "failed" : "done"}`,
						// The result box carries the tool's outcome, so a successful
						// result is green and a failed one red.
						tone: failed ? "error" : "success",
						icon: failed ? "✗" : "✓",
						tool: name,
						...(endedAt !== undefined ? { endedAt } : {}),
						// All lines, so expanding the paired tool block shows the whole
						// answer (the collapsed header is `text`).
						...(lines.length > 0 ? { detail: lines } : {}),
					},
				];
			});
		case "pi.compaction": {
			const data = isRecord(entry.data) ? entry.data : undefined;
			const reason = typeof data?.reason === "string" ? data.reason : undefined;
			return [
				{
					id: `${entryKey}:compaction`,
					kind: "compaction",
					text: compactionLabels.get(entryKey) ?? compactionLabel(reason),
					tone: "muted",
				},
			];
		}
		case "pi.reset":
			return [
				{
					id: `${entryKey}:reset`,
					kind: "compaction",
					text: "Context reset",
					tone: "muted",
				},
			];
		default:
			return [];
	}
}

/** The tool calls a still-streaming generation has emitted. The partial carries
 * each call as pi-ai builds it: the name as soon as the provider names the tool
 * and the arguments as they parse, so a `write` shows its path and the size of
 * the content it is producing long before the call is committed and executed.
 * Each call carries its id, so it pairs with the committed call and the running
 * slot that replace it instead of appearing beside them. */
function partialToolBlocks(
	message: Readonly<Record<string, unknown>>,
): AgentSessionBlock[] {
	if (!Array.isArray(message.content)) return [];
	const blocks: AgentSessionBlock[] = [];
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		if (typeof block.name !== "string") continue;
		const name = block.name;
		const args = toolArgs(block.arguments);
		const summary = argsSummary(args);
		blocks.push({
			id: `live:toolcall:${blocks.length}`,
			live: true,
			kind: "tool",
			text: summary ? `${name} ${summary}` : name,
			tone: "warning",
			icon: toolIcon(name),
			pending: true,
			tool: name,
			toolCall: {
				name,
				args,
				...(typeof block.id === "string" ? { callId: block.id } : {}),
			},
		});
	}
	return blocks;
}

/** The live in-flight generation and running tools, which the committed
 * transcript does not carry yet. */
function liveBlocks(
	live: Record<string, unknown> | undefined,
): AgentSessionBlock[] {
	if (!live) return [];
	const blocks: AgentSessionBlock[] = [];
	const tools = Array.isArray(live.tools) ? live.tools : [];
	for (const [index, slot] of tools.entries()) {
		if (!isRecord(slot) || slot.status === "done") continue;
		const name = typeof slot.name === "string" ? slot.name : "tool";
		// The call's own id pairs this running slot with the assistant call it
		// started, so its row is the committed one upgraded to running (in place)
		// instead of a second row beside it.
		const callId = typeof slot.callId === "string" ? slot.callId : undefined;
		const detail = outputLines(slot.output);
		blocks.push({
			id: `live:tool:${index}`,
			live: true,
			kind: "tool",
			text: name,
			tone: "warning",
			icon: toolIcon(name),
			pending: true,
			tool: name,
			toolCall: { name, args: {}, ...(callId === undefined ? {} : { callId }) },
			...(detail.length > 0 ? { detail } : {}),
		});
	}
	const generation = isRecord(live.generation) ? live.generation : undefined;
	if (generation) {
		if (
			isRecord(generation.retry) &&
			typeof generation.retry.error === "string"
		)
			blocks.push({
				id: "live:retry",
				live: true,
				kind: "notice",
				text: `Retrying: ${oneLine(generation.retry.error, 300)}`,
				tone: "warning",
			});
		else if (generation.deferred)
			blocks.push({
				id: "live:deferred",
				live: true,
				kind: "notice",
				text: "Waiting on provider response",
				tone: "muted",
			});
		const message = isRecord(generation.message)
			? generation.message
			: undefined;
		if (message) {
			// The partial carries the whole response so far, thinking included:
			// the reasoning block streams as its own fold just like the answer, in
			// the order the model emitted them.
			const thinking = contentThinking(message.content);
			if (thinking)
				blocks.push({
					id: "live:reasoning",
					live: true,
					kind: "reasoning",
					text: thinking,
					tone: "muted",
				});
			const text = contentRaw(message.content);
			if (text)
				blocks.push({
					id: "live:generation",
					live: true,
					kind: "assistant",
					text,
					tone: "base",
				});
			blocks.push(...partialToolBlocks(message));
		}
	}
	const compactions = Array.isArray(live.compactions) ? live.compactions : [];
	for (const [index, compaction] of compactions.entries()) {
		if (!isRecord(compaction)) continue;
		const reason =
			typeof compaction.reason === "string" ? compaction.reason : undefined;
		// A retry backoff is the summarizer's own failure, and the only place
		// pi-durable publishes it: the error is bounded to one line here.
		const retry = isRecord(compaction.retry) ? compaction.retry : undefined;
		const failure =
			retry && typeof retry.error === "string" ? oneLine(retry.error, 200) : "";
		blocks.push({
			id: `live:compaction:${index}`,
			live: true,
			kind: "compaction",
			text: `Compacting context (${compactionReasonLabel(reason)})${failure ? ` · retrying: ${failure}` : ""}…`,
			tone: "muted",
		});
	}
	return blocks;
}

/** Most recent blocks. The view renders a window of these and loads older ones
 * as the reader scrolls up, so this is the projection's memory bound, not a
 * screenful. */
const MAX_BLOCKS = 240;

/** The committed entry's own id when it has one, and its position otherwise:
 * the key every block of that entry is identified by. */
function entryId(entry: unknown, index: number): string {
	const id = isRecord(entry) ? entry.id : undefined;
	return typeof id === "string" ? id : `entry:${index}`;
}

/** One block's identity and content as a comparison key: two blocks with the
 * same key are the same block, unchanged. */
function blockKey(block: AgentSessionBlock): string {
	return [
		block.id,
		block.kind,
		block.tone,
		block.text,
		block.icon ?? "",
		block.pending ? "pending" : "",
		block.aborted ? "aborted" : "",
		block.live ? "live" : "",
		block.tool ?? "",
		block.request ?? "",
		block.durationMs ?? "",
		block.startedAt ?? "",
		block.endedAt ?? "",
		liveArgsKey(block),
		(block.detail ?? []).join("\u0000"),
	].join("\u0001");
}

/** A live block's argument identity. A streaming call's arguments change every
 * frame while its own text does not (a `write` names its path once and then
 * streams the content), so without this the reuse pass would hand the previous
 * frame's block back and the in-progress row would freeze. A long string is
 * reduced to its length so the identity costs no more than the frame it
 * describes. */
function liveArgsKey(block: AgentSessionBlock): string {
	if (block.live !== true || block.toolCall === undefined) return "";
	return Object.entries(block.toolCall.args)
		.map(([key, value]) => {
			if (typeof value === "string") return `${key}#${value.length}`;
			if (value === null || typeof value !== "object")
				return `${key}=${String(value)}`;
			return `${key}~${(JSON.stringify(value) ?? "").length}`;
		})
		.join(",");
}

/**
 * Carry the previous frame's block objects over to the next frame wherever the
 * content did not change, and hand the previous array back untouched when
 * nothing changed at all.
 *
 * The transcript renders with `<For>`, which keys rows by object identity: a
 * watch frame rebuilds every block object, so without this every frame would
 * rebuild every row and each markdown renderable would run its asynchronous
 * syntax pass again — the whole transcript flashing after each message.
 */
export function reuseAgentSessionBlocks(
	previous: readonly AgentSessionBlock[],
	next: readonly AgentSessionBlock[],
): readonly AgentSessionBlock[] {
	if (previous.length === 0) return next;
	const available = new Map<string, AgentSessionBlock[]>();
	for (const block of previous) {
		const key = blockKey(block);
		const list = available.get(key);
		if (list) list.push(block);
		else available.set(key, [block]);
	}
	let unchanged = previous.length === next.length;
	const reused = next.map((block, index) => {
		const before = available.get(blockKey(block))?.pop();
		if (!before) {
			unchanged = false;
			return block;
		}
		if (before !== previous[index]) unchanged = false;
		return before;
	});
	return unchanged ? previous : reused;
}

/** Defensive, version-tolerant read of pi-durable's `ConversationView` shape
 * (`docs["pi.live"]`, `docs["pi.inbox"]`, `entries`): every field is read as
 * unknown and checked, so a shape drift in the experimental package degrades
 * to a shorter transcript instead of throwing in the dashboard. */
/**
 * One entry per tool call instead of two. A committed call and its committed
 * result are paired by tool name (FIFO per name, so parallel identical calls
 * pair in order): the result's outcome replaces the call line, which moves to
 * `request` and only shows when the answer is expanded. A live running slot
 * upgrades its committed call to pending instead of duplicating it.
 */
/** The lifecycle key of a tool row: its call id when the source recorded one,
 * so a call pairs with the result that answers it rather than with the next
 * same-named call. */
function callKey(block: AgentSessionBlock): string {
	return block.toolCall?.callId ?? block.tool ?? block.text;
}

function mergeToolLifecycle(
	blocks: readonly AgentSessionBlock[],
): AgentSessionBlock[] {
	const out: AgentSessionBlock[] = [];
	/** Unanswered committed call indices in `out`, per tool name. */
	const open = new Map<string, number[]>();
	for (const block of blocks) {
		if (block.kind === "tool") {
			const key = callKey(block);
			const list = open.get(key);
			if (block.pending && list !== undefined && list.length > 0) {
				const index = list.shift();
				if (index !== undefined) {
					const call = out[index];
					if (call) {
						out[index] = {
							...call,
							pending: true,
							tone: block.tone,
							...(block.detail ? { detail: block.detail } : {}),
						};
						continue;
					}
				}
			}
			out.push(block);
			if (!block.pending) open.set(key, [...(list ?? []), out.length - 1]);
			continue;
		}
		if (block.kind === "result") {
			const key = callKey(block);
			const list = open.get(key);
			const index = list?.shift();
			const call = index === undefined ? undefined : out[index];
			if (index !== undefined && call) {
				out[index] = {
					...call,
					text: block.text,
					tone: block.tone,
					icon: block.icon,
					pending: false,
					// How long the call took: its result's recording time minus the
					// moment it was issued. A call with no known start has no duration
					// to show; a clock that ran backwards is not shown either.
					...(call.startedAt !== undefined &&
					block.endedAt !== undefined &&
					block.endedAt >= call.startedAt
						? { durationMs: block.endedAt - call.startedAt }
						: {}),
					request: `${call.icon ?? "•"} ${call.text}`,
					...(block.detail ? { detail: block.detail } : {}),
					...(call.toolCall
						? {
								toolCall: {
									...call.toolCall,
									...(block.toolCall?.result
										? { result: block.toolCall.result }
										: {}),
								},
							}
						: {}),
				};
				continue;
			}
			out.push(block);
			continue;
		}
		out.push(block);
	}
	return out;
}

/**
 * Whether a generation ended its turn instead of calling another tool. A turn
 * is the work one user or engine message starts: its assistant steps (thoughts,
 * tool calls) are steps *inside* it, and only the answer that stopped the loop
 * closes it.
 */
function endsTurn(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
	if (!isRecord(message)) return false;
	if (message.stopReason === "toolUse") return false;
	return !(
		Array.isArray(message.content) &&
		message.content.some(
			(block) => isRecord(block) && block.type === "toolCall",
		)
	);
}

/** opencode's assistant footer, minus the duration and token rate: pi-durable
 * records a message timestamp that is the generation's *start* and no
 * completion time, so subtracting timestamps fabricates a rate (a 58 ms
 * "duration" for a 476-token answer, seen live). The model and the output token
 * count are the accurate part of the footer.
 *
 * One footer per turn, like opencode: the intermediate generations that only
 * called tools carry no footer of their own. */
function assistantSummaryBlock(
	entry: unknown,
	timings: Readonly<Record<string, EntryTiming>>,
	summaryId: string,
): AgentSessionBlock | undefined {
	if (!isRecord(entry) || entry.kind !== "pi.assistant") return undefined;
	if (!endsTurn(entry)) return undefined;
	const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
	if (!isRecord(message) || message.stopReason === "error") return undefined;
	const provider =
		typeof message.provider === "string" ? message.provider : undefined;
	const modelId = typeof message.model === "string" ? message.model : undefined;
	const label =
		provider && modelId ? `${provider}/${modelId}` : (provider ?? modelId);
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const output = finiteNumber(usage?.output);
	const duration =
		typeof entry.id === "string" ? timings[entry.id]?.generationMs : undefined;
	const rate =
		output !== undefined && duration !== undefined && duration > 0
			? `${(output / (duration / 1000)).toFixed(1)} tok/s`
			: undefined;
	const parts = [
		label,
		duration !== undefined ? formatDuration(duration) : undefined,
		rate,
		// No measured timing (older entry, or a host that predates timings): show
		// the accurate output count instead of a fabricated rate.
		output !== undefined && duration === undefined
			? `${formatTokenCount(output)} out`
			: undefined,
	].filter((part): part is string => part !== undefined);
	if (parts.length === 0) return undefined;
	const startedAt = finiteNumber(message.timestamp);
	return {
		id: `${summaryId}:summary`,
		kind: "summary",
		text: parts.join(" · "),
		tone: "muted",
		...(duration !== undefined ? { durationMs: duration } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
	};
}

/** Blocks the first paint aims for: a screenful of transcript, which is what a
 * reader sees before scrolling. A long transcript must not be projected in full
 * before anything is drawn. */
const FIRST_PAINT_BLOCKS = 60;

/** Entries one `step` projects before it may stop at the time budget: a chunk
 * small enough to stay well inside a frame even when the entries carry large
 * tool results. */
const PROJECTION_CHUNK = 8;

/** A transcript projection that can be built a slice at a time.
 *
 * The dashboard rebuilds the whole session view on every host watch frame (a
 * streaming run changes `pi.live` at token rate), and projecting every entry of
 * a long transcript is what made opening the session feel slow: 1044 committed
 * entries measured 17.6 ms per frame, none of which the reader was looking at,
 * because the view renders only the newest window. The projection therefore
 * starts from the newest entries — the ones on screen — and grows older ones
 * on `step` while the frames keep their cost proportional to what is visible.
 */
export interface AgentSessionProjection {
	/** The blocks projected so far: the newest window of the transcript. */
	readonly blocks: readonly AgentSessionBlock[];
	/** Nothing older can add a rendered row: every entry that could still reach
	 * the rendered window has been projected. */
	readonly complete: boolean;
	/** Project older entries within `budgetMs`; returns `complete`. */
	step(budgetMs?: number): boolean;
	/** Project every remaining entry and return the blocks. This is the reference
	 * build: the result is the whole transcript, merged and bounded, whatever the
	 * projection had grown to. */
	finish(): readonly AgentSessionBlock[];
}

/** What a caller adds on top of a frame's own projection: local notices the
 * frame itself cannot carry because no document records them. A cancelled
 * manual compaction is the one such notice today — `/abort` cancels it and no
 * summary is placed, which is visible as a fact only to the client that
 * requested the abort. */
export interface AgentSessionProjectionOptions {
	readonly notices?: readonly AgentSessionBlock[];
}

class AgentSessionProjectionImpl implements AgentSessionProjection {
	private readonly entries: readonly unknown[];
	private readonly timings: Readonly<Record<string, EntryTiming>>;
	private readonly live: Readonly<Record<string, unknown>> | undefined;
	private readonly inboxItems: readonly unknown[];
	private readonly notices: readonly AgentSessionBlock[];
	/** Full labels of this frame's compaction entries (reason plus the measured
	 * token movement), keyed by block key. */
	private readonly compactionLabels: ReadonlyMap<string, string>;
	/** Index of the oldest projected entry; entries `[start, length)` are in
	 * `pending`, newest last. */
	private start: number;
	/** The un-merged blocks of the projected entries, in transcript order. */
	private pending: AgentSessionBlock[] = [];
	private published: readonly AgentSessionBlock[] = [];
	private done = false;

	constructor(value: unknown, options: AgentSessionProjectionOptions = {}) {
		const record = isRecord(value) ? value : {};
		const docs = isRecord(record.docs) ? record.docs : {};
		this.live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
		this.entries = Array.isArray(record.entries) ? record.entries : [];
		this.timings = isRecord(record.timings)
			? (record.timings as Record<string, EntryTiming>)
			: {};
		this.notices = options.notices ?? [];
		const inbox = isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
		this.inboxItems = Array.isArray(inbox?.items) ? inbox.items : [];
		this.compactionLabels = compactionEntryLabels(this.entries);
		this.start = this.entries.length;
		this.project(FIRST_PAINT_BLOCKS);
	}

	get blocks(): readonly AgentSessionBlock[] {
		return this.published;
	}

	get complete(): boolean {
		return this.done;
	}

	step(budgetMs = 8): boolean {
		if (this.done) return true;
		const deadline = performance.now() + budgetMs;
		this.project(PROJECTION_CHUNK, deadline);
		return this.done;
	}

	finish(): readonly AgentSessionBlock[] {
		// Every remaining entry in one pass, published without the early stop: the
		// reference build covers the whole transcript whatever the window held.
		this.project(Number.POSITIVE_INFINITY, undefined, false);
		return this.published;
	}

	/** Project entries backwards from `start` until `target` of them are in
	 * `pending`, the entries are exhausted, or the time budget is spent (after
	 * `target` is reached). One publish per call, so the caller has a window to
	 * render after every slice. */
	private project(
		target: number,
		deadline?: number,
		mayStopEarly = true,
	): void {
		const chunks: AgentSessionBlock[][] = [];
		let projected = 0;
		while (
			this.start > 0 &&
			(projected < target ||
				(deadline !== undefined && performance.now() < deadline))
		) {
			this.start--;
			chunks.push(this.entryBlocksAt(this.start));
			projected++;
		}
		if (projected > 0) {
			chunks.reverse();
			this.pending = [...chunks.flat(), ...this.pending];
		}
		this.publish(mayStopEarly);
	}

	private entryBlocksAt(index: number): AgentSessionBlock[] {
		const entry = this.entries[index];
		const key = entryId(entry, index);
		const blocks = entryBlocks(entry, this.timings, key, this.compactionLabels);
		const summary = assistantSummaryBlock(entry, this.timings, key);
		if (summary) blocks.push(summary);
		return blocks;
	}

	/** Merge what is projected and remember the window. `mayStopEarly` is the
	 * incremental path: once the merged window is as long as the projection can
	 * ever render (`MAX_BLOCKS`), older entries could only produce rows the trim
	 * would drop, so the projection is complete. `finish` never stops early, so
	 * its result is the reference build for any input. */
	private publish(mayStopEarly: boolean): void {
		const blocks: AgentSessionBlock[] = [...this.pending];
		blocks.push(...liveBlocks(this.live));
		blocks.push(...this.notices);
		for (const [index, item] of this.inboxItems.entries()) {
			if (
				!isRecord(item) ||
				(item.mode !== "steer" && item.mode !== "followUp")
			)
				continue;
			const text = contentRaw(item.content);
			if (text)
				blocks.push({
					id: `inbox:${index}`,
					kind: "notice",
					tone: "warning",
					text: `Queued ${item.mode === "steer" ? "steering" : "follow-up"}: ${text}`,
				});
		}
		const merged = mergeToolLifecycle(blocks);
		this.published =
			merged.length > MAX_BLOCKS
				? merged.slice(merged.length - MAX_BLOCKS)
				: merged;
		this.done =
			this.start === 0 || (mayStopEarly && merged.length >= MAX_BLOCKS);
	}
}

/** Start projecting one host watch frame: the newest entries are projected by
 * the time this returns, and `step` grows the window older. */
export function createAgentSessionProjection(
	value: unknown,
	options: AgentSessionProjectionOptions = {},
): AgentSessionProjection {
	return new AgentSessionProjectionImpl(value, options);
}

/** Runs `run` on a later turn and returns a canceller. Injected so the
 * progressive publish can be driven synchronously by tests. */
export type ProjectionScheduler = (run: () => void) => () => void;

/** Default scheduler: the next macrotask, so a slice yields to the renderer's
 * frame instead of holding the loop through the whole transcript. */
const nextTurnScheduler: ProjectionScheduler = (run) => {
	const timer = setTimeout(run, 0);
	return () => clearTimeout(timer);
};

/** Publish a projection as it grows: `onUpdate` receives the first paint
 * immediately — before any scheduled turn runs — and every later slice as it
 * lands, so the reader sees the newest rows of a long transcript without
 * waiting for the rest of it. Returns a disposer that stops the pump. */
export function streamAgentSessionProjection(
	projection: AgentSessionProjection,
	onUpdate: (blocks: readonly AgentSessionBlock[]) => void,
	options: {
		readonly schedule?: ProjectionScheduler;
		readonly budgetMs?: number;
	} = {},
): () => void {
	const schedule = options.schedule ?? nextTurnScheduler;
	let cancelled = false;
	let cancel: (() => void) | undefined;
	const pump = () => {
		if (cancelled) return;
		projection.step(options.budgetMs);
		onUpdate(projection.blocks);
		if (!projection.complete) cancel = schedule(pump);
	};
	onUpdate(projection.blocks);
	if (!projection.complete) cancel = schedule(pump);
	return () => {
		cancelled = true;
		cancel?.();
		cancel = undefined;
	};
}

/** The whole transcript projection for one host watch frame: the reference
 * build the incremental projection converges to. */
export function buildAgentSessionView(
	value: unknown,
	options: AgentSessionProjectionOptions = {},
): AgentSessionBlock[] {
	return [...createAgentSessionProjection(value, options).finish()];
}

/** The conversation's current model and thinking level, read from pi-durable's
 * `pi.agent` document so the prompt's metadata row always shows what the run
 * will actually use (including a live `/model` or `/thinking` override). */
/** The newest assistant generation's provider error, if that generation failed
 * and no later successful assistant entry cleared it. */
function lastAssistantError(entries: readonly unknown[]): string | undefined {
	let error: string | undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.kind !== "pi.assistant") continue;
		const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
		if (!isRecord(message)) continue;
		error =
			message.stopReason === "error" && typeof message.errorMessage === "string"
				? message.errorMessage
				: undefined;
	}
	return error;
}

export interface AgentSessionMetadata {
	readonly model?: string;
	readonly thinking?: string;
	/** The run is busy: a generation is in flight, a tool is running, or input
	 * is queued. */
	readonly working: boolean;
	/** The newest generation's provider error, if it failed. */
	readonly error?: string;
	/** Prompt tokens of the newest generation (input + cache read/write): the
	 * conversation's current context size. */
	readonly contextTokens?: number;
	/** The conversation's accumulated spend across models and tools. */
	readonly cost?: number;
	/** The conversation's accumulated input and output tokens (`pi.usage`). */
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	/** Output tokens over the conversation's measured generation time. */
	readonly tokensPerSecond?: number;
	/** A compaction in flight, so the status line shows a reason-carrying
	 * indicator (`add-agent-compaction`: "Compaction feedback"). */
	readonly compacting?: { readonly reason: string; readonly retrying?: string };
}

/** The host's measured wall-clock timing for one committed assistant entry
 * (see `agent-host/telemetry.ts`); absent for entries committed before the
 * host recorded timings or after a host restart. */
interface EntryTiming {
	readonly generationMs?: number;
	readonly thinkingMs?: number;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** The wall-clock time of day a block started, `14:03:27` in the reader's own
 * time zone: the transcript is read against the clock on the wall. */
export function formatClock(epochMs: number): string {
	const at = new Date(epochMs);
	const two = (value: number) => String(value).padStart(2, "0");
	return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** A tool call's duration: milliseconds under a second (`340ms`), then the same
 * `1.6s` / `1m 2s` the rest of the transcript uses. */
export function formatCallDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms);
}

/** A call slow enough to stand out in the transcript. */
export const SLOW_CALL_MS = 10_000;

/** `1.6s`, `1m 2s`. */
export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** `63.9K`, `1.2M`. */
export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return String(Math.round(tokens));
}

/** `$0.01`, `<$0.01`. */
export function formatCost(cost: number): string {
	if (cost > 0 && cost < 0.01) return "<$0.01";
	return `$${cost.toFixed(2)}`;
}

/** The newest generation's prompt tokens, i.e. the active context size. */
function lastPromptTokens(entries: readonly unknown[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.kind !== "pi.assistant") continue;
		const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
		if (!isRecord(message)) continue;
		const usage = isRecord(message.usage) ? message.usage : undefined;
		if (!usage) continue;
		const total =
			(finiteNumber(usage.input) ?? 0) +
			(finiteNumber(usage.cacheRead) ?? 0) +
			(finiteNumber(usage.cacheWrite) ?? 0);
		if (total > 0) return total;
	}
	return undefined;
}

/** Sum of one `pi.usage` bucket's recorded spend. */
function sumUsageCost(bucket: unknown): number {
	if (!isRecord(bucket)) return 0;
	let total = 0;
	for (const value of Object.values(bucket)) {
		if (!isRecord(value) || !isRecord(value.cost)) continue;
		total += finiteNumber(value.cost.total) ?? 0;
	}
	return total;
}

/** The conversation's accumulated spend, from pi-durable's `pi.usage` ledger. */
function usageCost(
	usage: Record<string, unknown> | undefined,
): number | undefined {
	if (!usage) return undefined;
	const total = sumUsageCost(usage.models) + sumUsageCost(usage.tools);
	return total > 0 ? total : undefined;
}

/** Sum of one `pi.usage` bucket's input/output tokens. */
function sumUsageTokens(bucket: unknown): { input: number; output: number } {
	if (!isRecord(bucket)) return { input: 0, output: 0 };
	let input = 0;
	let output = 0;
	for (const value of Object.values(bucket)) {
		if (!isRecord(value)) continue;
		input += finiteNumber(value.input) ?? 0;
		output += finiteNumber(value.output) ?? 0;
	}
	return { input, output };
}

/** The conversation's accumulated input/output tokens, from `pi.usage`. */
function usageTokens(
	usage: Record<string, unknown> | undefined,
): { input: number; output: number } | undefined {
	if (!usage) return undefined;
	const models = sumUsageTokens(usage.models);
	const tools = sumUsageTokens(usage.tools);
	const input = models.input + tools.input;
	const output = models.output + tools.output;
	return input > 0 || output > 0 ? { input, output } : undefined;
}

/** Total measured generation time across the conversation's committed assistant
 * entries (the host's `timings` map), for the output-token rate. */
function timingGenerationMs(value: unknown): number | undefined {
	if (!isRecord(value) || !isRecord(value.timings)) return undefined;
	let total = 0;
	for (const timing of Object.values(value.timings)) {
		if (!isRecord(timing)) continue;
		total += finiteNumber(timing.generationMs) ?? 0;
	}
	return total > 0 ? total : undefined;
}

export function readAgentSessionMetadata(value: unknown): AgentSessionMetadata {
	if (!isRecord(value)) return { working: false };
	const docs = isRecord(value.docs) ? value.docs : {};
	const agent = isRecord(docs["pi.agent"]) ? docs["pi.agent"] : undefined;
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	const inbox = isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
	const entries = Array.isArray(value.entries) ? value.entries : [];
	const model =
		agent && isRecord(agent.model)
			? `${String(agent.model.provider)}/${String(agent.model.modelId)}`
			: undefined;
	const thinking =
		agent && typeof agent.thinkingLevel === "string"
			? agent.thinkingLevel
			: undefined;
	const runningTool =
		live !== undefined &&
		Array.isArray(live.tools) &&
		live.tools.some((tool) => isRecord(tool) && tool.status === "running");
	const queued =
		inbox !== undefined && Array.isArray(inbox.items) && inbox.items.length > 0;
	const working =
		live?.run !== undefined ||
		runningTool ||
		queued ||
		live?.generation !== undefined;
	const error = lastAssistantError(entries);
	const contextTokens = lastPromptTokens(entries);
	const usage = isRecord(docs["pi.usage"]) ? docs["pi.usage"] : undefined;
	const cost = usageCost(usage);
	const tokens = usageTokens(usage);
	const generationMs = timingGenerationMs(value);
	const tokensPerSecond =
		tokens && tokens.output > 0 && generationMs !== undefined
			? Math.round((tokens.output / (generationMs / 1000)) * 10) / 10
			: undefined;
	const liveCompactions = Array.isArray(live?.compactions)
		? live.compactions
		: [];
	const runningCompaction = liveCompactions.find(isRecord);
	const compactionReason =
		runningCompaction && typeof runningCompaction.reason === "string"
			? runningCompaction.reason
			: undefined;
	const compactionRetry =
		runningCompaction && isRecord(runningCompaction.retry)
			? runningCompaction.retry
			: undefined;
	const compactionRetryError =
		compactionRetry && typeof compactionRetry.error === "string"
			? oneLine(compactionRetry.error, 200)
			: undefined;
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		working,
		...(error ? { error } : {}),
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(tokens
			? { inputTokens: tokens.input, outputTokens: tokens.output }
			: {}),
		...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
		...(compactionReason
			? {
					compacting: {
						reason: compactionReason,
						...(compactionRetryError ? { retrying: compactionRetryError } : {}),
					},
				}
			: {}),
	};
}

/** Plain-text projection of the same blocks, for tests and any caller that
 * only wants the transcript as lines. */
export function renderAgentSessionSummary(value: unknown): string {
	return buildAgentSessionView(value)
		.flatMap((block) => [block.text, ...(block.detail ?? [])])
		.join("\n");
}

/** What one prompt did to its run's workflow state, as the durable host
 * reports it back on the submission, rendered as one notification line. A
 * normal prompt reconciles nothing, so it shows no notice at all. */
export function submissionStateNote(
	state: SubmitWorkflowState | undefined,
): { readonly text: string; readonly tone: "success" | "warning" } | undefined {
	if (state === "resumed")
		return { text: "Workflow resumed after the abort", tone: "success" };
	if (state === "finished")
		return {
			text: "The run already handed off; the message went to its session",
			tone: "warning",
		};
	if (state === "stale")
		return {
			text: "The run is no longer its step's current attempt; the message went to its session",
			tone: "warning",
		};
	return undefined;
}
