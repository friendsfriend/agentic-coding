/** @jsxImportSource @opentui/solid */
// Theme picker overlay — one implementation for every surface. The picker itself
// is `ThemePicker`; this binds it to a surface's selection/query accessors.
import { ThemePicker } from "./ThemePicker";

/** A plain value or a getter, so surfaces that keep state in accessors and
 * surfaces that pass values share one picker. */
type Value<T> = T | (() => T);

export interface ThemePickerModalProps {
	selected: Value<number>;
	active: Value<string>;
	themes: Value<string[]>;
	query: Value<string>;
	filtering: Value<boolean>;
	onSelect?: (index: number) => void;
	onQueryChange?: (query: string) => void;
}

const asReadable = <T,>(value: Value<T>, fallback: T): (() => T) => {
	const read = () =>
		(typeof value === "function" ? (value as () => T)() : value) ?? fallback;
	return read;
};

export function ThemePickerModal(props: ThemePickerModalProps) {
	return (
		<ThemePicker
			selected={asReadable(props.selected, 0)}
			active={asReadable(props.active, "")}
			themes={asReadable(props.themes, [])}
			query={asReadable(props.query, "")}
			filtering={asReadable(props.filtering, false)}
			{...(props.onSelect ? { onSelect: props.onSelect } : {})}
			{...(props.onQueryChange ? { onQueryChange: props.onQueryChange } : {})}
			searchMode="display"
			showFilterKeybind={false}
		/>
	);
}
