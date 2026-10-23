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
// single `Thinking…` line; every tool call is a raised left-ruled block with a
// spinner in the icon gutter while it runs. Every other entry keeps the same
// left highlight the prompt uses, but stays on the page background: only the
// prompt, user messages and tool calls are raised surfaces. The prompt below
// mirrors opencode v2: a left-bordered raised block with the input and a
// metadata row (`Role · model · thinking` plus a live working indicator).
//
// The view replaces the detail grid, so its own keys (scroll, back) and the
// picker's keys are route keymap layers gated on the `agent.view` field. The
// prompt input is focused only while this view owns the keyboard and keeps
// accepting ordinary characters, including `j`, `k` and a `?` that starts a
// message; a keymap-only surface (the workspace sidebar, an open dialog) blurs
// it through `inputActive` so its keys are not swallowed.
import type {
	KeyEvent,
	Renderable,
	ScrollBoxRenderable,
	TextareaRenderable,
} from "@opentui/core";
import { CliRenderEvents, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
	ListViewModal,
	type MarkdownBlockPart,
	MarkdownViewer,
	ScrollableContent,
	type StreamingMarkdownBlockParts,
	streamingMarkdownBlockParts,
	streamingTailSource,
	uiColors,
	useMarkdownSyntaxStyle,
	useModalBackdrop,
	useRowMouse,
	useTap,
} from "@ui";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import {
	type AgentSessionBlock,
	type AgentSessionTone,
	BROWSER_TOOL_GLYPH,
	formatCallDuration,
	formatClock,
	formatCost,
	formatDuration,
	formatTokenCount,
	isBrowserTool,
	reuseAgentSessionBlocks,
	SLOW_CALL_MS,
} from "../agent-session.ts";
import { PromptPulse } from "./PromptPulse.tsx";
import { Spinner } from "./Spinner.tsx";
import {
	type ToolViewRow,
	type ToolViewSection,
	toolPendingView,
	toolView,
} from "./tool-views.ts";

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
	/** The conversation's accumulated input/output tokens. */
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	/** Output tokens over the conversation's measured generation time. */
	readonly tokensPerSecond?: number;
	/** A compaction in flight, so the status line shows a reason-carrying
	 * indicator (`add-agent-compaction`: "Compaction feedback"). */
	readonly compacting?: { readonly reason: string; readonly retrying?: string };
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
	/** Summarize this conversation's context on demand. The optional instructions
	 * are the free text after `/compact`; the host answers with one structured
	 * outcome the route reports as a notice. */
	readonly onCompact: (instructions?: string) => void;
	/** The transcript scroll box, so the route's keymap layer can scroll it. */
	readonly onScrollBoxReady?: (box: ScrollBoxRenderable) => void;
	/** The picker's key handler, registered while a picker is open. */
	readonly onPickerKeyReady?: (handler: (event: KeyEvent) => boolean) => void;
	/** Whether a picker is open, so the route can switch keymap layers. */
	readonly onPickerActiveChange?: (active: boolean) => void;
	/** `?` on an empty prompt: the route opens the shared keybind help. */
	readonly onHelp?: () => void;
	/** Whether this view owns the keyboard: the dashboard is the active shell
	 * feature and no dialog is on top. False blurs the prompt, so a keymap-only
	 * surface (the workspace sidebar, a modal) keeps the keys. Defaults to true
	 * so a standalone mount stays focused. */
	readonly inputActive?: () => boolean;
	/** Route-specific slash commands, offered after the built-in ones. */
	readonly extraCommands?: readonly SessionRouteCommand[];
}

/** A slash command a route adds to the prompt (for example `/new`). */
export interface SessionRouteCommand {
	readonly name: string;
	readonly description: string;
	readonly run: () => void;
}

/** Typing one of these exact messages, instead of an ordinary one, performs
 * the named action. See the module comment for why these are slash commands
 * rather than key bindings. */
export const ABORT_COMMAND = "/abort";
export const CLOSE_COMMAND = "/hide";
export const MODEL_COMMAND = "/model";
/** opencode calls the picker `/models`; accept that spelling as an alias while
 * `/model` stays the command the autocomplete lists. */
export const MODELS_COMMAND = "/models";
export const THINKING_COMMAND = "/thinking";
export const TIMELINE_COMMAND = "/timeline";
export const LATEST_COMMAND = "/latest";
/** Summarize the conversation's context (`add-agent-compaction`). An optional
 * free-text argument is passed to the summarizer as its instructions, exactly
 * as a `/model` or `/thinking` argument is passed to the host. */
export const COMPACT_COMMAND = "/compact";

interface SessionCommand {
	readonly name: string;
	readonly description: string;
}

/** The slash commands the prompt autocompletes, opencode-style: type `/` and
 * the list appears above the input. */
