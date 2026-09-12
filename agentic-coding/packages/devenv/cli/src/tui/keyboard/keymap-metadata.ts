import type { HelpSection } from "@devenv/ui";
import type { Keymap, KeymapEvent } from "@opentui/keymap";
import { KEYBINDS, type KeybindDef } from "./registry";

export interface FooterKeybind {
	key: string;
	action: string;
}

export interface KeymapHelpEntry {
	key: string;
	description: string;
	context: string;
	category: string;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const visible = (value: unknown): boolean => value !== false;

function attrsToEntry(
	key: string,
	commandAttrs?: Readonly<Record<string, unknown>>,
	bindingAttrs?: Readonly<Record<string, unknown>>,
): KeymapHelpEntry | undefined {
	if (
		!visible(commandAttrs?.discoverable) ||
		!visible(bindingAttrs?.discoverable)
	)
		return undefined;
	const context = text(bindingAttrs?.context) ?? text(commandAttrs?.context);
	const category = text(bindingAttrs?.category) ?? text(commandAttrs?.category);
	const title = text(commandAttrs?.title);
	const desc = text(commandAttrs?.desc);
	if (!context || !category || !title) return undefined;
	return { key, context, category, description: desc ?? title };
}

export function getActiveFooterKeybindsFromKeymap<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>): FooterKeybind[] {
	const seen = new Set<string>();
	const entries: FooterKeybind[] = [];
	for (const active of keymap.getActiveKeys({
		includeMetadata: true,
		includeBindings: true,
	})) {
		const binding = active.bindings?.find(
			(candidate) =>
				visible(candidate.commandAttrs?.discoverable) &&
				visible(candidate.attrs?.discoverable),
		);
		const commandAttrs = binding?.commandAttrs ?? active.commandAttrs;
		const bindingAttrs = binding?.attrs ?? active.bindingAttrs;
		const footer = text(bindingAttrs?.footer) ?? text(commandAttrs?.footer);
		const action = text(commandAttrs?.title) ?? text(commandAttrs?.desc);
		if (!footer || !action) continue;
		const key = `${footer}\0${action}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ key: footer, action });
	}
	return entries;
}

export function getHelpEntriesFromKeymap<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>, context?: string): KeymapHelpEntry[] {
	const seen = new Set<string>();
	const entries: KeymapHelpEntry[] = [];
	for (const commandEntry of keymap.getCommandEntries({
		visibility: "registered",
	})) {
		for (const binding of commandEntry.bindings) {
			const key = binding.sequence.map((part) => part.display).join(" ");
			const entry = attrsToEntry(key, binding.commandAttrs, binding.attrs);
			if (!entry) continue;
			if (context && entry.context !== "global" && entry.context !== context)
				continue;
			const dedupe = `${entry.context}\0${entry.category}\0${entry.key}\0${entry.description}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			entries.push(entry);
		}
	}
	return entries;
}

export function helpSectionsFromKeymap<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(
	keymap: Keymap<TTarget, TEvent>,
	context: string,
	fallback: KeybindDef[] = KEYBINDS,
): HelpSection[] {
	const entries = getHelpEntriesFromKeymap(keymap, context);
	const merged =
		entries.length > 0
			? entries
			: fallback
					.filter((def) => def.context === "global" || def.context === context)
					.map((def) => ({
						key: def.keys.join(", "),
						description: def.description,
						context: def.context,
						category: def.category,
					}));
	const groups = new Map<string, Array<{ key: string; description: string }>>();
	for (const entry of merged) {
		if (!groups.has(entry.category)) groups.set(entry.category, []);
		groups
			.get(entry.category)
			?.push({ key: entry.key, description: entry.description });
	}
	return Array.from(groups.entries()).map(([title, items]) => ({
		title,
		items,
	}));
}

export function allContextHelpSectionsFromKeymap<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(
	keymap: Keymap<TTarget, TEvent>,
	fallback: KeybindDef[] = KEYBINDS,
): HelpSection[] {
	const entries = getHelpEntriesFromKeymap(keymap);
	const source =
		entries.length > 0
			? entries
			: fallback.map((def) => ({
					key: def.keys.join(", "),
					description: def.description,
					context: def.context,
					category: def.category,
				}));
	const groups = new Map<string, Array<{ key: string; description: string }>>();
	for (const entry of source) {
		const title = entry.context;
		if (!groups.has(title)) groups.set(title, []);
		groups.get(title)?.push({ key: entry.key, description: entry.description });
	}
	return Array.from(groups.entries()).map(([title, items]) => ({
		title,
		items,
	}));
}
