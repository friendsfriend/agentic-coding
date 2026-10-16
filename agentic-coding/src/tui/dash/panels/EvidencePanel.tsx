/** Evidence panel (`add-dashboard-evidence-panel`).
 *
 * The developer's window onto what the run produced: every manifest entry of the
 * workflow, newest first and grouped by the debug request it was attached under,
 * beside a preview of the selected entry. Props-in: the manifest, the kitty
 * capability the route probed, and the selected entry's bytes and path all come
 * from the route, which owns the reads; opening a file is a keybind the key
 * handler dispatches.
 *
 * The panel is read-only — it lists, previews and hands a file to the platform's
 * opener, and offers no delete or edit action.
 *
 * Without kitty graphics support the image renderable is never mounted: a
 * terminal that cannot show the picture gets the metadata only, rather than a
 * half-block approximation or an image escape sequence it would print as
 * garbage.
 *
 * The panel is a compact row (see `evidencePanelLines`), so the preview column
 * often has fewer than `MIN_IMAGE_LINES` rows to spare: the metadata keeps
 * them, the row says the picture has no room, and the panel never grows to fit
 * an image — the file is one keybind away from the platform's own viewer. */

import type { TerminalCapabilities } from "@opentui/core";
import { resolveImageRenderProtocol, TextAttributes } from "@opentui/core";
import { Panel, SelectableList, uiColors } from "@ui";
import { createMemo, Show } from "solid-js";
import type { EvidenceEntry } from "../../../contracts/environment.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_PANEL_LINES,
	type EvidenceReadState,
	evidenceDetailLines,
	evidencePreviewEntry,
	evidenceRows,
} from "../evidence-panel.ts";

/**
 * Whether the renderer will draw an inline image. The terminal capability probe
 * it ran is the only source — `$TERM` is never sniffed — and the decision is the
 * image renderable's own (`resolveImageRenderProtocol`), so the panel never
 * mounts a picture the renderer would paint as half blocks instead: a terminal
 * without kitty graphics, and one behind a multiplexer that cannot pass images
 * through, both answer `false` and get the metadata only.
 */
export function inlineImagePreview(
	capabilities: TerminalCapabilities | null | undefined,
): boolean {
	return (
		resolveImageRenderProtocol("auto", capabilities ?? null, false) === "kitty"
	);
}

/** What the manifest read is doing. Only a read that actually succeeded with no
 * entries renders the neutral empty state: "this run produced no evidence" is a
 * fact the dashboard has to have established, not the default. */
export type EvidencePanelState = EvidenceReadState;

/** What the selected entry's preview is doing. `absent` is an answer — the
 * gateway reports that the recorded file is gone — so it must not read as
 * "still loading", and `error` is the read having failed. */
export type EvidencePreviewState = "loading" | "ready" | "absent" | "error";

/** Lines the image needs before it is worth drawing: a one-row strip reads as a
 * glitch rather than as a preview, and the metadata keeps the lines instead. */
const MIN_IMAGE_LINES = 3;

