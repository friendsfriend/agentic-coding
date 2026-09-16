import {
	type KeybindSection,
	PAGE_NAVIGATION_KEYBINDS,
} from "../../shared/keybinds";

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
			keybinds: [
				{ key: "Ctrl+P", action: "locations", short: "locations" },
				...PAGE_NAVIGATION_KEYBINDS,
			],
		},
		{
			title: "Actions",
			keybinds: [
				{ key: "?", action: "help" },
				{ key: "q", action: "quit", standard: true },
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
	const help = { key: "?", action: "help" };
	// One location picker, one structural parent (Escape) and the
	// chronological Back/Forward pair; destinations are pages now, so no
	// tab-order or number key belongs in the footer or the help.
	const locations = { key: "Ctrl+P", action: "locations", short: "locations" };
	const quit = { key: "q", action: "quit", standard: true };
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
							action: "close note / cancel comment",
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
					keybinds: [theme, locations, help, quit],
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
					keybinds: [theme, locations, help, quit],
				},
			];
		default:
			return [];
	}
}
