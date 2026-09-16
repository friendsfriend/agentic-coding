// Keybind catalogs for the page-based shell chrome
// (replace-nested-tabs-with-page-navigation, task 2.1). Declared once here and
// rendered by the shared footer/help contract; renderers own colors and
// separators, so no entry carries styling.
import {
	footerKeybinds,
	type Keybind,
	type KeybindSection,
	PAGE_NAVIGATION_KEYBINDS,
} from "../keybinds";

/** Home/category destinations list: pick a destination, no tab order. */
export function destinationPageKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [
				{ key: "j/k or ↑/↓", action: "select destination", standard: true },
				{ key: "Enter", action: "open destination", standard: true },
				...PAGE_NAVIGATION_KEYBINDS,
			],
		},
		{
			title: "Actions",
			keybinds: [
				{ key: "Ctrl+P", action: "locations", short: "locations" },
				{ key: "?", action: "help" },
				{ key: "T", action: "theme picker", short: "theme" },
				{ key: "q", action: "quit", standard: true },
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
		{ title: "Actions", keybinds: [{ key: "?", action: "help" }] },
	];
}

/**
 * The picker's modal footer: the shared projection (special keys only) of the
 * same catalog, so the dialog paints no key hint row of its own.
 */
export function locationPickerFooterKeybinds(): Keybind[] {
	return footerKeybinds(locationPickerKeybindCatalog());
}
