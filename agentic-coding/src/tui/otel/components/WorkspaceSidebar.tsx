/** @jsxImportSource @opentui/solid */
// Workspace sidebar (integrated-multiplexer sidebar).
//
// The shell's left/right panel listing durable workflows. It is a pure
// presentation surface: rows come from `WorkflowOverview` observations, the
// shell owns the selected index, the filter and the route navigation, and
// clicks report back through the same callbacks the key layer uses.
//
// The panel is collapsible: focused it expands to its full width, unfocused it
// collapses to the workspace index only. The width change is a short tween, so
// focus movement reads as a slide rather than a jump.

import type { MouseEvent } from "@opentui/core";
import { Panel, SelectableList, uiColors, useTerminalDimensions } from "@ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { WorkflowOverview } from "../../../contracts/workflow.ts";
import {
	clip,
	filterLabel,
	SIDEBAR_FILTERS,
	type SidebarFilter,
	type SidebarMode,
	type StatusTone,
	sidebarStatusGlyph,
	workflowDisplayName,
	workflowMeta,
} from "../app/sidebar-model.ts";

/** Expanded sidebar width: wide enough for a clipped workflow id plus its
 * phase, narrow enough to leave the main content usable on an 80-column
 * terminal. */
export const SIDEBAR_WIDTH = 34;

/** Collapsed width: the selection marker, one gap column and two index digits. */
export const SIDEBAR_COLLAPSED_WIDTH = 5;

/** Width at which the full row content replaces the index-only rows. */
const SIDEBAR_EXPANDED_THRESHOLD = 14;

/** One width tween: ~150ms of 16ms steps, eased out. Quick enough to read as a
 * slide, slow enough not to strobe. */
const SIDEBAR_ANIMATION_MS = 150;
const SIDEBAR_ANIMATION_STEP_MS = 16;

/** Lines the shell chrome above/below the list consumes: app header, breadcrumb,
 * blank row, panel title, filter row, blank row, status bar, plus one slack
 * row for the scroll indicator. */
const SIDEBAR_CHROME_LINES = 9;

function toneColor(tone: StatusTone): string {
	switch (tone) {
		case "success":
			return uiColors.success;
		case "warning":
			return uiColors.warning;
		case "error":
			return uiColors.error;
		case "info":
			return uiColors.info;
		default:
			return uiColors.textMuted;
	}
}

