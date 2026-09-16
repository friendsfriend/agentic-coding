/** @jsxImportSource @opentui/solid */
// Settings section view (centralize-application-settings, task 2.2). One list
// per section: each row states the effective value and the source/scope/effect
// line, and a row that cannot be edited here is marked read-only instead of
// looking like an editable control. Selection is controlled by the shell so it
// lives in route-keyed view state and survives leaving and returning.
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../shared/colors";
import { SelectableList } from "../shared/Selectable";
import type { SettingsItem } from "./items";

export interface SettingsSectionViewProps {
	items: SettingsItem[];
	selectedIndex: number;
	onSelectIndex: (index: number) => void;
}

/**
 * One Settings section's list. The section name lives in the shell chrome (the
 * breadcrumb and the destination row that opened it), so the page renders no
 * title, description or spacer row of its own.
 */
export function SettingsSectionView(props: SettingsSectionViewProps) {
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<Show
				when={props.items.length > 0}
				fallback={
					<box style={{ flexGrow: 1, justifyContent: "center" }}>
						<text fg={uiColors.textMuted}>
							No settings in this section on this surface
						</text>
					</box>
				}
			>
				<SelectableList
					items={props.items}
					selectedIndex={props.selectedIndex}
					onSelect={props.onSelectIndex}
					itemHeight={3}
					focusable={false}
					renderItem={(item, selected) => (
						<box
							style={{
								flexDirection: "column",
								paddingLeft: 2,
								paddingRight: 2,
								height: 3,
							}}
						>
							<box style={{ flexDirection: "row" }}>
								<text
									fg={selected ? uiColors.primary : uiColors.textPrimary}
									attributes={selected ? TextAttributes.BOLD : undefined}
								>
									{item.label}
								</text>
								<Show when={!item.editable}>
									<text fg={uiColors.textMuted}> · read-only</text>
								</Show>
								<Show when={item.value}>
									<text fg={uiColors.textSecondary}> — {item.value}</text>
								</Show>
							</box>
							<text fg={uiColors.textMuted}>{item.detail}</text>
						</box>
					)}
				/>
			</Show>
		</box>
	);
}
