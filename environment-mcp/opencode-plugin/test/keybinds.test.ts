import { describe, expect, test } from "bun:test";
import {
	footerKeybinds,
	HELP_SECTIONS,
	viewKeybinds,
} from "../src/keybinds.ts";

describe("environment keybind catalog", () => {
	test("footer advertises special keys and hides standard navigation", () => {
		const list = footerKeybinds("list").map((entry) => entry.key);
		expect(list).toContain("Enter");
		expect(list).toContain("/");
		expect(list).toContain("r");
		expect(list).toContain("Esc");
		expect(list).toContain("?");
		expect(list).not.toContain("↑/↓");
		expect(viewKeybinds("form").map((entry) => entry.key)).toContain(
			"Ctrl+Enter",
		);
		expect(footerKeybinds("list", true).map((entry) => entry.key)).toEqual([
			"Enter",
			"Esc",
		]);
	});

	test("help lists every surface and both open commands", () => {
		const keys = HELP_SECTIONS.flatMap((section) =>
			section.entries.map((entry) => entry.key),
		);
		expect(keys).toContain("↑/↓");
		expect(keys).toContain("Tab");
		expect(keys).toContain("Ctrl+Enter");
		expect(keys).toContain("Enter");
		expect(keys).toContain("/environment");
		expect(keys).toContain("<leader>v");
	});
});