export interface EvidencePanelProps {
	readonly entries: readonly EvidenceEntry[];
	readonly active: boolean;
	readonly selectedIndex: number;
	/** The renderer reports kitty graphics support (`inlineImagePreview`). */
	readonly kitty: boolean;
	/** Bytes of the selected entry's preview image. A function so the panel
	 * repaints when a load lands; `undefined` until then, or when the file is
	 * gone (`previewState` says which). */
	readonly preview?: () => Uint8Array | undefined;
	readonly previewState?: EvidencePreviewState;
	/** Absolute path of the selected entry's file, when the route could compose
	 * it. Shown as metadata; `Enter` and `y` act on the same file. */
	readonly path?: string;
	/** Panel height in lines: the full-width bottom row of the detail grid. */
	readonly height?: number;
	readonly state?: EvidencePanelState;
	/** The reason to show when `state` is "error". */
	readonly error?: string;
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`). */
	readonly onSelectIndex?: (index: number) => void;
	/**
	 * Whether the wheel may move this list's cursor. Default true; the route
	 * turns it off here because *selection* triggers the preview read, and the
	 * wheel must not issue one read per event (`tui-input-responsiveness`).
	 */
	readonly wheelMovesCursor?: boolean;
	/** Pointer: a tap on the selected row activates it (the keyboard's `Enter`). */
	readonly onActivateRow?: (index: number) => void;
	/** Pointer: a tap anywhere in the panel focuses it (`J/K/H/L`). */
	readonly onFocusRequest?: () => void;
}

export function EvidencePanel(props: EvidencePanelProps) {
	const rows = createMemo(() => evidenceRows(props.entries));
	// The panel is a compact fixed-height row: the listing scrolls inside the
	// body rather than growing the panel, and a caller may go as low as the one
	// title row (the empty state the route asks for with nothing attached).
	const height = () =>
		Math.max(EVIDENCE_EMPTY_LINES, props.height ?? EVIDENCE_PANEL_LINES);
	const bodyLines = () => Math.max(0, height() - 1);
	const collapsed = () => bodyLines() === 0;
	const selected = createMemo(() => rows()[props.selectedIndex]?.entry);
	const image = createMemo(() =>
		props.kitty ? evidencePreviewEntry(rows(), props.selectedIndex) : undefined,
	);
	const detailLines = createMemo(() => {
		const entry = selected();
		return entry ? evidenceDetailLines(entry, props.path) : [];
	});
	// The preview column paints at most three things: a one-line message, the
	// image, and the metadata — and the metadata is the part that must never be
	// clipped. It gets the rows it needs (up to the body), the image takes what is
	// left when that is a picture worth drawing, and the message row exists only
	// when a row is genuinely free: `messageRows + painted metadata <= bodyLines`.
	const metadataLines = createMemo(() =>
		Math.min(detailLines().length, bodyLines()),
	);
	const freeLines = createMemo(() => bodyLines() - metadataLines());
	const imageLines = createMemo(() => freeLines());
	const showsImage = createMemo(
		() =>
			image() !== undefined &&
			props.preview?.() !== undefined &&
			imageLines() >= MIN_IMAGE_LINES,
	);
	const showsMessage = createMemo(
		() => image() !== undefined && !showsImage() && freeLines() >= 1,
	);
	const visibleDetailLines = createMemo(() => {
		const lines = detailLines();
		const available = metadataLines();
		if (lines.length <= available) return lines;
		const kept = Math.max(0, available - 1);
		return [...lines.slice(0, kept), `… ${lines.length - kept} more lines`];
	});
	const previewMessage = () => {
		if (props.preview?.() === undefined) {
			if (props.previewState === "absent") return "Preview unavailable";
			if (props.previewState === "error") return "Preview could not be read";
			return "Loading preview…";
		}
		return "Preview too small";
	};
	/** The read state, shown beside a listing that is already on screen: a stale
	 * list must not look like a live one. Only a failure is marked — a read in
	 * flight leaves the last-known listing alone rather than flickering a marker
	 * on every background refresh. */
	const staleMarker = () =>
		rows().length > 0 && props.state === "error"
			? "last read failed"
			: undefined;
	const bodyMessage = () => {
		if (props.state === "error")
			return props.error
				? `Evidence could not be read: ${props.error}`
				: "Evidence could not be read";
		if (props.state === "loading") return "Loading evidence…";
		return "No evidence attached yet";
	};
	/** What the title row carries beside the title. A collapsed panel is that row
	 * alone, so the state message moves into it rather than being clipped away
	 * with the body. */
	const accessory = (): { text: string; failure: boolean } | undefined => {
		if (collapsed()) {
			if (rows().length > 0) return undefined;
			return { text: bodyMessage(), failure: props.state === "error" };
		}
		const marker = staleMarker();
		return marker ? { text: marker, failure: true } : undefined;
	};
	return (
		<Panel
			title="Evidence"
			accent={uiColors.accent}
			active={props.active}
			style={{ width: "100%", height: height(), flexShrink: 0 }}
			accessory={
				<Show when={accessory()}>
					{(line) => (
						<text fg={line().failure ? uiColors.error : uiColors.textMuted}>
							{line().text}
						</text>
					)}
				</Show>
			}
		>
			<Show when={!collapsed()}>
				<box
					style={{
						width: "100%",
						height: "100%",
						flexDirection: "row",
						gap: 1,
					}}
				>
					<box
						style={{
							flexGrow: 1,
							flexBasis: 0,
							minWidth: 0,
							height: "100%",
						}}
					>
						<Show
							when={rows().length > 0}
							fallback={
								<text
									fg={
										props.state === "error"
											? uiColors.error
											: uiColors.textSecondary
									}
								>
									{bodyMessage()}
								</text>
							}
						>
							<SelectableList
								items={rows()}
								availableLines={bodyLines()}
								wheelMovesCursor={props.wheelMovesCursor !== false}
								// A row that opens a debug request's group spends a second line
								// on its heading.
								itemHeights={rows().map((row) => (row.header ? 2 : 1))}
								selectedIndex={props.active ? props.selectedIndex : -1}
								{...(props.onSelectIndex
									? { onSelect: props.onSelectIndex }
									: {})}
								{...(props.onActivateRow
									? { onActivate: props.onActivateRow }
									: {})}
								renderItem={(row, selectedRow) => (
									<box
										width="100%"
										height={row.header ? 2 : 1}
										flexDirection="column"
									>
										<Show when={row.header}>
											{(header) => (
												<box width="100%" height={1} overflow="hidden">
													<text fg={uiColors.textMuted}>{header()}</text>
												</box>
											)}
										</Show>
										<box width="100%" height={1} overflow="hidden">
											<text
												fg={
													selectedRow
														? uiColors.textPrimary
														: uiColors.textSecondary
												}
												attributes={selectedRow ? TextAttributes.BOLD : 0}
											>
												{row.label}
											</text>
										</box>
									</box>
								)}
							/>
						</Show>
					</box>
					<box
						style={{
							width: "45%",
							minWidth: 0,
							height: "100%",
							flexDirection: "column",
						}}
					>
						<Show when={selected() !== undefined}>
							<Show when={showsImage()}>
								<box
									style={{
										width: "100%",
										height: imageLines(),
										flexShrink: 0,
									}}
								>
									<image
										source={props.preview?.()}
										fit="fit"
										style={{ width: "100%", height: "100%" }}
									/>
								</box>
							</Show>
							<Show when={showsMessage()}>
								<box width="100%" height={1} flexShrink={0}>
									<text
										fg={
											props.previewState === "error"
												? uiColors.error
												: uiColors.textMuted
										}
									>
										{previewMessage()}
									</text>
								</box>
							</Show>
							<box
								style={{
									width: "100%",
									flexGrow: 1,
									minHeight: 0,
									flexDirection: "column",
								}}
							>
								{visibleDetailLines().map((line) => (
									<box width="100%" height={1} overflow="hidden">
										<text fg={uiColors.textSecondary}>{line}</text>
									</box>
								))}
							</box>
						</Show>
					</box>
				</box>
			</Show>
		</Panel>
	);
}
