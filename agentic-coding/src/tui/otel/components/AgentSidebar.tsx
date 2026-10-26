/** @jsxImportSource @opentui/solid */
// Persistent navigation for the workflow-backed agent runs. Selection and
// navigation identities are owned by the shell; this component owns only its
// responsive presentation and independent scroll window.

import {
	Panel,
	type RowGestureState,
	Selectable,
	uiColors,
	useHover,
	useTap,
	useTerminalDimensions,
	useWheelScroll,
} from "@agentic-coding/ui";
import { TextAttributes } from "@opentui/core";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import type {
	AgentSidebarMode,
	AgentSidebarRow,
} from "../app/agent-sidebar-model.ts";
import {
	AGENT_SIDEBAR_COLLAPSED_WIDTH,
	AGENT_SIDEBAR_WIDTH,
	clampAgentListOffset,
} from "../app/agent-sidebar-model.ts";
import { clip } from "../app/sidebar-model.ts";

const COLLAPSED_ROW_WIDTH = 4;
const EXPANDED_THRESHOLD = 14;
const ROW_HEIGHT = 3;
const PANEL_CHROME_LINES = 9;

function status(row: AgentSidebarRow): {
	readonly glyph: string;
	readonly tone: string;
} {
	switch (row.status) {
		case "pending":
			return { glyph: "…", tone: uiColors.info };
		case "working":
			return { glyph: "●", tone: uiColors.info };
		case "completed":
			return { glyph: "✓", tone: uiColors.success };
		case "blocked":
			return { glyph: "!", tone: uiColors.warning };
		case "failed":
			return { glyph: "×", tone: uiColors.error };
		case "expired":
			return { glyph: "·", tone: uiColors.textMuted };
	}
}

export interface AgentSidebarProps {
	readonly active: boolean;
	readonly mode: AgentSidebarMode;
	readonly widthLimit: number;
	readonly rows: readonly AgentSidebarRow[];
	readonly selectedIndex: number;
	readonly sourceState: "loading" | "fresh" | "stale";
	onToggleMode: () => void;
	onSelectIndex: (index: number) => void;
	onOpen: (row: AgentSidebarRow) => void;
	onFocus: () => void;
}

