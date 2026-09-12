/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";

export type SortDirection = "asc" | "desc" | "none";

export interface SortParameterOption {
	key: string;
	label: string;
	direction: SortDirection;
}

export interface SortModalProps {
	parameters: SortParameterOption[];
	selectedIndex: number;
}

export function SortModal(props: SortModalProps) {
	const directionLabel = (direction: SortDirection) => {
		if (direction === "asc") return "↑";
		if (direction === "desc") return "↓";
		return "—";
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
						return (
							<box
								backgroundColor={selected() ? uiColors.bgSurface2 : undefined}
								style={{
									height: 1,
									flexDirection: "row",
									paddingLeft: 1,
									paddingRight: 1,
								}}
							>
								<box style={{ width: 5 }}>
									<text fg={uiColors.textMuted}>{index() + 1}</text>
								</box>
								<box style={{ width: "60%" }}>
									<text
										fg={
											selected() ? uiColors.textPrimary : uiColors.textSecondary
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
