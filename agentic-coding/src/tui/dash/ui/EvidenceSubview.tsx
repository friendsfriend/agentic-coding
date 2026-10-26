/** The evidence subview (`evidence-summary-subview`, task 4.1).
 *
 * A page of the dashboard body — the same mechanism as the agent-session page,
 * not a dialog and not a shell route — opened by `Enter` on the Evidence panel
 * and left with `Esc`. It is where the run's evidence is actually read:
 *
 * - the left pane renders the run's optional markdown report with the wiki's own
 *   renderer and citation markers (`[^<evidence-id>]`), a cited screenshot inline
 *   in place of its citation when the renderer reports kitty graphics, and a
 *   trailing sources list of everything the report cites;
 * - the right pane lists *every* entry of the manifest — grouped by stage flow
 *   segment when the workflow recorded one, by debug request otherwise — with the
 *   focused entry's metadata under it, and the same tap-to-select/tap-to-activate
 *   wiring the panel used to have.
 *
 * Presentational: the route owns the report read, the cited-image reads and the
 * kitty probe, and its keymap layer owns `Esc`, the selection keys and the two
 * file actions. Without kitty graphics the image renderable is never mounted, so
 * no image bytes are ever sent to a terminal that would print them as garbage. */

import {
	MarkdownBlockView,
	Panel,
	parseMarkdownBlocks,
	ScrollableContent,
	SelectableList,
	uiColors,
	useTerminalDimensions,
} from "@agentic-coding/ui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import type { EvidenceEntry } from "../../../contracts/environment.ts";
import type { StageJournal } from "../../../contracts/stages.ts";
import {
	type EvidenceListRow,
	type EvidenceMarker,
	type EvidenceReadState,
	evidenceDetailLines,
	evidenceReadFailureMarker,
	evidenceRows,
	evidenceStepDetailLines,
} from "../evidence-panel.ts";
import {
	type EvidenceReportSection,
	evidenceImageFallbackLines,
	evidenceReportSections,
	renderEvidenceReport,
} from "../evidence-report.ts";

/** What the report read is doing. `none` is a fact — the workflow attached no
 * report — and `absent` is the gateway's answer that the recorded file is gone;
 * neither reads as "still loading". */
export type EvidenceReportState =
	| "none"
	| "loading"
	| "ready"
	| "absent"
	| "error";

/** Rows the page's own chrome takes: the dashboard's footer and status bar around
 * the body and the panes' title rows. A list windowed without it would paint rows
 * the host clips. */
const SUBVIEW_CHROME_LINES = 8;

/** Rows one cited screenshot is given. A picture is worth more than a line, and a
 * report with four of them should still leave prose on screen. */
const REPORT_IMAGE_LINES = 12;

