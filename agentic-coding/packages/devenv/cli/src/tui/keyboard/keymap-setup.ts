import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui";

export type DevenvKeymap = Keymap<Renderable, KeyEvent>;

export const KEYMAP_CONTEXTS = [
	"global",
	"modal",
	"text-entry",
	"table",
	"list",
	"detail",
	"kubernetes",
	"help",
	"panel",
	"worktree",
] as const;

export type KeymapContext = (typeof KEYMAP_CONTEXTS)[number] | (string & {});

export interface DevenvCommandMetadata {
	context: KeymapContext;
	category: string;
	title: string;
	desc?: string;
	footer?: string;
	discoverable?: boolean;
}

export interface DevenvBindingMetadata {
	context?: KeymapContext;
	category?: string;
	footer?: string;
	discoverable?: boolean;
}

const APP_KEYMAP_SETUP_RESOURCE = Symbol("devenv:keymap-setup");

const normalizeText = (field: string, value: unknown): string => {
	if (typeof value !== "string")
		throw new Error(`Keymap ${field} must be a string`);
	const text = value.trim();
	if (!text) throw new Error(`Keymap ${field} cannot be empty`);
	return text;
};

const normalizeBoolean = (field: string, value: unknown): boolean => {
	if (typeof value !== "boolean")
		throw new Error(`Keymap ${field} must be a boolean`);
	return value;
};

export function setupDevenvKeymap(keymap: DevenvKeymap): () => void {
	return keymap.acquireResource(APP_KEYMAP_SETUP_RESOURCE, () => {
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
				if (
					upper === event.name ||
					upper.toLowerCase() !== event.name.toLowerCase()
				)
					return undefined;
				return [
					ctx.resolveKey({
						name: upper,
						ctrl: false,
						shift: false,
						meta: false,
						super: false,
					}),
				];
			}),
			keymap.registerLayerFields({
				appViewMode(value, ctx) {
					ctx.require("app.viewMode", normalizeText("appViewMode", value));
				},
				activeTab(value, ctx) {
					ctx.require("app.activeTab", normalizeText("activeTab", value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", normalizeText("activeModal", value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", normalizeBoolean("textEntry", value));
				},
				shutdown(value, ctx) {
					ctx.require("shutdown.active", normalizeBoolean("shutdown", value));
				},
				focusedPanel(value, ctx) {
					ctx.require("focus.panel", normalizeText("focusedPanel", value));
				},
				focusedList(value, ctx) {
					ctx.require("focus.list", normalizeText("focusedList", value));
				},
				worktreeManager(value, ctx) {
					ctx.require(
						"worktree.active",
						normalizeBoolean("worktreeManager", value),
					);
				},
			}),
			keymap.registerBindingFields({
				context(value, ctx) {
					ctx.attr("context", normalizeText("context", value));
				},
				category(value, ctx) {
					ctx.attr("category", normalizeText("category", value));
				},
				footer(value, ctx) {
					ctx.attr("footer", normalizeText("footer", value));
				},
				discoverable(value, ctx) {
					ctx.attr("discoverable", normalizeBoolean("discoverable", value));
				},
			}),
			keymap.registerCommandFields({
				context(value, ctx) {
					ctx.attr("context", normalizeText("context", value));
				},
				category(value, ctx) {
					ctx.attr("category", normalizeText("category", value));
				},
				title(value, ctx) {
					ctx.attr("title", normalizeText("title", value));
				},
				desc(value, ctx) {
					ctx.attr("desc", normalizeText("desc", value));
				},
				footer(value, ctx) {
					ctx.attr("footer", normalizeText("footer", value));
				},
				discoverable(value, ctx) {
					ctx.attr("discoverable", normalizeBoolean("discoverable", value));
				},
			}),
		];

		return () => {
			for (const dispose of [...disposers].reverse()) dispose();
		};
	});
}
