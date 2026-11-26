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
		expect(keys).toContain("n");
		expect(keys).toContain("p");
		expect(keys).toContain("c");
		expect(keys).toContain("i");
		expect(keys).toContain("K");
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
			expect.arrayContaining([
				"b",
				"E",
				"X",
				"m",
				"s",
				"t",
				"S",
				"g",
				"c",
				"l",
				"L",
				"e",
				"Esc",
			]),
		);
	});

	test("configuration forms advertise field, confirmation and target actions", () => {
		expect(viewKeybinds("targets").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["n", "d", "e", "x"]),
		);
		expect(viewKeybinds("config-write").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["Tab", "y", "t", "Esc"]),
		);
	});

	test("provider views advertise read-only navigation and state", () => {
		expect(viewKeybinds("providers").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["Enter", "r", "Esc"]),
		);
		expect(viewKeybinds("provider-changes").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["c", "i", "l", "s", "/"]),
		);
		expect(
			viewKeybinds("provider-pipelines").map((entry) => entry.key),
		).toContain("Enter");
		expect(viewKeybinds("provider-change").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["d", "h", "c", "a", "Esc"]),
		);
		expect(
			viewKeybinds("provider-change").map((entry) => entry.key),
		).not.toContain("f");
		expect(viewKeybinds("provider-issue").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["c", "h"]),
		);
		expect(
			viewKeybinds("provider-pipelines").map((entry) => entry.key),
		).toEqual(expect.arrayContaining(["t", "x"]));
		expect(viewKeybinds("provider-write").map((entry) => entry.key)).toContain(
			"y",
		);
		expect(
			viewKeybinds("provider-change-files").map((entry) => entry.key),
		).toContain("Enter");
		expect(
			viewKeybinds("provider-job-logs").map((entry) => entry.key),
		).toContain("Esc");
	});

	test("cluster views advertise namespace entry and refresh", () => {
		expect(viewKeybinds("clusters").map((entry) => entry.key)).toEqual(
			expect.arrayContaining(["Enter", "r", "Esc"]),
		);
		expect(
			viewKeybinds("cluster-namespace").map((entry) => entry.key),
		).toContain("Enter");
		expect(
			viewKeybinds("cluster-resources").map((entry) => entry.key),
		).toContain("r");
	});

	test("container stats expose refresh and back only", () => {
		expect(viewKeybinds("container-stats").map((entry) => entry.key)).toEqual([
			"r",
			"Esc",
		]);
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
				"E",
				"X",
				"m",
				"s",
				"t",
				"S",
				"l",
				"L",
				"e",
				"Enter",
				"/environment",
				"<leader>v",
				"/git",
				"/issues",
				"/changes",
				"<leader>G",
				"/",
				"w",
				"a",
				"x",
			]),
		);
	});
});
