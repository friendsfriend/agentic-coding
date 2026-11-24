import type { EnvironmentView } from "./model.ts";

export type Keybind = {
	readonly key: string;
	readonly action: string;
	readonly short?: string;
	readonly standard?: boolean;
};

const HELP: Keybind = { key: "?", action: "help", short: "help" };

const SEARCH: readonly Keybind[] = [
	{ key: "Enter", action: "focus the filtered list", short: "list" },
	{ key: "↑/↓", action: "move filtered results", standard: true },
	{ key: "Esc", action: "clear filter", short: "clear" },
];

const TABLE: readonly Keybind[] = [
	{ key: "↑/↓", action: "move selection", standard: true },
	{ key: "j/k", action: "move selection", standard: true },
	{ key: "Enter", action: "open application", short: "open" },
	{ key: "/", action: "filter", short: "filter" },
	{ key: "Tab", action: "next tab", short: "next" },
	{ key: "1–5", action: "switch tab", standard: true },
	{ key: "r", action: "refresh", short: "refresh" },
	{ key: "Esc", action: "close environments", short: "close" },
	HELP,
];

const DETAIL: readonly Keybind[] = [
	{ key: "b", action: "build", short: "build" },
	{ key: "s", action: "start / run", short: "run" },
	{ key: "t", action: "test", short: "test" },
	{ key: "S", action: "stop owned resources", short: "stop" },
	{ key: "c", action: "changes", short: "changes" },
	{ key: "l", action: "logs", short: "logs" },
	{ key: "L", action: "history", short: "history" },
	{ key: "e", action: "telemetry", short: "telemetry" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const TARGETS: readonly Keybind[] = [
	{ key: "↑/↓", action: "move target", standard: true },
	{ key: "j/k", action: "move target", standard: true },
	{ key: "Enter", action: "execute target", short: "execute" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const HISTORY: readonly Keybind[] = [
	{ key: "↑/↓", action: "move receipt", standard: true },
	{ key: "j/k", action: "move receipt", standard: true },
	{ key: "Enter", action: "open receipt", short: "open" },
	{ key: "r", action: "refresh history", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
	HELP,
];

const OPERATION: readonly Keybind[] = [
	{ key: "Tab", action: "switch operation tab", short: "tabs" },
	{
		key: "Shift+Tab",
		action: "switch operation tab backwards",
		standard: true,
	},
	{ key: "1–3", action: "select operation tab", standard: true },
	{ key: "↑/↓", action: "move build step", standard: true },
	{ key: "j/k", action: "move build step", standard: true },
	{ key: "r", action: "refresh operation", short: "refresh" },
	{ key: "Esc", action: "back", short: "back" },
	HELP,
];

const LOGS: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll logs", standard: true },
	{ key: "r", action: "reload logs", short: "reload" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const TELEMETRY: readonly Keybind[] = [
	{ key: "↑/↓", action: "move trace", standard: true },
	{ key: "j/k", action: "move trace", standard: true },
	{ key: "Enter", action: "open trace", short: "open" },
	{ key: "Esc", action: "back to application", short: "back" },
	HELP,
];

const CHANGES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move change", standard: true },
	{ key: "j/k", action: "move change", standard: true },
	{ key: "Enter", action: "open diff", short: "diff" },
	{ key: "r", action: "refresh changes", short: "refresh" },
	{ key: "Esc", action: "back to application", short: "back" },
];

const DIFF: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll diff", standard: true },
	{ key: "r", action: "reload diff", short: "reload" },
	{ key: "Esc", action: "back to changes", short: "back" },
];

const SERVICES: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll services", standard: true },
	{ key: "r", action: "refresh services", short: "refresh" },
	{ key: "Esc", action: "back to applications", short: "back" },
];

export function viewKeybinds(view: EnvironmentView): readonly Keybind[] {
	switch (view) {
		case "table":
			return TABLE;
		case "detail":
			return DETAIL;
		case "targets":
			return TARGETS;
		case "history":
			return HISTORY;
		case "operation":
			return OPERATION;
		case "logs":
			return LOGS;
		case "telemetry":
			return TELEMETRY;
		case "changes":
			return CHANGES;
		case "diff":
			return DIFF;
		case "services":
			return SERVICES;
	}
}

export function footerKeybinds(
	view: EnvironmentView,
	searchFocused = false,
): readonly Keybind[] {
	if (view === "table" && searchFocused)
		return SEARCH.filter((entry) => !entry.standard);
	return viewKeybinds(view).filter((entry) => !entry.standard);
}

export type HelpSection = {
	readonly title: string;
	readonly entries: readonly Keybind[];
};

export const HELP_SECTIONS: readonly HelpSection[] = [
	{ title: "Browse", entries: TABLE },
	{
		title: "Filter",
		entries: [
			{ key: "Enter", action: "focus the filtered list", short: "list" },
			{ key: "↑/↓", action: "move filtered results", standard: true },
			{ key: "Esc", action: "clear filter", short: "clear" },
		],
	},
	{ title: "Application detail", entries: DETAIL },
	{ title: "Execute and observe", entries: [...TARGETS, ...OPERATION] },
	{
		title: "Receipts and evidence",
		entries: [...HISTORY, ...LOGS, ...TELEMETRY],
	},
	{
		title: "Open from anywhere",
		entries: [
			{ key: "/environment", action: "open environments" },
			{ key: "<leader>v", action: "open environments" },
		],
	},
];
