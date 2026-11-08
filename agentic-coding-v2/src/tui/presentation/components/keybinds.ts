import { createSignal } from "solid-js";

/**
 * Semantic keybind contract shared by every TUI footer and help surface.
 *
 * A keybind is data only: renderers own colors, separators, and layout, so an
 * entry can never smuggle in styling. The optional flags classify an entry
 * without coupling it to a particular footer:
 *
 * - `standard`: universally understood navigation (j/k, arrows, Enter select,
 *   Esc up, Tab, q). Footers advertise only special keys; the `?` help modal
 *   lists every keybind, standard ones included.
 * - `context`: footer-only visibility scope (e.g. the focused dashboard
 *   panel). The `?` help modal lists the entry regardless of context.
 */
export interface Keybind {
	/** Display label for the key combo, e.g. "J/K", "Enter", "/". */
	key: string;
	/**
	 * Full action description. Footers without a `short` label and the `?` help
	 * modal render this.
	 */
	action: string;
	/**
	 * Optional one-word label for footer surfaces (the main StatusBar and modal
	 * footers via `HelpText`), which render `short ?? action`. The `?` help
	 * modal always renders `action`, and shifted letters are written uppercase
	 * (`T`, `J/K/H/L`), never `Shift+T`.
	 */
	short?: string;
	/** Hide from footers (still shown in `?` help); defaults to false. */
	standard?: boolean;
	/** Footer context this entry belongs to; undefined means every context. */
	context?: string;
}

/**
 * Label a footer renders for an entry: the compact `short` when provided,
 * otherwise the full `action`. The `?` help modal always renders `action`.
 */
export function keybindFooterLabel(keybind: Keybind): string {
	return keybind.short ?? keybind.action;
}

export interface KeybindSection {
	title: string;
	keybinds: Keybind[];
}

export type KeybindCatalog = readonly KeybindSection[];

/** Every keybind in a catalog, in section order. */
export function catalogKeybinds(catalog: KeybindCatalog): Keybind[] {
	return catalog.flatMap((section) => section.keybinds);
}

/**
 * Drop the standard navigation keys every user already knows. */
/**
 * The parent/back/forward navigation set every page surface advertises
 * (hierarchical-tui-navigation): Escape is the structural up-step, Back and
 * Forward are the chronological pair on the vim jump-list keys with
 * terminal-independent `Alt` arrow equivalents. All entries are standard
 * navigation, so the footer stays free for special actions and the `?` help
 * modal documents them.
 */
export const PAGE_NAVIGATION_KEYBINDS: readonly Keybind[] = [
	{ key: "Esc", action: "parent page", short: "parent", standard: true },
	{
		key: "Ctrl+O/Alt+Left",
		action: "back",
		short: "back",
		standard: true,
	},
	{
		key: "Ctrl+I/Alt+Right",
		action: "forward",
		short: "forward",
		standard: true,
	},
];

export function specialKeybinds(keybinds: readonly Keybind[]): Keybind[] {
	return keybinds.filter((keybind) => !keybind.standard);
}

/**
 * Footer view of a catalog: special keys only, further narrowed to `context`
 * when the active surface supplies one.
 */
export function footerKeybinds(
	catalog: KeybindCatalog,
	context?: string,
): Keybind[] {
	return specialKeybinds(catalogKeybinds(catalog)).filter(
		(keybind) => keybind.context === undefined || keybind.context === context,
	);
}

/**
 * Reactive store for the catalog the shell footer and `?` help modal read.
 * The owner of the active surface publishes here (shell tab, dashboard
 * overview, or dashboard detail panel); every footer/help surface consumes.
 */
const [activeCatalog, setActiveCatalog] = createSignal<KeybindCatalog>([]);
const [activeContext, setActiveContext] = createSignal<string | undefined>();

export function setActiveKeybindCatalog(
	catalog: KeybindCatalog,
	context?: string,
): void {
	setActiveCatalog(catalog);
	setActiveContext(context);
}

export function activeKeybindCatalog(): KeybindCatalog {
	return activeCatalog();
}

export function activeKeybindContext(): string | undefined {
	return activeContext();
}

/**
 * The `?` help modal's own pointer note, stated once for every surface
 * (`tui-mouse-interaction`): the pointer drives the same actions the keys do.
 * It is a section, not key text inside a body, and the modal lists it last so a
 * short terminal clips it first.
 */
export const HELP_MOUSE_SECTION: KeybindSection = {
	title: "Mouse",
	keybinds: [
		{ key: "tap", action: "Select a row, panel or tab" },
		{ key: "tap again", action: "Open the selected row (same as Enter)" },
		{ key: "wheel", action: "Scroll the pane under the pointer" },
	],
};

/** One rendered row of the `?` help modal: a section title or a keybind. */
export type HelpModalRow = { title: string } | Keybind;

/**
 * The rows the `?` help modal paints for a catalog, in order. Callers that
 * clamp the help scroll offset read this instead of counting the catalog
 * themselves, so the clamp can never drift from what the modal renders.
 */
export function helpModalRows(
	sections: readonly KeybindSection[],
): HelpModalRow[] {
	return [...sections, HELP_MOUSE_SECTION].flatMap((section) => [
		{ title: section.title },
		...section.keybinds,
	]);
}

/** The row count of {@link helpModalRows}. */
export function helpModalRowCount(sections: readonly KeybindSection[]): number {
	return (
		sections.reduce(
			(count, section) => count + section.keybinds.length + 1,
			0,
		) +
		HELP_MOUSE_SECTION.keybinds.length +
		1
	);
}