export function AgentSidebar(props: AgentSidebarProps) {
	const dimensions = useTerminalDimensions();
	const expandedByMode = () => props.mode === "permanent" || props.active;
	const width = () =>
		expandedByMode()
			? Math.min(AGENT_SIDEBAR_WIDTH, Math.max(0, props.widthLimit))
			: Math.min(AGENT_SIDEBAR_COLLAPSED_WIDTH, Math.max(0, props.widthLimit));
	const expanded = () => expandedByMode() && width() >= EXPANDED_THRESHOLD;
	const visibleLines = () =>
		Math.max(ROW_HEIGHT, dimensions().height - PANEL_CHROME_LINES);
	const visibleCount = () =>
		Math.max(1, Math.floor(visibleLines() / ROW_HEIGHT));
	// Kept local rather than in the shell: scrolling is not selection.
	const [offset, setOffset] = createSignal(0);
	const gesture: RowGestureState = {};
	const listRows = () => props.rows.slice(offset(), offset() + visibleCount());
	const toggleGlyph = () => (props.mode === "permanent" ? "»" : "«");
	const toggleTap = useTap(
		() => {
			props.onFocus();
			props.onToggleMode();
		},
		{ stopPropagation: true },
	);
	const toggleHover = useHover(toggleTap.onMouseOut);

	createEffect(() => {
		const count = props.rows.length;
		const shown = visibleCount();
		const selected = props.selectedIndex;
		if (selected < 0 || selected >= count) {
			setOffset((current) => clampAgentListOffset(current, count, shown));
			return;
		}
		const current = untrack(offset);
		if (selected < current)
			setOffset(clampAgentListOffset(selected, count, shown));
		else if (selected >= current + shown)
			setOffset(clampAgentListOffset(selected - shown + 1, count, shown));
		else setOffset(clampAgentListOffset(current, count, shown));
	});

	const wheel = useWheelScroll({
		enabled: () => props.rows.length > visibleCount(),
		onScroll: (direction, delta) => {
			const step = direction === "up" ? -delta : delta;
			setOffset((current) =>
				clampAgentListOffset(current + step, props.rows.length, visibleCount()),
			);
		},
	});
	const select = (index: number): void => {
		props.onFocus();
		props.onSelectIndex(index);
	};
	const activate = (index: number): void => {
		const row = props.rows[index];
		if (!row) return;
		select(index);
		props.onOpen(row);
	};
	const sourceMessage = (): string => {
		if (props.sourceState === "loading") return "Reading agents…";
		if (props.sourceState === "stale") return "Workflow source unavailable";
		return "";
	};
	const compactSourceMark = (): string =>
		props.sourceState === "loading"
			? "Load…"
			: props.sourceState === "stale"
				? "Stale"
				: "";
	const textWidth = () => Math.max(0, width() - 5);

	return (
		<box
			width={width()}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
			style={{ flexDirection: "column", minHeight: 0, overflow: "hidden" }}
			{...useTap(() => props.onFocus())}
		>
			<Show
				when={expanded()}
				fallback={
					<>
						<box
							height={1}
							flexShrink={0}
							paddingLeft={1}
							flexDirection="row"
							backgroundColor={
								toggleHover.hovered() ? uiColors.bgHover : undefined
							}
							{...toggleTap}
							{...toggleHover}
						>
							<text fg={uiColors.textMuted}>{toggleGlyph()}</text>
						</box>
						<Show when={compactSourceMark()}>
							<box height={1} flexShrink={0} paddingLeft={1}>
								<text
									fg={
										props.sourceState === "stale"
											? uiColors.warning
											: uiColors.textMuted
									}
								>
									{compactSourceMark()}
								</text>
							</box>
						</Show>
						<box {...wheel} flexGrow={1} minHeight={0} overflow="hidden">
							<For each={listRows()}>
								{(row, localIndex) => {
									const index = () => offset() + localIndex();
									const selected = () => props.selectedIndex === index();
									const mark = status(row);
									return (
										<Selectable
											gesture={gesture}
											height={ROW_HEIGHT}
											selected={selected()}
											onMouseUp={() => select(index())}
											onActivate={() => activate(index())}
										>
											<box
												style={{ height: ROW_HEIGHT, flexDirection: "column" }}
											>
												<text
													fg={
														selected()
															? uiColors.textPrimary
															: uiColors.textSecondary
													}
												>
													{clip(String(index() + 1), COLLAPSED_ROW_WIDTH)}
												</text>
												<text fg={mark.tone}>{mark.glyph}</text>
												<text fg={uiColors.textMuted}>{clip(row.role, 3)}</text>
											</box>
										</Selectable>
									);
								}}
							</For>
						</box>
					</>
				}
			>
				<Panel
					title="Agents"
					active={props.active}
					style={{ flexGrow: 1, minHeight: 0 }}
					accessory={
						<box style={{ flexDirection: "row", gap: 1 }}>
							<Show when={props.sourceState === "stale"}>
								<text fg={uiColors.warning}>stale</text>
							</Show>
							<text
								fg={
									toggleHover.hovered()
										? uiColors.textPrimary
										: uiColors.textMuted
								}
								bg={toggleHover.hovered() ? uiColors.bgHover : undefined}
								{...toggleTap}
								{...toggleHover}
							>
								{toggleGlyph()}
							</text>
						</box>
					}
				>
					<Show
						when={props.rows.length > 0}
						fallback={
							<Show when={sourceMessage()}>
								<box flexGrow={1} minHeight={0} paddingTop={1}>
									<text
										fg={
											props.sourceState === "stale"
												? uiColors.warning
												: uiColors.textMuted
										}
									>
										{sourceMessage()}
									</text>
								</box>
							</Show>
						}
					>
						<box
							{...wheel}
							flexGrow={1}
							minHeight={0}
							overflow="hidden"
							flexDirection="column"
						>
							<For each={listRows()}>
								{(row, localIndex) => {
									const index = () => offset() + localIndex();
									const selected = () => props.selectedIndex === index();
									const mark = status(row);
									return (
										<Selectable
											gesture={gesture}
											height={ROW_HEIGHT}
											selected={selected()}
											onMouseUp={() => select(index())}
											onActivate={() => activate(index())}
										>
											<box
												height={ROW_HEIGHT}
												minWidth={0}
												flexDirection="column"
												overflow="hidden"
											>
												<box
													height={1}
													minWidth={0}
													flexDirection="row"
													overflow="hidden"
												>
													<text fg={mark.tone} attributes={TextAttributes.BOLD}>
														{mark.glyph}
													</text>
													<text
														fg={
															selected()
																? uiColors.textPrimary
																: uiColors.textSecondary
														}
														attributes={TextAttributes.BOLD}
													>
														{` ${clip(row.role, Math.max(0, textWidth() - 2))}`}
													</text>
												</box>
												<text fg={uiColors.textMuted}>
													{clip(
														`${row.workflowId}${row.workflowStep ? ` · ${row.workflowStep}` : ""}`,
														textWidth(),
													)}
												</text>
												<text fg={uiColors.textMuted}>
													{clip(
														[row.status, row.runtime, row.model]
															.filter(Boolean)
															.join(" · "),
														textWidth(),
													)}
												</text>
											</box>
										</Selectable>
									);
								}}
							</For>
						</box>
					</Show>
				</Panel>
			</Show>
		</box>
	);
}
