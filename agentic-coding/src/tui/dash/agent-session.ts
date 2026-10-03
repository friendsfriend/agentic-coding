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

export interface AgentSessionBlock {
	readonly kind: AgentSessionKind;
	readonly text: string;
	readonly tone: AgentSessionTone;
	/** Two-cell glyph for tool/notice rows (opencode v2's icon gutter). */
	readonly icon?: string;
	/** A tool call still in flight: rendered in the warning color. */
	readonly pending?: boolean;
	/** Extra, dimmer lines under the block (tool output, error detail). */
	readonly detail?: readonly string[];
	/** Measured wall-clock duration, when the host recorded one: a thinking
	 * block's reasoning time, or an assistant footer's generation time. */
	readonly durationMs?: number;
	/** Canonical tool name, so a call and its result can be paired. */
	readonly tool?: string;
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

/** Bound and split output into display lines, newest kept. */
function outputLines(value: unknown, max = 12): string[] {
	if (typeof value !== "string") return [];
	const lines = stripHarness(stripAnsi(value))
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.filter((line) => line.length > 0);
	return lines.length > max ? lines.slice(lines.length - max) : lines;
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
};
function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "•";
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

/** Render one committed transcript entry as zero or more blocks. Unknown entry
 * kinds are skipped rather than guessed at. */
function entryBlocks(
	entry: unknown,
	timings: Readonly<Record<string, EntryTiming>>,
): AgentSessionBlock[] {
	if (!isRecord(entry)) return [];
	const model = Array.isArray(entry.model) ? entry.model : [];
	const timing = typeof entry.id === "string" ? timings[entry.id] : undefined;
	switch (entry.kind) {
		case "pi.user":
			return (
				model
					.map((message) => oneLine(isRecord(message) ? message.content : ""))
					.filter(Boolean)
					// The user's own prompt is the accent-colored box, distinct from the
					// model's neutral messages.
					.map((text) => ({ kind: "user", text, tone: "accent" }) as const)
			);
		case "pi.assistant": {
			const blocks: AgentSessionBlock[] = [];
			for (const message of model) {
				if (!isRecord(message) || !Array.isArray(message.content)) continue;
				for (const block of message.content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string") {
						// Assistant output keeps its line structure: the view renders it
						// as markdown, not as a collapsed one-liner.
						const text = rawText(block.text);
						if (text) blocks.push({ kind: "assistant", text, tone: "base" });
					} else if (
						block.type === "thinking" &&
						typeof block.thinking === "string"
					) {
						const text = rawText(block.thinking, 4000);
						if (text)
							blocks.push({
								kind: "reasoning",
								text,
								tone: "muted",
								...(timing?.thinkingMs !== undefined
									? { durationMs: timing.thinkingMs }
									: {}),
							});
					} else if (
						block.type === "toolCall" &&
						typeof block.name === "string"
					) {
						const args = argsSummary(block.arguments);
						blocks.push({
							kind: "tool",
							text: `${block.name}${args ? ` ${args}` : ""}`,
							tone: "muted",
							icon: toolIcon(block.name),
							tool: block.name,
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
						kind: "error",
						text: oneLine(message.errorMessage, 400),
						tone: "error",
					});
			}
			return blocks;
		}
		case "pi.tool-result":
			return model.flatMap((message): AgentSessionBlock[] => {
				if (!isRecord(message)) return [];
				const name =
					typeof message.toolName === "string" ? message.toolName : "tool";
				const failed = message.isError === true;
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
						kind: "result",
						text: first
							? `${name}: ${oneLine(first, 2000)}`
							: `${name} ${failed ? "failed" : "done"}`,
						// The result box carries the tool's outcome, so a successful
						// result is green and a failed one red.
						tone: failed ? "error" : "success",
						icon: failed ? "✗" : "✓",
						tool: name,
						// All lines, so expanding the paired tool block shows the whole
						// answer (the collapsed header is `text`).
						...(lines.length > 0 ? { detail: lines } : {}),
					},
				];
			});
		case "pi.compaction":
			return [{ kind: "compaction", text: "Compaction", tone: "muted" }];
		case "pi.reset":
			return [{ kind: "compaction", text: "Context reset", tone: "muted" }];
		default:
			return [];
	}
}

/** The live in-flight generation and running tools, which the committed
 * transcript does not carry yet. */
