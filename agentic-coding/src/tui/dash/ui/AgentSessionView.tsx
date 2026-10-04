/** @jsxImportSource @opentui/solid */
// Dashboard agent session view (add-pi-durable-runtime,
// dashboard-agent-session-view): a live, writable view of one `pi-durable`
// agent run, opened from the Agents panel. It is a page of the dashboard body
// — the detail grid stays mounted behind it — not a dialog. Status/transcript
// blocks are owned by the route (a live `HostClient.watch()` subscription);
// this component owns the presentation, the opencode-style prompt, and the
// `/model` and `/thinking` pickers.
//
// Assistant output renders as markdown with no box; thinking collapses to a
// single `Thinking…` line; every other entry is a status box with a solid
// status-tinted background and the same left highlight the prompt uses. The
// prompt below mirrors opencode v2: a left-bordered raised block with the
// input and a metadata row (`Role · model · thinking` plus a live working
// indicator).
//
// The view replaces the detail grid, so its own keys (scroll, back) and the
// picker's keys are route keymap layers gated on the `agent.view` field. The
// prompt input stays focused throughout and keeps accepting ordinary
// characters, including `j`, `k` and a `?` that starts a message.
import type {
	InputRenderable,
	KeyEvent,
	ScrollBoxRenderable,
} from "@opentui/core";
import {
	CliRenderEvents,
	parseColor,
	RGBA,
	rgbToHex,
	TextAttributes,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
	ListViewModal,
	MarkdownViewer,
	parseMarkdownBlocks,
	ScrollableContent,
	uiColors,
} from "@ui";
import {
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	type AgentSessionBlock,
	type AgentSessionTone,
	formatCost,
	formatDuration,
	formatTokenCount,
	reuseAgentSessionBlocks,
} from "../agent-session.ts";
import { PromptPulse } from "./PromptPulse.tsx";
import { toolView } from "./tool-views.ts";

export interface AgentSessionViewProps {
	readonly role: string;
	readonly blocks: readonly AgentSessionBlock[];
	readonly draft: string;
	readonly history: readonly string[];
	readonly onHistoryAppend: (text: string) => void;
	/** Current model/thinking/working state from pi-durable's `pi.agent` + `pi.live`. */
	readonly model?: string;
	readonly thinking?: string;
	readonly working: boolean;
	readonly error?: string;
	/** Prompt tokens of the newest generation (the active context size). */
	readonly contextTokens?: number;
	/** The model's context window, for the meter's percentage. */
	readonly contextWindow?: number;
	/** The conversation's accumulated spend. */
	readonly cost?: number;
	/** Picker catalogs, from the host's `catalog` request. */
	readonly models: readonly string[];
	readonly thinkingLevels: readonly string[];
	readonly onDraftChange: (value: string) => void;
	readonly onSubmit: (text: string) => void;
	readonly onAbort: () => void;
	/** Leave the view for the dashboard grid; the run keeps streaming. */
	readonly onBack: () => void;
	/** Apply a live model / thinking override. */
	readonly onConfigure: (change: { model?: string; thinking?: string }) => void;
	/** The transcript scroll box, so the route's keymap layer can scroll it. */
	readonly onScrollBoxReady?: (box: ScrollBoxRenderable) => void;
	/** The picker's key handler, registered while a picker is open. */
	readonly onPickerKeyReady?: (handler: (event: KeyEvent) => boolean) => void;
	/** Whether a picker is open, so the route can switch keymap layers. */
	readonly onPickerActiveChange?: (active: boolean) => void;
	/** `?` on an empty prompt: the route opens the shared keybind help. */
	readonly onHelp?: () => void;
}

/** Typing one of these exact messages, instead of an ordinary one, performs
 * the named action. See the module comment for why these are slash commands
 * rather than key bindings. */
export const ABORT_COMMAND = "/abort";
export const CLOSE_COMMAND = "/hide";
export const MODEL_COMMAND = "/model";
export const THINKING_COMMAND = "/thinking";

interface SessionCommand {
	readonly name: string;
	readonly description: string;
}

/** The slash commands the prompt autocompletes, opencode-style: type `/` and
 * the list appears above the input. */
const SESSION_COMMANDS: readonly SessionCommand[] = [
	{ name: MODEL_COMMAND, description: "Change the model for this run" },
	{ name: THINKING_COMMAND, description: "Change the thinking level" },
	{ name: ABORT_COMMAND, description: "Abort the running turn" },
	{ name: CLOSE_COMMAND, description: "Hide this session view" },
];

/** pi-ai's thinking levels, used when the host cannot serve a catalog (e.g. a
 * host started before the catalog request existed). */
