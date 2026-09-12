import { describe, expect, test } from "bun:test";
import { isNextRelatedKey, isPreviousRelatedKey } from "./horizontal-scroll";
import {
	isDownKey,
	isEnterKey,
	isLeftKey,
	isRightKey,
	isUpKey,
} from "./nav-keys";
import type { KeyboardEvent } from "./types";

const key = (name: string, sequence = name, shift = false): KeyboardEvent =>
	({ name, sequence, shift }) as KeyboardEvent;

describe("keyboard navigation helpers", () => {
	test("plain vim keys are line/navigation keys", () => {
		expect(isDownKey(key("j"))).toBe(true);
		expect(isUpKey(key("k"))).toBe(true);
		expect(isLeftKey(key("h"))).toBe(true);
		expect(isRightKey(key("l"))).toBe(true);
	});

	test("shifted J/K are previous/next related keys, not line navigation", () => {
		const shiftJ = key("j", "J", true);
		const shiftK = key("k", "K", true);

		expect(isDownKey(shiftJ)).toBe(false);
		expect(isUpKey(shiftK)).toBe(false);
		expect(isNextRelatedKey(shiftJ)).toBe(true);
		expect(isPreviousRelatedKey(shiftK)).toBe(true);
	});

	test("enter helper accepts named and raw return events", () => {
		expect(isEnterKey(key("return", "\r"))).toBe(true);
		expect(isEnterKey(key("enter", "\n"))).toBe(true);
		expect(isEnterKey({ sequence: "\r" } as KeyboardEvent)).toBe(true);
		expect(isEnterKey({ raw: "\n" } as KeyboardEvent)).toBe(true);
		expect(isEnterKey(key("j"))).toBe(false);
	});
});
