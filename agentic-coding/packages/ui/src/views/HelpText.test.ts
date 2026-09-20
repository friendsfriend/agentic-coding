import { describe, expect, test } from "bun:test";
import {
	formatHelpText,
	formatHelpTextLines,
} from "../components/HelpText.tsx";

const entries = [
	{ key: "j/k", action: "Nav" },
	{ key: "n/N", action: "Next/Prev" },
	{ key: "Ctrl+Enter", action: "Submit" },
];

describe("formatHelpText", () => {
	test("joins entries with the shared single-space bullet separator", () => {
		expect(formatHelpText(entries)).toBe(
			"j/k Nav • n/N Next/Prev • Ctrl+Enter Submit",
		);
	});
});

describe("formatHelpTextLines", () => {
	test("wraps keybind entries at entry boundaries", () => {
		const lines = formatHelpTextLines(entries, 25);

		expect(lines).toEqual(["j/k Nav • n/N Next/Prev", "Ctrl+Enter Submit"]);
	});
});
