/** @jsxImportSource @opentui/solid */
// Shared theme picker — single source: src/tui/shared/ThemePicker.tsx. The
// environment shell keeps its live-search and `/` filter keybind contract.
import { ThemePicker } from "../../../../../src/tui/shared/ThemePicker";

export interface ThemePickerViewProps {
	selectedIndex: number;
	activeTheme: string;
	filterQuery?: string;
	filterActive?: boolean;
	themes?: string[];
}

export function ThemePickerView(props: ThemePickerViewProps) {
	return (
		<ThemePicker
			selected={props.selectedIndex}
			active={props.activeTheme}
			themes={props.themes}
			query={props.filterQuery}
			filtering={props.filterActive}
			searchMode="live"
		/>
	);
}

export type { ThemePickerProps } from "../../../../../src/tui/shared/ThemePicker";
