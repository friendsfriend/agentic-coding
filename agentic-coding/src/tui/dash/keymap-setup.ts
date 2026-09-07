import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui";

export function setupKeymap(keymap: Keymap<Renderable, KeyEvent>) {
	const resource = Symbol("agent-dash:keymap");
	return keymap.acquireResource(resource, () => {
		const disposers = [
			registerBaseLayoutFallback(keymap),
			keymap.appendEventMatchResolver((event, ctx) => {
				if (
					!event.shift ||
					event.ctrl ||
					event.meta ||
					event.super ||
					event.name.length !== 1
				)
					return undefined;
				const upper = event.name.toUpperCase();
				return upper !== event.name
					? [
							ctx.resolveKey({
								name: upper,
								ctrl: false,
								shift: false,
								meta: false,
								super: false,
							}),
						]
					: undefined;
			}),
			keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			}),
		];
		return () => {
			for (const dispose of [...disposers].reverse()) dispose();
		};
	});
}
