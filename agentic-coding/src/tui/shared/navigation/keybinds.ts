// Keybind catalogs for the page-based shell chrome
// (replace-nested-tabs-with-page-navigation, task 2.1). Declared once here and
// rendered by the shared footer/help contract; renderers own colors and
// separators, so no entry carries styling.

import {
	footerKeybinds,
	hostDiagnosticsKeybind,
	hostKeybind,
	type Keybind,
	type KeybindSection,
	PAGE_NAVIGATION_KEYBINDS,
} from "@ui";

/** Home/category destinations list: pick a destination, no tab order. */
export function destinationPageKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [
				{ key: "j/k or ↑/↓", action: "select destination", standard: true },
				// The page's own action, so the footer advertises it: a list page whose
				// every key is "standard" looks like it has none left (the environment
				// category list was exactly that).
				{ key: "Enter", action: "open destination", short: "open" },
				...PAGE_NAVIGATION_KEYBINDS,
			],
		},
		{
			title: "Actions",
			keybinds: [
				hostKeybind("ctrl+p"),
				hostKeybind("?"),
				hostDiagnosticsKeybind(),
				{ key: "T", action: "theme picker", short: "theme" },
				hostKeybind("q"),
			],
		},
	];
}

/** Location picker: search and jump. */
export function locationPickerKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [
				{ key: "type", action: "search locations", standard: true },
				{ key: "↑/↓", action: "select location", standard: true },
				{ key: "Enter", action: "go to location", standard: true },
				{ key: "Esc", action: "close picker", standard: true },
			],
		},
		{ title: "Actions", keybinds: [hostKeybind("?")] },
	];
}

/**
 * The picker's modal footer: the shared projection (special keys only) of the
 * same catalog, so the dialog paints no key hint row of its own.
 */
export function locationPickerFooterKeybinds(): Keybind[] {
	return footerKeybinds(locationPickerKeybindCatalog());
}
