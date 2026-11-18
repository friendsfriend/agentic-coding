/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import {
	type UiWorkspaceFilter,
	uiWorkspaceFilters,
} from "../../../protocol/viewpoints.ts";
import { bindings, type Keybind, layerCommands } from "../../ui/keybinds.ts";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { useTap } from "./mouse/useTap.ts";
import { Panel } from "./Panel.tsx";
import { PinRow } from "./PinRow.tsx";
import {
	type WorkspaceTaskObservation,
	WorkspaceTaskRow,
} from "./WorkspaceTaskRow.tsx";

export type WorkspaceEntry = {
	name: string;
	description: string;
	value: string;
	/** The row's own mark; a navigation tree names each kind of row. */
	glyph?: string;
	task?: WorkspaceTaskObservation;
	tone?: "primary" | "accent" | "muted" | "success" | "warning" | "error";
	tree?: {
		prefix: string;
		parent?: string;
		branch: boolean;
		collapsed: boolean;
		summary: string;
		kind: "project" | "workflow" | "task";
	};
};

export const workspaceNavigationKeybinds: Keybind[] = [
	{
		key: "f",
		cmd: "workspace.filter",
		action: "Cycle filter (active/attention/all)",
		short: "filter",
	},
	{
		key: "e",
		cmd: "workspace.size",
		action: "Toggle expanding/permanent sidebar",
		short: "size",
	},
	{
		key: "up",
		cmd: "workspace.previous",
		action: "Previous workspace entry",
		standard: true,
	},
	{
		key: "down",
		cmd: "workspace.next",
		action: "Next workspace entry",
		standard: true,
	},
	{
		key: "k",
		cmd: "workspace.previous",
		action: "Previous workspace entry",
		standard: true,
	},
	{
		key: "j",
		cmd: "workspace.next",
		action: "Next workspace entry",
		standard: true,
	},
	{
		key: "left",
		cmd: "workspace.collapse",
		action: "Collapse branch or select parent",
		standard: true,
	},
	{
		key: "right",
		cmd: "workspace.expand",
		action: "Expand branch or select child",
		standard: true,
	},
	// Row actions belong to the caller: this panel only reports which row and
	// which intent, so it never edits a native identity itself.
	{
		key: "r",
		cmd: "workspace.rename",
		action: "Rename the selected orchestrator",
		short: "rename",
	},
	{
		key: "d",
		cmd: "workspace.close",
		action: "Close the selected orchestrator session",
		short: "close",
	},
	{
		key: "p",
		cmd: "workspace.profile",
		action: "Choose the selected orchestrator's profile",
		short: "profile",
	},
	// Terminals report Return as either name; a row that only answered one of
	// them looked like a dead Enter (the Home list already binds both).
	...["enter", "return"].map((key) => ({
		key,
		cmd: "workspace.open",
		action: "Open workspace entry",
		short: "open",
	})),
];
/** Original workspace pin-row presentation and expanding/permanent geometry,
 * adapted to native navigation entries. Focus/activation never dispatch a task. */
