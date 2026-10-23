/** @jsxImportSource @opentui/solid */
// Workspace sidebar (integrated-multiplexer sidebar).
//
// The shell's left/right panel listing durable workflows. It is a pure
// presentation surface: rows come from `WorkflowOverview` observations, the
// shell owns the selected index, the filter and the route navigation, and
// clicks report back through the same callbacks the key layer uses.
//
// The panel is collapsible: focused it expands to its full width, unfocused it
// collapses to a three-line stack per workflow: bold index, status glyph, and
// one phase-specific character. The glyph and its tone still say which
// workspace needs a reader.
// Expanding is a short width tween, so focus movement reads as a slide rather
// than a jump; collapsing is a cut to the fixed compact width, because the
// compact strip is the whole collapsed view and neither its rows nor the columns
// it frees may wait on an animation.

import {
	Panel,
	Selectable,
	SelectableList,
	uiColors,
	useHover,
	useTap,
	useTerminalDimensions,
} from "@ui";
import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import type { WorkflowOverview } from "../../../contracts/workflow.ts";
import {
	clip,
	clipMetaSegments,
	filterLabel,
	SIDEBAR_FILTERS,
	type SidebarFilter,
	type SidebarMode,
	type SidebarPin,
	type StatusTone,
	sidebarCollapsedRow,
	sidebarStatusGlyph,
	workflowProjectName,
	workflowRowLabel,
	workflowStageMeta,
} from "../app/sidebar-model.ts";

/** Expanded sidebar width: wide enough for a clipped workflow id, its stage
 * line and its project name, narrow enough to leave the main content usable on
 * an 80-column terminal. */
export const SIDEBAR_WIDTH = 34;

/** Columns a compact row's content needs: four cells, enough for a four-digit
 * jump-list position. The status glyph and phase character each use one of those
 * cells on their own lines. */
const SIDEBAR_COLLAPSED_ROW_WIDTH = 4;

/** Collapsed width: the selection marker, one gap column and the compact row.
 * Fixed, and the row is measured against it and never against the animated
 * width, so a marked row fits the strip and the columns the page body gains do
 * not depend on an animation. */
export const SIDEBAR_COLLAPSED_WIDTH = SIDEBAR_COLLAPSED_ROW_WIDTH + 2;

/** Text columns an expanded workflow row has after the panel chrome (border,
 * padding) and its own selection marker and gap: `SIDEBAR_WIDTH` minus five. */
const SIDEBAR_ROW_TEXT_WIDTH = SIDEBAR_WIDTH - 5;

/** The name line spends one column on the status glyph and one on the space
 * after it, leaving this many columns for the workflow label. */
const SIDEBAR_ROW_LABEL_WIDTH = SIDEBAR_ROW_TEXT_WIDTH - 2;

/** Width at which the full row content replaces the three-line compact rows. */
const SIDEBAR_EXPANDED_THRESHOLD = 14;

/** What the panel paints for one sidebar state and the width the slide has
 * reached. The state is the gate: unfocused `expanding` is the fixed compact
 * strip whatever the animation is doing, and the full rows — which need the room
 * — appear only while the state asks for the panel *and* the slide has widened it
 * enough to hold a row. An expanded width left over from an animation that never
 * ran (a delayed tween on a busy main thread, a width left from the previous
 * expansion) therefore can never keep the full expanded panel on screen. */
export function sidebarPanelView(input: {
	/** `ui.sidebar_mode: "permanent"`, or the panel holds focus. */
	readonly expandedByState: boolean;
	/** Width the width tween has reached. */
	readonly animatedWidth: number;
}): { readonly width: number; readonly expanded: boolean } {
	if (!input.expandedByState)
		return { width: SIDEBAR_COLLAPSED_WIDTH, expanded: false };
	return {
		width: input.animatedWidth,
		expanded: input.animatedWidth >= SIDEBAR_EXPANDED_THRESHOLD,
	};
}

/** One width tween: ~150ms of 16ms steps, eased out. Quick enough to read as a
 * slide, slow enough not to strobe. */
