import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { handleGlobalKeys } from "./global-keys";
import { routePastedText } from "./paste-handler";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

export interface GlobalKeymapLayerDeps {
	stores: KeyboardStores;
	actions: KeyboardActions;
	ctx: KeyboardContext;
}

const GLOBAL_PRIORITY = 900;
const SHUTDOWN_PRIORITY = 10_000;
const ANY_KEY_PATTERN = Symbol("devenv:any-key-pattern");

export function registerGlobalKeymapLayers(
	keymap: Keymap<Renderable, KeyEvent>,
	deps: GlobalKeymapLayerDeps,
): () => void {
	const disposers: Array<() => void> = [];

	disposers.push(
		keymap.acquireResource(ANY_KEY_PATTERN, () =>
			keymap.registerSequencePattern({
				name: "any",
				match(event) {
					return { value: event.name, display: event.name };
				},
				finalize(values) {
					return values[0];
				},
			}),
		),
	);

	const runGlobal = (event: KeyEvent) =>
		handleGlobalKeys(event, deps.stores, deps.actions, deps.ctx);

	disposers.push(
		keymap.registerLayer({
			name: "Shutdown Guard",
			priority: SHUTDOWN_PRIORITY,
			shutdown: true,
			commands: [
				{
					name: "app.shutdown.consume",
					context: "global",
					category: "System",
					title: "Shutdown guard",
					desc: "Consume keyboard input while shutdown is active.",
					discoverable: false,
					run: () => true,
				},
			],
			bindings: [
				{ key: "{any}", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "?", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "q", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "ctrl+c", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "escape", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "ctrl+r", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "ctrl+/", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "/", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "meta+c", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "ctrl+v", cmd: "app.shutdown.consume", discoverable: false },
				{ key: "meta+v", cmd: "app.shutdown.consume", discoverable: false },
			],
		}),
	);

	disposers.push(
		keymap.registerLayer({
			name: "Global",
			priority: GLOBAL_PRIORITY,
			shutdown: false,
			activeModal: "none",
			commands: [
				{
					name: "help.open",
					context: "global",
					category: "Help",
					title: "Open help",
					desc: "Open help for current context.",
					footer: "?",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "console.toggle",
					context: "global",
					category: "Console",
					title: "Toggle console",
					desc: "Toggle OpenTUI console overlay.",
					footer: "Ctrl+/",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "console.close",
					context: "global",
					category: "Console",
					title: "Close console",
					desc: "Close OpenTUI console overlay.",
					footer: "Esc",
					discoverable: false,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "running-text.toggle",
					context: "global",
					category: "Display",
					title: "Toggle running text",
					desc: "Toggle running text for overflowing UI fields.",
					footer: "Ctrl+R",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "selection.copy",
					context: "global",
					category: "Clipboard",
					title: "Copy selection",
					desc: "Copy selected terminal text.",
					footer: "Alt+C",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "app.quit.q",
					context: "global",
					category: "System",
					title: "Quit",
					desc: "Press q twice to quit.",
					footer: "q",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "app.quit.ctrl-c",
					context: "global",
					category: "System",
					title: "Quit / copy",
					desc: "Copy selection or press Ctrl+C twice to quit.",
					footer: "Ctrl+C",
					discoverable: true,
					run: ({ event }) => runGlobal(event),
				},
				{
					name: "paste.route",
					context: "global",
					category: "Clipboard",
					title: "Paste",
					desc: "Route clipboard text to active modal input.",
					footer: "Ctrl+V",
					discoverable: true,
					run: async () => {
						const { readFromClipboard } = await import("@devenv/core");
						return routePastedText(
							readFromClipboard() ?? "",
							deps.stores.providerStore,
						);
					},
				},
			],
			bindings: [
				{
					key: "?",
					cmd: "help.open",
					context: "global",
					category: "Help",
					footer: "?",
				},
				{
					key: "ctrl+/",
					cmd: "console.toggle",
					context: "global",
					category: "Console",
					footer: "Ctrl+/",
				},
				{
					key: "escape",
					cmd: "console.close",
					context: "global",
					category: "Console",
					footer: "Esc",
					fallthrough: true,
					preventDefault: false,
				},
				{
					key: "ctrl+r",
					cmd: "running-text.toggle",
					context: "global",
					category: "Display",
					footer: "Ctrl+R",
				},
				{
					key: "meta+c",
					cmd: "selection.copy",
					context: "global",
					category: "Clipboard",
					footer: "Alt+C",
				},
				{
					key: "q",
					cmd: "app.quit.q",
					context: "global",
					category: "System",
					footer: "q",
				},
				{
					key: "ctrl+c",
					cmd: "app.quit.ctrl-c",
					context: "global",
					category: "System",
					footer: "Ctrl+C",
				},
				{
					key: "ctrl+v",
					cmd: "paste.route",
					context: "global",
					category: "Clipboard",
					footer: "Ctrl+V",
				},
				{
					key: "meta+v",
					cmd: "paste.route",
					context: "global",
					category: "Clipboard",
					footer: "Meta+V",
				},
			],
		}),
	);

	return () => {
		for (const dispose of [...disposers].reverse()) dispose();
	};
}
