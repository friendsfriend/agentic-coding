import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { highlightColor } from "../components/Highlight";
import { createTonePalette } from "../theme/animationColors";

describe("animation colors", () => {
	test("semantic tones pass through theme-neutral foreground", () => {
		const neutral = RGBA.fromHex(highlightColor("primary"));
		expect(
			createTonePalette("positive").some((color) => color.equals(neutral)),
		).toBe(true);
		expect(
			createTonePalette("negative").some((color) => color.equals(neutral)),
		).toBe(true);
	});
});