const SIDEBAR_ANIMATION_MS = 150;
const SIDEBAR_ANIMATION_STEP_MS = 16;

/** Lines the shell chrome above/below the list consumes: app header, breadcrumb,
 * blank row, panel title, filter row, blank row, status bar, plus one slack
 * row for the scroll indicator. */
const SIDEBAR_CHROME_LINES = 9;

/** Lines the pins add above the list: two per pin (one in the collapsed strip)
 * plus the shared rule separating them from workflows. */
function pinLines(pinCount: number): number {
	return pinCount > 0 ? pinCount * 2 + 1 : 0;
}

function collapsedPinLines(pinCount: number): number {
	return pinCount > 0 ? pinCount + 1 : 0;
}

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

/** The pinned entry's row: mark and name, then one line of meta, so the fixed
 * entry reads as a row and not as panel chrome. Workflow rows add their project
 * line below it; the pin has no project. Collapsed, only the mark fits. */
function PinRow(props: {
	pin: SidebarPin;
	selected: boolean;
	height: number;
	onActivate: () => void;
}) {
	return (
		<Selectable
			height={props.height}
			selected={props.selected}
			hoverBackground={uiColors.bgHover}
			onMouseUp={props.onActivate}
		>
			{props.height > 1 ? (
				<box style={{ flexDirection: "column" }}>
					<text
						fg={props.selected ? uiColors.textPrimary : uiColors.textSecondary}
					>
						<strong>{props.pin.glyph}</strong>
						{` ${clip(props.pin.label, SIDEBAR_WIDTH - 8)}`}
					</text>
					<text fg={uiColors.textMuted}>
						{clip(props.pin.meta, SIDEBAR_WIDTH - 8)}
					</text>
				</box>
			) : (
				<text
					fg={props.selected ? uiColors.textPrimary : uiColors.textSecondary}
				>
					{props.pin.glyph}
				</text>
			)}
		</Selectable>
	);
}

/** The rule between the pinned entry and the workflow list: a dim line, so the
 * fixed entry reads as separated chrome rather than as one more workspace. */
