/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, Show } from "solid-js";
import type { CostMessage, CostRow } from "../data";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { ScrollableContent } from "./ScrollableContent";
import { SelectableList } from "./Selectable";

export type CostBreakdownRow = Omit<CostRow, "messages"> & {
	messages: CostMessage[];
};

export function CostModal(props: {
	rows: CostBreakdownRow[];
	selected: number;
	agent: string | null;
	offset: number;
}) {
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(40, Math.floor(dimensions().width * 0.7) - 8);
	let scrollbox: ScrollBoxRenderable | undefined;
	createEffect(() => scrollbox?.scrollTo(props.offset));
	const total = () => props.rows.reduce((sum, row) => sum + row.cost, 0);
	const selectedRow = () => props.rows[props.selected];
	return (
		<GenericModal
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
							{selectedRow()?.messages.map((message) => (
								<box height={1} flexDirection="row" width="100%">
									<text fg={uiColors.textMuted} width={18}>
										{message.at}
									</text>
									<text
										fg={uiColors.textSecondary}
										width={24}
									>{`in ${message.inputTokens} · out ${message.outputTokens}`}</text>
									<text
										fg={uiColors.textPrimary}
									>{`$${message.cost.toFixed(4)}`}</text>
								</box>
							))}
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
						selectedIndex={props.selected}
						renderItem={(row, selected) => (
							<box
								width="100%"
								height={1}
								flexDirection="row"
								paddingLeft={1}
								paddingRight={1}
							>
								<text
									fg={selected ? uiColors.primary : uiColors.textPrimary}
									width={22}
								>
									{row.role}
								</text>
								<text fg={uiColors.textSecondary} width={10}>
									{row.messages.length}
								</text>
								<text
									fg={uiColors.textSecondary}
									width={24}
								>{`${row.inputTokens}/${row.outputTokens}`}</text>
								<text
									fg={selected ? uiColors.primary : uiColors.textSecondary}
								>{`$${row.cost.toFixed(2)}`}</text>
							</box>
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
