// Shell route ↔ environment destination mapping
// (replace-nested-tabs-with-page-navigation, task 2.2).
//
// The page shell owns the route; the environment store owns the data and the
// per-tab state. These are the pure translations between a route's destination
// and the store's `activeTab`/`viewMode`, so the two authorities cannot grow
// separate tables of their own.
import type { TabType, ViewMode } from "./stores/index.ts";

/** View modes that live under the change-request detail page. */
const CHANGE_REQUEST_CHILD_VIEWS: Readonly<Record<string, string>> = {
	changedFiles: "changeRequestDetail.changedFiles",
	discussionsView: "changeRequestDetail.discussionsView",
	testResults: "changeRequestDetail.testResults",
	jobs: "changeRequestDetail.jobs",
	changeRequestLinkedIssues: "changeRequestDetail.changeRequestLinkedIssues",
};

/** Route view path for a store view mode ("" = the category's table). */
export function viewPathForMode(mode: string): string {
	if (mode === "table") return "";
	return CHANGE_REQUEST_CHILD_VIEWS[mode] ?? mode;
}

/**
 * Store view mode for a route view path. A nested path resolves to its last
 * segment, because the store's stack holds one mode per entry.
 */
export function viewModeForPath(path: string | undefined): ViewMode {
	if (!path) return "table";
	const last = path.slice(path.lastIndexOf(".") + 1);
	return last as ViewMode;
}

/** Category requested by the route, only when the store actually has that tab. */
export function requestedCategory(
	category: string | undefined,
	tabs: readonly string[],
): TabType | undefined {
	if (!category) return undefined;
	return tabs.includes(category) ? (category as TabType) : undefined;
}
