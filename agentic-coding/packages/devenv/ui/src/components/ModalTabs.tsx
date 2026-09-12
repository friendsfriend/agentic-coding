/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For, type JSX } from "solid-js";
import { uiColors } from "../colors";

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
					const label = () =>
						`${active() ? "●" : "○"} ${tab.label}${tab.badge !== undefined ? ` (${tab.badge})` : ""}`;
					return (
						<box
							style={{ flexDirection: "row", marginRight: 2 }}
							onMouseUp={() => props.onChange?.(tab.id)}
						>
							<text
								fg={active() ? uiColors.primary : uiColors.textMuted}
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
