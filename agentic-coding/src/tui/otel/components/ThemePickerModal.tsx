/** @jsxImportSource @opentui/solid */
// Shared theme picker — single source: src/tui/shared/ThemePicker.tsx. The
// observability shell keeps its display-only `/ <query>` header and accessor
// props.
import { ThemePicker } from "../../shared/ThemePicker";

export function ThemePickerModal(props: {
	selected: () => number;
	active: () => string;
	themes: () => string[];
	query: () => string;
	filtering: () => boolean;
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
