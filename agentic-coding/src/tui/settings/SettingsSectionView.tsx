/** @jsxImportSource @opentui/solid */
// Settings section view (centralize-application-settings, task 2.2). One list
// per section: each row states the effective value and the source/scope/effect
// line, and a row that cannot be edited here is marked read-only instead of
// looking like an editable control. Selection is controlled by the shell so it
// lives in route-keyed view state and survives leaving and returning.
import { useTerminalDimensions } from "@opentui/solid";
import {
	Card,
	hostChromeLines,
	LAYOUT_CHROME_LINES,
	ScrollableList,
	uiColors,
} from "@ui";
import { Show } from "solid-js";
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
/** Card title: the setting, why it is not editable, and its effective value. */
function itemTitle(item: SettingsItem): string {
	const readonly = item.editable ? "" : " · read-only";
	const value = item.value ? ` — ${item.value}` : "";
	return `${item.label}${readonly}${value}`;
}

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
						<Card
							height={3}
							selected={isSelected()}
							title={itemTitle(item)}
							cells={[<text fg={uiColors.textMuted}>{item.detail}</text>]}
						/>
					)}
				/>
			</Show>
		</box>
	);
}