const DEFAULT_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Blend a status color into the dialog background, so every box has a solid
 * background that still reads as "the theme, tinted by status". Named theme
 * colors resolve through OpenTUI's own parser. */
function tint(color: string, amount: number): string {
	const base = parseColor(uiColors.bgBase);
	const tone = parseColor(color);
	const mix = (from: number, to: number) => from + (to - from) * amount;
	return rgbToHex(
		RGBA.fromValues(
			mix(base.r, tone.r),
			mix(base.g, tone.g),
			mix(base.b, tone.b),
			1,
		),
	);
}

/** Rows rendered on open, and how many more each load at the top adds. The
 * projection keeps a longer transcript, so the window is a rendering budget,
 * not the transcript's own bound. */
const TRANSCRIPT_WINDOW = 60;
const TRANSCRIPT_PAGE = 40;

/** The separator between the transcript and its newest output: a rule in the
 * theme's accent with `new` and a down arrow centered on it, so the boundary is
 * visible without tinting or bordering the content that follows it. */
function NewContentDivider() {
	return (
		<box
			width="100%"
			height={1}
			flexShrink={0}
			border={["top"]}
			borderColor={uiColors.accent}
			title=" new ↓ "
			titleColor={uiColors.accent}
			titleAlignment="center"
		/>
	);
}

/** The left-edge marker color: the status color, fully saturated. */
function markerColor(tone: AgentSessionTone): string {
	switch (tone) {
		case "error":
			return uiColors.error;
		case "warning":
			return uiColors.warning;
		case "success":
			return uiColors.success;
		case "info":
			return uiColors.info;
		case "accent":
			return uiColors.accent;
		case "muted":
			return uiColors.textMuted;
		default:
			return uiColors.primary;
	}
}

/** The solid background of one status box. */
function boxBackground(tone: AgentSessionTone): string {
	switch (tone) {
		case "error":
			return tint(uiColors.error, 0.16);
		case "warning":
			return tint(uiColors.warning, 0.16);
		case "success":
			return tint(uiColors.success, 0.14);
		case "info":
			return tint(uiColors.info, 0.14);
		case "accent":
			return tint(uiColors.accent, 0.14);
		case "muted":
			return uiColors.bgSurface1;
		default:
			return uiColors.bgSurface0;
	}
}

function toneColor(tone: AgentSessionTone): string {
	return tone === "base" ? uiColors.textPrimary : markerColor(tone);
}

function titlecase(value: string): string {
	return value.length === 0 ? value : value[0]?.toUpperCase() + value.slice(1);
}

/** Keep the metadata row to one line: the model is the field that can be long,
 * so it is the one that truncates (the role and thinking level stay whole). */
function truncateModel(model: string): string {
	return model.length > 32 ? `${model.slice(0, 31)}…` : model;
}

/** One rendered piece of an assistant message: a fenced code block, or the
 * prose around it. */
interface AssistantPart {
	readonly source: string;
	/** Fenced code: drawn as text immediately instead of waiting for the
	 * markdown syntax pass (prose needs that pass to conceal its own markers). */
	readonly code: boolean;
}

/**
 * Split an assistant message at its top-level markdown blocks. Each part keeps
 * the blank lines up to the next block, because a rendered part only draws the
 * spacing that is part of its own text.
 */
function assistantParts(text: string): AssistantPart[] {
	const blocks = parseMarkdownBlocks(text);
	const lines = text.split("\n");
	return blocks.map((block, index) => {
		const next = blocks[index + 1];
		return {
			source: lines
				.slice(block.startLine - 1, next ? next.startLine - 1 : lines.length)
				.join("\n"),
			code: block.kind === "code",
		};
	});
}

/**
 * One assistant message as its markdown pieces. A single `<markdown>` for the
 * whole message would stay blank wherever the asynchronous syntax pass has not
 * landed yet — every paragraph, or (with the streaming preview on) every code
 * block — so code draws as a code block and prose as a streaming preview, and
 * neither waits to become visible.
 */
function AssistantMarkdown(props: { text: string }) {
	// Lexing the message is the expensive part of a render, so it happens once
	// per text (every streaming frame), not once per part.
	const parts = createMemo(() => assistantParts(props.text));
	return (
		<box flexDirection="column">
			<For each={parts()}>
				{(part, index) => (
					<MarkdownViewer
						content={part.source}
						fg={uiColors.textPrimary}
						streaming={!part.code}
						// A code block's trailing blank line is not part of its text,
						// so the following block would touch it.
						{...(part.code && index() < parts().length - 1
							? { marginBottom: 1 }
							: {})}
					/>
				)}
			</For>
		</box>
	);
}

