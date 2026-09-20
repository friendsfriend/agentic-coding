/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "../theme/colors";
import { GenericModal } from "./GenericModal.tsx";

export interface FilterValueOption {
	value: string;
	label: string;
	count?: number;
}

export interface FilterParameterOption {
	key: string;
	label: string;
	values: FilterValueOption[];
}

/**
 * Which value the `●`/`○` marker follows:
 * - `"active"` (default, env surface): the value currently applied to the list.
 *   The cursor is a background band.
 * - `"cursor"` (observability shell): the row under the cursor, whose value is
 *   only applied on Enter.
 */
export type FilterModalMark = "active" | "cursor";

export interface FilterModalProps {
	parameters: FilterParameterOption[];
	selectedParameterIndex: number;
	selectedValueIndex: number;
	focusedPane: "parameter" | "value";
	activeFilters: Record<string, string[]>;
	/** Default `"active"`. */
	mark?: FilterModalMark;
	/** Heading of the parameter column. Default `"Parameter"`. */
	parameterHeading?: string;
	/** Heading of the value column when no parameter is selected. Default `"Values"`. */
	valueHeading?: string;
}

export function FilterModal(props: FilterModalProps) {
	const selectedParameter = () =>
		props.parameters[props.selectedParameterIndex];
	const mark = () => props.mark ?? "active";
	const isValueActive = (param: string, value: string) =>
		(props.activeFilters[param] ?? []).includes(value);
	/** Whether the marker sits on this value row. */
	const isMarked = (param: string, value: string, index: number) =>
		mark() === "cursor"
			? index === props.selectedValueIndex
			: isValueActive(param, value);
	const selectionBg = (pane: "parameter" | "value") =>
		props.focusedPane === pane ? uiColors.bgSurface2 : uiColors.bgMantle;

	return (
		<GenericModal
			title="Filter"
			helpText={[
				{ key: "h/l", action: "Focus" },
				{ key: "j/k", action: "Move" },
				{ key: "Space", action: "Toggle" },
				{ key: "x", action: "Clear all" },
				{ key: "Enter", action: "Apply" },
				{ key: "Esc", action: "Close" },
			]}
			widthPercent={0.7}
			heightPercent={0.65}
		>
			<box
				style={{ width: "100%", height: "100%", flexDirection: "row", gap: 2 }}
			>
				<box style={{ width: "35%", flexDirection: "column" }}>
					<text
						fg={
							props.focusedPane === "parameter"
								? uiColors.primary
								: uiColors.textPrimary
						}
						attributes={TextAttributes.BOLD}
					>
						{props.parameterHeading ?? "Parameter"}
					</text>
					<For each={props.parameters}>
						{(parameter, index) => {
							const selected = () => index() === props.selectedParameterIndex;
							const count = () =>
								props.activeFilters[parameter.key]?.length ?? 0;
							return (
								<box
									backgroundColor={
										selected() ? selectionBg("parameter") : undefined
									}
									style={{ height: 1, paddingLeft: 1 }}
								>
									<text
										fg={selected() ? uiColors.primary : uiColors.textSecondary}
									>
										{parameter.label}
										{count() ? ` (${count()})` : ""}
									</text>
								</box>
							);
						}}
					</For>
				</box>

				<box style={{ width: "65%", flexDirection: "column" }}>
					<text
						fg={
							props.focusedPane === "value"
								? uiColors.primary
								: uiColors.textPrimary
						}
						attributes={TextAttributes.BOLD}
					>
						{selectedParameter()?.label ?? props.valueHeading ?? "Values"}
					</text>
					<For each={selectedParameter()?.values ?? []}>
						{(option, index) => {
							const selected = () => index() === props.selectedValueIndex;
							const active = () =>
								isMarked(selectedParameter()?.key ?? "", option.value, index());
							return (
								<box
									backgroundColor={
										selected() ? selectionBg("value") : undefined
									}
									style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}
								>
									<text fg={active() ? uiColors.success : uiColors.textMuted}>
										{active() ? "● " : "○ "}
									</text>
									<text
										fg={
											selected() ? uiColors.textPrimary : uiColors.textSecondary
										}
									>
										{option.label}
									</text>
									<box style={{ width: "auto", marginLeft: "auto" }}>
										<text fg={uiColors.textMuted}>
											{option.count !== undefined ? String(option.count) : ""}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</box>
			</box>
		</GenericModal>
	);
}
