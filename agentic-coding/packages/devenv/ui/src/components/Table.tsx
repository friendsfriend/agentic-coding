/** @jsxImportSource @opentui/solid */

import type { TableRow } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../colors";
import {
	formatRuntimeStatus,
	getGitStatusStyle,
	getStatusStyle,
	runtimeState,
} from "../statusUtils";
import {
	statusAnimationIntentForOperation,
	statusAnimationIntentForText,
} from "./AnimatedStatusText";
import { CenteredState } from "./CenteredState";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText } from "./Highlight";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";
import { WorkItemCard } from "./WorkItemCard";

export interface TableColumn {
	key: string;
	header: string;
	width: number | string;
	render?: (app: TableRow) => string;
	renderParts?: (
		app: TableRow,
		isSelected: boolean,
	) => Array<{ text: string; color?: string }>;
	color?: (app: TableRow) => string; // Optional color function for styled rendering
}

export interface TableTab<T = string> {
	id: T;
	label: string;
	count?: number; // Optional count to display after label
}

export interface TableProps<T = string> {
	apps: TableRow[];
	columns: TableColumn[];
	selectedIndex: number;
	onSelect?: (index: number) => void;
	showBorder?: boolean; // Optional: show border around table (default true)

	// Optional tabs feature
	tabs?: TableTab<T>[];
	activeTab?: T;
	onTabChange?: (tabId: T) => void;
	getTabBorderColor?: (tabId: T) => string; // Function to get border color for each tab

	// Search
	searchMode?: boolean; // true while user is typing after /
	searchQuery?: string; // current query string (empty = no active search)

