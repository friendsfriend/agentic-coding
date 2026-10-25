import {
	hostDiagnosticsKeybind,
	type KeybindSection,
	PAGE_NAVIGATION_KEYBINDS,
} from "@ui";
import { hostKeybind } from "../../../../packages/devenv/cli/src/tui/keyboard/host-keys.ts";

/** The page body's panel section: the dedicated Ctrl+S toggle and the
 * Ctrl+A agent-panel toggle and Ctrl+H/Ctrl+L workspace cycle, all host keys so
 * every surface (including feature views that claim h/l) reaches them. */
export function workspaceSidebarPanelSection(): KeybindSection {
	return {
		title: "Panels",
		keybinds: [
			hostKeybind("ctrl+s"),
			hostKeybind("ctrl+a"),
			hostKeybind("ctrl+h"),
			hostKeybind("ctrl+l"),
		],
	};
}

/**
 * Footer/help catalog for an embedded terminal agent page. The agent owns
 * every key except the panel host keys the shell keeps while the terminal
 * has focus: Ctrl+S leaves for the workspace sidebar; Ctrl+H/Ctrl+L cycle
 * workspaces. Ctrl+A stays with the terminal's editable input.
 * A `helpKey` is advertised only when the agent itself handles that
 * key; the shell does not claim `?`, `q`, Escape or Ctrl+T on the content page.
 */
export function terminalAgentKeybindCatalog(
	name: string,
	helpKey?: string,
): KeybindSection[] {
	return [
		{
			title: name,
			keybinds: [
				{
					key: "Ctrl+S",
					action: "toggle focus to the workspace sidebar",
					short: "sidebar",
				},
				{
					key: "Ctrl+H",
					action: "previous workspace",
					short: "prev",
					standard: true,
				},
				{
					key: "Ctrl+L",
					action: "next workspace",
					short: "next",
					standard: true,
				},
				...(helpKey
					? [
							{
								key: helpKey,
								action: `${name} help`,
								short: "help",
							},
						]
					: []),
			],
		},
	];
}

/** Footer/help catalog for the embedded OpenCode page. */
export function opencodeKeybindCatalog(): KeybindSection[] {
	return terminalAgentKeybindCatalog("OpenCode", "?");
}

/** Footer/help catalog for the embedded Pi page. Pi has no `?` help key; its
 * hotkeys are the `/hotkeys` command inside the client. */
export function piKeybindCatalog(): KeybindSection[] {
	return terminalAgentKeybindCatalog("Pi");
}

/**
 * Workspace sidebar keys (integrated-multiplexer sidebar), published while the
 * sidebar panel holds focus: the rows, the panel actions, the workspace cycle
 * (host keys, so they also work from the page body) and the dedicated Ctrl+S
 * toggle back to the page body.
 */
export function agentSidebarKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Agents",
			keybinds: [
				{
					key: "j/k or ↑/↓",
					action: "select agent run",
					standard: true,
				},
				{
					key: "Enter",
					action: "open selected run / durable agent session",
					short: "open",
				},
				{ key: "f", action: "switch Active/All filter", short: "filter" },
				{ key: "e", action: "toggle sidebar size", short: "size" },
				{ key: "Esc", action: "focus the main content", standard: true },
				hostKeybind("ctrl+a"),
			],
		},
	];
}

export function workspaceSidebarKeybindCatalog(
	options: { embeddedPage?: boolean } = {},
): KeybindSection[] {
	const keybinds = [
		{
			key: "j/k or ↑/↓",
			action: "select the Orchestrator, OpenCode, Pi, or a workflow",
			standard: true,
		},
		{ key: "Enter", action: "open the selected entry", short: "open" },
		{
			key: "f",
			action: "cycle filter (active/attention/all)",
			short: "filter",
		},
		{
			key: "n",
			action: "open this workflow's dashboard in a new tmux window",
			short: "tmux",
		},
		{
			key: "d",
			action: "delete workflow (store rows and worktree, keeping the branch)",
			short: "delete",
		},
		{
			key: "e",
			action: "toggle sidebar (expanding/permanent)",
			short: "expand",
		},
		{ key: "+", action: "start a new workflow", short: "new" },
		hostKeybind("ctrl+h"),
		hostKeybind("ctrl+l"),
		hostKeybind("ctrl+s"),
		hostKeybind("ctrl+a"),
		hostKeybind("ctrl+p"),
		hostKeybind("?"),
		hostDiagnosticsKeybind(),
		hostKeybind("q"),
		...(!options.embeddedPage ? [hostKeybind("ctrl+t")] : []),
		{
			key: "Esc",
			action: "focus the main content",
			standard: true,
		},
	];
	return [
		{
			title: "Workspaces",
			keybinds,
		},
	];
}

/** Traces-local view: list, span tree or span detail. */
export type View = "selection" | "detail" | "span";

export type OtelTab =
	| "environments"
	| "workflow"
	| "wiki"
	| "traces"
	| "metrics"
	| "logs"
	| "topology";