function PinDivider(props: { width: number }) {
	return (
		<box style={{ height: 1, flexShrink: 0, paddingLeft: 2 }}>
			<text fg={uiColors.border}>
				{"─".repeat(Math.max(0, props.width - 4))}
			</text>
		</box>
	);
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
	/** The pinned entries above the workflow rows, present whenever the shell
	 * renders a Home surface. Absent leaves the panel as it was. */
	pins?: readonly SidebarPin[];
	filter: SidebarFilter;
	/** Cursor in the sidebar's own space: the pinned entries first, then the
	 * filter's workflow rows. */
	selectedIndex: number;
	/** True until the first observation lands. */
	loading: boolean;
	onSelectIndex: (index: number) => void;
	/** Enter/click on a pinned entry: open its page. */
	onOpenPin: (pin: SidebarPin) => void;
	/** Enter/click: open the workflow dashboard for the row. */
	onOpen: (overview: WorkflowOverview) => void;
	onFilterChange: (filter: SidebarFilter) => void;
	/** Any mouse activity in the panel asks the shell to focus it. */
	onFocus: () => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
	const dimensions = useTerminalDimensions();
	/** Leading cursor slots the pinned entries take, so the workflow list keeps
	 * its own 0-based index while the panel cursor counts the pins first. */
	const pinCount = () => props.pins?.length ?? 0;
	const pinOffset = () => pinCount();
	const listLines = () =>
		Math.max(
			1,
			dimensions().height - SIDEBAR_CHROME_LINES - pinLines(pinCount()),
		);
	/** Click/Enter on a pinned entry: select it, then open its page. */
	const activatePin = (index: number, pin: SidebarPin): void => {
		props.onFocus();
		props.onSelectIndex(index);
		props.onOpenPin(pin);
	};
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
		// Untracked: the tween writes the width, so a tracked read would make the
		// effect below re-run on every frame it renders and restart the tween.
		const start = untrack(width);
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
		if (!expandedByMode()) {
			// Collapsing is a cut, not a slide: the compact strip is the whole
			// collapsed view, so the panel returns to its fixed compact width at
			// once instead of holding the expanded width — and the full expanded
			// rows — until a tween gets around to finishing.
			stopAnimation();
			setWidth(SIDEBAR_COLLAPSED_WIDTH);
			return;
		}
		animateTo(SIDEBAR_WIDTH);
	});
	onCleanup(stopAnimation);
	/** The panel's width and whether it paints its full rows. The sidebar's own
	 * mode/focus state decides both, so the collapsed view can never be the
	 * expanded one and a stale animated width can never widen it. */
	const panel = () =>
		sidebarPanelView({
			expandedByState: expandedByMode(),
			animatedWidth: width(),
		});
	// The glyph points toward the body: on the left side `»` pushes the panel
	// open (permanent) and `«` returns it to auto-collapse; on the right side
	// the pair is mirrored.
	const openGlyph = () => (props.side === "left" ? "»" : "«");
	const collapseGlyph = () => (props.side === "left" ? "«" : "»");
	const toggleGlyph = () =>
		props.mode === "permanent" ? collapseGlyph() : openGlyph();
	const toggleMode = (): void => {
		props.onFocus();
		props.onToggleMode();
	};
	// The glyphs are click-only controls nested in the strip: the shared tap rule
	// drops drags and non-primary buttons, and the tap stops here so the strip's
	// own focus handler does not run twice.
	const toggleModeTap = useTap(toggleMode, { stopPropagation: true });
	const toggleModeHover = useHover(toggleModeTap.onMouseOut);
	return (
		<box
			width={panel().width}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
			style={{ flexDirection: "column", minHeight: 0, overflow: "hidden" }}
			{...useTap(() => props.onFocus())}
		>
			<Show
				when={panel().expanded}
				fallback={
					// Collapsed: a toggle glyph, the pinned entries as their marks, then one
					// three-line row per workflow — its bold jump-list position, its status
					// glyph, and one phase-specific character — so the strip matches the
					// expanded row's height while staying nameless.
					<>
						<box
							style={{
								height: 1,
								flexShrink: 0,
								paddingLeft: 1,
								flexDirection: "row",
							}}
							backgroundColor={
								toggleModeHover.hovered() ? uiColors.bgHover : undefined
							}
							{...toggleModeTap}
							{...toggleModeHover}
						>
							<text
								fg={
									toggleModeHover.hovered()
										? uiColors.textPrimary
										: uiColors.textMuted
								}
							>
								{openGlyph()}
							</text>
						</box>
						{/* Pinned entries are chrome above the list, so they keep their
						    slots in the strip too: always drawn, and the index list below
						    them stays empty when there is nothing to index — the strip is a
						    jump list, so a filler line ("No items") would be the only thing
						    it ever says with no workflows. The expanded panel explains an
						    empty list in words instead. */}
						<For each={props.pins ?? []}>
							{(pin, index) => (
								<PinRow
									pin={pin}
									selected={props.selectedIndex === index()}
									height={1}
									onActivate={() => activatePin(index(), pin)}
								/>
							)}
						</For>
						<Show when={pinCount() > 0}>
							<PinDivider width={panel().width} />
						</Show>
						<Show when={props.overviews.length > 0}>
							<SelectableList
								items={props.overviews}
								selectedIndex={props.selectedIndex - pinOffset()}
								itemHeight={3}
								hoverBackground={uiColors.bgHover}
								availableLines={Math.max(
									3,
									dimensions().height - 4 - collapsedPinLines(pinCount()),
								)}
								onSelect={(index) => {
									props.onFocus();
									props.onSelectIndex(index + pinOffset());
								}}
								renderItem={(overview, selected, index) => {
									// The collapsed row is the expanded row's height: the bold
									// jump-list position, then the status mark in its tone colour
									// (bold while it waits on a reader), then one phase-specific
									// character. The strip stays nameless and metadata-free.
									const row = sidebarCollapsedRow(
										overview,
										index,
										SIDEBAR_COLLAPSED_ROW_WIDTH,
									);
									return (
										<box
											style={{
												height: 3,
												minWidth: 0,
												flexDirection: "column",
												overflow: "hidden",
											}}
										>
											<text
												fg={
													selected
														? uiColors.textPrimary
														: uiColors.textSecondary
												}
											>
												<strong>{row.index}</strong>
											</text>
											<text fg={toneColor(row.tone)}>
												{row.needsReader ? (
													<strong>{row.glyph}</strong>
												) : (
													row.glyph
												)}
											</text>
											<text fg={toneColor(row.signal.tone)}>
												{row.signal.text}
											</text>
										</box>
									);
								}}
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
							fg={
								props.active
									? uiColors.primary
									: toggleModeHover.hovered()
										? uiColors.textPrimary
										: uiColors.textMuted
							}
							bg={toggleModeHover.hovered() ? uiColors.bgHover : undefined}
							{...toggleModeTap}
							{...toggleModeHover}
						>
							{toggleGlyph()}
						</text>
					}
				>
					<box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
						<For each={SIDEBAR_FILTERS}>
							{(entry) => {
								const active = () => props.filter === entry.id;
								const tap = useTap(() => {
									props.onFocus();
									props.onFilterChange(entry.id);
								});
								const hover = useHover(tap.onMouseOut);
								return (
									<box style={{ marginRight: 1 }} {...tap} {...hover}>
										<text
											fg={
												active()
													? uiColors.bgBase
													: hover.hovered()
														? uiColors.textPrimary
														: uiColors.textMuted
											}
											bg={
												active()
													? hover.hovered()
														? uiColors.primaryDim
														: uiColors.primary
													: hover.hovered()
														? uiColors.bgHover
														: uiColors.bgMantle
											}
										>
											{` ${entry.label} `}
										</text>
									</box>
								);
							}}
						</For>
					</box>
					{/* Pinned entries sit above the windowed list, so they stay put
					    while the workflows scroll under them, and they are drawn whatever
					    the filter leaves. */}
					<For each={props.pins ?? []}>
						{(pin, index) => (
							<PinRow
								pin={pin}
								selected={props.selectedIndex === index()}
								height={2}
								onActivate={() => activatePin(index(), pin)}
							/>
						)}
					</For>
					<Show when={pinCount() > 0}>
						<PinDivider width={width()} />
					</Show>
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
							selectedIndex={props.selectedIndex - pinOffset()}
							itemHeight={3}
							hoverBackground={uiColors.bgHover}
							availableLines={listLines()}
							onSelect={(index) => {
								props.onFocus();
								props.onSelectIndex(index + pinOffset());
								const entry = props.overviews[index];
								if (entry) props.onOpen(entry);
							}}
							renderItem={(overview, selected) => {
								const status = sidebarStatusGlyph(overview);
								const nameTone = selected
									? uiColors.textPrimary
									: uiColors.textSecondary;
								return (
									<box
										style={{
											height: 3,
											minWidth: 0,
											flexDirection: "column",
											overflow: "hidden",
										}}
									>
										<box
											style={{
												height: 1,
												minWidth: 0,
												flexDirection: "row",
												overflow: "hidden",
											}}
										>
											<text fg={toneColor(status.tone)}>
												<strong>{status.glyph}</strong>
											</text>
											<text fg={nameTone}>
												<strong>
													{` ${clip(
														workflowRowLabel(overview),
														SIDEBAR_ROW_LABEL_WIDTH,
													)}`}
												</strong>
											</text>
										</box>
										<box
											style={{
												height: 1,
												minWidth: 0,
												flexDirection: "row",
												overflow: "hidden",
											}}
										>
											<For
												each={clipMetaSegments(
													workflowStageMeta(overview),
													SIDEBAR_ROW_TEXT_WIDTH,
												)}
											>
												{(segment) => (
													<text fg={toneColor(segment.tone)}>
														{segment.text}
													</text>
												)}
											</For>
										</box>
										<text fg={uiColors.textMuted}>
											{clip(
												workflowProjectName(overview),
												SIDEBAR_ROW_TEXT_WIDTH,
											)}
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