export interface WorkspaceSidebarProps {
	/** Panel focus: the accent strip follows the shell panel model, and focus
	 * drives the expand/collapse animation in `expanding` mode. */
	active: boolean;
	/** `expanding` collapses while unfocused; `permanent` stays expanded. */
	mode: SidebarMode;
	/** Which side the panel is mounted on; the toggle glyph points outward. */
	side: "left" | "right";
	/** Toggle `expanding`/`permanent` (the title-row glyph and the collapsed
	 * strip's glyph both call it). */
	onToggleMode: () => void;
	overviews: WorkflowOverview[];
	filter: SidebarFilter;
	selectedIndex: number;
	/** True until the first observation lands. */
	loading: boolean;
	onSelectIndex: (index: number) => void;
	/** Enter/click: open the workflow dashboard for the row. */
	onOpen: (overview: WorkflowOverview) => void;
	onFilterChange: (filter: SidebarFilter) => void;
	/** Any mouse activity in the panel asks the shell to focus it. */
	onFocus: () => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
	const dimensions = useTerminalDimensions();
	const listLines = () =>
		Math.max(1, dimensions().height - SIDEBAR_CHROME_LINES);
	const expandedByMode = () => props.mode === "permanent" || props.active;
	const [width, setWidth] = createSignal(
		expandedByMode() ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH,
	);
	// The tween runs on a plain interval: the renderer repaints on the signal
	// change, so no animation framework is needed for a width slide.
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopAnimation = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const animateTo = (target: number): void => {
		stopAnimation();
		const start = width();
		if (start === target) return;
		const startedAt = Date.now();
		timer = setInterval(() => {
			const progress = Math.min(
				1,
				(Date.now() - startedAt) / SIDEBAR_ANIMATION_MS,
			);
			const eased = 1 - (1 - progress) ** 3;
			setWidth(Math.round(start + (target - start) * eased));
			if (progress >= 1) stopAnimation();
		}, SIDEBAR_ANIMATION_STEP_MS);
	};
	createEffect(() => {
		animateTo(expandedByMode() ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH);
	});
	onCleanup(stopAnimation);
	const expanded = () => width() >= SIDEBAR_EXPANDED_THRESHOLD;
	// The glyph points toward the body: on the left side `»` pushes the panel
	// open (permanent) and `«` returns it to auto-collapse; on the right side
	// the pair is mirrored.
	const openGlyph = () => (props.side === "left" ? "»" : "«");
	const collapseGlyph = () => (props.side === "left" ? "«" : "»");
	const toggleGlyph = () =>
		props.mode === "permanent" ? collapseGlyph() : openGlyph();
	const toggleMode = (event: MouseEvent): void => {
		event.stopPropagation();
		props.onFocus();
		props.onToggleMode();
	};
	return (
		<box
			width={width()}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
			style={{ flexDirection: "column", minHeight: 0, overflow: "hidden" }}
			onMouseUp={() => props.onFocus()}
		>
			<Show
				when={expanded()}
				fallback={
					// Collapsed: a toggle glyph, then the workspace index only, one row
					// per workflow, so the strip stays a usable jump list without names
					// or metadata.
					<>
						<box
							style={{
								height: 1,
								flexShrink: 0,
								paddingLeft: 1,
								flexDirection: "row",
							}}
							onMouseUp={toggleMode}
						>
							<text fg={uiColors.textMuted}>{openGlyph()}</text>
						</box>
						{/* An index list with nothing to index stays empty: the strip is a
						    jump list, so a filler line ("No items") would be the only thing
						    it ever says when there are no workflows. The expanded panel
						    explains an empty list in words instead. */}
						<Show when={props.overviews.length > 0}>
							<SelectableList
								items={props.overviews}
								selectedIndex={props.selectedIndex}
								itemHeight={1}
								availableLines={Math.max(1, dimensions().height - 4)}
								onSelect={(index) => {
									props.onFocus();
									props.onSelectIndex(index);
								}}
								renderItem={(_overview, _selected, index) => (
									<text fg={uiColors.textSecondary}>{`${index + 1}`}</text>
								)}
							/>
						</Show>
					</>
				}
			>
				{/* One fixed-height panel chrome for every shell page: title, filter
				    row, then the windowed workflow list. */}
				<Panel
					title="Workspaces"
					active={props.active}
					style={{ flexGrow: 1, minHeight: 0 }}
					accessory={
						<text
							fg={props.active ? uiColors.primary : uiColors.textMuted}
							onMouseUp={toggleMode}
						>
							{toggleGlyph()}
						</text>
					}
				>
					<box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
						<For each={SIDEBAR_FILTERS}>
							{(entry) => (
								<box
									style={{ marginRight: 1 }}
									onMouseUp={() => {
										props.onFocus();
										props.onFilterChange(entry.id);
									}}
								>
									<text
										fg={
											props.filter === entry.id
												? uiColors.bgBase
												: uiColors.textMuted
										}
										bg={
											props.filter === entry.id
												? uiColors.primary
												: uiColors.bgMantle
										}
									>
										{` ${entry.label} `}
									</text>
								</box>
							)}
						</For>
					</box>
					<Show
						when={props.overviews.length > 0}
						fallback={
							<box style={{ flexGrow: 1, minHeight: 0, paddingTop: 1 }}>
								<text fg={uiColors.textMuted}>
									{props.loading
										? "Reading workflows…"
										: `No ${filterLabel(props.filter).toLowerCase()} workflows`}
								</text>
							</box>
						}
					>
						<SelectableList
							items={props.overviews}
							selectedIndex={props.selectedIndex}
							itemHeight={2}
							availableLines={listLines()}
							onSelect={(index) => {
								props.onFocus();
								props.onSelectIndex(index);
								const entry = props.overviews[index];
								if (entry) props.onOpen(entry);
							}}
							renderItem={(overview, selected) => {
								const status = sidebarStatusGlyph(overview);
								return (
									<box style={{ flexDirection: "column" }}>
										<text
											fg={
												selected ? uiColors.textPrimary : uiColors.textSecondary
											}
										>
											<strong>{status.glyph}</strong>
											{` ${clip(workflowDisplayName(overview), SIDEBAR_WIDTH - 8)}`}
										</text>
										<text fg={toneColor(status.tone)}>
											{clip(workflowMeta(overview), SIDEBAR_WIDTH - 8)}
										</text>
									</box>
								);
							}}
						/>
					</Show>
				</Panel>
			</Show>
		</box>
	);
}