/** The transcript rows and the blocks carrying the newest-content marker. */
interface TranscriptState {
	readonly rows: readonly AgentSessionBlock[];
	/** The block the newest-output divider sits above, by id. */
	readonly dividerId: string | undefined;
}

/** One transcript entry. Assistant output is markdown with no status box;
 * thinking is collapsible; everything else is a status box with the same left
 * highlight the prompt uses. */
function Block(props: {
	block: AgentSessionBlock;
	role: string;
	expanded: boolean;
	onToggle: (id: string) => void;
	/** The parts folded away, and how to fold one: a long tool view keeps its
	 * headers when a part is closed. */
	foldedSections: () => ReadonlySet<string>;
	onToggleSection: (key: string) => void;
}) {
	const color = () => toneColor(props.block.tone);
	if (props.block.kind === "summary")
		// opencode's assistant footer: agent · model · duration · tok/s.
		return (
			<box paddingLeft={3} paddingRight={1} flexShrink={0}>
				<text fg={uiColors.textMuted} wrapMode="none" truncate>
					{titlecase(props.role)} · {props.block.text}
				</text>
			</box>
		);
	if (props.block.kind === "user")
		// opencode's user prompt: the prompt box's own raised block, with a blank
		// line above and below the text so a message reads as a paragraph of its
		// own instead of a dense row.
		return (
			<box
				border={["left"]}
				borderColor={uiColors.accent}
				backgroundColor={uiColors.bgMantle}
				paddingTop={1}
				paddingBottom={1}
				paddingLeft={2}
				paddingRight={1}
				flexShrink={0}
			>
				<text fg={uiColors.textPrimary}>{props.block.text}</text>
			</box>
		);
	if (props.block.kind === "assistant")
		return (
			<box paddingLeft={3} paddingRight={1} flexShrink={0}>
				<AssistantMarkdown text={props.block.text} />
			</box>
		);
	if (props.block.kind === "reasoning")
		return (
			<box
				paddingLeft={3}
				paddingRight={1}
				flexDirection="column"
				flexShrink={0}
				onMouseUp={() => props.onToggle(props.block.id)}
			>
				<text fg={uiColors.warning}>
					{props.expanded ? "▾" : "▸"}{" "}
					{props.block.durationMs !== undefined
						? `Thought: ${formatDuration(props.block.durationMs)}`
						: "Thinking…"}
				</text>
				<Show when={props.expanded}>
					<text fg={uiColors.textMuted} attributes={TextAttributes.ITALIC}>
						{props.block.text}
					</text>
				</Show>
			</box>
		);
	// The tools a run leans on get a view built from their call and result; a
	// tool without one keeps the generic row below (icon, name, argument).
	const tool = props.block.toolCall
		? toolView(props.block.toolCall)
		: undefined;
	if (tool && (props.block.kind === "tool" || props.block.kind === "result")) {
		const expandable = () =>
			(tool.rows?.length ?? 0) > 0 || (tool.sections?.length ?? 0) > 0;
		return (
			<box
				border={["left"]}
				borderColor={markerColor(props.block.tone)}
				backgroundColor={boxBackground(props.block.tone)}
				paddingLeft={2}
				paddingRight={1}
				flexShrink={0}
			>
				<box flexDirection="column">
					<box
						flexDirection="row"
						onMouseUp={() => props.onToggle(props.block.id)}
					>
						{/* The fold glyph leads the row, so a list of tool rows reads as
						    a list of folds rather than a ragged right edge. */}
						<text width={2} flexShrink={0} fg={uiColors.textMuted}>
							{expandable() ? (props.expanded ? "▾" : "▸") : ""}
						</text>
						<text width={2} flexShrink={0} fg={color()}>
							{tool.icon}
						</text>
						<text
							fg={color()}
							flexGrow={1}
							minWidth={0}
							wrapMode="none"
							truncate
						>
							{tool.summary}
							{props.block.pending ? " …" : ""}
						</text>
						<Show when={tool.hint}>
							{(hint) => (
								<text fg={uiColors.textMuted} flexShrink={0}>
									{` ${hint()}`}
								</text>
							)}
						</Show>
					</box>
					<box paddingLeft={2} flexDirection="column">
						<For each={tool.alwaysRows ?? []}>
							{(row) => (
								<text fg={markerColor(row.tone)} wrapMode="none" truncate>
									{row.text}
								</text>
							)}
						</For>
					</box>
					<Show when={props.expanded}>
						<box paddingLeft={2} flexDirection="column">
							<For each={tool.rows ?? []}>
								{(row) => (
									<text fg={markerColor(row.tone)} wrapMode="none" truncate>
										{row.text}
									</text>
								)}
							</For>
							{/* A long view splits into parts: the header stays, so
							    folding one away keeps the overview. */}
							<For each={tool.sections ?? []}>
								{(section) => {
									const key = `${props.block.id}:${section.id}`;
									const folded = () => props.foldedSections().has(key);
									return (
										<box flexDirection="column">
											<box
												flexDirection="row"
												onMouseUp={() => props.onToggleSection(key)}
											>
												<text fg={uiColors.textMuted} wrapMode="none" truncate>
													{folded() ? "▸" : "▾"} {section.label}{" "}
													{`(${section.rows.length} lines)`}
												</text>
											</box>
											<Show when={!folded()}>
												<box flexDirection="column" paddingLeft={2}>
													<For each={section.rows}>
														{(row) => (
															<text
																fg={markerColor(row.tone)}
																wrapMode="none"
																truncate
															>
																{row.text}
															</text>
														)}
													</For>
												</box>
											</Show>
										</box>
									);
								}}
							</For>
						</box>
					</Show>
				</box>
			</box>
		);
	}

	const content = () => {
		switch (props.block.kind) {
			case "tool":
				// One line per tool call: the result's answer replaces the request, and
				// the full output (plus the request) only shows when expanded.
				return (
					<box flexDirection="column">
						<box
							flexDirection="row"
							onMouseUp={() => props.onToggle(props.block.id)}
						>
							<text width={2} flexShrink={0} fg={color()}>
								{props.block.icon ?? "•"}
							</text>
							<text
								fg={color()}
								flexGrow={1}
								minWidth={0}
								wrapMode="none"
								truncate
							>
								{props.block.text}
								{props.block.pending ? " …" : ""}
							</text>
							<Show when={(props.block.detail?.length ?? 0) > 0}>
								<text fg={uiColors.textMuted} flexShrink={0}>
									{props.expanded ? " ▾" : " ▸"}
								</text>
							</Show>
						</box>
						<Show when={props.expanded}>
							<box paddingLeft={2} flexDirection="column">
								<Show when={props.block.request}>
									{(request) => (
										<text fg={uiColors.textMuted} wrapMode="none" truncate>
											{request()}
										</text>
									)}
								</Show>
								<For each={props.block.detail ?? []}>
									{(line) => <text fg={uiColors.textMuted}>{line}</text>}
								</For>
							</box>
						</Show>
					</box>
				);
			case "result":
				return (
					<box flexDirection="column">
						<box flexDirection="row">
							<text width={2} flexShrink={0} fg={color()}>
								{props.block.tone === "error" ? "✗" : "✓"}
							</text>
							<text fg={color()} flexGrow={1}>
								{props.block.text}
							</text>
						</box>
						<Show when={props.block.detail}>
							{(detail) => (
								<box paddingLeft={2} flexDirection="column">
									<For each={detail()}>
										{(line) => <text fg={uiColors.textMuted}>{line}</text>}
									</For>
								</box>
							)}
						</Show>
					</box>
				);
			case "error":
				return <text fg={uiColors.error}>Error: {props.block.text}</text>;
			case "notice":
				return <text fg={color()}>{props.block.text}</text>;
			case "compaction":
				return <text fg={uiColors.textMuted}>— {props.block.text} —</text>;
		}
	};
	return (
		// The status hint is the same left highlight the prompt uses: a
		// one-column border in the status color over the tinted background.
		<box
			border={["left"]}
			borderColor={markerColor(props.block.tone)}
			backgroundColor={boxBackground(props.block.tone)}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
		>
			{content()}
		</box>
	);
}

