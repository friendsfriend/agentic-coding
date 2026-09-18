/** @jsxImportSource @opentui/solid */
// Settings section view (centralize-application-settings, task 2.2). One list
// per section: each row states the effective value and the source/scope/effect
// line, and a row that cannot be edited here is marked read-only instead of
// looking like an editable control. Selection is controlled by the shell so it
// lives in route-keyed view state and survives leaving and returning.
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { uiColors } from "../shared/colors";
import { hostChromeLines } from "../shared/hostChrome";
import { LAYOUT_CHROME_LINES, ScrollableList } from "../shared/ScrollableList";
import { Selectable } from "../shared/Selectable";
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
	// A windowed list, not a scroll box: the shell's chrome already says where the
	// page is, so the section only needs to know how many rows it may paint. The
	// scroll box in the shared selection list re-clamps its own offset whenever a
	// layout pass sees the list before it has been measured, which snaps a long
	// section back to the top under the cursor.
	const dimensions = useTerminalDimensions();
	const availableLines = () =>
		Math.max(1, dimensions().height - hostChromeLines(LAYOUT_CHROME_LINES) - 1);

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
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
				<ScrollableList
					items={props.items}
					selectedIndex={props.selectedIndex}
					availableLines={availableLines()}
					estimatedItemHeight={3}
					showScrollIndicator={false}
					renderItem={(item, isSelected) => (
						<Selectable height={3} selected={isSelected()}>
							<box style={{ flexDirection: "column", height: 3 }}>
								<box style={{ flexDirection: "row" }}>
									<text
										fg={isSelected() ? uiColors.primary : uiColors.textPrimary}
										attributes={isSelected() ? TextAttributes.BOLD : undefined}
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
						</Selectable>
					)}
				/>
			</Show>
		</box>
	);
}
