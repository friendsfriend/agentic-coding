import { useKeymap } from "@opentui/keymap/solid";
import { onCleanup } from "solid-js";
import { bindings, type Keybind, layerCommands } from "./keybinds.ts";

/** Keys of the original menu → list → form pages. They only move a local
 * cursor, open a level or edit a local draft; nothing here reaches the server. */
export type MenuKey = "up" | "down" | "open" | "back" | "left" | "right";

export const menuKeybinds: Keybind[] = [
	...["k", "up"].map((key) => ({
		key,
		cmd: "menu.up",
		action: "Previous entry",
		short: "move",
		standard: key !== "k",
	})),
	...["j", "down"].map((key) => ({
		key,
		cmd: "menu.down",
		action: "Next entry",
		standard: true,
	})),
	{ key: "return", cmd: "menu.open", action: "Open or edit", short: "open" },
	{
		key: "l",
		cmd: "menu.right",
		action: "Into the value pane",
		standard: true,
	},
	{
		key: "right",
		cmd: "menu.right",
		action: "Into the value pane",
		standard: true,
	},
	{
		key: "h",
		cmd: "menu.left",
		action: "Back to the field list",
		standard: true,
	},
	{
		key: "left",
		cmd: "menu.left",
		action: "Back to the field list",
		standard: true,
	},
	{ key: "escape", cmd: "menu.back", action: "Back one level", short: "back" },
];

/** One keymap layer for a mounted menu page; `active` gates it so the prompt,
 * editors and dialogs keep their own keys whenever the menu is not focused. */
export function useMenuKeys(options: {
	active: () => boolean;
	/** Answer false to leave the key to the next layer (Escape on the top menu). */
	key: (key: MenuKey) => boolean | undefined;
}) {
	const keymap = useKeymap();
	const run = (key: MenuKey) => () =>
		options.active() ? options.key(key) !== false : false;
	const unregister = keymap.registerLayer({
		id: "v2.menu-page",
		priority: 30,
		enabled: options.active,
		commands: layerCommands([
			{ id: "menu.up", name: "Previous entry", run: run("up") },
			{ id: "menu.down", name: "Next entry", run: run("down") },
			{ id: "menu.open", name: "Open or edit", run: run("open") },
			{ id: "menu.back", name: "Back one level", run: run("back") },
			{ id: "menu.left", name: "Field list", run: run("left") },
			{ id: "menu.right", name: "Value pane", run: run("right") },
		]),
		bindings: bindings(menuKeybinds),
	});
	onCleanup(unregister);
}