/**
 * Footer/help catalog for the imported Environments feature. Its feature-local
 * navigation is registered by the embedded devenv keymap layers; this catalog
 * keeps the shell footer informative until those registrations are projected
 * through the shared contract (compose-unified-feature-shell task 3.6).
 */
export function environmentsKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [hostKeybind("ctrl+p"), ...PAGE_NAVIGATION_KEYBINDS],
		},
		{
			title: "Actions",
			keybinds: [
				hostKeybind("ctrl+h"),
				hostKeybind("ctrl+l"),
				hostKeybind("ctrl+s"),
				hostKeybind("ctrl+a"),
				hostKeybind("ctrl+t"),
				hostKeybind("?"),
				hostDiagnosticsKeybind(),
				hostKeybind("q"),
			],
		},
	];
}

/**
 * Keybind catalog for the observability shell tabs. Standard navigation keys
 * are marked so the footer advertises only special actions; the `?` help modal
 * renders the whole catalog.
 */
export function observabilityKeybindCatalog(options: {
	tab: OtelTab;
	view: View;
}): KeybindSection[] {
	const theme = { key: "T", action: "theme picker", short: "theme" };
	const help = hostKeybind("?");
	// One location picker, one structural parent (Escape) and the
	// chronological Back/Forward pair; destinations are pages now, so no
	// tab-order or number key belongs in the footer or the help.
	const locations = hostKeybind("ctrl+p");
	const quit = hostKeybind("q");
	const windowKeybind = hostKeybind("ctrl+t");
	if (options.tab === "traces") {
		const navigation =
			options.view === "selection"
				? [
						{ key: "j/k or ↑/↓", action: "select trace", standard: true },
						{ key: "Enter", action: "open trace", standard: true },
						// The list is paged: one page of newest-first traces is read at a
						// time, so older traces need an explicit page step.
						{
							key: "[ / ]",
							action: "older or newer trace page",
							short: "page",
						},
					]
				: options.view === "detail"
					? [
							{ key: "j/k or ↑/↓", action: "select span", standard: true },
							{ key: "h/l", action: "collapse or expand", standard: true },
							{ key: "g/G", action: "first or last span", standard: true },
							{ key: "Enter", action: "span details", standard: true },
							...PAGE_NAVIGATION_KEYBINDS,
						]
					: [...PAGE_NAVIGATION_KEYBINDS];
		// `/`, `F`, `O` and `w` are handled before the view branch, so
		// they stay live in the detail and span views too.
		return [
			{ title: "Navigation", keybinds: navigation },
			{
				title: "Actions",
				keybinds: [
					{ key: "/", action: "search" },
					{ key: "F", action: "filter" },
					{ key: "O", action: "sort" },
					{ key: "w", action: "all workspaces", short: "workspaces" },
					theme,
					windowKeybind,
					locations,
					help,
					quit,
				],
			},
		];
	}
	switch (options.tab) {
		case "wiki":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select", standard: true },
						{ key: "Enter", action: "open or expand", standard: true },
						{
							key: "Esc",
							action: "cancel comment, close note, then parent page",
							standard: true,
						},
					],
				},
				{
					// Only live while a note is open; scoped so the footer does not
					// advertise no-ops in the tree state (the `?` help still lists them).
					title: "Note actions",
					keybinds: [
						{ key: "c", action: "comment", context: "note" },
						{
							key: "F",
							action: "show frontmatter",
							short: "frontmatter",
							context: "note",
						},
						{
							key: "v",
							action: "visual line selection",
							short: "visual",
							context: "note",
						},
						{
							key: "n/N",
							action: "next/previous note",
							short: "note",
							context: "note",
						},
					],
				},
				{
					title: "Actions",
					keybinds: [
						{
							key: "w",
							action: "new independent research workflow",
							short: "new workflow",
						},
						{ key: "f", action: "finish review", short: "finish" },
						{ key: "r", action: "refresh" },
						windowKeybind,
						locations,
						help,
						quit,
					],
				},
			];
		case "metrics":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select metric", standard: true },
						{ key: "Enter", action: "detail", standard: true },
						...PAGE_NAVIGATION_KEYBINDS,
					],
				},
				{
					title: "Actions",
					keybinds: [theme, windowKeybind, locations, help, quit],
				},
			];
		case "logs":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select log", standard: true },
						{ key: "Enter", action: "detail", standard: true },
						...PAGE_NAVIGATION_KEYBINDS,
					],
				},
				{
					title: "Actions",
					keybinds: [
						{ key: "/", action: "search" },
						theme,
						windowKeybind,
						locations,
						help,
						quit,
					],
				},
			];
		case "topology":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select service", standard: true },
						{ key: "Enter", action: "detail", standard: true },
						...PAGE_NAVIGATION_KEYBINDS,
					],
				},
				{
					title: "Actions",
					keybinds: [theme, windowKeybind, locations, help, quit],
				},
			];
		default:
			return [];
	}
}