const SESSION_COMMANDS: readonly SessionCommand[] = [
	{ name: MODEL_COMMAND, description: "Change the model for this run" },
	{ name: THINKING_COMMAND, description: "Change the thinking level" },
	{
		name: COMPACT_COMMAND,
		description: "Summarize the context (optional instructions)",
	},
	{ name: TIMELINE_COMMAND, description: "Jump to a user message" },
	{ name: LATEST_COMMAND, description: "Jump to the latest output" },
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

/** Rows rendered on open, and how many more each load at the top adds. The
 * projection keeps a longer transcript, so the window is a rendering budget,
 * not the transcript's own bound. */
const TRANSCRIPT_WINDOW = 60;
const TRANSCRIPT_PAGE = 40;
/** Compact user prompts while preserving the full text for click-to-expand. */
const USER_PROMPT_PREVIEW_LINES = 5;

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

/** A tool block's left rule carries the call's state: light grey while it runs,
 * green once it succeeds, red when it fails. An aborted call never ran to a
 * result, so it stays neutral rather than reading as a failure. */
function toolBorderColor(block: AgentSessionBlock): string {
	if (block.pending === true) return uiColors.textMuted;
	if (block.tone === "error" || block.toolCall?.result?.isError === true)
		return uiColors.error;
	if (block.tone === "success" || block.toolCall?.result !== undefined)
		return uiColors.success;
	return uiColors.textMuted;
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

/** Parsed markdown parts, per block id, kept for the life of one view: a
 * streaming block re-renders every frame, and this is what lets a frame lex its
 * tail instead of the whole message. */
type MarkdownPartsFor = (
	key: string,
	text: string,
) => readonly MarkdownBlockPart[];

/**
 * Hold back the last line of a live markdown part. OpenTUI 0.6's streaming
 * parser can relayout the block above an unfinished line (a list item, table
 * row or blockquote), so the line is committed only when the next line starts.
 */
function holdBackTrailingLine(source: string): string {
	const lastBreak = source.lastIndexOf("\n");
	if (lastBreak <= 0) return source;
	const previousBreak = source.lastIndexOf("\n", lastBreak - 1);
	if (previousBreak < 0) return source;
	return source.slice(0, previousBreak).replace(/\s+$/, "");
}

/**
 * One assistant message as its markdown pieces. A single `<markdown>` for the
 * whole message would stay blank wherever the asynchronous syntax pass has not
 * landed yet — every paragraph, or (with the streaming preview on) every code
 * block — so code draws as a code block and prose as a streaming preview, and
 * neither waits to become visible.
 *
 * Only the last part is still growing. It is drawn from its text with the
 * unfinished trailing line held back (see `streamingTailSource`), and while the
 * message is live the previous line is held back as well, so the streaming
 * parser cannot move a settled line back down by reflowing the trailing block.
 */
function AssistantMarkdown(props: {
	transcript: MarkdownPartsFor;
	/** Identity of the message this text belongs to: the key its parsed parts are
	 * reused under across frames. */
	partKey: string;
	text: string;
	live?: boolean;
}) {
	// Lexing the message is the expensive part of a render, so it happens once
	// per text (every streaming frame), not once per part — and a frame that only
	// appended to the message reuses the parts the previous frame settled.
	const parts = createMemo(() => props.transcript(props.partKey, props.text));
	return (
		<box flexDirection="column">
			<For each={parts()}>
				{(part, index) => (
					<MarkdownViewer
						content={(() => {
							const last = index() === parts().length - 1;
							const source = last ? streamingTailSource(part) : part.source;
							return last && props.live === true
								? holdBackTrailingLine(source)
								: source;
						})()}
						fg={uiColors.textPrimary}
						// Prose always takes the streaming preview: it draws the text
						// concealed, so it never re-flashes its own markers. A fenced
						// block draws its raw text instead, which re-adds the fence
						// lines on every chunk — while the message is still arriving it
						// keeps the text it already laid out instead, so the transcript
						// holds its height and the reader is not jolted line by line.
						streaming={part.code ? props.live === true : true}
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

interface ReadActivityGroup {
	readonly displayKind: "read-activity-group";
	readonly id: string;
	readonly blocks: readonly AgentSessionBlock[];
}

type TranscriptDisplayRow = AgentSessionBlock | ReadActivityGroup;

/** Only successful, completed reads can disappear into a summary. Pending,
 * aborted, and failed calls stay individually visible. */
function canGroupRead(
	block: AgentSessionBlock | undefined,
): block is AgentSessionBlock {
	return (
		block?.kind === "tool" &&
		block.tool?.toLowerCase() === "read" &&
		block.pending !== true &&
		block.aborted !== true &&
		block.tone === "success"
	);
}

function readGroupLabel(blocks: readonly AgentSessionBlock[]): string {
	return `${blocks.length} reads`;
}

/** The timing of one transcript row, drawn at its right edge: how long a tool
 * call took (a slow one in the warning color, so the expensive calls stand out
 * as the transcript scrolls) and the time of day it started. Both are muted
 * context beside the row's own content, and each is simply absent when the
 * source recorded no time for it. */
function Stamp(props: {
	block: AgentSessionBlock;
	/** Draw the call's duration too (a tool row); the others show the clock. */
	duration?: boolean;
}) {
	return (
		<>
			<Show when={props.duration === true && props.block.durationMs}>
				{(ms) => (
					<text
						fg={ms() >= SLOW_CALL_MS ? uiColors.warning : uiColors.textMuted}
						flexShrink={0}
					>
						{` ${formatCallDuration(ms())}`}
					</text>
				)}
			</Show>
			<Show when={props.block.startedAt}>
				{(at) => (
					<text fg={uiColors.textMuted} flexShrink={0}>
						{` ${formatClock(at())}`}
					</text>
				)}
			</Show>
		</>
	);
}

/** One row of a specialized tool view. A row with a detail of its own — a
 * codemode call is a whole tool call, a question offers its options — folds
 * open into it, so one part can be read without expanding the rest. */
function ToolRow(props: {
	block: AgentSessionBlock;
	row: ToolViewRow;
	/** Which rows are folded open, and how to fold one. */
	openRows: () => ReadonlySet<string>;
	onToggleRow: (key: string) => void;
	transcript: MarkdownPartsFor;
}) {
	const key = () => `${props.block.id}:${props.row.id ?? props.row.text}`;
	const open = () => props.openRows().has(key());
	const detail = () => props.row.detail ?? [];
	const syntaxStyle = useMarkdownSyntaxStyle();
	// A row of source — a codemode script — is drawn as the code it is, one
	// highlighted block rather than a fold. `drawUnstyledText` keeps it visible
	// while the tree-sitter pass is still in flight.
	if (props.row.syntax)
		return (
			<box flexDirection="column">
				<code
					filetype={props.row.syntax}
					content={props.row.text}
					syntaxStyle={syntaxStyle}
					drawUnstyledText
					fg={markerColor(props.row.tone)}
				/>
			</box>
		);
	return (
		<box flexDirection="column">
			<box
				flexDirection="row"
				{...(detail().length > 0 ? useTap(() => props.onToggleRow(key())) : {})}
			>
				<Show when={detail().length > 0}>
					<text width={2} flexShrink={0} fg={uiColors.textMuted}>
						{open() ? "▾" : "▸"}
					</text>
				</Show>
				<Show
					when={props.row.markdown}
					fallback={
						// A row is read in place: a long output line wraps onto the
						// next rows instead of losing its middle to an ellipsis.
						<text fg={markerColor(props.row.tone)} wrapMode="word">
							{props.row.text}
						</text>
					}
				>
					<AssistantMarkdown
						transcript={props.transcript}
						partKey={key()}
						text={props.row.text}
					/>
				</Show>
			</box>
			<Show when={open()}>
				<box flexDirection="column" paddingLeft={2}>
					{/* A row's detail is rows again: a question folds into its options, an
					    option into the description the agent attached to it. */}
					<For each={detail()}>
						{(row) => (
							<ToolRow
								block={props.block}
								row={row}
								openRows={props.openRows}
								onToggleRow={props.onToggleRow}
								transcript={props.transcript}
							/>
						)}
					</For>
				</box>
			</Show>
		</box>
	);
}

/** The lines a section's rows carry: a row may be one output line or a whole
 * block of source drawn as one highlighted code row. */
function sectionLineCount(section: ToolViewSection): number {
	return section.rows.reduce(
		(total, row) => total + row.text.split("\n").length,
		0,
	);
}

/** The surface every tool call is drawn on: opencode's raised block with a heavy
 * left rule and one line of the raised surface above and below the call. The
 * rule takes the call's state color (grey while running, green on success, red
 * on failure). opencode itself keeps ordinary calls inline, but this transcript
 * uses the block for every tool so a run reads as one consistent stack of call
 * surfaces rather than switching shapes by tool. */
function ToolFrame(props: { color: string; children: JSX.Element }) {
	return (
		<box
			border={["left"]}
			borderStyle="heavy"
			borderColor={props.color}
			backgroundColor={uiColors.bgMantle}
			paddingTop={1}
			paddingBottom={1}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
		>
			{props.children}
		</box>
	);
}

/** A tool call's header row: fold, family glyph, action icon, label, facts and
 * timing. Browser tools carry their web glyph before the action icon, so the
 * family reads at a glance while the action icon keeps the call's state. The
 * icon slot carries the spinner while the call runs, the way opencode draws a
 * running tool. An ordinary call is muted; only a failed one takes the error
 * color. */
function ToolCallHeader(props: {
	block: AgentSessionBlock;
	icon: string;
	label: string;
	hint?: string;
	expandable: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	const fg = () =>
		props.block.tone === "error" ? uiColors.error : uiColors.textMuted;
	const browser = () =>
		isBrowserTool(props.block.toolCall?.name ?? props.block.tool);
	return (
		<box flexDirection="row" {...useTap(props.onToggle)}>
			{/* The fold glyph leads the row, so a list of tool rows reads as a list
			    of folds rather than a ragged right edge. */}
			<text width={2} flexShrink={0} fg={uiColors.textMuted}>
				{props.expandable ? (props.expanded ? "▾" : "▸") : ""}
			</text>
			{/* Browser tools need one more cell: family glyph + action glyph + the
			    gap before the label. Other tools keep the existing two-cell gutter. */}
			<box width={browser() ? 3 : 2} flexShrink={0} flexDirection="row">
				<Show when={browser()}>
					<text fg={uiColors.textMuted} flexShrink={0}>
						{BROWSER_TOOL_GLYPH}
					</text>
				</Show>
				<Show
					when={props.block.pending === true}
					fallback={<text fg={fg()}>{props.icon}</text>}
				>
					<Spinner color={fg()} />
				</Show>
			</box>
			{/* The label is the call's own text — a path, a command — and a reader
			    folds the row to see the call, not to see a clipped one: it wraps
			    onto further lines instead of being cut with an ellipsis. The fold
			    glyph, icon and facts stay on the first line. */}
			<text fg={fg()} flexGrow={1} minWidth={0} wrapMode="word">
				{props.label}
			</text>
			<Show when={props.hint}>
				{(hint) => (
					<text fg={uiColors.textMuted} flexShrink={0}>
						{` ${hint()}`}
					</text>
				)}
			</Show>
			<Show when={props.block.aborted}>
				<text fg={uiColors.error} flexShrink={0}>
					{" aborted"}
				</text>
			</Show>
			<Stamp block={props.block} duration />
		</box>
	);
}

/** One transcript entry. Assistant output is markdown with no status box;
 * thinking is collapsible; a tool call is a raised bordered block; every other
 * entry is a status box with the same left highlight the prompt uses. */
function Block(props: {
	block: AgentSessionBlock;
	role: string;
	expanded: boolean;
	onToggle: (id: string) => void;
	/** The parsed markdown parts of a block, reused across this view's frames. */
	transcript: MarkdownPartsFor;
	/** Which parts a reader toggled away from their default, and how to toggle
	 * one: a part that starts folded (`script`) opens on a click, one that starts
	 * open closes on it. */
	toggledSections: () => ReadonlySet<string>;
	onToggleSection: (key: string) => void;
	/** The rows folded open, and how to fold one: a call inside a script opens
	 * into its own view without expanding the rest. */
	openRows: () => ReadonlySet<string>;
	onToggleRow: (key: string) => void;
}) {
	const color = () => toneColor(props.block.tone);
	if (props.block.kind === "summary")
		// opencode's assistant footer: agent · model · duration · tok/s.
		return (
			<box paddingLeft={3} paddingRight={1} flexShrink={0} flexDirection="row">
				<text
					fg={uiColors.textMuted}
					flexGrow={1}
					minWidth={0}
					wrapMode="none"
					truncate
				>
					{titlecase(props.role)} · {props.block.text}
				</text>
				<Stamp block={props.block} />
			</box>
		);
	if (props.block.kind === "user")
		// opencode's user prompt: the prompt box's own raised block, with a blank
		// line above and below the text so a message reads as a paragraph of its
		// own instead of a dense row. Long prompts fold to a short preview.
		return (
			<box
				border={["left"]}
				borderColor={uiColors.accent}
				backgroundColor={uiColors.bgMantle}
				paddingBottom={1}
				paddingLeft={2}
				paddingRight={1}
				flexShrink={0}
				{...useTap(() => props.onToggle(props.block.id))}
			>
				{/* The blank line above the prompt carries its disclosure and time. */}
				<box flexDirection="row" justifyContent="flex-end" height={1}>
					<text fg={uiColors.textMuted}>{props.expanded ? "▾ " : "▸ "}</text>
					<Stamp block={props.block} />
				</box>
				<box
					maxHeight={
						props.expanded
							? props.block.text.length + 1
							: USER_PROMPT_PREVIEW_LINES
					}
					overflow="hidden"
				>
					<text fg={uiColors.textPrimary}>{props.block.text}</text>
				</box>
			</box>
		);
	if (props.block.kind === "assistant")
		return (
			<box paddingLeft={3} paddingRight={1} flexShrink={0}>
				<AssistantMarkdown
					transcript={props.transcript}
					partKey={props.block.id}
					text={props.block.text}
					{...(props.block.live === true ? { live: true } : {})}
				/>
			</box>
		);
	if (props.block.kind === "reasoning")
		// A reasoning block that is still streaming is the same fold, dimmed:
		// the text grows with each watch frame while the model thinks, so it
		// reads as provisional until the committed entry replaces it at full
		// strength.
		return (
			<box
				paddingLeft={3}
				paddingRight={1}
				flexDirection="column"
				flexShrink={0}
				{...useTap(() => props.onToggle(props.block.id))}
			>
				<box flexDirection="row">
					<box flexGrow={1} minWidth={0} flexDirection="row">
						<text
							fg={
								props.block.live === true
									? uiColors.textMuted
									: uiColors.warning
							}
							attributes={
								props.block.live === true ? TextAttributes.DIM : undefined
							}
							flexShrink={0}
						>
							{props.expanded ? "▾" : "▸"}{" "}
						</text>
						<Show
							when={
								props.block.live === true &&
								props.block.durationMs === undefined
							}
						>
							{/* opencode's thinking row: an animated marker while the model is
							    still producing the thought, replaced by the measured duration
							    once it commits. */}
							<Spinner
								color={uiColors.textMuted}
								attributes={TextAttributes.DIM}
							/>
							<text fg={uiColors.textMuted} attributes={TextAttributes.DIM}>
								{" "}
							</text>
						</Show>
						<text
							fg={
								props.block.live === true
									? uiColors.textMuted
									: uiColors.warning
							}
							attributes={
								props.block.live === true ? TextAttributes.DIM : undefined
							}
						>
							{props.block.durationMs !== undefined
								? `Thought: ${formatDuration(props.block.durationMs)}`
								: "Thinking…"}
						</text>
					</box>
					<Stamp block={props.block} />
				</box>
				<Show when={props.expanded}>
					<text
						fg={uiColors.textMuted}
						attributes={
							props.block.live === true
								? TextAttributes.ITALIC | TextAttributes.DIM
								: TextAttributes.ITALIC
						}
					>
						{props.block.text}
					</text>
				</Show>
			</box>
		);
	// The tools a run leans on get a view built from their call and result; a
	// tool without one keeps the generic row below (icon, name, argument). A call
	// still in flight takes the in-progress view instead, so its row appears the
	// moment its name is known and only the arguments (not the answer) are shown.
	const tool = props.block.toolCall
		? props.block.pending === true
			? toolPendingView(props.block.toolCall, props.block.detail ?? [])
			: toolView(props.block.toolCall)
		: undefined;
	if (tool && (props.block.kind === "tool" || props.block.kind === "result")) {
		const expandable = () =>
			(tool.rows?.length ?? 0) > 0 || (tool.sections?.length ?? 0) > 0;
		return (
			<ToolFrame color={toolBorderColor(props.block)}>
				<box flexDirection="column">
					<ToolCallHeader
						block={props.block}
						icon={tool.icon}
						label={tool.label ?? tool.summary}
						hint={tool.hint}
						expandable={expandable()}
						expanded={props.expanded}
						onToggle={() => props.onToggle(props.block.id)}
					/>
					<Show when={props.expanded}>
						<box paddingLeft={2} flexDirection="column">
							<For each={tool.rows ?? []}>
								{(row) => (
									<ToolRow
										block={props.block}
										row={row}
										openRows={props.openRows}
										onToggleRow={props.onToggleRow}
										transcript={props.transcript}
									/>
								)}
							</For>
							{/* A long view splits into parts: the header stays, so
							    folding one away keeps the overview. */}
							<For each={tool.sections ?? []}>
								{(section) => {
									const key = `${props.block.id}:${section.id}`;
									// The signal keys the sections a reader moved; whether a key means
									// "open" or "closed" is the section's own default.
									const open = () => {
										const toggled = props.toggledSections().has(key);
										return section.collapsed === true ? toggled : !toggled;
									};
									return (
										<box flexDirection="column">
											<box
												flexDirection="row"
												{...useTap(() => props.onToggleSection(key))}
											>
												<text fg={uiColors.textMuted} wrapMode="word">
													{open() ? "▾" : "▸"} {section.label}{" "}
													{`(${sectionLineCount(section)} lines)`}
												</text>
											</box>
											<Show when={open()}>
												<box flexDirection="column" paddingLeft={2}>
													<For each={section.rows}>
														{(row) => (
															<ToolRow
																block={props.block}
																row={row}
																openRows={props.openRows}
																onToggleRow={props.onToggleRow}
																transcript={props.transcript}
															/>
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
			</ToolFrame>
		);
	}

	const content = () => {
		switch (props.block.kind) {
			case "tool": {
				// A tool without a specialized view is still a raised block: its own
				// one-line call, with the full request and output under the fold.
				const expandable =
					(props.block.detail?.length ?? 0) > 0 ||
					props.block.request !== undefined;
				return (
					<box flexDirection="column">
						<ToolCallHeader
							block={props.block}
							icon={props.block.icon ?? "•"}
							label={props.block.text}
							expandable={expandable}
							expanded={props.expanded}
							onToggle={() => props.onToggle(props.block.id)}
						/>
						<Show when={props.expanded}>
							<box paddingLeft={2} flexDirection="column">
								<Show when={props.block.request}>
									{(request) => (
										<text fg={uiColors.textMuted} wrapMode="word">
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
			}
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
	if (props.block.kind === "tool")
		return (
			<ToolFrame color={toolBorderColor(props.block)}>{content()}</ToolFrame>
		);
	return (
		// The status hint is the same left highlight the prompt uses, but the row
		// itself stays on the page background: the raised surface is for prompts,
		// user messages and tool calls, not for every status line.
		<box
			border={["left"]}
			borderColor={markerColor(props.block.tone)}
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

type PickerKind = "model" | "thinking" | "timeline";
interface PickerState {
	readonly kind: PickerKind;
	readonly selected: number;
	readonly filter: string;
	readonly filtering: boolean;
}

interface PickerItem {
	readonly value: string;
	readonly label: string;
	readonly detail?: string;
	readonly blockId?: string;
}

export function AgentSessionView(props: AgentSessionViewProps) {
	let inputRef: TextareaRenderable | undefined;
	// The editor buffer is the source of truth while typing (native editing,
	// undo and selection); the draft signal is kept in step with it. The prompt
	// text is mirrored into a signal as it changes, so the autocomplete is live:
	// the editor buffer itself is not reactive, and reading it alone left the
	// command list frozen at the query it opened with.
	const [promptMirror, setPromptMirror] = createSignal(
		untrack(() => props.draft),
	);
	const promptText = () => {
		// The editor buffer is the live value in key handlers; reading the
		// mirror as well makes the render depend on content-change publication.
		const mirrored = promptMirror();
		return inputRef?.plainText ?? mirrored;
	};
	// One write path for every prompt change the view makes itself: the editor
	// buffer first, then the draft the parent owns. The editor publishes its
	// own content change asynchronously, so a clear that waited for the signal
	// to round-trip would land after the next keystrokes.
	const setPrompt = (text: string) => {
		const editor = inputRef;
		if (editor && editor.plainText !== text) {
			editor.setText(text);
			editor.gotoBufferEnd();
		}
		setPromptMirror(text);
		if (props.draft !== text) props.onDraftChange(text);
	};
	// A write the view did not make itself — the parent resetting the draft —
	// reaches the editor here. Typing is skipped: the buffers already match,
	// and re-setting the text would drop the cursor and the undo history.
	createEffect(() => {
		const editor = inputRef;
		const draft = props.draft;
		if (!editor || editor.plainText === draft) {
			setPromptMirror(draft);
			return;
		}
		editor.setText(draft);
		editor.gotoBufferEnd();
		setPromptMirror(draft);
	});
	// Negative offsets from newest; zero is the empty prompt, not an entry.
	let historyIndex = 0;
	const recallHistory = (direction: -1 | 1): boolean => {
		const value = promptText();
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
		setPrompt(next === 0 ? "" : (props.history.at(next) ?? ""));
		setAutocompleteIndex(0);
		return true;
	};
	// The prompt's own first (`up`) or last (`down`) logical line, so history
	// browsing only takes the arrow key the cursor has nowhere left to go with
	// it: inside a multi-line message the arrows move the cursor instead.
	const onPromptEdge = (up: boolean) => {
		const editor = inputRef;
		if (!editor) return true;
		return up
			? editor.logicalCursor.row === 0
			: editor.logicalCursor.row >= editor.lineCount - 1;
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
	const [awayFromBottom, setAwayFromBottom] = createSignal(false);
	const [latestHovered, setLatestHovered] = createSignal(false);
	const windowRows = () => {
		const rows = transcript().rows;
		const oldest = anchor();
		const anchoredStart = oldest ? rows.indexOf(oldest) : -1;
		let start =
			anchoredStart >= 0
				? anchoredStart
				: Math.max(0, rows.length - TRANSCRIPT_WINDOW);
		// Do not cut a run of reads at the render-window seam: its summary should
		// describe the same complete run whether history was loaded or jumped to.
		while (
			start > 0 &&
			canGroupRead(rows[start - 1]) &&
			canGroupRead(rows[start])
		)
			start--;
		return rows.slice(start);
	};
	const displayRows = createMemo<readonly TranscriptDisplayRow[]>(
		(previous) => {
			const existing = new Map<string, ReadActivityGroup>();
			for (const row of previous ?? [])
				if ("displayKind" in row) existing.set(row.id, row);
			const blocks = windowRows();
			const result: TranscriptDisplayRow[] = [];
			for (let index = 0; index < blocks.length; ) {
				if (!canGroupRead(blocks[index])) {
					const block = blocks[index];
					if (block) result.push(block);
					index++;
					continue;
				}
				const start = index++;
				while (canGroupRead(blocks[index])) index++;
				const group = blocks.slice(start, index);
				if (group.length < 2) {
					result.push(...group);
					continue;
				}
				const first = group[0];
				if (!first) continue;
				const id = `read-activity:${first.id}`;
				const before = existing.get(id);
				const unchanged =
					before !== undefined &&
					before.blocks.length === group.length &&
					before.blocks.every((block, offset) => block === group[offset]);
				result.push(
					unchanged
						? before
						: { displayKind: "read-activity-group", id, blocks: group },
				);
			}
			return result;
		},
		[],
	);
	let scrollBox: ScrollBoxRenderable | undefined;
	/** A load in flight: the frame that lays the older rows out moves the
	 * viewport down by their height, so the reader keeps their place. */
	let pendingLoad: { height: number; top: number } | undefined;
	let pendingJump:
		| { readonly kind: "latest" }
		| { readonly kind: "block"; readonly blockId: string }
		| undefined;
	/**
	 * The row the viewport was resting on before a fold, and where it was. A
	 * fold grows or shrinks the content above the reader, and the scroll box
	 * re-pins to the newest output on every content change: without following
	 * this row, opening a block above the viewport moves everything the reader
	 * was looking at.
	 */
	let pendingAnchor: { row: Renderable; screenY: number } | undefined;

	/** The first row at or below the viewport's top edge. */
	const anchorRow = (): Renderable | undefined => {
		const box = scrollBox;
		if (!box) return undefined;
		const top = box.viewport.screenY;
		const rows = box.content.getChildren()[0]?.getChildren() ?? [];
		return rows.find((row) => row.screenY >= top) ?? rows.at(-1);
	};

	/** Keep the reader's place across a fold. */
	const keepPlace = () => {
		const row = anchorRow();
		if (row) pendingAnchor = { row, screenY: row.screenY };
	};
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
	// The picker is a read-only dialog: a backdrop tap is the `Esc` its own
	// handler already implements (closing the filter first, then the picker).
	const pickerBackdrop = useModalBackdrop({ kind: "agent-session-picker" });
	const [autocompleteIndex, setAutocompleteIndex] = createSignal(0);
	// Which thinking blocks are expanded, by block id: collapsed by default so a
	// long reasoning block is one line until asked for, and an entry keeps its
	// state while output arrives around it.
	const [expandedBlocks, setExpandedBlocks] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	const [expandedReadGroups, setExpandedReadGroups] = createSignal<
		ReadonlySet<string>
	>(new Set());
	// Which tool-view rows are folded open, by `${block.id}:${row.id}`: a
	// codemode call row opens into that call's own view, and stays shut until
	// asked for so the call list keeps its overview.
	const [expandedRows, setExpandedRows] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	// The parsed markdown parts per message, kept for the life of the view: the
	// streaming assistant block changes on every host frame, and this is what
	// lets a frame lex only its tail instead of the whole message.
	const markdownCache = new Map<string, StreamingMarkdownBlockParts>();
	const markdownParts: MarkdownPartsFor = (key, text) => {
		const next = streamingMarkdownBlockParts(markdownCache.get(key), text);
		markdownCache.set(key, next);
		return next.parts;
	};
	const toggleRow = (key: string) => {
		keepPlace();
		setExpandedRows((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	// Which parts of an expanded tool view a reader moved away from their
	// default, by `${block.id}:${section.id}`. Empty means every part is in its
	// own default state: a section with `collapsed` starts folded, the rest open.
	const [toggledSections, setToggledSections] = createSignal<
		ReadonlySet<string>
	>(new Set());
	const toggleSection = (key: string) => {
		keepPlace();
		setToggledSections((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const toggleBlock = (id: string) => {
		keepPlace();
		setExpandedBlocks((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	/** Ctrl+T / Ctrl+O: expand every block of one kind, or collapse them all. */
	const toggleBlocksOfKind = (kind: AgentSessionBlock["kind"]) => {
		keepPlace();
		const ids = props.blocks.flatMap((block) =>
			block.kind === kind ? [block.id] : [],
		);
		const groups =
			kind === "tool"
				? displayRows().flatMap((row) => ("displayKind" in row ? [row.id] : []))
				: [];
		const collapse =
			ids.some((id) => expandedBlocks().has(id)) ||
			groups.some((id) => expandedReadGroups().has(id));
		setExpandedBlocks(collapse ? new Set<string>() : new Set<string>(ids));
		setExpandedReadGroups(
			collapse ? new Set<string>() : new Set<string>(groups),
		);
	};
	const toggleReadGroup = (id: string) => {
		keepPlace();
		setExpandedReadGroups((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const jumpToLatest = () => {
		pendingAnchor = undefined;
		pendingLoad = undefined;
		pendingJump = { kind: "latest" };
		setAnchor(undefined);
		setAwayFromBottom(false);
		setLatestHovered(false);
	};
	const jumpToBlock = (blockId: string) => {
		const block = transcript().rows.find((row) => row.id === blockId);
		if (!block) return;
		pendingAnchor = undefined;
		pendingLoad = undefined;
		pendingJump = { kind: "block", blockId };
		// Pin the window at the target so a timeline jump also mounts a message
		// that is older than the currently rendered tail.
		setAnchor(block);
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
		if (props.inputTokens !== undefined || props.outputTokens !== undefined)
			parts.push(
				`tok ${formatTokenCount(props.inputTokens ?? 0)}→${formatTokenCount(props.outputTokens ?? 0)}`,
			);
		if (props.tokensPerSecond !== undefined)
			parts.push(`${props.tokensPerSecond} tok/s`);
		if (props.compacting) {
			// The compaction indicator carries its reason, so a manual `/compact`
			// reads differently from the harness's own threshold compaction.
			const reason =
				props.compacting.reason === "manual" ? "manual" : "automatic";
			parts.push(
				`compacting (${reason}${props.compacting.retrying ? ", retrying" : ""})`,
			);
		}
		return parts.join(" · ");
	};

	/** The command list shown while the draft is still a bare `/prefix`. The
	 * editor buffer keeps a key handler exact; `promptText`'s mirror read makes
	 * the list re-evaluate when a keystroke is published. */
	const autocompleteItems = () => {
		const match = /^\/(\S*)$/.exec(promptText());
		if (!match) return [];
		const query = (match[1] ?? "").toLowerCase();
		return [...SESSION_COMMANDS, ...(props.extraCommands ?? [])].filter(
			(command) => command.name.slice(1).toLowerCase().startsWith(query),
		);
	};

	/** The palette renders at most this many rows and follows the selection, so a
	 * route that adds one command per record (the orchestrator's subscriptions)
	 * cannot grow the palette past the page it lives in. Every command stays in
	 * the list the Enter key and the filter read. */
	const AUTOCOMPLETE_ROWS = 8;
	const visibleAutocompleteItems = () => {
		const items = autocompleteItems();
		if (items.length <= AUTOCOMPLETE_ROWS) return { items, offset: 0 };
		const half = Math.floor(AUTOCOMPLETE_ROWS / 2);
		const offset = Math.min(
			Math.max(0, autocompleteIndex() - half),
			items.length - AUTOCOMPLETE_ROWS,
		);
		return { items: items.slice(offset, offset + AUTOCOMPLETE_ROWS), offset };
	};

	const pickerItems = () => {
		const state = picker();
		if (!state) return [];
		const source: PickerItem[] =
			state.kind === "model"
				? props.models.map((value) => ({ value, label: value }))
				: state.kind === "thinking"
					? thinkingLevels().map((value) => ({ value, label: value }))
					: props.blocks
							.filter((block) => block.kind === "user" && block.text.trim())
							.reverse()
							.map((block) => {
								const text = block.text.replace(/\s+/g, " ").trim();
								return {
									value: block.id,
									label: text.length > 160 ? `${text.slice(0, 159)}…` : text,
									detail:
										block.startedAt === undefined
											? undefined
											: formatClock(block.startedAt),
									blockId: block.id,
								};
							});
		const query = state.filter.trim().toLowerCase();
		return query
			? source.filter(
					(item) =>
						item.label.toLowerCase().includes(query) ||
						item.detail?.toLowerCase().includes(query),
				)
			: source;
	};

	const closePicker = () => {
		setPicker(undefined);
		props.onPickerActiveChange?.(false);
	};
	const openPicker = (kind: PickerKind) => {
		// Start on the current value, like opencode's `/models`: reopening the
		// picker after a change must show that change as the selected row, not
		// silently jump back to the first entry.
		const current =
			kind === "model"
				? props.model
				: kind === "thinking"
					? props.thinking
					: undefined;
		const choices =
			kind === "model"
				? props.models
				: kind === "thinking"
					? thinkingLevels()
					: [];
		const index = current ? choices.indexOf(current) : -1;
		setPicker({
			kind,
			selected: index >= 0 ? index : 0,
			filter: "",
			filtering: false,
		});
		props.onPickerActiveChange?.(true);
	};
	const selectPicker = (selectedIndex?: number) => {
		const state = picker();
		if (!state) return;
		const value = pickerItems()[selectedIndex ?? state.selected];
		if (value) {
			if (state.kind === "timeline") jumpToBlock(value.value);
			else
				props.onConfigure(
					state.kind === "model"
						? { model: value.value }
						: { thinking: value.value },
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
				setPicker({ ...state, filtering: false, filter: "", selected: 0 });
			else if (name === "enter" || name === "return")
				setPicker({ ...state, filtering: false });
			else if (name === "backspace")
				setPicker({
					...state,
					filter: state.filter.slice(0, -1),
					selected: 0,
				});
			else if (event.name.length === 1)
				setPicker({ ...state, filter: state.filter + event.name, selected: 0 });
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
		else if (name === "/")
			setPicker({ ...state, filtering: true, filter: "", selected: 0 });
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
		if (name === MODEL_COMMAND || name === MODELS_COMMAND) openPicker("model");
		else if (name === THINKING_COMMAND) openPicker("thinking");
		else if (name === TIMELINE_COMMAND) openPicker("timeline");
		else if (name === LATEST_COMMAND) jumpToLatest();
		else if (
			name === COMPACT_COMMAND ||
			name.startsWith(`${COMPACT_COMMAND} `)
		) {
			// `/compact <instructions>`: the free text after the command is the
			// summarizer's guidance. The bare command keeps exact-match behavior, like
			// `/model` and `/thinking`.
			const instructions = name.slice(COMPACT_COMMAND.length).trim();
			props.onCompact(instructions || undefined);
		} else if (name === ABORT_COMMAND) props.onAbort();
		else if (name === CLOSE_COMMAND) props.onBack();
		else {
			const extra = props.extraCommands?.find(
				(command) => command.name === name,
			);
			if (extra) extra.run();
			else props.onSubmit(name);
		}
		setPrompt("");
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
		const text = promptText().trim();
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
			if (!box) return;
			const jump = pendingJump;
			if (jump?.kind === "latest") {
				pendingJump = undefined;
				box.stickyScroll = true;
				box.scrollTo(box.scrollHeight);
			} else if (jump?.kind === "block") {
				const index = displayRows().findIndex((row) =>
					"displayKind" in row
						? row.blocks.some((block) => block.id === jump.blockId)
						: row.id === jump.blockId,
				);
				const row = box.content.getChildren()[0]?.getChildren()[index];
				if (index >= 0 && row && !row.isDestroyed) {
					pendingJump = undefined;
					box.stickyScroll = false;
					box.scrollTo(
						Math.max(0, box.scrollTop + row.screenY - box.viewport.screenY),
					);
				}
			}
			if (pendingAnchor) {
				const moved = pendingAnchor.row.screenY - pendingAnchor.screenY;
				pendingAnchor = undefined;
				if (moved !== 0) box.scrollTop += moved;
			}
			if (pendingLoad) {
				const grown = box.scrollHeight - pendingLoad.height;
				if (grown > 0) {
					box.scrollTop = pendingLoad.top + grown;
					pendingLoad = undefined;
				}
			}
			const away =
				box.scrollTop < Math.max(0, box.scrollHeight - box.viewport.height);
			if (away !== awayFromBottom()) setAwayFromBottom(away);
			if (!away) {
				setAnchor(undefined);
				setLatestHovered(false);
			}
		};
		renderer.on(CliRenderEvents.FRAME, onFrame);
		onCleanup(() => renderer.off(CliRenderEvents.FRAME, onFrame));
	});

	/** Stop the window sliding: the rows on screen keep their place while the
	 * reader is not following the newest output. */
	const freezeWindow = () => {
		setAwayFromBottom(true);
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
			// Changing the loaded window for an explicit timeline jump can itself
			// emit a scrollbar change. Let the pending jump place the target before
			// treating that layout event as reader navigation.
			if (pendingJump) return;
			const away =
				box.scrollTop < Math.max(0, box.scrollHeight - box.viewport.height);
			setAwayFromBottom(away);
			if (away) freezeWindow();
			else {
				setAnchor(undefined);
				setLatestHovered(false);
			}
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
						style={{ marginBottom: 0 }}
					>
						<box flexDirection="column" gap={1}>
							<For each={displayRows()}>
								{(row) => {
									if ("displayKind" in row) {
										const expanded = () => expandedReadGroups().has(row.id);
										const latest = row.blocks.at(-1);
										return (
											<box width="100%" flexDirection="column">
												<Show
													when={row.blocks.some(
														(block) => block.id === transcript().dividerId,
													)}
												>
													<NewContentDivider />
												</Show>
												<ToolFrame
													color={
														latest
															? toolBorderColor(latest)
															: uiColors.textMuted
													}
												>
													<box
														flexDirection="row"
														{...useTap(() => toggleReadGroup(row.id))}
													>
														<text
															width={2}
															flexShrink={0}
															fg={uiColors.textMuted}
														>
															{expanded() ? "▾" : "▸"}
														</text>
														<text fg={uiColors.textMuted} flexGrow={1}>
															→ {readGroupLabel(row.blocks)}
														</text>
														<Show when={latest}>
															{(block) => <Stamp block={block()} />}
														</Show>
													</box>
												</ToolFrame>
												<Show when={expanded()}>
													<box flexDirection="column" gap={1}>
														<For each={row.blocks}>
															{(block) => (
																<Block
																	block={block}
																	role={props.role}
																	expanded={expandedBlocks().has(block.id)}
																	onToggle={toggleBlock}
																	toggledSections={toggledSections}
																	onToggleSection={toggleSection}
																	openRows={expandedRows}
																	onToggleRow={toggleRow}
																	transcript={markdownParts}
																/>
															)}
														</For>
													</box>
												</Show>
											</box>
										);
									}
									const block = row;
									return (
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
												toggledSections={toggledSections}
												onToggleSection={toggleSection}
												openRows={expandedRows}
												onToggleRow={toggleRow}
												transcript={markdownParts}
											/>
										</box>
									);
								}}
							</For>
						</box>
					</ScrollableContent>
					<box
						width="100%"
						height={1}
						flexShrink={0}
						flexDirection="row"
						justifyContent="flex-end"
					>
						<Show when={awayFromBottom()}>
							<box
								id="agent-session-jump-to-latest"
								paddingLeft={1}
								onMouseOver={() => setLatestHovered(true)}
								onMouseOut={() => setLatestHovered(false)}
								onMouseUp={jumpToLatest}
							>
								<text
									fg={latestHovered() ? uiColors.primary : uiColors.textMuted}
								>
									Jump to latest ↓
								</text>
							</box>
						</Show>
					</box>
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
							<For each={visibleAutocompleteItems().items}>
								{(command, index) => (
									<box
										flexDirection="row"
										gap={2}
										paddingLeft={2}
										paddingRight={1}
										backgroundColor={
											visibleAutocompleteItems().offset + index() ===
											autocompleteIndex()
												? uiColors.selectionBg
												: undefined
										}
										{...useRowMouse({
											// The filtered list keeps the same command objects, so a row
											// instance survives a reorder: the index must be live.
											index: () => index(),
											selectedIndex: autocompleteIndex,
											activatable: () => true,
											onSelect: (row) =>
												setAutocompleteIndex(
													Math.max(
														0,
														Math.min(row, autocompleteItems().length - 1),
													),
												),
											onActivate: () => {
												historyIndex = 0;
												setPrompt(command.name);
											},
										})}
									>
										<text
											width={14}
											flexShrink={0}
											fg={
												visibleAutocompleteItems().offset + index() ===
												autocompleteIndex()
													? uiColors.selectionText
													: uiColors.textPrimary
											}
										>
											{command.name}
										</text>
										<text
											fg={
												visibleAutocompleteItems().offset + index() ===
												autocompleteIndex()
													? uiColors.selectionText
													: uiColors.textMuted
											}
										>
											{command.description}
										</text>
									</box>
								)}
							</For>
							<Show
								when={
									autocompleteItems().length >
									visibleAutocompleteItems().items.length
								}
							>
								<text paddingLeft={2} fg={uiColors.textMuted}>
									{`… +${
										autocompleteItems().length -
										visibleAutocompleteItems().items.length
									} more`}
								</text>
							</Show>
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
							<textarea
								ref={(editor) => {
									inputRef = editor;
								}}
								focused={
									picker() === undefined && (props.inputActive?.() ?? true)
								}
								// The editor owns its buffer once mounted; the effect above syncs
								// it with every external draft write.
								initialValue={untrack(() => props.draft)}
								width="100%"
								// One row to start, growing with the message and scrolling once
								// it would take the transcript's place.
								minHeight={1}
								maxHeight={8}
								wrapMode="word"
								placeholder="Ask anything…"
								onContentChange={() => {
									const value = promptText();
									setPromptMirror(value);
									if (value !== props.draft) props.onDraftChange(value);
									setAutocompleteIndex(0);
								}}
								onSubmit={submit}
								onKeyDown={(event: KeyEvent) => {
									const name = event.name.toLowerCase();
									// Enter sends; Shift+Enter is the newline the multi-line prompt
									// exists for. The editor's own bindings never see either.
									if (
										name === "return" ||
										name === "kpenter" ||
										name === "linefeed"
									) {
										event.preventDefault();
										if (event.shift) inputRef?.newLine();
										else submit();
										return;
									}
									if (event.ctrl && name === "t") {
										event.preventDefault();
										toggleBlocksOfKind("reasoning");
										return;
									}
									if (event.ctrl && name === "o") {
										event.preventDefault();
										toggleBlocksOfKind("tool");
										return;
									}
									// `?` opens the shared help, but only on an empty prompt: a message
									// may start with one, so anything typed keeps it literal.
									if (name === "?" && promptText().length === 0) {
										event.preventDefault();
										props.onHelp?.();
										return;
									}
									// Up and Down browse history only from the prompt's own first and
									// last line; inside a multi-line message they move the cursor.
									if (
										!event.ctrl &&
										!event.meta &&
										!event.shift &&
										(name === "up" || name === "down") &&
										onPromptEdge(name === "up") &&
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
											setPrompt(item.name);
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
						{...pickerBackdrop}
						onSelect={(index) => {
							const current = picker();
							if (current) setPicker({ ...current, selected: index });
						}}
						onActivate={(index) => {
							const current = picker();
							if (current) setPicker({ ...current, selected: index });
							selectPicker(index);
						}}
						title={
							state().kind === "model"
								? "Select model"
								: state().kind === "thinking"
									? "Select thinking level"
									: "Jump to message"
						}
						items={pickerItems()}
						selectedIndex={state().selected}
						filterPlaceholder={
							state().kind === "timeline" ? "Filter prompts" : "Filter"
						}
						filterActive={state().filtering}
						filterQuery={state().filter}
						{...(state().kind === "timeline"
							? {
									emptyContent: (
										<text fg={uiColors.textMuted}>
											No user messages to show.
										</text>
									),
								}
							: {})}
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
							<box flexDirection="row" minWidth={0}>
								<text
									fg={isActive() ? uiColors.primary : uiColors.textSecondary}
									flexGrow={1}
									minWidth={0}
									wrapMode="none"
									truncate
								>
									{item.label}
								</text>
								<Show when={item.detail}>
									{(text) => (
										<text fg={uiColors.textMuted} flexShrink={0}>
											{text()}
										</text>
									)}
								</Show>
							</box>
						)}
					/>
				)}
			</Show>
		</>
	);
}
