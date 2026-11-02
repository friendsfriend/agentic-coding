/** @jsxImportSource @opentui/solid */

import {
	createKeyedItems,
	GenericModal,
	ScrollableContent,
	SelectableList,
	uiColors,
	useKeyDispatch,
	useModalBackdrop,
	useTerminalDimensions,
} from "@agentic-coding/ui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, For, Show } from "solid-js";
import type { CostMessage, CostRow } from "../../../contracts/workflow";

export type CostBreakdownRow = Omit<CostRow, "messages"> & {
	messages: CostMessage[];
};

function CostOverviewRow(props: { row: CostBreakdownRow; selected: boolean }) {
	return (
		<box width="100%" height={1} flexDirection="row" paddingRight={1}>
			<text
				fg={props.selected ? uiColors.primary : uiColors.textPrimary}
				width={22}
			>
				{props.row.role}
			</text>
			<text fg={uiColors.textSecondary} width={10}>
				{props.row.messages.length}
			</text>
			<text
				fg={uiColors.textSecondary}
				width={24}
			>{`${props.row.inputTokens}/${props.row.outputTokens}`}</text>
			<text
				fg={props.selected ? uiColors.primary : uiColors.textSecondary}
			>{`$${props.row.cost.toFixed(2)}`}</text>
		</box>
	);
}

export function CostModal(props: {
	rows: CostBreakdownRow[];
	selected: number;
	agent: string | null;
	offset: number;
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`). */
	onSelectIndex?: (index: number) => void;
}) {
	const dispatch = useKeyDispatch();
	const backdrop = useModalBackdrop({ kind: "cost" });
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(40, Math.floor(dimensions().width * 0.7) - 8);
	let scrollbox: ScrollBoxRenderable | undefined;
	createEffect(() => scrollbox?.scrollTo(props.offset));
	const total = () => props.rows.reduce((sum, row) => sum + row.cost, 0);
	const selectedRow = createMemo(() =>
		props.agent
			? props.rows.find((row) => row.role === props.agent)
			: props.rows[props.selected],
	);
	const messages = createKeyedItems(
		() => selectedRow()?.messages ?? [],
		(message) => JSON.stringify([selectedRow()?.role, message.at]),
	);
	return (
		<GenericModal
			{...backdrop}
			title={
				props.agent
					? `Cost breakdown · ${props.agent}`
					: "Cost breakdown · all agents"
			}
			widthPercent={0.72}
			heightPercent={0.78}
			help={
				props.agent
					? [
							{ key: "j/k", action: "Scroll" },
							{ key: "Esc", action: "Back" },
						]
					: [
							{ key: "j/k", action: "Navigate" },
							{ key: "Enter", action: "Message detail" },
							{ key: "Esc", action: "Close" },
						]
			}
		>
			<Show
				when={!props.agent}
				fallback={
					<ScrollableContent
						onScrollBoxReady={(box) => {
							scrollbox = box;
						}}
					>
						<box flexDirection="column" width={contentWidth()}>
							<For each={messages()}>
								{(slot) => (
									<box height={1} flexDirection="row" width="100%">
										<text fg={uiColors.textMuted} width={18}>
											{slot.value().at}
										</text>
										<text
											fg={uiColors.textSecondary}
											width={24}
										>{`in ${slot.value().inputTokens} · out ${slot.value().outputTokens}`}</text>
										<text
											fg={uiColors.textPrimary}
										>{`$${slot.value().cost.toFixed(4)}`}</text>
									</box>
								)}
							</For>
						</box>
					</ScrollableContent>
				}
			>
				<box flexDirection="column" width="100%">
					<box
						height={1}
						flexDirection="row"
						width="100%"
						paddingLeft={1}
						paddingRight={1}
					>
						<text fg={uiColors.textMuted} width={22}>
							Agent
						</text>
						<text fg={uiColors.textMuted} width={10}>
							Msgs
						</text>
						<text fg={uiColors.textMuted} width={24}>
							Tokens (in/out)
						</text>
						<text fg={uiColors.textMuted}>Cost</text>
					</box>
					<SelectableList
						items={props.rows}
						itemKey={(row) => row.role}
						selectedIndex={props.selected}
						{...(props.onSelectIndex ? { onSelect: props.onSelectIndex } : {})}
						{...(props.onSelectIndex
							? { onActivate: () => dispatch("Enter") }
							: {})}
						renderItem={(row, selected) => (
							<CostOverviewRow row={row} selected={selected} />
						)}
						renderReactiveItem={(row, selected) => (
							<CostOverviewRow row={row()} selected={selected()} />
						)}
					/>
					<box
						height={1}
						flexDirection="row"
						width="100%"
						paddingLeft={1}
						paddingRight={1}
					>
						<box flexGrow={1} />
						<text
							fg={uiColors.textPrimary}
						>{`Total $${total().toFixed(2)}`}</text>
					</box>
				</box>
			</Show>
		</GenericModal>
	);
}
