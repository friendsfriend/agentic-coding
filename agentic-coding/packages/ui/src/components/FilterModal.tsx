/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For, type JSX } from "solid-js";
import { uiColors } from "../theme/colors";
import { GenericModal } from "./GenericModal.tsx";
import { useHover } from "./mouse/useHover.ts";
import { useKeyDispatch } from "./mouse/useKeybindChips.ts";
import { useRowMouse } from "./mouse/useRowMouse.ts";

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
	/** Pointer: a tap selects a parameter row (the keyboard's `j`/`k`). */
	onSelectParameter?: (index: number) => void;
	/** Pointer: a tap selects a value row; a tap on the selected row applies it. */
	onSelectValue?: (index: number) => void;
	/**
	 * The stroke a tap on the selected row runs. Default `"Enter"` (the value pane
	 * applies); the environment surface applies with `Space`, where `Enter` closes
	 * the dialog, so it passes its own key.
	 */
	activateKey?: string;
}

/**
 * One filter row: a tap selects it, and a tap on the selected row runs the
 * dialog's own `Enter` (apply the filter / move to the value pane) through the
 * keymap, so the row activates exactly what the key activates. `activatable`
 * names the pane's own gate — a row whose pane has no selection callback stays
 * select-only instead of borrowing the other pane's behaviour.
 */
function FilterRow(props: {
	index: number;
	selectedIndex: number;
	activatable: boolean;
	activateKey: string;
	backgroundColor?: string;
	style?: Record<string, unknown>;
	onSelect?: (index: number) => void;
	children: JSX.Element;
}) {
	const dispatch = useKeyDispatch();
	const mouse = useRowMouse({
		index: () => props.index,
		selectedIndex: () => props.selectedIndex,
		activatable: () => props.activatable && props.onSelect !== undefined,
		onSelect: (index) => props.onSelect?.(index),
		onActivate: (index) => {
			props.onSelect?.(index);
			dispatch(props.activateKey);
		},
	});
	const hover = useHover(mouse.onMouseOut);
	const interactive = () => props.onSelect !== undefined;
	return (
		<box
			{...mouse}
			{...hover}
			backgroundColor={
				props.backgroundColor ??
				(interactive() && hover.hovered() ? uiColors.bgHover : undefined)
			}
			style={props.style}
		>
			{props.children}
		</box>
	);
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
								<FilterRow
									index={index()}
									selectedIndex={props.selectedParameterIndex}
									activatable={props.onSelectParameter !== undefined}
									activateKey={props.activateKey ?? "Enter"}
									backgroundColor={
										selected() ? selectionBg("parameter") : undefined
									}
									style={{ height: 1, paddingLeft: 1 }}
									{...(props.onSelectParameter
										? { onSelect: props.onSelectParameter }
										: {})}
								>
									<text
										fg={selected() ? uiColors.primary : uiColors.textSecondary}
									>
										{parameter.label}
										{count() ? ` (${count()})` : ""}
									</text>
								</FilterRow>
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
								<FilterRow
									index={index()}
									selectedIndex={props.selectedValueIndex}
									activatable={props.onSelectValue !== undefined}
									activateKey={props.activateKey ?? "Enter"}
									backgroundColor={
										selected() ? selectionBg("value") : undefined
									}
									{...(props.onSelectValue
										? { onSelect: props.onSelectValue }
										: {})}
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
								</FilterRow>
							);
						}}
					</For>
				</box>
			</box>
		</GenericModal>
	);
}
