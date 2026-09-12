import type { Keymap, KeymapEvent } from "@opentui/keymap";
import type { TestKeyModifierOptions } from "@opentui/keymap/testing";
import {
	createTestKeymap,
	type TestKeymapEvent,
} from "@opentui/keymap/testing";

export function createKeyboardTestHarness() {
	return createTestKeymap({ defaultKeys: true });
}

export function dispatchKey(
	host: ReturnType<typeof createTestKeymap>["host"],
	name: string,
	modifiers?: TestKeyModifierOptions,
): TestKeymapEvent {
	return host.press(name, modifiers);
}

export function activeKeyStrings<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>): string[] {
	return keymap
		.getActiveKeys()
		.map((key) => key.display)
		.sort();
}

export function commandNames<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>): string[] {
	return keymap
		.getCommands()
		.map((command) => command.name)
		.sort();
}

export function expectActiveKeys<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>, expected: string[]): void {
	const actual = activeKeyStrings(keymap);
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		throw new Error(
			`Expected active keys ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

export function expectCommandNames<
	TTarget extends object,
	TEvent extends KeymapEvent,
>(keymap: Keymap<TTarget, TEvent>, expected: string[]): void {
	const actual = commandNames(keymap);
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		throw new Error(
			`Expected commands ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}
