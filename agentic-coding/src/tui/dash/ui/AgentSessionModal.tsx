/** @jsxImportSource @opentui/solid */
// Dashboard agent session view (add-pi-durable-runtime,
// dashboard-agent-session-view): a live, writable view of one `pi-durable`
// agent run, opened from the Agents panel. Status/transcript blocks are owned
// by the route (a live `HostClient.watch()` subscription); this component
// owns the presentation, the opencode-style prompt, and the `/model` and
// `/thinking` pickers.
//
// Assistant output renders as markdown with no box; thinking collapses to a
// single `Thinking…` line; every other entry is a status box with a solid
// status-tinted background and the same left highlight the prompt uses. The
// prompt below mirrors opencode v2: a left-bordered raised block with the
// input and a metadata row (`Role · model · thinking` plus a live working
// indicator).
//
// The picker keys are handled by the route's keymap layer (the input is
// unfocused while a picker is open), so the always-focused input can keep
// accepting ordinary characters, including `j` and `k`.
import type {
	InputRenderable,
	KeyEvent,
	ScrollBoxRenderable,
} from "@opentui/core";
import { parseColor, RGBA, rgbToHex, TextAttributes } from "@opentui/core";
import {
	GenericModal,
	ListViewModal,
	MarkdownViewer,
	ScrollableContent,
	uiColors,
} from "@ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
	type AgentSessionBlock,
	type AgentSessionTone,
	formatCost,
	formatDuration,
	formatTokenCount,
} from "../agent-session.ts";
import { PromptPulse } from "./PromptPulse.tsx";

export interface AgentSessionModalProps {
	readonly role: string;
	readonly blocks: readonly AgentSessionBlock[];
	readonly draft: string;
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
	readonly onClose: () => void;
	/** Apply a live model / thinking override. */
	readonly onConfigure: (change: { model?: string; thinking?: string }) => void;
	/** The transcript scroll box, so the route's keymap layer can scroll it. */
	readonly onScrollBoxReady?: (box: ScrollBoxRenderable) => void;
	/** The picker's key handler, registered while a picker is open. */
	readonly onPickerKeyReady?: (handler: (event: KeyEvent) => boolean) => void;
	/** Whether a picker is open, so the route can switch keymap layers. */
	readonly onPickerActiveChange?: (active: boolean) => void;
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

/** One transcript entry. Assistant output is markdown with no status box;
 * thinking is collapsible; everything else is a status box with the same left
 * highlight the prompt uses. */
function Block(props: {
	block: AgentSessionBlock;
	role: string;
	index: number;
	expanded: boolean;
	onToggle: (index: number) => void;
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
	if (props.block.kind === "assistant")
		return (
			<box paddingLeft={3} paddingRight={1} flexShrink={0}>
				<MarkdownViewer content={props.block.text} fg={uiColors.textPrimary} />
			</box>
		);
	if (props.block.kind === "reasoning")
		return (
			<box
				paddingLeft={3}
				paddingRight={1}
				flexDirection="column"
				flexShrink={0}
				onMouseUp={() => props.onToggle(props.index)}
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
	const content = () => {
		switch (props.block.kind) {
			case "user":
				return <text fg={uiColors.textPrimary}>{props.block.text}</text>;
			case "tool":
				// One line per tool call: the result's answer replaces the request, and
				// the full output (plus the request) only shows when expanded.
				return (
					<box flexDirection="column">
						<box
							flexDirection="row"
							onMouseUp={() => props.onToggle(props.index)}
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

type PickerKind = "model" | "thinking";
interface PickerState {
	readonly kind: PickerKind;
	readonly selected: number;
	readonly filter: string;
	readonly filtering: boolean;
}

export function AgentSessionModal(props: AgentSessionModalProps) {
	let inputRef: InputRenderable | undefined;
	const [picker, setPicker] = createSignal<PickerState | undefined>();
	const [autocompleteIndex, setAutocompleteIndex] = createSignal(0);
	// Which thinking blocks are expanded. Collapsed by default so a long
	// reasoning block is one line until asked for.
	const [expandedBlocks, setExpandedBlocks] = createSignal<ReadonlySet<number>>(
		new Set(),
	);
	const toggleBlock = (index: number) => {
		setExpandedBlocks((current) => {
			const next = new Set(current);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});
	};
	/** Ctrl+T / Ctrl+O: expand every block of one kind, or collapse them all. */
	const toggleBlocksOfKind = (kind: AgentSessionBlock["kind"]) => {
		const indices = props.blocks.flatMap((block, index) =>
			block.kind === kind ? [index] : [],
		);
		setExpandedBlocks((current) =>
			indices.some((index) => current.has(index))
				? new Set<number>()
				: new Set<number>(indices),
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
			else if (name === "enter") setPicker({ ...state, filtering: false });
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
		else if (name === "enter") selectPicker();
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
		if (name === MODEL_COMMAND) openPicker("model");
		else if (name === THINKING_COMMAND) openPicker("thinking");
		else if (name === ABORT_COMMAND) props.onAbort();
		else if (name === CLOSE_COMMAND) props.onClose();
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

	return (
		<>
			<GenericModal
				title={`Agent · ${props.role}`}
				widthPercent={0.72}
				heightPercent={0.8}
				help={[
					// The footer advertises only the special keys; the slash commands are
					// discovered by typing `/`, and the autocomplete keys are standard.
					{ key: "PgUp/PgDn", action: "Scroll transcript", short: "scroll" },
					{ key: "Enter", action: "Send message", short: "send" },
				]}
				helpSections={[
					{
						title: "Session",
						keybinds: [
							{
								key: "PgUp/PgDn",
								action: "Scroll transcript",
								short: "scroll",
							},
							{ key: "Enter", action: "Send message", short: "send" },
							{ key: "Tab", action: "Complete command", standard: true },
							{ key: "↑/↓", action: "Choose command", standard: true },
							{
								key: "Ctrl+T",
								action: "Expand/collapse thinking",
								standard: true,
							},
							{
								key: "Ctrl+O",
								action: "Expand/collapse tool output",
								standard: true,
							},
						],
					},
				]}
			>
				<box
					width="100%"
					flexDirection="column"
					flexGrow={1}
					gap={1}
					minHeight={0}
				>
					<ScrollableContent
						stickyStart="bottom"
						stickyScroll
						onScrollBoxReady={(box) => props.onScrollBoxReady?.(box)}
					>
						<box flexDirection="column" gap={1}>
							<For each={props.blocks}>
								{(block, index) => (
									<Block
										block={block}
										role={props.role}
										index={index()}
										expanded={expandedBlocks().has(index())}
										onToggle={toggleBlock}
									/>
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
						marginBottom={1}
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
									const items = autocompleteItems();
									if (items.length === 0) return;
									const name = event.name.toLowerCase();
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
										if (item) props.onDraftChange(item.name);
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
			</GenericModal>
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
