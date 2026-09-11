import { createSignal } from "solid-js";
import type { Keybind, KeybindSection } from "./keybinds";

/**
 * Automatic `?` help entry for modal footers. Modals advertise it exactly like
 * the shell/panel footers advertise help, and the shared `HelpModal` renders
 * the modal's keybind catalog when it is pressed.
 */
export const MODAL_HELP_KEYBIND: Keybind = {
	key: "?",
	action: "Open help",
	short: "help",
};

/**
 * Copy `entries`, appending the automatic `?` help entry when the modal does
 * not already advertise one. Never mutates the caller's array.
 */
export function withModalHelpKeybind(
	entries: readonly Keybind[],
): readonly Keybind[] {
	if (entries.length === 0) return entries;
	if (entries.some((entry) => entry.key === "?")) return entries;
	return [...entries, MODAL_HELP_KEYBIND];
}

/** One help section's rows, matching the `?` modal's title row + key rows. */
function rowCount(sections: readonly KeybindSection[]): number {
	return sections.reduce(
		(count, section) => count + section.keybinds.length + 1,
		0,
	);
}

/**
 * Registration published by a mounted modal so the surface's key handler can
 * open the modal's own help overlay. Accessors keep the catalog live (modal
 * help entries change with the modal step) and `lines` lets the shared store
 * clamp scrolling to the overlay's visible height.
 */
export interface ModalHelpRegistration {
	sections: () => KeybindSection[];
	lines: () => number;
}

const [registry, setRegistry] = createSignal<readonly ModalHelpRegistration[]>(
	[],
);
const [open, setOpen] = createSignal(false);
const [offset, setOffset] = createSignal(0);

/**
 * Publish a modal's help catalog while it is mounted. Returns the disposer the
 * modal calls on cleanup; the last-registered modal (the topmost one) wins.
 */
export function registerModalHelp(
	registration: ModalHelpRegistration,
): () => void {
	setRegistry((list) => [...list, registration]);
	return () => {
		setRegistry((list) => list.filter((entry) => entry !== registration));
		setOpen(false);
		setOffset(0);
	};
}

/** Catalog of the topmost mounted modal, or undefined when none registered. */
export function activeModalHelp(): ModalHelpRegistration | undefined {
	const list = registry();
	return list[list.length - 1];
}

export function modalHelpOpen(): boolean {
	// A closed overlay must not linger after its modal unmounts (registration
	// cleanup also clears this, but the guard keeps stale reads honest).
	return open() && activeModalHelp() !== undefined;
}

export function modalHelpOffset(): number {
	return offset();
}

export function modalHelpMaxOffset(): number {
	const active = activeModalHelp();
	if (!active) return 0;
	return Math.max(0, rowCount(active.sections()) - active.lines());
}

export function openModalHelp(): boolean {
	const active = activeModalHelp();
	if (!active || active.sections().length === 0) return false;
	setOffset(0);
	setOpen(true);
	return true;
}

export function closeModalHelp(): void {
	setOpen(false);
}

export function scrollModalHelp(delta: number): void {
	setOffset((value) =>
		Math.max(0, Math.min(modalHelpMaxOffset(), value + delta)),
	);
}

/**
 * Surface-agnostic routing for a modal's own `?` help: opens help when a
 * mounted modal published a catalog, and owns `j/k`/`Esc` while it is open.
 * Returns true when the key was consumed, so surfaces can fall through
 * otherwise (e.g. text-entry modals keep `?` for the focused editor).
 */
export function handleModalHelpKey(key: string): boolean {
	const name = key.toLowerCase();
	if (open()) {
		if (name === "escape" || name === "esc") {
			closeModalHelp();
			return true;
		}
		if (name === "j" || name === "down") {
			scrollModalHelp(1);
			return true;
		}
		if (name === "k" || name === "up") {
			scrollModalHelp(-1);
			return true;
		}
		return true;
	}
	if (key === "?") return openModalHelp();
	return false;
}
