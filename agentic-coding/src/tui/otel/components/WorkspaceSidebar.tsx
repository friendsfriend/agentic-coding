/** @jsxImportSource @opentui/solid */
// Workspace sidebar (integrated-multiplexer sidebar).
//
// The shell's left/right panel listing durable workflows. It is a pure
// presentation surface: rows come from `WorkflowOverview` observations, the
// shell owns the selected index, the filter and the route navigation, and
// clicks report back through the same callbacks the key layer uses.
import { Panel, SelectableList, uiColors, useTerminalDimensions } from "@ui";
import { For, Show } from "solid-js";
import type { WorkflowOverview } from "../../../contracts/workflow.ts";
import {
	clip,
	filterLabel,
	SIDEBAR_FILTERS,
	type SidebarFilter,
	type StatusTone,
	statusGlyph,
	workflowDisplayName,
	workflowMeta,
} from "../app/sidebar-model.ts";

/** Fixed sidebar width: wide enough for a clipped workflow id plus its phase,
 * narrow enough to leave the main content usable on an 80-column terminal. */
export const SIDEBAR_WIDTH = 34;

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
	/** Panel focus: the accent strip follows the shell panel model. */
	active: boolean;
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
	return (
		<box
			width={SIDEBAR_WIDTH}
			flexShrink={0}
			style={{ flexDirection: "column", minHeight: 0 }}
			onMouseUp={() => props.onFocus()}
		>
			{/* One fixed-height panel chrome for every shell page: title, filter
			    row, then the windowed workflow list. */}
			<Panel
				title="Workspaces"
				active={props.active}
				style={{ flexGrow: 1, minHeight: 0 }}
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
							const status = statusGlyph(overview.state.status);
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
		</box>
	);
}