function liveBlocks(
	live: Record<string, unknown> | undefined,
): AgentSessionBlock[] {
	if (!live) return [];
	const blocks: AgentSessionBlock[] = [];
	const tools = Array.isArray(live.tools) ? live.tools : [];
	for (const slot of tools) {
		if (!isRecord(slot) || slot.status === "done") continue;
		const name = typeof slot.name === "string" ? slot.name : "tool";
		const detail = outputLines(slot.output, 8);
		blocks.push({
			kind: "tool",
			text: name,
			tone: "warning",
			icon: toolIcon(name),
			pending: true,
			tool: name,
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
				kind: "notice",
				text: `Retrying: ${oneLine(generation.retry.error, 300)}`,
				tone: "warning",
			});
		else if (generation.deferred)
			blocks.push({
				kind: "notice",
				text: "Waiting on provider response",
				tone: "muted",
			});
		const message = isRecord(generation.message)
			? generation.message
			: undefined;
		if (message) {
			const text = contentRaw(message.content);
			if (text) blocks.push({ kind: "assistant", text, tone: "base" });
		}
	}
	const compactions = Array.isArray(live.compactions) ? live.compactions : [];
	for (const compaction of compactions) {
		if (isRecord(compaction))
			blocks.push({
				kind: "compaction",
				text: "Compacting context",
				tone: "muted",
			});
	}
	return blocks;
}

/** Most recent blocks, bounded so the view keeps the newest
 * activity visible instead of clipping it. */
const MAX_BLOCKS = 60;

/** One block's content as a comparison key: two blocks with the same key
 * render identically. */
function blockKey(block: AgentSessionBlock): string {
	return [
		block.kind,
		block.tone,
		block.text,
		block.icon ?? "",
		block.pending ? "pending" : "",
		block.tool ?? "",
		block.request ?? "",
		block.durationMs ?? "",
		(block.detail ?? []).join("\u0000"),
	].join("\u0001");
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
function mergeToolLifecycle(
	blocks: readonly AgentSessionBlock[],
): AgentSessionBlock[] {
	const out: AgentSessionBlock[] = [];
	/** Unanswered committed call indices in `out`, per tool name. */
	const open = new Map<string, number[]>();
	for (const block of blocks) {
		if (block.kind === "tool") {
			const key = block.tool ?? block.text;
			const list = open.get(key);
			if (block.pending && list !== undefined && list.length > 0) {
				const index = list[0];
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
			const key = block.tool ?? "";
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
					request: `${call.icon ?? "•"} ${call.text}`,
					...(block.detail ? { detail: block.detail } : {}),
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
	return {
		kind: "summary",
		text: parts.join(" · "),
		tone: "muted",
		...(duration !== undefined ? { durationMs: duration } : {}),
	};
}

export function buildAgentSessionView(value: unknown): AgentSessionBlock[] {
	if (!isRecord(value)) return [];
	const docs = isRecord(value.docs) ? value.docs : {};
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	const entries = Array.isArray(value.entries) ? value.entries : [];
	const timings = isRecord(value.timings)
		? (value.timings as Record<string, EntryTiming>)
		: {};
	const blocks: AgentSessionBlock[] = [];
	for (const entry of entries) {
		blocks.push(...entryBlocks(entry, timings));
		const summary = assistantSummaryBlock(entry, timings);
		if (summary) blocks.push(summary);
	}
	blocks.push(...liveBlocks(live));
	const inbox = isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
	for (const item of Array.isArray(inbox?.items) ? inbox.items : []) {
		if (!isRecord(item) || (item.mode !== "steer" && item.mode !== "followUp"))
			continue;
		const text = contentRaw(item.content);
		if (text)
			blocks.push({
				kind: "notice",
				tone: "warning",
				text: `Queued ${item.mode === "steer" ? "steering" : "follow-up"}: ${text}`,
			});
	}
	const merged = mergeToolLifecycle(blocks);
	return merged.length > MAX_BLOCKS
		? merged.slice(merged.length - MAX_BLOCKS)
		: merged;
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
	const cost = usageCost(
		isRecord(docs["pi.usage"]) ? docs["pi.usage"] : undefined,
	);
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		working,
		...(error ? { error } : {}),
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(cost !== undefined ? { cost } : {}),
	};
}

/** Plain-text projection of the same blocks, for tests and any caller that
 * only wants the transcript as lines. */
export function renderAgentSessionSummary(value: unknown): string {
	return buildAgentSessionView(value)
		.flatMap((block) => [block.text, ...(block.detail ?? [])])
		.join("\n");
}
