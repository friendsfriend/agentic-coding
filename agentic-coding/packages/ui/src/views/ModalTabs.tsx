/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For, type JSX } from "solid-js";
import { useHover } from "../components/mouse/useHover.ts";
import { useTap } from "../components/mouse/useTap.ts";
import { uiColors } from "../theme/colors";

export interface ModalTabItem {
	id: string;
	label: string;
	badge?: string | number;
}

export interface ModalTabsProps {
	tabs: ModalTabItem[];
	activeId: string;
	onChange?: (id: string) => void;
}

export function ModalTabs(props: ModalTabsProps): JSX.Element {
	return (
		<box style={{ width: "100%", flexDirection: "row", flexShrink: 0 }}>
			<For each={props.tabs}>
				{(tab) => {
					const active = () => tab.id === props.activeId;
					const interactive = () => props.onChange !== undefined;
					const tap = useTap(() => props.onChange?.(tab.id));
					const hover = useHover(tap.onMouseOut);
					const label = () =>
						`${active() ? "●" : "○"} ${tab.label}${tab.badge !== undefined ? ` (${tab.badge})` : ""}`;
					return (
						<box
							{...tap}
							{...hover}
							backgroundColor={
								interactive() && hover.hovered() ? uiColors.bgHover : undefined
							}
							style={{ flexDirection: "row", marginRight: 2 }}
						>
							<text
								fg={
									active()
										? uiColors.primary
										: interactive() && hover.hovered()
											? uiColors.textPrimary
											: uiColors.textMuted
								}
								attributes={active() ? TextAttributes.BOLD : undefined}
							>
								{label()}
							</text>
						</box>
					);
				}}
			</For>
		</box>
	);
}
