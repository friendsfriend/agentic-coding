import { describe, expect, test } from "bun:test";
import { formatHelpTextLines } from "./HelpText";

describe("formatHelpTextLines", () => {
	test("wraps keybind entries at entry boundaries", () => {
		const lines = formatHelpTextLines(
			[
				{ key: "j/k", action: "Nav" },
				{ key: "n/N", action: "Next/Prev" },
				{ key: "Ctrl+Enter", action: "Submit" },
			],
			25,
		);

		expect(lines).toEqual(["j/k Nav  •  n/N Next/Prev", "Ctrl+Enter Submit"]);
	});
});
