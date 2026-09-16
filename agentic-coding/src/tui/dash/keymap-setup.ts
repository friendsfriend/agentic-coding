import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui";

const SHELL_FEATURE_RESOURCE = Symbol("agent-shell:feature-field");

export function registerShellFeatureField(
	keymap: Keymap<Renderable, KeyEvent>,
): () => void {
	return keymap.acquireResource(SHELL_FEATURE_RESOURCE, () =>
		keymap.registerLayerFields({
			name(value, ctx) {
				ctx.attr("name", String(value));
			},
			shellFeature(value, ctx) {
				ctx.require("shell.feature", String(value));
			},
		}),
	);
}

/**
 * Register the shell's own dialog handling as the top key layer while one of
 * its overlays is open (replace-nested-tabs-with-page-navigation, task 3.1).
 * Overlay precedence is then a property of the registration, not of every
 * feature layer's own modal filter: a typed character in the location picker
 * cannot reach a dashboard or environment binding.
 */
export function registerShellOverlayLayer(
	keymap: Keymap<Renderable, KeyEvent>,
	handler: (event: KeyEvent) => void,
): () => void {
	const resource = Symbol("agent-shell:overlay-layer");
	return keymap.acquireResource(resource, () =>
		keymap.registerLayer({
			name: "Agent Shell Overlay",
			priority: 2000,
			commands: [
				{
					name: "shell.overlay.dispatch",
					context: "global",
					run: ({ event }) => {
						handler(event);
						return true;
					},
				},
			],
			bindings: SHELL_KEYS.map((key) => ({
				key,
				cmd: "shell.overlay.dispatch",
				preventDefault: false,
			})),
		}),
	);
}

export function setupKeymap(keymap: Keymap<Renderable, KeyEvent>) {
	const resource = Symbol("agent-dash:keymap");
	return keymap.acquireResource(resource, () => {
		const disposers = [
			registerBaseLayoutFallback(keymap),
			registerShellFeatureField(keymap),
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
				// The embedded environment feature shares this keymap. Its runtime
				// synchronizes these data keys, so register its layer metadata here
				// instead of silently making those layers unconditional.
				appViewMode(value, ctx) {
					ctx.require("app.viewMode", String(value));
				},
				activeTab(value, ctx) {
					ctx.require("app.activeTab", String(value));
				},
				shutdown(value, ctx) {
					ctx.require("shutdown.active", Boolean(value));
				},
				focusedPanel(value, ctx) {
					ctx.require("focus.panel", String(value));
				},
				focusedList(value, ctx) {
					ctx.require("focus.list", String(value));
				},
				worktreeManager(value, ctx) {
					ctx.require("worktree.active", Boolean(value));
				},
			}),
			keymap.registerBindingFields({
				context(value, ctx) {
					ctx.attr("context", String(value));
				},
				category(value, ctx) {
					ctx.attr("category", String(value));
				},
				footer(value, ctx) {
					ctx.attr("footer", String(value));
				},
				discoverable(value, ctx) {
					ctx.attr("discoverable", Boolean(value));
				},
			}),
			keymap.registerCommandFields({
				context(value, ctx) {
					ctx.attr("context", String(value));
				},
				footer(value, ctx) {
					ctx.attr("footer", String(value));
				},
				discoverable(value, ctx) {
					ctx.attr("discoverable", Boolean(value));
				},
			}),
		];
		return () => {
			for (const dispose of [...disposers].reverse()) dispose();
		};
	});
}

/**
 * Register the shell's observability/shell key handling as the lowest-priority
 * keymap layer (compose-unified-feature-shell task 3.5/3.6): higher-priority
 * dashboard/environment layers consume their keys first, and this layer is the
 * single remaining dispatcher instead of a competing raw `keypress` listener.
 */
const SHELL_KEYS: string[] = [
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
	...[
		"-",
		"_",
		"=",
		"+",
		"[",
		"]",
		"{",
		"}",
		";",
		":",
		"\\",
		"|",
		",",
		".",
		"<",
		">",
		"`",
		"~",
		"!",
		"@",
		"#",
		"$",
		"%",
		"^",
		"&",
		"*",
		"(",
		")",
		'"',
		"'",
		"/",
		"?",
		"space",
		"escape",
		"tab",
		"shift+tab",
		"up",
		"down",
		"left",
		"right",
		"enter",
		"return",
		"backspace",
		"delete",
		// Page navigation bindings (replace-nested-tabs-with-page-navigation, task
		// 3.1): one location picker and one structural parent, no destination
		// cycling. Explicit so a feature layer still owns whatever it registers.
		"ctrl+p",
		"alt+up",
	],
];

/**
 * Register the shell's observability/shell key handling as the lowest-priority
 * keymap layer (compose-unified-feature-shell task 3.5/3.6): higher-priority
 * dashboard/environment layers consume their keys first, and this layer is the
 * single remaining dispatcher instead of a competing raw `keypress` listener.
 * Explicit bindings (rather than a catch-all sequence) keep feature layers
 * authoritative for the keys they register.
 */
export function registerShellKeyLayer(
	keymap: Keymap<Renderable, KeyEvent>,
	handler: (event: KeyEvent) => void,
): () => void {
	const resource = Symbol("agent-shell:key-layer");
	return keymap.acquireResource(resource, () =>
		keymap.registerLayer({
			name: "Agent Shell",
			priority: 1,
			commands: [
				{
					name: "shell.dispatch",
					context: "global",
					run: ({ event }) => {
						handler(event);
						return true;
					},
				},
			],
			bindings: SHELL_KEYS.map((key) => ({
				key,
				cmd: "shell.dispatch",
				preventDefault: false,
			})),
		}),
	);
}