export function WorkspaceNavigation(props: {
	active: boolean;
	scope: object;
	mode: "expanding" | "permanent";
	onToggleMode: () => void;
	filter: UiWorkspaceFilter;
	onFilterChange: (filter: UiWorkspaceFilter) => void;
	taskCount: number;
	tasksKnown: boolean;
	/** Covered surfaces must not accept focus taps or retained activations. */
	interactive?: boolean;
	entries: WorkspaceEntry[];
	/** Fixed leading UI pins, rendered outside the scrolling resource list. */
	pinCount?: number;
	/** A row action on the selected row; omitted when the caller offers none. */
	onRowAction?: (value: string, action: "rename" | "close" | "profile") => void;
	/** The selected row, owned by the caller. A row move never navigates. */
	cursor: string;
	onCursor: (value: string) => void;
	onToggleBranch?: (value: string) => void;
	open: (value: string) => void;
	focus: () => void;
	onWidth: (width: number) => void;
}) {
	const dimensions = useTerminalDimensions();
	const permanent = () => props.mode === "permanent";
	// The sidebar has one side, so the original mirrored glyphs collapse to the
	// left-side pair: pointing outward to grow, inward to shrink.
	const toggleGlyph = () => (permanent() ? "«" : "»");
	const interactive = () => props.interactive !== false;
	const focus = () => {
		if (interactive()) props.focus();
	};
	const toggleSize = () => {
		if (interactive()) props.onToggleMode();
	};
	// The cursor is the caller's state (v1 kept destination selection in
	// route-keyed view state); this panel only reports movement.
	const cursorValue = () => props.cursor;
	const setCursorValue = (value: string) => props.onCursor(value);
	let scroll: ScrollBoxRenderable | undefined;
	const expandedByState = () => permanent() || props.active;
	const targetWidth = () =>
		Math.min(
			60,
			Math.max(
				6,
				Math.floor(dimensions().width * 0.32),
				Math.min(42, dimensions().width - 40),
			),
		);
	const [animatedWidth, setAnimatedWidth] = createSignal(
		expandedByState() ? targetWidth() : 6,
	);
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopAnimation = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const animateTo = (target: number) => {
		stopAnimation();
		// The frame writes this signal; reading it untracked avoids restarting
		// the tween on its own frames or leaving several competing intervals.
		const start = untrack(animatedWidth);
		if (start === target) return;
		const startedAt = Date.now();
		timer = setInterval(() => {
			const progress = Math.min(1, (Date.now() - startedAt) / 150);
			const eased = 1 - (1 - progress) ** 3;
			setAnimatedWidth(Math.round(start + (target - start) * eased));
			if (progress >= 1) stopAnimation();
		}, 16);
	};
	createEffect(() => {
		if (!expandedByState()) {
			stopAnimation();
			setAnimatedWidth(6);
			return;
		}
		animateTo(targetWidth());
	});
	onCleanup(stopAnimation);
	// State gates both surfaces: a delayed frame can never keep full rows or
	// an expanded width on screen after focus/mode asks for the compact strip.
	const width = () =>
		expandedByState() ? Math.min(animatedWidth(), targetWidth()) : 6;
	const expanded = () => expandedByState() && width() >= 14;
	createEffect(() => props.onWidth(width()));
	const entries = createMemo(() => props.entries);
	const entriesByKey = createMemo(
		() =>
			new Map(entries().map((entry, index) => [entry.value, { entry, index }])),
	);
	const pinCount = () =>
		Math.min(entries().length, Math.max(0, Math.floor(props.pinCount ?? 0)));
	const cursor = createMemo(() =>
		entries().findIndex((entry) => entry.value === cursorValue()),
	);
	const open = () => {
		if (!props.active || !interactive()) return;
		// A removed identity is deliberately not replaced by its old row index.
		const entry = entries().find((entry) => entry.value === cursorValue());
		if (entry) props.open(entry.value);
	};
	const move = (direction: number) => {
		if (!props.active || !interactive()) return;
		const count = entries().length;
		if (!count) return;
		const index = cursor();
		const next =
			index < 0
				? direction < 0
					? count - 1
					: 0
				: (index + direction + count) % count;
		const entry = entries()[next];
		if (entry) setCursorValue(entry.value);
	};
	const unregister = useKeymap().registerLayer({
		priority: 15,
		enabled: () => props.active && interactive(),
		commands: layerCommands([
			{
				id: "workspace.filter",
				name: "Cycle native task filter",
				run: () => {
					if (!props.active || !interactive()) return;
					props.onFilterChange(
						uiWorkspaceFilters[
							(uiWorkspaceFilters.indexOf(props.filter) + 1) %
								uiWorkspaceFilters.length
						] ?? "active",
					);
				},
			},
			{
				id: "workspace.size",
				name: "Toggle sidebar size",
				run: () => {
					if (props.active) toggleSize();
				},
			},
			{
				id: "workspace.previous",
				name: "Previous workspace entry",
				run: () => move(-1),
			},
			{
				id: "workspace.next",
				name: "Next workspace entry",
				run: () => move(1),
			},
			{ id: "workspace.open", name: "Open workspace entry", run: open },
			{
				id: "workspace.collapse",
				name: "Collapse branch or select parent",
				run: () => {
					const entry = entriesByKey().get(cursorValue())?.entry;
					if (entry?.tree?.branch && !entry.tree.collapsed)
						props.onToggleBranch?.(entry.value);
					else if (entry?.tree?.parent) setCursorValue(entry.tree.parent);
				},
			},
			{
				id: "workspace.expand",
				name: "Expand branch or select child",
				run: () => {
					const slot = entriesByKey().get(cursorValue());
					if (slot?.entry.tree?.branch && slot.entry.tree.collapsed)
						props.onToggleBranch?.(slot.entry.value);
					else if (slot) {
						const next = entries()[slot.index + 1];
						if (next?.tree?.parent === slot.entry.value)
							setCursorValue(next.value);
					}
				},
			},
			{
				id: "workspace.rename",
				name: "Rename the selected orchestrator",
				run: () => {
					if (!props.active || !interactive()) return;
					props.onRowAction?.(cursorValue(), "rename");
				},
			},
			{
				id: "workspace.close",
				name: "Close the selected orchestrator session",
				run: () => {
					if (!props.active || !interactive()) return;
					props.onRowAction?.(cursorValue(), "close");
				},
			},
			{
				id: "workspace.profile",
				name: "Choose the selected orchestrator's profile",
				run: () => {
					if (!props.active || !interactive()) return;
					props.onRowAction?.(cursorValue(), "profile");
				},
			},
		]),
		bindings: bindings(workspaceNavigationKeybinds),
	});
	onCleanup(unregister);
	createEffect(() => {
		const index = cursor() - pinCount();
		if (!scroll || index < 0) return;
		const flowing = entries().slice(pinCount());
		const rowHeight = (entry: WorkspaceEntry) =>
			entry.task
				? 3
				: !expanded()
					? 1
					: entry.tree
						? entry.value === cursorValue() || entry.tree.summary
							? 2
							: 1
						: 2;
		const entry = flowing[index];
		if (!entry) return;
		const height = rowHeight(entry);
		const top = flowing
			.slice(0, index)
			.reduce((sum, entry) => sum + rowHeight(entry), 0);
		if (top < scroll.scrollTop) scroll.scrollTo(top);
		else if (top + height > scroll.scrollTop + scroll.viewport.height)
			scroll.scrollTo(Math.max(0, top + height - scroll.viewport.height));
	});
	const toggle = useTap(
		() => {
			if (!interactive()) return;
			focus();
			toggleSize();
		},
		{ stopPropagation: true },
	);
	const hover = useHover(toggle.onMouseOut);
	// One mark per row of the shell's navigation tree; the caller names the ones
	// whose identity it knows (each orchestrator, each child session, `+`).
	const marks: Readonly<Record<string, string>> = {
		home: "⌂",
		opencode: "󱚞",
		pi: "π",
		orchestrator: "∞",
	};
	const glyph = (entry: WorkspaceEntry) =>
		entry.glyph ?? marks[entry.value] ?? "·";
	const taskPositions = createMemo(
		() =>
			new Map(
				entries()
					.filter((entry) => entry.task)
					.map((entry, index) => [entry.value, index]),
			),
	);
	const renderRow = (key: string) => (
		<Show when={entriesByKey().get(key)}>
			{(slot) => {
				const gesture: RowGestureState = {};
				const signature = createMemo(() =>
					JSON.stringify([
						slot().entry,
						slot().index,
						width(),
						props.tasksKnown,
						props.filter,
						props.active,
						interactive(),
						expanded(),
						taskPositions().get(key),
					]),
				);
				createEffect(() => {
					props.scope;
					signature();
					gesture.down = undefined;
					gesture.lastTap = undefined;
				});
				onCleanup(() => {
					gesture.down = undefined;
					gesture.lastTap = undefined;
				});
				const activate = () => {
					if (!interactive() || !entriesByKey().has(key)) return;
					focus();
					setCursorValue(key);
					props.open(key);
				};
				return (
					<Show
						when={slot().entry.task}
						fallback={
							<PinRow
								pin={{
									glyph: glyph(slot().entry),
									label: slot().entry.name,
									meta: slot().entry.description,
								}}
								selected={cursorValue() === key}
								height={
									!expanded()
										? 1
										: slot().entry.tree
											? cursorValue() === key || slot().entry.tree?.summary
												? 2
												: 1
											: 2
								}
								wide={expanded()}
								width={width() - 4}
								tone={slot().entry.tone}
								tree={slot().entry.tree}
								onToggleBranch={() => {
									if (interactive()) {
										focus();
										setCursorValue(key);
										props.onToggleBranch?.(key);
									}
								}}
								gesture={gesture}
								onActivate={activate}
							/>
						}
					>
						{(task) => (
							<WorkspaceTaskRow
								name={slot().entry.name}
								meta={slot().entry.description}
								task={task()}
								position={taskPositions().get(key) ?? 0}
								expanded={expanded()}
								selected={cursorValue() === key}
								gesture={gesture}
								open={activate}
							/>
						)}
					</Show>
				);
			}}
		</Show>
	);
	const rows = () => (
		<>
			<For
				each={entries()
					.slice(0, pinCount())
					.map((entry) => entry.value)}
			>
				{renderRow}
			</For>
			<Show when={pinCount() > 0}>
				<box height={1} flexShrink={0} paddingLeft={2}>
					<text fg={uiColors.border}>
						{"─".repeat(Math.max(0, width() - 4))}
					</text>
				</box>
			</Show>
			<scrollbox
				ref={(value) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				scrollY={true}
			>
				<For
					each={entries()
						.slice(pinCount())
						.map((entry) => entry.value)}
				>
					{renderRow}
				</For>
			</scrollbox>
		</>
	);
	return (
		<box
			width={width()}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
			flexDirection="column"
			minHeight={0}
			overflow="hidden"
			{...useTap(focus)}
		>
			<Show
				when={expanded()}
				fallback={
					<>
						<box
							height={1}
							flexShrink={0}
							paddingLeft={1}
							backgroundColor={hover.hovered() ? uiColors.bgHover : undefined}
							{...toggle}
							{...hover}
						>
							<text
								fg={hover.hovered() ? uiColors.textPrimary : uiColors.textMuted}
							>
								{toggleGlyph()}
							</text>
						</box>
						{rows()}
					</>
				}
			>
				<Panel
					title="Workspaces"
					active={props.active}
					style={{ flexGrow: 1, minHeight: 0 }}
					accessory={
						<text
							fg={
								props.active
									? uiColors.primary
									: hover.hovered()
										? uiColors.textPrimary
										: uiColors.textMuted
							}
							bg={hover.hovered() ? uiColors.bgHover : undefined}
							{...toggle}
							{...hover}
						>
							{toggleGlyph()}
						</text>
					}
				>
					<box height={1} flexShrink={0} flexDirection="row">
						<For each={uiWorkspaceFilters}>
							{(filter) => {
								const gesture: RowGestureState = {};
								const signature = createMemo(() =>
									JSON.stringify([
										props.filter,
										width(),
										props.tasksKnown,
										props.active,
										interactive(),
										expanded(),
									]),
								);
								createEffect(() => {
									props.scope;
									signature();
									gesture.down = undefined;
									gesture.lastTap = undefined;
								});
								onCleanup(() => {
									gesture.down = undefined;
									gesture.lastTap = undefined;
								});
								const tap = useTap(
									() => {
										if (!interactive()) return;
										focus();
										props.onFilterChange(filter);
									},
									{ gesture, stopPropagation: true },
								);
								const hover = useHover(tap.onMouseOut);
								const selected = () => props.filter === filter;
								return (
									<box marginRight={1} {...tap} {...hover}>
										<text
											fg={
												selected()
													? uiColors.bgBase
													: hover.hovered()
														? uiColors.textPrimary
														: uiColors.textMuted
											}
											bg={
												selected()
													? hover.hovered()
														? uiColors.primaryDim
														: uiColors.primary
													: hover.hovered()
														? uiColors.bgHover
														: uiColors.bgMantle
											}
										>{` ${filter[0]?.toUpperCase()}${filter.slice(1)} `}</text>
									</box>
								);
							}}
						</For>
					</box>
					{rows()}
					<Show when={props.taskCount === 0 || !props.tasksKnown}>
						<text fg={uiColors.textMuted} wrapMode="none" truncate>
							{!props.tasksKnown
								? "Cached · activity unknown"
								: props.filter === "all"
									? "No native tasks in supplied view"
									: `No ${props.filter} native tasks`}
						</text>
					</Show>
				</Panel>
			</Show>
		</box>
	);
}
