import type { Keybind } from "./keybinds.ts";

/**
 * The host shell's own key bindings: the keys the shell owns on **every**
 * surface, including while a feature body or one of its dialogs is on screen.
 *
 * This is the one registry for them. It is read in exactly three places, so the
 * three can never drift apart:
 *
 * - the shell's always-on key layer (`dash/keymap-setup.ts`) binds these keys,
 * - the footer/`?` help catalogs (`otel/app/keybinds.ts`, `dash/keybinds.ts`,
 *   `shared/modalHelp.ts`) render these labels,
 * - an embedded feature excludes exactly these keys from its own layers
 *   (`hostOwnedKeys`), because a key the host owns must never be claimed by a
 *   feature layer that handles nothing for it — that is how the location picker
 *   and the shared help modal used to go dead on the environment surface.
 */
export interface HostKeybind extends Keybind {
	/** Binding name the key layer registers (`ctrl+p`; labels stay in `key`). */
	binding: string;
}

export const HOST_KEYBINDS: readonly HostKeybind[] = [
	{
		binding: "ctrl+p",
		key: "Ctrl+P",
		action: "locations",
		short: "locations",
	},
	{
		binding: "?",
		key: "?",
		action: "Open help",
		short: "help",
	},
	{
		// Quit is the shell's, on every surface: a feature that binds `q` for its
		// own table (the environment's registry lists it) would swallow it.
		binding: "q",
		key: "q",
		action: "quit",
		standard: true,
	},
	{
		// Support tool: reports which keymap fields the active surface gates on, so
		// "nothing responds here" can be told apart from "the keyboard is dead"
		// without a rebuild. Hidden from footers, listed by `?`.
		binding: "alt+d",
		key: "Alt+D",
		action: "keybind diagnostics",
		standard: true,
	},
];

/** The binding names, in registration order. */
export const HOST_KEY_BINDINGS: readonly string[] = HOST_KEYBINDS.map(
	(entry) => entry.binding,
);

/** The catalog entry for one host key. */
export function hostKeybind(binding: string): Keybind {
	const entry = HOST_KEYBINDS.find(
		(candidate) => candidate.binding === binding,
	);
	if (!entry) throw new Error(`unknown host keybind: ${binding}`);
	const { binding: _binding, ...keybind } = entry;
	return keybind;
}

const NO_HOST_KEYS: ReadonlySet<string> = new Set();
const EMBEDDED_HOST_KEYS: ReadonlySet<string> = new Set(HOST_KEY_BINDINGS);

/** The diagnostics entry, for catalogs that list the host's own keys. */
export function hostDiagnosticsKeybind(): Keybind {
	return hostKeybind("alt+d");
}

/**
 * Keys an embedded feature must not claim. Standalone the feature has no host
 * layer above it, so it keeps all of its own bindings.
 */
export function hostOwnedKeys(
	embedded: boolean | undefined,
): ReadonlySet<string> {
	return embedded ? EMBEDDED_HOST_KEYS : NO_HOST_KEYS;
}
