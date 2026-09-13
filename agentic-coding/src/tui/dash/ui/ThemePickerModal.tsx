/** @jsxImportSource @opentui/solid */
// Shared theme picker — single source: src/tui/shared/ThemePicker.tsx. The
// dashboard keeps its display-only `/ <query>` header (no live cursor).
import { ThemePicker } from "../../shared/ThemePicker";

export function ThemePickerModal(props: {
	selected: number;
	active: string;
	themes: string[];
	query: string;
	filtering: boolean;
}) {
	return (
		<ThemePicker
			selected={props.selected}
			active={props.active}
			themes={props.themes}
			query={props.query}
			filtering={props.filtering}
			searchMode="display"
			showFilterKeybind={false}
		/>
	);
}