export interface EvidenceSubviewProps {
	readonly entries: readonly EvidenceEntry[];
	/** The workflow's stage step journal, when it has one: the sidebar then keeps
	 * the flow grouping and lists the journal steps between the evidence they
	 * produced. */
	readonly journal?: StageJournal;
	/** The sidebar rows, when the route already computed them: the grid's selection
	 * clamp, the key handler and this list then share one grouping per refresh
	 * instead of two. Without it the pane derives the same rows from `entries`. */
	readonly rows?: () => EvidenceListRow[];
	/** What the manifest read is doing. The sidebar says so when it has no rows, so
	 * an empty, pending and failed listing are three different answers rather than
	 * one blank pane. `ready` when the route does not track it. */
	readonly state?: EvidenceReadState;
	/** The reason to show when `state` is "error". */
	readonly error?: string;
	/** The report text, read by the route; `undefined` until it lands. */
	readonly report?: () => string | undefined;
	readonly reportState: EvidenceReportState;
	/** The reason to show when `reportState` is "error". */
	readonly reportError?: string;
	/** The renderer reports kitty graphics support (`inlineImagePreview`). */
	readonly kitty: boolean;
	/** Cited screenshot bytes by entry id. A function so the pane repaints when a
	 * load lands; a missing id renders the entry's text fallback. */
	readonly images?: () => Readonly<Record<string, Uint8Array>>;
	readonly selectedIndex: number;
	/** Absolute path of the focused entry's file, when the route could compose it. */
	readonly pathOf?: (entry: EvidenceEntry) => string | undefined;
	/** The report pane's scroll box, published so the keymap layer can scroll it. */
	readonly onScrollBoxReady?: (box: ScrollBoxRenderable) => void;
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`). */
	readonly onSelectIndex?: (index: number) => void;
	/** Pointer: a tap on the selected row activates it (the keyboard's `Enter`). */
	readonly onActivateRow?: (index: number) => void;
}

export function EvidenceSubview(props: EvidenceSubviewProps) {
	const dimensions = useTerminalDimensions();
	const state = () => props.state ?? "ready";
	const rows = createMemo(
		() => props.rows?.() ?? evidenceRows(props.entries, props.journal),
	);
	const selected = createMemo(() => rows()[props.selectedIndex]);
	const detailLines = createMemo(() => {
		const row = selected();
		if (row?.entry)
			return evidenceDetailLines(row.entry, props.pathOf?.(row.entry));
		// A journal step has no file: its own expectations and captures are what
		// the detail rows have to say about it.
		return row?.step ? evidenceStepDetailLines(row.step) : [];
	});
	/** The report's own reading width: the pane's 60% of the terminal, less the
	 * pane's border marker and padding. Markdown renders to a cell width, so the
	 * route never has to measure the box. */
	const reportWidth = () =>
		Math.max(20, Math.floor((dimensions().width - 2) * 0.6) - 3);
	const imageLines = () =>
		Math.min(
			REPORT_IMAGE_LINES,
			Math.max(4, Math.floor(dimensions().height / 3)),
		);
	/** The sidebar's list window: what the pane leaves once its detail rows have
	 * the space they need. */
	const detailBudget = () =>
		Math.min(
			detailLines().length,
			Math.max(1, Math.floor(dimensions().height / 3)),
		);
	const listLines = () =>
		Math.max(3, dimensions().height - SUBVIEW_CHROME_LINES - detailBudget());
	/** The report document exactly as it is painted: control characters folded out
	 * and citations resolved. It is a string, so its memo compares by value: a
	 * manifest refresh that changes nothing about the document does not notify the
	 * lex below. */
	const document = createMemo(() =>
		props.reportState === "ready"
			? renderEvidenceReport(props.report?.() ?? "", props.entries)
			: "",
	);
	/** The document's markdown blocks, lexed once per document text — not once per
	 * manifest refresh. A run streaming republishes the manifest about once a
	 * second, and a tokenizer run over the whole report inside the render loop is
	 * the one avoidable cost of that refresh; the citation resolution and layout
	 * below are a regex pass and map lookups. */
	const blocks = createMemo(() => parseMarkdownBlocks(document()), [], {
		equals: (left, right) =>
			left.length === right.length &&
			left.every((block, index) => block.source === right[index]?.source),
	});
	/** The layout for those blocks. An unchanged answer keeps the previous identity,
	 * so a refresh repaints nothing. */
	const sections = createMemo<EvidenceReportSection[]>(
		() =>
			props.reportState === "ready"
				? evidenceReportSections(props.report?.() ?? "", props.entries, {
						blocks: blocks(),
					})
				: [],
		[],
		{ equals: sameSections },
	);
	/** What the sidebar says when it has no rows: a read that has not landed, a read
	 * that failed, and a run that attached nothing are three different facts, and the
	 * page that owns the listing is where they have to be visible. */
	const sidebarMessage = (): { text: string; failure: boolean } | undefined => {
		if (rows().length > 0) return undefined;
		if (state() === "error")
			return {
				text: props.error
					? `Evidence could not be read: ${props.error}`
					: "Evidence could not be read",
				failure: true,
			};
		if (state() === "loading")
			return { text: "Loading evidence…", failure: false };
		return { text: "No evidence attached yet", failure: false };
	};
	/** What the sidebar's title row carries: how many entries the listing holds once
	 * it is real, and — over rows that are still painted after a failed refresh —
	 * the same `last read failed` marker the grid's summary row shows for the same
	 * manifest, so the two surfaces never disagree about whether the list is live. */
	const accessoryMarkers = (): EvidenceMarker[] => {
		const failure = evidenceReadFailureMarker(state());
		const count =
			state() === "loading" || props.entries.length === 0
				? undefined
				: {
						text: `${props.entries.length} ${
							props.entries.length === 1 ? "entry" : "entries"
						}`,
						failure: false,
					};
		return [...(count ? [count] : []), ...(failure ? [failure] : [])];
	};
	const reportMessage = (): { text: string; failure: boolean } => {
		if (props.reportState === "loading")
			return { text: "Loading report…", failure: false };
		if (props.reportState === "absent")
			return { text: "The report file is not on this machine.", failure: true };
		if (props.reportState === "error")
			return {
				text: props.reportError
					? `The report could not be read: ${props.reportError}`
					: "The report could not be read.",
				failure: true,
			};
		return { text: "No report attached", failure: false };
	};
	/** One report section. A discriminated union, so each branch reads its own
	 * fields without a cast. */
	const renderSection = (section: EvidenceReportSection) => {
		if (section.kind === "markdown")
			return (
				<MarkdownBlockView
					source={section.source}
					width={reportWidth()}
					fg={uiColors.textSecondary}
				/>
			);
		if (section.kind === "image") {
			const entry = section.entry;
			// Read reactively: the cited bytes land after the first paint (the route
			// starts those reads once the report text is in), so an eager read here would
			// pin the text fallback for the life of the item.
			const bytes = () =>
				props.kitty ? props.images?.()[entry.id] : undefined;
			const fallback = createMemo(() =>
				evidenceImageFallbackLines(entry, props.pathOf?.(entry)),
			);
			return (
				<Show
					when={bytes()}
					fallback={
						// No kitty graphics, or the bytes have not landed: the citation keeps
						// its text and metadata instead of a half-block approximation.
						<box style={{ width: "100%", flexDirection: "column" }}>
							{fallback().map((line) => (
								<box style={{ width: "100%", height: 1, overflow: "hidden" }}>
									<text fg={uiColors.textMuted}>{line}</text>
								</box>
							))}
						</box>
					}
				>
					{(imageBytes) => (
						<box style={{ width: "100%", height: imageLines(), flexShrink: 0 }}>
							<image
								source={imageBytes()}
								fit="fit"
								style={{ width: "100%", height: "100%" }}
							/>
						</box>
					)}
				</Show>
			);
		}
		return (
			<box style={{ width: "100%", flexDirection: "column" }}>
				<text fg={uiColors.textMuted}>sources</text>
				{section.rows.map((row) => (
					<box style={{ width: "100%", height: 1, overflow: "hidden" }}>
						<text fg={row.known ? uiColors.textSecondary : uiColors.error}>
							{row.label}
						</text>
					</box>
				))}
			</box>
		);
	};
	return (
		<box
			width="100%"
			height="100%"
			flexDirection="row"
			gap={1}
			minHeight={0}
			backgroundColor={uiColors.bgBase}
		>
			<Panel
				title="Report"
				accent={uiColors.accent}
				active
				style={{ flexGrow: 3, flexBasis: 0, minWidth: 0, height: "100%" }}
			>
				<ScrollableContent
					onScrollBoxReady={(box) => props.onScrollBoxReady?.(box)}
					// A report is up to a few thousand lines; culling keeps a repaint to
					// what is on screen, exactly as the agent transcript does.
					viewportCulling
					style={{ width: "100%", height: "100%" }}
				>
					<box
						style={{
							width: "100%",
							flexDirection: "column",
							gap: 1,
							paddingRight: 1,
						}}
					>
						<For each={sections()}>{(section) => renderSection(section)}</For>
						{props.reportState === "ready" ? undefined : (
							<box style={{ width: "100%", height: 1, overflow: "hidden" }}>
								<text
									fg={
										reportMessage().failure
											? uiColors.error
											: uiColors.textSecondary
									}
								>
									{reportMessage().text}
								</text>
							</box>
						)}
					</box>
				</ScrollableContent>
			</Panel>
			<Panel
				title="Evidence"
				accent={uiColors.accent}
				style={{ flexGrow: 2, flexBasis: 0, minWidth: 0, height: "100%" }}
				accessory={
					<Show when={accessoryMarkers().length > 0}>
						<box style={{ flexDirection: "row", gap: 1 }}>
							{accessoryMarkers().map((marker) => (
								<text fg={marker.failure ? uiColors.error : uiColors.textMuted}>
									{marker.text}
								</text>
							))}
						</box>
					</Show>
				}
			>
				<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
					<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
						<Show
							when={sidebarMessage()}
							fallback={
								<SelectableList
									items={rows()}
									availableLines={listLines()}
									wheelMovesCursor={false}
									// A row that opens a group spends a second line on its heading.
									itemHeights={rows().map((row) => (row.header ? 2 : 1))}
									selectedIndex={props.selectedIndex}
									{...(props.onSelectIndex
										? { onSelect: props.onSelectIndex }
										: {})}
									{...(props.onActivateRow
										? { onActivate: props.onActivateRow }
										: {})}
									renderItem={(row, selectedRow) => renderRow(row, selectedRow)}
								/>
							}
						>
							{(message) => (
								<box style={{ width: "100%", height: 1, overflow: "hidden" }}>
									<text
										fg={
											message().failure
												? uiColors.error
												: uiColors.textSecondary
										}
									>
										{message().text}
									</text>
								</box>
							)}
						</Show>
					</box>
					<box
						style={{
							width: "100%",
							flexShrink: 0,
							flexDirection: "column",
						}}
					>
						{detailLines()
							.slice(0, Math.max(0, detailBudget()))
							.map((line) => (
								<box style={{ width: "100%", height: 1, overflow: "hidden" }}>
									<text fg={uiColors.textSecondary}>{line}</text>
								</box>
							))}
					</box>
				</box>
			</Panel>
		</box>
	);
}

/** Whether two section lists paint the same thing. Compared field by field, so an
 * identical resolution keeps the previous array and `<For>` does not rebuild the
 * report from scratch. */
function sameSections(
	left: readonly EvidenceReportSection[],
	right: readonly EvidenceReportSection[],
): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.every((section, index) => {
		const other = right[index];
		if (other?.kind !== section.kind) return false;
		if (section.kind === "markdown")
			return other.kind === "markdown" && other.source === section.source;
		if (section.kind === "image")
			return other.kind === "image" && other.entry.id === section.entry.id;
		return (
			other.kind === "sources" &&
			other.rows.length === section.rows.length &&
			other.rows.every(
				(row, rowIndex) =>
					row.label === section.rows[rowIndex]?.label &&
					row.known === section.rows[rowIndex]?.known,
			)
		);
	});
}

/** One sidebar row: the group heading it opens (when it opens one) and the row's
 * own label. The selection styling is `Selectable`'s, so the row only weights its
 * own text. */
function renderRow(row: EvidenceListRow, selectedRow: boolean) {
	return (
		<box width="100%" height={row.header ? 2 : 1} flexDirection="column">
			{row.header === undefined ? undefined : (
				<box width="100%" height={1} overflow="hidden">
					<text fg={uiColors.textMuted}>{row.header}</text>
				</box>
			)}
			<box width="100%" height={1} overflow="hidden">
				<text
					fg={selectedRow ? uiColors.textPrimary : uiColors.textSecondary}
					attributes={selectedRow ? TextAttributes.BOLD : 0}
				>
					{row.label}
				</text>
			</box>
		</box>
	);
}