	/** Optional: total lines available for this component before its own chrome (border, tabs, header).
	 *  When provided, `reservedLines` is ignored and the list height is computed from this value
	 *  minus the Table's own chrome. */
	availableLines?: number;
	filterSummary?: string;
	sortSummary?: string;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

/**
 * Table component for displaying applications
 * Uses OpenTUI's flexbox layout system
 *
 * Features:
 * - Column-based table rendering with customizable widths
 * - Optional tabs with customizable border colors
 * - Optional outer border (showBorder prop)
 * - Keyboard navigation support
 * - / search: filters rows (no highlighting)
 */
export function appRunTargetRightMetadata(app: TableRow): string | undefined {
	return app.rowKind === "app" ? app.runTargetInfo?.display : undefined;
}

function WorkItemTable<T = string>(
	props: TableProps<T> & { emptyMessage?: string; runningLabel?: string },
) {
	const providerIcon = (app: TableRow) => {
		if (app.rowKind !== "app") return "";
		if (app.sourceType === "github") return "";
		if (app.sourceType === "gitlab") return "";
		return "?";
	};

	const activeTabLabel = () =>
		props.tabs?.find((tab) => tab.id === props.activeTab)?.label ??
		"Applications";

	const isRunning = (app: TableRow) =>
		runtimeState(app.runtimeStatus, app.status || app.dockerInfo?.Status) ===
		"running";

	const runningSummary = () =>
		props.runningLabel ??
		`${props.apps.filter(isRunning).length}/${props.apps.length} running`;

	const appKind = (app: TableRow) => {
		if (app.rowKind === "script")
			return app.nodeType === "folder" ? "Folder" : "Task";
		if (app.rowKind === "infra") return "Infra";
		return app.appType === "APP" ? "Application" : "Library";
	};

	const appMarker = (app: TableRow) => {
		if (app.rowKind === "script")
			return app.nodeType === "folder" ? (app.scriptExpanded ? "▾" : "▸") : "󱆃";
		if (app.rowKind === "infra") return "▣";
		return app.appType === "APP" ? "◆" : "◇";
	};

	const appStatus = (app: TableRow) => {
		if (app.operationStatus?.status && app.operationStatus.message) {
			return app.operationStatus.message;
		}
		if (app.rowKind === "script" && app.nodeType === "folder") return "folder";
		if (app.rowKind === "script")
			return app.scriptExecutable ? "executable task" : "task file";
		return formatRuntimeStatus(
			app.runtimeStatus,
			app.status || app.dockerInfo?.Status || "not found",
		);
	};

	const gitStatus = (app: TableRow) =>
		app.rowKind === "app" ? app.gitStatus?.trim() || "..." : "";

	const gitStatusText = (app: TableRow) => {
		const status = gitStatus(app);
		if (status === "✓") return "git clean";
		if (status === "x") return "git unavailable";
		if (status === "error") return "git error";
		if (status === "...") return "git unknown";
		return `git ${status}`;
	};

	const appStatusSuffix = (app: TableRow) => {
		if (app.rowKind === "script") {
			return app.interpreter ? ` • ${app.interpreter}` : "";
		}
		const details = [
			gitStatusText(app),
			app.rowKind === "app" && app.branch ? `branch ${app.branch}` : undefined,
		]
			.filter(Boolean)
			.join(" • ");
		return details ? ` • ${details}` : "";
	};

	const appStatusAnimation = (app: TableRow) => {
		const operation = app.operationStatus;
		if (
			operation &&
			(operation.status === "active" || operation.status === "pending")
		) {
			return statusAnimationIntentForOperation(operation.operation);
		}
		const status = (app.status || app.dockerInfo?.Status || "").toLowerCase();
		if (app.runtimeStatus && app.runtimeStatus.state === "starting")
			return "load";
		if (
			/starting|stopping|building|checking|pulling|pushing|cloning|pending|waiting|preparing/.test(
				status,
			)
		) {
			return statusAnimationIntentForText(status);
		}
		return undefined;
	};

	const appStatusHighlight = (app: TableRow) => {
		if (app.operationStatus?.status) {
			switch (app.operationStatus.status) {
				case "active":
					return undefined;
				case "completed":
					return "positive" as const;
				case "failed":
					return "negative" as const;
				case "pending":
					return undefined;
			}
		}
		const state = runtimeState(
			app.runtimeStatus,
			app.status || app.dockerInfo?.Status,
		);
		if (state === "running") return "positive" as const;
		if (state === "failed") return "negative" as const;
		if (state === "starting") return "warning" as const;
		return undefined;
	};

	const appStatusColor = (app: TableRow) => {
		if (app.operationStatus?.status) {
			switch (app.operationStatus.status) {
				case "active":
					return uiColors.primary;
				case "completed":
					return uiColors.success;
				case "failed":
					return uiColors.error;
				case "pending":
					return uiColors.warning;
				default:
					return uiColors.textPrimary;
			}
		}
		if (app.rowKind === "script") return uiColors.textSecondary;
		return getStatusStyle(
			app.runtimeStatus
				? app.runtimeStatus.state
				: app.status || app.dockerInfo?.Status || "not found",
		).color;
	};

	const appMetadata = (app: TableRow) => {
		if (app.rowKind === "script") {
			const params = app.scriptParameters?.length ?? 0;
			return `${app.scriptRelativePath}${app.nodeType === "script" && params ? ` • ${params} params` : ""}`;
		}
		if (app.rowKind === "infra") {
			const parts: Array<string | JSX.Element> = [app.containerBaseName ?? ""];
			if (app.dockerInfo?.Ports)
				parts.push(
					<HighlightedText text={app.dockerInfo.Ports} highlight="highlight" />,
				);
			if (parts.length === 1) return parts[0] as string;
			return (
				<box style={{ flexDirection: "row", gap: 1 }}>
					{parts.map((p) => (typeof p === "string" ? <text>{p}</text> : p))}
				</box>
			);
		}

		const isLinkedWorktree =
			app.activeWorktree && app.activeWorktree !== app.mainWorktreeBranch;
		const hasUnknownProvider =
			app.rowKind === "app" && providerIcon(app) === "?" && !app.provider;
		const parts: Array<string | JSX.Element> = [
			`${providerIcon(app)} ${app.provider || app.sourceType || "repo"}`,
		];
		if (isLinkedWorktree) parts.push(`worktree ${app.activeWorktree}`);
		if (app.dockerInfo?.Ports)
			parts.push(
				<HighlightedText text={app.dockerInfo.Ports} highlight="highlight" />,
			);
		if (parts.length === 1)
			return hasUnknownProvider ? (
				<HighlightedText text={parts[0] as string} highlight="negative" />
			) : (
				(parts[0] as string)
			);
		return (
			<box style={{ flexDirection: "row", gap: 1 }}>
				<HighlightedText
					text={parts[0] as string}
					highlight={hasUnknownProvider ? "negative" : "secondary"}
				/>
				{parts
					.slice(1)
					.map((p) => (typeof p === "string" ? <text>{p}</text> : p))}
			</box>
		);
	};

	/**
	 * Lines of fixed chrome outside the table body.
	 * Auto-computed from props so callers never need to pass a magic number:
	 *
	 *   Layout chrome                    = LAYOUT_CHROME_LINES (7)
	 *   Outer rounded border (if shown)  = 2
	 *   Tab bar (if tabs present)        = 3
	 *   Table column-header row          = 1
	 */
	// When caller provides an exact height budget (e.g. content-router knows
	// Layout chrome + compact action strip consumption), subtract Table's own chrome
	// and pass the remainder to ScrollableList via availableLines.
	const scrollableLines = (): number | undefined => {
		if (props.availableLines === undefined) return undefined;
		let lines = props.availableLines;
		if (props.showBorder !== false) lines -= 2;
		if (props.tabs && props.tabs.length > 0) lines -= 3;
		lines -= 1; // list header
		if (props.filterSummary || props.sortSummary) lines -= 1;
		return Math.max(1, lines);
	};

	// Legacy reserved-lines path (fallback when no availableLines is given).
	const reservedLines = () => {
		let lines = LAYOUT_CHROME_LINES + 1;
		if (props.showBorder !== false) lines += 2;
		if (props.tabs && props.tabs.length > 0) lines += 3;
		if (props.filterSummary || props.sortSummary) lines += 1;
		return lines;
	};

	const hasSearch = () => (props.searchQuery ?? "").length > 0;

	const tableContent = () => (
		<box
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "column",
			}}
		>
			{/* Optional Tabs */}
			<Show when={props.tabs && props.tabs.length > 0}>
				<box
					backgroundColor={uiColors.bgBase}
					style={{
						width: "100%",
						flexDirection: "row",
						gap: 1,
					}}
				>
					<For each={props.tabs}>
						{(tab) => {
							const isActive = () => props.activeTab === tab.id;
							return (
								<box
									backgroundColor={
										isActive() ? uiColors.bgSurface0 : uiColors.bgMantle
									}
									onMouseUp={() => props.onTabChange?.(tab.id)}
									style={{
										paddingLeft: 2,
										paddingRight: 2,
										height: 3,
										alignItems: "center",
										justifyContent: "center",
									}}
								>
									<text
										fg={isActive() ? uiColors.primary : uiColors.textMuted}
										attributes={isActive() ? TextAttributes.BOLD : undefined}
									>
										{tab.label}
										{tab.count !== undefined ? ` (${tab.count})` : ""}
									</text>
								</box>
							);
						}}
					</For>
				</box>
			</Show>

