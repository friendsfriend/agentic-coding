/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from "@opentui/core";
import { Portal, useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import { colors, uiColors } from "./colors";
import { FilterStatusBar } from "./FilterStatusBar";
import { HelpText, wrapHelpEntries } from "./HelpText";
import type { Keybind } from "./keybinds";
import { SearchHeader } from "./SearchHeader";
import { invokeGlobalSelectionMouseUpHandler } from "./selectionCopy";

export interface SummaryEntry {
	label: string;
	value: string;
}

const mixHex = (from: string, to: string, amount: number) => {
	const channel = (hex: string, offset: number) =>
		parseInt(hex.slice(offset, offset + 2), 16);
	const mixed = [1, 3, 5].map((offset) =>
		Math.round(
			channel(from, offset) +
				(channel(to, offset) - channel(from, offset)) * amount,
		),
	);
	return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};
const progressColor = (position: number) =>
	position < 0.5
		? mixHex(colors.blue, colors.lavender, position * 2)
		: mixHex(colors.lavender, colors.green, (position - 0.5) * 2);

const SUMMARY_TABLE_WIDTH = 42;
const SUMMARY_TABLE_GUTTER = 2;
/* Keep at least this many columns for the sibling content column. */
const SUMMARY_CONTENT_MIN_WIDTH = 24;
/* Side-by-side table needs at least this many columns to be usable. */
const SUMMARY_TABLE_MIN_WIDTH = 20;

function SummaryTable(props: {
	entries: SummaryEntry[];
	full?: boolean;
	width?: number;
}) {
	const labelWidth = () => {
		if (props.width === undefined) return 26;
		// Row = marker(2) + label + value; keep the legacy 14-col value floor.
		return Math.max(2, Math.min(26, props.width - 16));
	};
	return (
		<box
			width={props.width ?? (props.full ? "100%" : SUMMARY_TABLE_WIDTH)}
			flexShrink={0}
			marginLeft={props.full ? 0 : SUMMARY_TABLE_GUTTER}
			flexDirection="column"
		>
			<text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>
				Selections
			</text>
			<For each={props.entries}>
				{(entry) => (
					<box width="100%" height={1} flexDirection="row">
						<box width={2} backgroundColor={uiColors.bgMantle} />
						<box width={labelWidth()} overflow="hidden">
							<text fg={uiColors.textMuted}>{entry.label}</text>
						</box>
						<box flexGrow={1} minWidth={0} overflow="hidden">
							<text fg={uiColors.textPrimary}>{entry.value}</text>
						</box>
					</box>
				)}
			</For>
		</box>
	);
}

function hexToRgba(hex: string, alpha: number): RGBA {
	const normalized = hex.replace("#", "");
	if (normalized.length !== 6) return RGBA.fromHex(hex);

	const r = parseInt(normalized.slice(0, 2), 16) / 255;
	const g = parseInt(normalized.slice(2, 4), 16) / 255;
	const b = parseInt(normalized.slice(4, 6), 16) / 255;
	return RGBA.fromValues(r, g, b, alpha);
}

function wrapHelpText(text: string, maxWidth: number): string[] {
	if (!text) return [""];
	if (maxWidth <= 0) return [text];

	const sourceLines = text.split("\n");
	const lines: string[] = [];

	for (const sourceLine of sourceLines) {
		const chunks = sourceLine.includes("•")
			? sourceLine
					.split(/\s+•\s+/)
					.map((chunk) => chunk.trim())
					.filter(Boolean)
			: sourceLine.split(/\s+/).filter(Boolean);
		const separator = sourceLine.includes("•") ? " • " : " ";
		let current = "";

		for (const chunk of chunks) {
			const candidate = current ? `${current}${separator}${chunk}` : chunk;
			if (current && candidate.length > maxWidth) {
				lines.push(current);
				current = chunk;
			} else {
				current = candidate;
			}
		}

		lines.push(current);
	}

	return lines.length ? lines : [""];
}

export interface GenericModalProps {
	/** Modal title displayed in header */
	title: string;
	/** Optional title color override (default: theme primary) */
	titleColor?: string;
	/** Main content to render in the middle section */
	children: JSX.Element;
	/** Footer help entries (dashboard-style) */
	help?: readonly Keybind[];
	/** Footer help text: entries, or a string that wraps to the dialog width */
	helpText?: string | readonly Keybind[];
	/** Optional label above the content column */
	fieldLabel?: string;
	/** Optional summary table entries rendered beside the content */
	summary?: SummaryEntry[];
	/** Render only the summary table (no content column) */
	summaryOnly?: boolean;
	/** Width as percentage of screen (0-1), default 0.5 (50%) */
	widthPercent?: number;
	/** Height as percentage of screen (0-1), default 0.7 (70%) */
	heightPercent?: number;
	/** Exact height in terminal lines. Overrides heightPercent when provided. */
	heightLines?: number;
	/** Progress bar position (0-based); rendered when provided together with total */
	step?: number;
	/** Total steps for the progress bar */
	total?: number;
	/** Legacy single-query search mode (equivalent to searchMode + searchQuery) */
	search?: string;
	/** Search mode/query for the header SearchHeader */
	searchMode?: boolean;
	searchQuery?: string;
	searchResultCount?: number;
	/** Optional filter/sort summary for FilterStatusBar */
	filterSummary?: string;
	sortSummary?: string;
	/** Optional custom header content (replaces default title) */
	customHeader?: JSX.Element;
	/** Optional custom footer content (replaces default help text) */
	customFooter?: JSX.Element;
	/** Hide modal header when child panels provide their own headers. */
	hideHeader?: boolean;
	/** Portal z-order; provided when the modal must stack above other modals */
	zIndex?: number;
	/** Click handler for backdrop */
	onBackdropClick?: () => void;
	/** Dialog background alpha (0-1); feature wrappers pin their look */
	dialogAlpha?: number;
	/** Stop dialog clicks from bubbling to the backdrop close handler */
	stopDialogClick?: boolean;
}

/**
 * GenericModal - shared portaled modal framing for dashboard and devenv
 * surfaces. All modal layouts render the same shell: terminal-anchored
 * backdrop, centered dialog, header (title/search), optional progress bar,
 * optional filter/sort row, middle content, and footer help/custom footer.
 * Feature-specific content, footer, animation, and key handling stay in the
 * callers; this component only owns framing.
 */
export function GenericModal(props: GenericModalProps) {
	const dimensions = useTerminalDimensions();
	const width = () =>
		Math.floor(
			dimensions().width *
				(props.widthPercent ??
					(props.summaryOnly ? 0.6 : props.summary?.length ? 0.75 : 0.5)),
		);
	const height = () =>
		Math.min(
			dimensions().height,
			props.heightLines ??
				Math.floor(dimensions().height * (props.heightPercent ?? 0.7)),
		);
	const progressWidth = () => Math.max(1, width() - 4);
	/** Width the summary table may occupy beside the content column; shrinks
	 * on narrow terminals and becomes 0 (stacked below content) when the
	 * dialog is too small for a usable side-by-side layout. */
	const tableWidth = () => {
		const available =
			width() -
			4 /* dialog padding */ -
			SUMMARY_CONTENT_MIN_WIDTH -
			SUMMARY_TABLE_GUTTER;
		return available >= SUMMARY_TABLE_MIN_WIDTH
			? Math.min(SUMMARY_TABLE_WIDTH, available)
			: 0;
	};
	const stackSummary = () =>
		props.summary?.length ? tableWidth() === 0 : false;
	const [animatedProgress, setAnimatedProgress] = createSignal(0);
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	createEffect(() => {
		// The bar only renders when step is provided; skip the animation timer
		// entirely for every other modal open.
		if (props.step === undefined) return;
		const target =
			(progressWidth() * ((props.step ?? 0) + 1)) /
			Math.max(1, props.total ?? 1);
		const start = untrack(animatedProgress);
		const startedAt = Date.now();
		clearInterval(progressTimer);
		progressTimer = setInterval(() => {
			const elapsed = Math.min(1, (Date.now() - startedAt) / 320);
			const eased = 1 - (1 - elapsed) ** 3;
			setAnimatedProgress(start + (target - start) * eased);
			if (elapsed === 1) clearInterval(progressTimer);
		}, 16);
	});
	onCleanup(() => clearInterval(progressTimer));
	const progressEnd = () =>
		Math.min(progressWidth() - 1, Math.floor(animatedProgress()));
	const progressCharacter = (index: number) =>
		index < progressEnd() ? "━" : index === progressEnd() ? "▸" : "─";

	// Keybind-array help (dashboard-style): wrap entries so a long footer grows
	// by a row instead of clipping the entries past the first wrapped line.
	const helpEntries = (): readonly Keybind[] | undefined =>
		props.help ??
		(typeof props.helpText === "string" ? undefined : props.helpText);
	const helpEntryLines = (): Keybind[][] | undefined => {
		const entries = helpEntries();
		return entries
			? wrapHelpEntries(entries, Math.max(1, width() - 4))
			: undefined;
	};
	// Legacy string help: wrapped to the dialog width as before.
	const helpStringLines = (): string[] | undefined =>
		typeof props.helpText === "string"
			? wrapHelpText(props.helpText, Math.max(1, width() - 4))
			: undefined;
	const footerHelpLineCount = () =>
		helpEntryLines()?.length ?? helpStringLines()?.length ?? 1;
	const helpLines = () => helpStringLines() ?? [""];
	// Only an explicit searchMode (devenv live-search) shows the trailing
	// input cursor; the legacy dash `search` prop maps to the display-only
	// "/ <query>" header the removed dash SearchHeader rendered.
	const searchMode = () => props.searchMode ?? false;
	const searchQuery = () => props.searchQuery ?? props.search ?? "";
	const headerContent = () => (
		<SearchHeader
			searchMode={searchMode()}
			searchQuery={searchQuery()}
			resultCount={props.searchResultCount}
		>
			<box
				style={{
					width: "100%",
					justifyContent: "flex-start",
					flexDirection: "row",
				}}
			>
				<text
					fg={props.titleColor ?? uiColors.primary}
					attributes={TextAttributes.BOLD}
				>
					{props.title}
				</text>
			</box>
		</SearchHeader>
	);

	return (
		<Portal
			ref={(el) => {
				const portal = el as { position?: string; zIndex?: number };
				portal.position = "absolute";
				if (props.zIndex !== undefined) portal.zIndex = props.zIndex;
			}}
		>
			<box
				position="absolute"
				top={0}
				left={0}
				width={dimensions().width}
				height={dimensions().height}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
				backgroundColor={RGBA.fromValues(0, 0, 0, 0.35)}
				onMouseUp={() => props.onBackdropClick?.()}
			>
				<box
					backgroundColor={hexToRgba(uiColors.bgMantle, props.dialogAlpha ?? 1)}
					onMouseUp={(e) => {
						invokeGlobalSelectionMouseUpHandler();
						if (props.stopDialogClick) e.stopPropagation();
					}}
					width={width()}
					height={height()}
					flexDirection="column"
					paddingTop={1}
					paddingBottom={1}
					paddingLeft={2}
					paddingRight={2}
				>
					{!props.hideHeader &&
						(props.customHeader ? props.customHeader : headerContent())}
					{props.step !== undefined && (
						<box width="100%" height={1}>
							<text>
								<For
									each={Array.from(
										{ length: progressWidth() },
										(_, index) => index,
									)}
								>
									{(index) => (
										<span
											style={{
												fg:
													index <= progressEnd()
														? progressColor(
																index / Math.max(1, progressWidth() - 1),
															)
														: uiColors.textMuted,
											}}
										>
											{progressCharacter(index)}
										</span>
									)}
								</For>
							</text>
						</box>
					)}
					<FilterStatusBar
						filterSummary={props.filterSummary}
						sortSummary={props.sortSummary}
					/>
					<Show
						when={props.summaryOnly}
						fallback={
							<box
								width="100%"
								flexDirection="column"
								flexGrow={1}
								flexShrink={1}
								minHeight={0}
								overflow="hidden"
							>
								<box
									width="100%"
									flexDirection="row"
									flexGrow={1}
									flexShrink={1}
									minHeight={0}
									overflow="hidden"
								>
									<box
										flexDirection="column"
										flexGrow={1}
										flexShrink={1}
										minWidth={0}
										overflow="hidden"
									>
										<Show when={props.fieldLabel}>
											<box width="100%" height={1} flexShrink={0}>
												<text
													fg={uiColors.textPrimary}
													attributes={TextAttributes.BOLD}
												>
													{props.fieldLabel}
												</text>
											</box>
										</Show>
										<box
											style={{
												width: "100%",
												flexDirection: "column",
												flexGrow: 1,
												flexShrink: 1,
												minHeight: 0,
												overflow: "hidden",
											}}
										>
											{props.children}
										</box>
									</box>
									{props.summary?.length && !stackSummary() ? (
										<SummaryTable
											entries={props.summary}
											width={tableWidth()}
										/>
									) : null}
								</box>
								{stackSummary() ? (
									<box
										width="100%"
										flexShrink={0}
										flexDirection="column"
										overflow="hidden"
									>
										<SummaryTable entries={props.summary ?? []} full />
									</box>
								) : null}
							</box>
						}
					>
						<box width="100%" flexGrow={1} flexDirection="column">
							<SummaryTable entries={props.summary ?? []} full />
						</box>
					</Show>
					{props.customFooter ? (
						props.customFooter
					) : (
						<box
							style={{
								width: "100%",
								height: footerHelpLineCount(),
								justifyContent: "flex-start",
								flexDirection: "column",
								flexShrink: 0,
							}}
						>
							{helpEntryLines() ? (
								<For each={helpEntryLines() ?? []}>
									{(line) => <HelpText entries={line} />}
								</For>
							) : (
								<For each={helpLines()}>
									{(line) => (
										<text style={{ fg: uiColors.textSecondary }}>{line}</text>
									)}
								</For>
							)}
						</box>
					)}
				</box>
			</box>
		</Portal>
	);
}

export type { HelpEntry } from "./HelpText";
export type { Keybind } from "./keybinds";
