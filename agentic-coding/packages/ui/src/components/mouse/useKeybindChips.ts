import type { ParsedKey } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { Keybind } from "../keybinds.ts";

/**
 * Key chips as pointer targets (design D6).
 *
 * A chip runs the command its key runs, and it does so by *dispatching the key*
 * through the renderer's own key handler: the layered keymap then decides
 * exactly as it would for a keypress, so a chip can never run a command that is
 * unavailable in the current state, and no surface needs a second dispatch
 * table next to its key bindings.
 *
 * A label that is not a single stroke (`j/k`, `J/K/H/L`, `PgUp/PgDn`) is not a
 * key and stays inert; so does a label whose command needs a typed argument, and
 * those are exactly the labels `parseChipKey` refuses.
 */

const NAMED_KEYS: Record<string, string> = {
	Enter: "return",
	Esc: "escape",
	Tab: "tab",
	Space: "space",
	Backspace: "backspace",
	Delete: "delete",
	Insert: "insert",
	Home: "home",
	End: "end",
	PgUp: "pageup",
	PgDn: "pagedown",
	"↑": "up",
	"↓": "down",
	"←": "left",
	"→": "right",
};

export interface ChipKey {
	name: string;
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
}

/** A label that is one stroke, or `undefined` when it is not chip-runnable. */
export function parseChipKey(label: string): ChipKey | undefined {
	const trimmed = label.trim();
	if (!trimmed) return undefined;
	const parts = trimmed.split("+");
	const base = parts.pop() ?? "";
	if (!base) return undefined;
	const chip: ChipKey = { name: "", ctrl: false, shift: false, alt: false };
	for (const modifier of parts) {
		const normalized = modifier.toLowerCase();
		if (normalized === "ctrl" || normalized === "control") chip.ctrl = true;
		else if (normalized === "shift") chip.shift = true;
		else if (normalized === "alt" || normalized === "option") chip.alt = true;
		else return undefined;
	}
	const named = NAMED_KEYS[base];
	if (named) {
		chip.name = named;
		return chip;
	}
	// An alternative (`j/k`), a phrase (`Shift+Enter` alone is fine, `a or b` is
	// not) or a multi-character label that is not a named key is not a stroke.
	if (base.length > 1) return undefined;
	if (base === " ") chip.name = "space";
	else if (/^[A-Z]$/.test(base)) {
		// The keymap resolves a shifted letter to its uppercase name, so a chip
		// for `T` dispatches the stroke the developer actually types.
		chip.name = base.toLowerCase();
		chip.shift = true;
	} else chip.name = base;
	return chip;
}

/** Whether a catalog entry can be run from its chip in any state. */
export function keybindChipRunnable(keybind: Keybind): boolean {
	return parseChipKey(keybind.key) !== undefined;
}

/**
 * The sequence a real keystroke carries for a printable stroke. Handlers in the
 * environment layer match Space by `event.sequence === " "`, so a synthesized
 * stroke has to carry it; a named key's control sequence is not reproducible and
 * stays empty (those handlers match on the name).
 */
function sequenceFor(chip: ChipKey): string {
	if (chip.name === "space") return " ";
	if (chip.name.length !== 1) return "";
	return chip.shift ? chip.name.toUpperCase() : chip.name;
}

function parsedKeyFrom(chip: ChipKey): ParsedKey {
	return {
		name: chip.name,
		ctrl: chip.ctrl,
		meta: false,
		shift: chip.shift,
		option: chip.alt,
		sequence: sequenceFor(chip),
		number: chip.name.length === 1 && /\d/.test(chip.name),
		raw: sequenceFor(chip),
		eventType: "press",
		source: "raw",
	};
}

export interface KeybindChips {
	/** Spread onto `StatusBar`/`HelpText`/`GenericModal` as their chip callback. */
	onActivate: (keybind: Keybind) => void;
	/** Whether that chip is a pointer target at all. */
	activatable: (keybind: Keybind) => boolean;
}

/**
 * Push a stroke through the renderer's key handler, exactly as typing it.
 * Surfaces whose activation is only expressed as a keymap binding (the
 * dashboard panels' `Enter`) use this instead of a second action table, so the
 * keymap keeps deciding what is available in the current state.
 */
export function useKeyDispatch(): (label: string) => boolean {
	const renderer = useRenderer();
	return (label: string) => {
		const chip = parseChipKey(label);
		if (!chip) return false;
		renderer.keyInput.processParsedKey(parsedKeyFrom(chip));
		return true;
	};
}

/** The chip runner for the surface that renders the catalog. */
export function useKeybindChips(): KeybindChips {
	const dispatch = useKeyDispatch();
	return {
		activatable: keybindChipRunnable,
		onActivate: (keybind) => {
			if (!keybindChipRunnable(keybind)) return;
			dispatch(keybind.key);
		},
	};
}
