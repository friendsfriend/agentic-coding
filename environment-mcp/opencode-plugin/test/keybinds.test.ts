import { describe, expect, test } from "bun:test";
import {
	footerKeybinds,
	HELP_SECTIONS,
	viewKeybinds,
} from "../src/environments/keybinds.ts";

describe("environment keybind catalog", () => {
	test("table footer advertises special keys and hides navigation", () => {
		const keys = footerKeybinds("table").map((entry) => entry.key);
		expect(keys).toContain("Enter");
		expect(keys).toContain("/");
		expect(keys).toContain("Tab");
		expect(keys).toContain("r");
		expect(keys).toContain("Esc");
		expect(keys).toContain("?");
		expect(keys).not.toContain("↑/↓");
		expect(footerKeybinds("table", true).map((entry) => entry.key)).toEqual([
			"Enter",
			"Esc",
		]);
	});

	test("detail exposes the environment actions", () => {
		const keys = viewKeybinds("detail").map((entry) => entry.key);
		expect(keys).toEqual(
			expect.arrayContaining(["b", "s", "t", "S", "l", "L", "e", "Esc"]),
		);
	});

	test("operation surface has no approval dispatch key", () => {
		expect(viewKeybinds("operation").map((entry) => entry.key)).not.toContain(
			"d",
		);
	});

	test("help lists every action and both open commands", () => {
		const keys = HELP_SECTIONS.flatMap((section) =>
			section.entries.map((entry) => entry.key),
		);
		expect(keys).toEqual(
			expect.arrayContaining([
				"b",
				"s",
				"t",
				"S",
				"l",
				"L",
				"e",
				"Enter",
				"/environment",
				"<leader>v",
			]),
		);
	});
});
