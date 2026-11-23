import type { EnvironmentUiView } from "../../src/ui/controller.ts";

/**
 * Footer/help catalog, copied in shape from agentic-coding's shared keybind
 * contract: entries are plain data, renderers own color and spacing, `standard`
 * navigation stays out of the footer, and the `?` help modal lists everything.
 */
export type Keybind = {
	readonly key: string;
	readonly action: string;
	readonly short?: string;
	readonly standard?: boolean;
};

const HELP: Keybind = { key: "?", action: "help", short: "help" };

const LIST: readonly Keybind[] = [
	{ key: "↑/↓", action: "move selection", standard: true },
	{ key: "j/k", action: "move selection", standard: true },
	{ key: "Enter", action: "open capability", short: "open" },
	{ key: "/", action: "filter capabilities", short: "filter" },
	{ key: "r", action: "refresh capabilities", short: "refresh" },
	{ key: "Esc", action: "close environment", short: "close" },
	HELP,
];

const SEARCH: readonly Keybind[] = [
	{ key: "Enter", action: "open capability", short: "open" },
	{ key: "Esc", action: "clear filter", short: "clear" },
];

const FORM: readonly Keybind[] = [
	{ key: "Tab", action: "next field", standard: true },
	{ key: "Shift+Tab", action: "previous field", standard: true },
	{
		key: "Enter",
		action: "run (last field or no inputs)",
		standard: true,
	},
	{ key: "Ctrl+Enter", action: "run capability", short: "run" },
	{ key: "Esc", action: "back to capabilities", short: "back" },
];

const RUNNING: readonly Keybind[] = [
	{ key: "Esc", action: "cancel request", short: "cancel" },
	HELP,
];

const TRACES: readonly Keybind[] = [
	{ key: "↑/↓", action: "move trace", standard: true },
	{ key: "j/k", action: "move trace", standard: true },
	{ key: "Enter", action: "open trace", short: "open" },
	{ key: "Esc", action: "back to capabilities", short: "back" },
	HELP,
];

const RESULT: readonly Keybind[] = [
	{ key: "↑/↓", action: "scroll result", standard: true },
	{ key: "Esc", action: "back to capabilities", short: "back" },
	HELP,
];

const ERROR: readonly Keybind[] = [
	{ key: "r", action: "retry", short: "retry" },
	{ key: "Esc", action: "back to capabilities", short: "back" },
	HELP,
];

const LOADING: readonly Keybind[] = [
	{ key: "Esc", action: "close environment", short: "close" },
	HELP,
];

export function viewKeybinds(view: EnvironmentUiView): readonly Keybind[] {
	switch (view) {
		case "form":
			return FORM;
		case "running":
			return RUNNING;
		case "traces":
			return TRACES;
		case "result":
			return RESULT;
		case "error":
			return ERROR;
		case "loading":
			return LOADING;
		case "list":
			return LIST;
	}
}

/** The footer advertises special keys only; standard navigation lives in `?`.
 * A focused filter owns the keyboard, so its footer is the two keys it accepts. */
export function footerKeybinds(
	view: EnvironmentUiView,
	searchFocused = false,
): readonly Keybind[] {
	if (view === "list" && searchFocused) return SEARCH;
	return viewKeybinds(view).filter((entry) => !entry.standard);
}

export type HelpSection = {
	readonly title: string;
	readonly entries: readonly Keybind[];
};

export const HELP_SECTIONS: readonly HelpSection[] = [
	{ title: "Browse", entries: LIST },
	{ title: "Form", entries: FORM },
	{ title: "Telemetry", entries: TRACES },
	{
		title: "Result and errors",
		entries: [
			{ key: "↑/↓", action: "scroll result", standard: true },
			{ key: "r", action: "retry", short: "retry" },
			{ key: "Esc", action: "back to capabilities", short: "back" },
			HELP,
		],
	},
	{
		title: "Open from anywhere",
		entries: [
			{ key: "/environment", action: "open environment" },
			{ key: "<leader>v", action: "open environment" },
		],
	},
];
