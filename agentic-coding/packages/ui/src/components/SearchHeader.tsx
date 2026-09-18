/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { colors, uiColors } from "../theme/colors";

/** A plain value or a getter, so surfaces that keep their state in accessors
 * (observability) and surfaces that pass values (shell, devenv) share one
 * header. */
type Value<T> = T | (() => T);
const read = <T,>(value: Value<T> | undefined, fallback: T): T =>
	typeof value === "function" ? (value as () => T)() : (value ?? fallback);

export interface SearchHeaderProps {
	/** Render no row at all when there is neither a query nor children. The
	 * shell's headers use this; a surface that reserves the row keeps the
	 * default. */
	collapseWhenEmpty?: boolean;
	searchMode?: Value<boolean>;
	searchQuery?: Value<string>;
	resultCount?: Value<number>;
	backgroundColor?: string;
	active?: boolean;
	children?: JSX.Element;
}

export function SearchHeader(props: SearchHeaderProps) {
	const query = () => read(props.searchQuery, "");
	const searching = () => read(props.searchMode, false);
	const count = () => read(props.resultCount, 0);
	const hasSearch = () => query().length > 0;
	const collapse = () =>
		props.collapseWhenEmpty === true &&
		!searching() &&
		!hasSearch() &&
		!props.children;
	const searchContent = () => (
		<box flexDirection="row">
			{[
				<text fg={colors.peach}>/</text>,
				<text fg={uiColors.textPrimary}>{query()}</text>,
				searching() ? <text fg={uiColors.primary}>█</text> : null,
				!searching() && hasSearch() && props.resultCount !== undefined ? (
					<text fg={uiColors.textMuted}> ({count()} results)</text>
				) : null,
			].filter(Boolean)}
		</box>
	);

	return (
		<box
			backgroundColor={props.backgroundColor ?? uiColors.bgSurface1}
			style={{
				width: "100%",
				height: collapse() ? 0 : 1,
				flexDirection: "row",
				paddingLeft: 1,
				paddingRight: 1,
				flexShrink: 0,
			}}
		>
			{searching() || hasSearch() ? searchContent() : props.children}
		</box>
	);
}