/**
 * The picker's keys are routed by the route's keymap layer (the prompt input
 * is unfocused while a picker is open), so the names it binds must cover every
 * spelling a terminal reports: Enter arrives as `enter` or `return`, and the
 * unpicked letters are the filter's alphabet.
 */
export const SESSION_PICKER_KEYS = [
	"j",
	"k",
	"up",
	"down",
	"enter",
	"return",
	"escape",
	"/",
	"backspace",
	..."abcdefghijklmnopqrstuvwxyz".split(""),
];

type PickerKind = "model" | "thinking";
interface PickerState {
	readonly kind: PickerKind;
	readonly selected: number;
	readonly filter: string;
	readonly filtering: boolean;
}

export function AgentSessionView(props: AgentSessionViewProps) {
	let inputRef: InputRenderable | undefined;
	// Negative offsets from newest; zero is the empty prompt, not an entry.
	let historyIndex = 0;
	const recallHistory = (direction: -1 | 1): boolean => {
		const value = inputRef?.value ?? props.draft;
		if (value.length === 0) historyIndex = 0;
		// Only empty or unchanged recalled input can navigate. Never overwrite edits.
		else if (historyIndex === 0 || value !== props.history.at(historyIndex))
			return false;
		const next = Math.max(
			-props.history.length,
			Math.min(0, historyIndex + direction),
		);
		if (next === historyIndex) return historyIndex !== 0;
		historyIndex = next;
		props.onDraftChange(next === 0 ? "" : (props.history.at(next) ?? ""));
		setAutocompleteIndex(0);
		return true;
	};
	/**
	 * The transcript rows, plus the id the "new content" divider sits above.
	 *
	 * The rows reuse the previous frame's blocks wherever their content did not
	 * change: `<For>` keys its rows by object identity, and a watch frame hands
	 * us a freshly built block for every entry, so rendering the rebuilt array
	 * directly would recreate every row each frame and take each markdown
	 * renderable through its async highlight pass again — the transcript
	 * flashing after every message.
	 *
	 * The divider opens the newest run of the model's output: the first block
	 * that is not a user or engine message after the newest one. A turn's steps
	 * (thoughts, tool calls, the answer, its footer) are one run, so the divider
	 * stays at the run's first block as the turn fills in, and moves when the
	 * next turn's output starts. While the newest message is the user's own, the
	 * divider keeps the position it had — it marks output, not the prompt. It
	 * starts unset: opening a page adds no output.
	 */
	const transcript = createMemo((previous: TranscriptState | undefined) => {
		const rows = reuseAgentSessionBlocks(previous?.rows ?? [], props.blocks);
		if (!previous) return { rows, dividerId: undefined };
		const newestUser = rows.findLastIndex((row) => row.kind === "user");
		const runStart =
			newestUser >= 0
				? rows.findIndex(
						(row, index) => index > newestUser && row.kind !== "user",
					)
				: -1;
		return {
			rows,
			dividerId: runStart >= 0 ? rows[runStart]?.id : previous.dividerId,
		};
	}, undefined);
	// The oldest rendered row. While the reader is at the bottom the window
	// slides with the newest output; once they scroll up it is anchored to this
	// row instead, so arriving output never slides the rendered transcript (and
	// the viewport with it) out from under them. The projection keeps far more
	// than a screenful, so reaching the top loads the older rows the window left
	// out rather than dropping them.
	const [anchor, setAnchor] = createSignal<AgentSessionBlock | undefined>();
	const windowRows = () => {
		const rows = transcript().rows;
		const oldest = anchor();
		const start = oldest ? rows.indexOf(oldest) : -1;
		if (start >= 0) return rows.slice(start);
		return rows.slice(Math.max(0, rows.length - TRANSCRIPT_WINDOW));
	};
	let scrollBox: ScrollBoxRenderable | undefined;
	/** A load in flight: the frame that lays the older rows out moves the
	 * viewport down by their height, so the reader keeps their place. */
	let pendingLoad: { height: number; top: number } | undefined;
	const loadOlder = () => {
		const box = scrollBox;
		if (!box || pendingLoad) return;
		const rows = transcript().rows;
		const oldest = anchor();
		const start =
			oldest && rows.indexOf(oldest) >= 0
				? rows.indexOf(oldest)
				: Math.max(0, rows.length - TRANSCRIPT_WINDOW);
		if (start <= 0) return;
		pendingLoad = { height: box.scrollHeight, top: box.scrollTop };
		setAnchor(rows[Math.max(0, start - TRANSCRIPT_PAGE)]);
	};
	const [picker, setPicker] = createSignal<PickerState | undefined>();
	const [autocompleteIndex, setAutocompleteIndex] = createSignal(0);
	// Which thinking blocks are expanded, by block id: collapsed by default so a
	// long reasoning block is one line until asked for, and an entry keeps its
	// state while output arrives around it.
	const [expandedBlocks, setExpandedBlocks] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	// Which parts of an expanded tool view are folded away, by
	// `${block.id}:${section.id}`. Empty means every part is open.
	const [foldedSections, setFoldedSections] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	const toggleSection = (key: string) => {
		setFoldedSections((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const toggleBlock = (id: string) => {
		setExpandedBlocks((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	/** Ctrl+T / Ctrl+O: expand every block of one kind, or collapse them all. */
	const toggleBlocksOfKind = (kind: AgentSessionBlock["kind"]) => {
		const ids = props.blocks.flatMap((block) =>
			block.kind === kind ? [block.id] : [],
		);
		setExpandedBlocks((current) =>
			ids.some((id) => current.has(id))
				? new Set<string>()
				: new Set<string>(ids),
		);
	};

	const thinkingLevels = () =>
		props.thinkingLevels.length > 0
			? props.thinkingLevels
			: [...DEFAULT_THINKING_LEVELS];

	/** opencode's prompt-footer meter: `63.9K (6%) · $0.01`. */
	const contextMeter = () => {
		const parts: string[] = [];
		if (props.contextTokens !== undefined) {
			const percent =
				props.contextWindow !== undefined && props.contextWindow > 0
					? ` (${Math.round((props.contextTokens / props.contextWindow) * 100)}%)`
					: "";
			parts.push(`${formatTokenCount(props.contextTokens)}${percent}`);
		}
		if (props.cost !== undefined) parts.push(formatCost(props.cost));
		return parts.join(" · ");
	};

	/** The command list shown while the draft is still a bare `/prefix`. */
	const autocompleteItems = () => {
		const match = /^\/(\S*)$/.exec(props.draft);
		if (!match) return [];
		const query = (match[1] ?? "").toLowerCase();
		return SESSION_COMMANDS.filter((command) =>
			command.name.slice(1).toLowerCase().startsWith(query),
		);
	};

	const pickerItems = () => {
		const state = picker();
		if (!state) return [];
		const source = state.kind === "model" ? props.models : thinkingLevels();
		const query = state.filter.trim().toLowerCase();
		return query
			? source.filter((item) => item.toLowerCase().includes(query))
			: [...source];
	};

	const closePicker = () => {
		setPicker(undefined);
		props.onPickerActiveChange?.(false);
	};
	const openPicker = (kind: PickerKind) => {
		setPicker({ kind, selected: 0, filter: "", filtering: false });
		props.onPickerActiveChange?.(true);
	};
	const selectPicker = () => {
		const state = picker();
		if (!state) return;
		const value = pickerItems()[state.selected];
		if (value) {
			props.onConfigure(
				state.kind === "model" ? { model: value } : { thinking: value },
			);
		}
		closePicker();
	};
	const handlePickerKey = (event: KeyEvent): boolean => {
		const state = picker();
		if (!state) return false;
		const name = event.name.toLowerCase();
		const items = pickerItems();
		if (state.filtering) {
			if (name === "escape")
				setPicker({ ...state, filtering: false, filter: "" });
			else if (name === "enter" || name === "return")
				setPicker({ ...state, filtering: false });
			else if (name === "backspace")
				setPicker({ ...state, filter: state.filter.slice(0, -1) });
			else if (event.name.length === 1)
				setPicker({ ...state, filter: state.filter + event.name });
			return true;
		}
		if (name === "escape") closePicker();
		else if (name === "j" || name === "down")
			setPicker({
				...state,
				selected: Math.min(Math.max(0, items.length - 1), state.selected + 1),
			});
		else if (name === "k" || name === "up")
			setPicker({ ...state, selected: Math.max(0, state.selected - 1) });
		else if (name === "/") setPicker({ ...state, filtering: true, filter: "" });
		// Terminals report Enter either name, so both must select.
		else if (name === "enter" || name === "return") selectPicker();
		return true;
	};
	onMount(() => props.onPickerKeyReady?.(handlePickerKey));
	onCleanup(() => {
		// Leaving with a picker open must not leave the keymap parked on the
		// picker's letter-wide layer.
		props.onPickerKeyReady?.(() => false);
		props.onPickerActiveChange?.(false);
	});

	const runCommand = (name: string) => {
		props.onHistoryAppend(name);
		historyIndex = 0;
		if (name === MODEL_COMMAND) openPicker("model");
		else if (name === THINKING_COMMAND) openPicker("thinking");
		else if (name === ABORT_COMMAND) props.onAbort();
		else if (name === CLOSE_COMMAND) props.onBack();
		else props.onSubmit(name);
		props.onDraftChange("");
	};

	const submit = () => {
		// An open autocomplete owns Enter: it runs the highlighted command
		// rather than sending the raw text.
		const items = autocompleteItems();
		if (items.length > 0) {
			const item = items[Math.min(autocompleteIndex(), items.length - 1)];
			if (item) {
				runCommand(item.name);
				return;
			}
		}
		const text = (inputRef?.value ?? props.draft).trim();
		if (!text) return;
		runCommand(text);
	};

	// Scrolling is owned by the scroll box (keys, wheel, scrollbar), so the
	// view follows its position instead of intercepting keys: the box's own
	// sticky logic only re-reads "the reader scrolled away from the bottom"
	// from its `scrollTop` setter, which a `scrollBy` from the keymap bypasses —
	// without this, the next frame would yank the viewport back to the bottom.
	onMount(() => {
		const renderer = useRenderer();
		const onFrame = () => {
			const box = scrollBox;
			if (!box || !pendingLoad) return;
			const grown = box.scrollHeight - pendingLoad.height;
			if (grown <= 0) return;
			box.scrollTop = pendingLoad.top + grown;
			pendingLoad = undefined;
		};
		renderer.on(CliRenderEvents.FRAME, onFrame);
		onCleanup(() => renderer.off(CliRenderEvents.FRAME, onFrame));
	});

	/** Stop the window sliding: the rows on screen keep their place while the
	 * reader is not following the newest output. */
	const freezeWindow = () => {
		if (anchor()) return;
		const rows = transcript().rows;
		setAnchor(rows[Math.max(0, rows.length - TRANSCRIPT_WINDOW)]);
	};

	const attachScrollBox = (box: ScrollBoxRenderable) => {
		scrollBox = box;
		const onScroll = () => {
			// The box only re-reads "the reader scrolled away from the bottom"
			// from its own `scrollTop` setter, which a `scrollBy` from the keymap
			// bypasses: without this the next frame would yank the viewport back
			// down to the bottom.
			box.scrollTo(box.scrollTop);
			if (box.scrollTop < box.scrollHeight - box.viewport.height)
				freezeWindow();
			if (box.scrollTop <= 0) loadOlder();
		};
		box.verticalScrollBar.on("change", onScroll);
		onCleanup(() => box.verticalScrollBar.off("change", onScroll));
		props.onScrollBoxReady?.(box);
	};

	return (
		<>
			{/* The page fills the body its host reserved for it (the shell owns the
			    blank lines around the header and footer) and spans its full width:
			    the transcript and the prompt are the page's own edges, so they carry
			    no margin of their own. The run is named by the prompt's metadata row
			    instead of a title row of its own. */}
			<box
				width="100%"
				height="100%"
				flexDirection="column"
				minHeight={0}
				backgroundColor={uiColors.bgBase}
			>
				<box width="100%" flexDirection="column" flexGrow={1} minHeight={0}>
					<ScrollableContent
						stickyStart="bottom"
						stickyScroll
						// Expanded tool output can be thousands of lines; culling keeps
						// the transcript's cost to what is on screen.
						viewportCulling
						onScrollBoxReady={attachScrollBox}
						// One blank line between the transcript and the prompt: the
						// transcript owns it, so the autocomplete stays attached to the
						// prompt it completes.
						style={{ marginBottom: 1 }}
					>
						<box flexDirection="column" gap={1}>
							<For each={windowRows()}>
								{(block) => (
									<box width="100%" flexDirection="column">
										{/* Above the newest output's first block, and only there:
										    the divider is the boundary, not a mark on the
										    content. */}
										<Show when={block.id === transcript().dividerId}>
											<NewContentDivider />
										</Show>
										<Block
											block={block}
											role={props.role}
											expanded={expandedBlocks().has(block.id)}
											onToggle={toggleBlock}
											foldedSections={foldedSections}
											onToggleSection={toggleSection}
										/>
									</box>
								)}
							</For>
						</box>
					</ScrollableContent>
					{/* opencode-style command autocomplete: appears above the prompt
					    while the draft is a bare `/prefix`. */}
					<Show when={autocompleteItems().length > 0}>
						<box
							flexDirection="column"
							flexShrink={0}
							border={["left"]}
							borderColor={uiColors.accent}
							backgroundColor={uiColors.bgMantle}
						>
							<For each={autocompleteItems()}>
								{(command, index) => (
									<box
										flexDirection="row"
										gap={2}
										paddingLeft={2}
										paddingRight={1}
										backgroundColor={
											index() === autocompleteIndex()
												? uiColors.selectionBg
												: undefined
										}
									>
										<text
											width={14}
											flexShrink={0}
											fg={
												index() === autocompleteIndex()
													? uiColors.selectionText
													: uiColors.textPrimary
											}
										>
											{command.name}
										</text>
										<text
											fg={
												index() === autocompleteIndex()
													? uiColors.selectionText
													: uiColors.textMuted
											}
										>
											{command.description}
										</text>
									</box>
								)}
							</For>
						</box>
					</Show>
					{/* opencode v2's prompt: a left-bordered raised block holding the
					    input and a metadata row with a live working indicator. */}
					<box
						border={["left"]}
						borderColor={uiColors.accent}
						flexShrink={0}
						backgroundColor={uiColors.bgMantle}
					>
						{/* The status indicator's line, outside the input's horizontal
						    padding so it spans the full box width: a pulsing gradient
						    while working, held static red on error, a plain line when
						    idle (so the prompt never changes height, and an idle prompt
						    runs no animation). */}
						<Show
							when={props.working || props.error !== undefined}
							fallback={
								<box
									width="100%"
									height={1}
									flexShrink={0}
									backgroundColor={uiColors.bgMantle}
								/>
							}
						>
							<PromptPulse
								active={props.working}
								error={props.error !== undefined && !props.working}
							/>
						</Show>
						<box
							flexDirection="column"
							flexGrow={1}
							paddingLeft={2}
							paddingRight={2}
						>
							<input
								ref={inputRef}
								focused={picker() === undefined}
								value={props.draft}
								placeholder="Ask anything…"
								onInput={(value: string) => {
									props.onDraftChange(value);
									setAutocompleteIndex(0);
								}}
								onSubmit={submit}
								onKeyDown={(event: KeyEvent) => {
									if (event.ctrl && event.name.toLowerCase() === "t") {
										event.preventDefault();
										toggleBlocksOfKind("reasoning");
										return;
									}
									if (event.ctrl && event.name.toLowerCase() === "o") {
										event.preventDefault();
										toggleBlocksOfKind("tool");
										return;
									}
									const name = event.name.toLowerCase();
									// `?` opens the shared help, but only on an empty prompt: a message
									// may start with one, so anything typed keeps it literal.
									if (
										name === "?" &&
										(inputRef?.value ?? props.draft).length === 0
									) {
										event.preventDefault();
										props.onHelp?.();
										return;
									}
									if (
										!event.ctrl &&
										!event.meta &&
										!event.shift &&
										(name === "up" || name === "down") &&
										recallHistory(name === "up" ? -1 : 1)
									) {
										event.preventDefault();
										return;
									}
									const items = autocompleteItems();
									if (items.length === 0) return;
									if (name === "down") {
										event.preventDefault();
										setAutocompleteIndex((index) => (index + 1) % items.length);
									} else if (name === "up") {
										event.preventDefault();
										setAutocompleteIndex(
											(index) => (index - 1 + items.length) % items.length,
										);
									} else if (name === "tab") {
										event.preventDefault();
										const item =
											items[Math.min(autocompleteIndex(), items.length - 1)];
										if (item) {
											historyIndex = 0;
											props.onDraftChange(item.name);
										}
									}
								}}
								focusedBackgroundColor={uiColors.bgMantle}
								focusedTextColor={uiColors.textPrimary}
							/>
							<box
								flexDirection="row"
								gap={1}
								paddingTop={1}
								alignItems="center"
							>
								<text fg={uiColors.accent} flexShrink={0}>
									{titlecase(props.role)}
								</text>
								<Show when={props.model}>
									{(model) => (
										<>
											<text fg={uiColors.textMuted} flexShrink={0}>
												·
											</text>
											<text
												fg={uiColors.textPrimary}
												flexShrink={1}
												minWidth={0}
												wrapMode="none"
												truncate
											>
												{truncateModel(model())}
											</text>
										</>
									)}
								</Show>
								<Show when={props.thinking}>
									{(thinking) => (
										<>
											<text fg={uiColors.textMuted} flexShrink={0}>
												·
											</text>
											<text
												fg={uiColors.warning}
												attributes={TextAttributes.BOLD}
												flexShrink={0}
											>
												{thinking()}
											</text>
										</>
									)}
								</Show>
								<box flexGrow={1} minWidth={0} />
								<Show when={contextMeter().length > 0}>
									<text fg={uiColors.textMuted} flexShrink={0} wrapMode="none">
										{contextMeter()}
									</text>
								</Show>
							</box>
						</box>
					</box>
				</box>
			</box>
			<Show when={picker()}>
				{(state) => (
					<ListViewModal
						sizing="cap"
						title={
							state().kind === "model"
								? "Select model"
								: "Select thinking level"
						}
						items={pickerItems()}
						selectedIndex={state().selected}
						filterPlaceholder="Filter"
						filterActive={state().filtering}
						filterQuery={state().filter}
						help={
							state().filtering
								? [
										{ key: "Type", action: "Filter query" },
										{ key: "Enter", action: "Done filtering" },
										{ key: "Esc", action: "Dismiss filter" },
									]
								: [
										{ key: "j/k", action: "Navigate" },
										{ key: "/", action: "Filter" },
										{ key: "Enter", action: "Select" },
										{ key: "Esc", action: "Cancel" },
									]
						}
						renderItem={(item, isActive) => (
							<text fg={isActive() ? uiColors.primary : uiColors.textSecondary}>
								{item}
							</text>
						)}
					/>
				)}
			</Show>
		</>
	);
}
