import type { KeybindSection } from "../../shared/keybinds";
import type { View } from "./navigation";

export type OtelTab =
	| "workflow"
	| "wiki"
	| "traces"
	| "metrics"
	| "logs"
	| "topology";

/**
 * Keybind catalog for the observability shell tabs. Standard navigation keys
 * are marked so the footer advertises only special actions; the `?` help modal
 * renders the whole catalog.
 */
export function observabilityKeybindCatalog(options: {
	tab: OtelTab;
	view: View;
	tabCount: number;
}): KeybindSection[] {
	const theme = { key: "Shift+T", action: "theme picker" };
	const help = { key: "?", action: "help" };
	const tabs = {
		key: `1-${options.tabCount}`,
		action: "tabs",
		standard: true,
	};
	const quit = { key: "q", action: "quit", standard: true };
	if (options.tab === "traces") {
		const navigation =
			options.view === "selection"
				? [
						{ key: "j/k or ↑/↓", action: "select trace", standard: true },
						{ key: "Enter", action: "open trace", standard: true },
					]
				: options.view === "detail"
					? [
							{ key: "j/k or ↑/↓", action: "select span", standard: true },
							{ key: "h/l", action: "collapse or expand", standard: true },
							{ key: "g/G", action: "first or last span", standard: true },
							{ key: "Enter", action: "span details", standard: true },
							{ key: "Esc/b", action: "back to traces", standard: true },
						]
					: [{ key: "Esc/b", action: "back to span tree", standard: true }];
		// `/`, Shift+F, Shift+O and `w` are handled before the view branch, so
		// they stay live in the detail and span views too.
		return [
			{ title: "Navigation", keybinds: navigation },
			{
				title: "Actions",
				keybinds: [
					{ key: "/", action: "search" },
					{ key: "Shift+F", action: "filter" },
					{ key: "Shift+O", action: "sort" },
					{ key: "w", action: "all workspaces" },
					theme,
					help,
					tabs,
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
						{ key: "v", action: "visual line selection", context: "note" },
						{ key: "n/N", action: "next/previous note", context: "note" },
					],
				},
				{
					title: "Actions",
					keybinds: [
						{ key: "f", action: "finish review" },
						{ key: "r", action: "refresh" },
						help,
						tabs,
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
						{ key: "Esc", action: "back", standard: true },
					],
				},
				{ title: "Actions", keybinds: [theme, help, tabs, quit] },
			];
		case "logs":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select log", standard: true },
						{ key: "Enter", action: "detail", standard: true },
						{ key: "Esc", action: "back", standard: true },
					],
				},
				{
					title: "Actions",
					keybinds: [{ key: "/", action: "search" }, theme, help, tabs, quit],
				},
			];
		case "topology":
			return [
				{
					title: "Navigation",
					keybinds: [
						{ key: "j/k or ↑/↓", action: "select service", standard: true },
						{ key: "Enter", action: "detail", standard: true },
						{ key: "Esc", action: "back", standard: true },
					],
				},
				{ title: "Actions", keybinds: [theme, help, tabs, quit] },
			];
		default:
			return [];
	}
}