			{/* Header row — doubles as search input bar while searchMode is active */}
			<SearchHeader
				searchMode={props.searchMode}
				searchQuery={props.searchQuery}
				resultCount={props.apps.length}
			>
				<box style={{ width: "100%", flexDirection: "row" }}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{activeTabLabel()}
					</text>
					<box
						style={{
							width: "auto",
							marginLeft: "auto",
							flexDirection: "row",
							gap: 2,
						}}
					>
						<text fg={uiColors.success} attributes={TextAttributes.BOLD}>
							{runningSummary()}
						</text>
						<text fg={uiColors.textMuted}>{`${props.apps.length} loaded`}</text>
					</box>
				</box>
			</SearchHeader>

			<FilterStatusBar
				filterSummary={props.filterSummary}
				sortSummary={props.sortSummary}
			/>

			{/* Table Body — virtual scroll keeps selected row always visible */}
			<Show
				when={props.apps.length > 0}
				fallback={
					<CenteredState
						message={
							hasSearch()
								? "No results"
								: (props.emptyMessage ?? "No rows in this tab")
						}
						height="auto"
						style={{ flexGrow: 1 }}
					/>
				}
			>
				<ScrollableList<TableRow>
					items={props.apps}
					selectedIndex={props.selectedIndex}
					availableLines={scrollableLines()}
					reservedLines={
						props.availableLines === undefined ? reservedLines() : undefined
					}
					estimatedItemHeight={2}
					showScrollIndicator={false}
					renderItem={(app, isSelected, index) => {
						// Libraries are dev-dependencies — no container status,
						// but git status / branch info is still relevant.
						const isLib = app.rowKind === "app" && app.appType !== "APP";
						const hideIdleLibraryStatus = isLib && !app.operationStatus;
						return (
							<WorkItemCard
								marker={appMarker(app)}
								prefix={`[${appKind(app)}] `}
								prefixColor={uiColors.primary}
								title={app.displayName}
								titleQuery={props.searchQuery}
								statusText={hideIdleLibraryStatus ? "" : appStatus(app)}
								statusColor={appStatusColor(app)}
								statusBadgeHighlight={
									hideIdleLibraryStatus ? undefined : appStatusHighlight(app)
								}
								statusAnimationIntent={
									hideIdleLibraryStatus ? undefined : appStatusAnimation(app)
								}
								statusTransitionKey={`${app.rowKind}:${app.ident}:status`}
								statusSuffixText={appStatusSuffix(app)}
								statusSuffixColor={
									gitStatus(app) === "✓"
										? uiColors.textMuted
										: gitStatus(app) === "x" ||
												gitStatus(app) === "..." ||
												gitStatus(app) === "error"
											? uiColors.error
											: getGitStatusStyle(gitStatus(app)).color
								}
								metadata={appMetadata(app)}
								rightMetadata={appRunTargetRightMetadata(app)}
								rightMetadataColor={uiColors.highlight}
								selected={isSelected()}
								index={index}
								runningTextEnabled={props.runningTextEnabled}
								runningTextOffset={props.runningTextOffset}
								onMouseUp={() => props.onSelect?.(index)}
							/>
						);
					}}
				/>
			</Show>
		</box>
	);

	// If showBorder is false, render content directly without wrapper box
	return props.showBorder === false ? (
		tableContent()
	) : (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "column",
			}}
		>
			{tableContent()}
		</box>
	);
}
export function RepositoryTable<T = string>(props: TableProps<T>) {
	return (
		<WorkItemTable {...props} emptyMessage="No repositories in this tab" />
	);
}

export function InfrastructureTable<T = string>(props: TableProps<T>) {
	return <WorkItemTable {...props} emptyMessage="No infrastructure services" />;
}

export function TaskTable<T = string>(props: TableProps<T>) {
	return (
		<WorkItemTable
			{...props}
			emptyMessage="No tasks"
			runningLabel={`${props.apps.length} tasks`}
		/>
	);
}

/** Generic table component. Prefer RepositoryTable, InfrastructureTable, or TaskTable for domain-specific variants. */
export function Table<T = string>(props: TableProps<T>) {
	return <RepositoryTable {...props} />;
}
