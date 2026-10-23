/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "../theme/colors";
import { GenericModal } from "./GenericModal.tsx";
import { useHover } from "./mouse/useHover.ts";
import { useKeyDispatch } from "./mouse/useKeybindChips.ts";
import { useRowMouse } from "./mouse/useRowMouse.ts";

export type SortDirection = "asc" | "desc" | "none";

export interface SortParameterOption {
	key: string;
	label: string;
	direction: SortDirection;
}

export interface SortModalProps {
	parameters: SortParameterOption[];
	selectedIndex: number;
	/** Direction labels; the env surface shows arrows only, the observability
	 * shell spells the mode out (`↑ ASC`). */
	directionLabels?: { asc: string; desc: string; none: string };
	/** Skip the direction marker entirely for parameters that ignore it. */
	hideDirection?: (parameter: SortParameterOption) => boolean;
	/** Pointer: a tap selects a row; a tap on the selected row applies it. */
	onSelectRow?: (index: number) => void;
	/** The stroke a tap on the selected row runs. Default `"Enter"`. */
	activateKey?: string;
}

/** The shared tap rule for one sort row: select, then activate the selected. */
function sortRowMouse(
	props: SortModalProps,
	index: () => number,
	selectedIndex: () => number,
) {
	const dispatch = useKeyDispatch();
	const mouse = useRowMouse({
		// The row can move under a stable instance: resolve it per event.
		index,
		selectedIndex,
		activatable: () => props.onSelectRow !== undefined,
		onSelect: (row) => props.onSelectRow?.(row),
		onActivate: (row) => {
			props.onSelectRow?.(row);
			dispatch(props.activateKey ?? "Enter");
		},
	});
	return { mouse, hover: useHover(mouse.onMouseOut) };
}

export function SortModal(props: SortModalProps) {
	const labels = () =>
		props.directionLabels ?? { asc: "↑", desc: "↓", none: "—" };
	const directionLabel = (direction: SortDirection) => {
		if (direction === "asc") return labels().asc;
		if (direction === "desc") return labels().desc;
		return labels().none;
	};

	const directionColor = (direction: SortDirection) => {
		if (direction === "none") return uiColors.textMuted;
		return uiColors.primary;
	};

	return (
		<GenericModal
			title="Order / Sort"
			helpText={[
				{ key: "j/k", action: "Select" },
				{ key: "Space", action: "Mode" },
				{ key: "K/J", action: "Priority" },
				{ key: "x", action: "Clear all" },
				{ key: "Enter", action: "Apply" },
				{ key: "Esc", action: "Close" },
			]}
			widthPercent={0.6}
			heightPercent={0.55}
		>
			<box style={{ width: "100%", flexDirection: "column" }}>
				<box
					style={{
						height: 1,
						flexDirection: "row",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					<box style={{ width: 5 }}>
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							Prio
						</text>
					</box>
					<box style={{ width: "60%" }}>
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							Parameter
						</text>
					</box>
					<box style={{ width: "auto", marginLeft: "auto" }}>
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							Mode
						</text>
					</box>
				</box>
				<For each={props.parameters}>
					{(parameter, index) => {
						const selected = () => index() === props.selectedIndex;
						const interactive = () => props.onSelectRow !== undefined;
						const pointer = sortRowMouse(
							props,
							index,
							() => props.selectedIndex,
						);
						return (
							<box
								{...pointer.mouse}
								{...pointer.hover}
								backgroundColor={
									selected()
										? uiColors.bgSurface2
										: interactive() && pointer.hover.hovered()
											? uiColors.bgHover
											: undefined
								}
								style={{
									height: 1,
									flexDirection: "row",
									paddingLeft: 1,
									paddingRight: 1,
								}}
							>
								<box style={{ width: 5 }}>
									<text
										fg={
											interactive() && pointer.hover.hovered()
												? uiColors.textSecondary
												: uiColors.textMuted
										}
									>
										{index() + 1}
									</text>
								</box>
								<box style={{ width: "60%" }}>
									<text
										fg={
											selected() || (interactive() && pointer.hover.hovered())
												? uiColors.textPrimary
												: uiColors.textSecondary
										}
									>
										{parameter.label}
									</text>
								</box>
								<box style={{ width: "auto", marginLeft: "auto" }}>
									<text
										fg={directionColor(parameter.direction)}
										attributes={
											parameter.direction === "none"
												? undefined
												: TextAttributes.BOLD
										}
									>
										{directionLabel(parameter.direction)}
									</text>
								</box>
							</box>
						);
					}}
				</For>
			</box>
		</GenericModal>
	);
}
