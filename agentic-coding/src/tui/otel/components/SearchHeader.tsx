/** @jsxImportSource @opentui/solid */
// Shell header preset: the framework `SearchHeader` with the observability
// surface's policy of collapsing the row when it has nothing to show.
import {
	type SearchHeaderProps,
	SearchHeader as SharedSearchHeader,
} from "@ui";

export type { SearchHeaderProps };

export function SearchHeader(props: SearchHeaderProps) {
	return <SharedSearchHeader collapseWhenEmpty {...props} />;
}
