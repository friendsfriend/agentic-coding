import { createSignal } from "solid-js";

/**
 * Semantic keybind contract shared by every TUI footer and help surface.
 *
 * A keybind is data only: renderers own colors, separators, and layout, so an
 * entry can never smuggle in styling. The optional flags classify an entry
 * without coupling it to a particular footer:
 *
 * - `standard`: universally understood navigation (j/k, arrows, Enter select,
 *   Esc back, Tab, q). Footers advertise only special keys; the `?` help modal
 *   lists every keybind, standard ones included.
 * - `context`: footer-only visibility scope (e.g. the focused dashboard
 *   panel). The `?` help modal lists the entry regardless of context.
 */
export interface Keybind {
	/** Display label for the key combo, e.g. "Shift+J/K", "Enter", "/". */
	key: string;
	/** Short action description, e.g. "Move between panels". */
	action: string;
	/** Hide from footers (still shown in `?` help); defaults to false. */
	standard?: boolean;
	/** Footer context this entry belongs to; undefined means every context. */
	context?: string;
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

/** Drop the standard navigation keys every user already knows. */
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
