import { describe, expect, test } from "bun:test";
import type { TerminalColors } from "@opentui/core";
import {
	loadRendererThemeColors,
	terminalColorsToThemeColors,
} from "./theme-settings";

const terminalColors = (
	overrides: Partial<TerminalColors> = {},
): TerminalColors => ({
	palette: Array.from(
		{ length: 16 },
		(_, idx) => `#${idx.toString(16).repeat(6).slice(0, 6)}`,
	),
	defaultForeground: "#AABBCC",
	defaultBackground: "#112233",
	cursorColor: null,
	mouseForeground: null,
	mouseBackground: null,
	tekForeground: null,
	tekBackground: null,
	highlightBackground: null,
	highlightForeground: null,
	...overrides,
});

describe("terminalColorsToThemeColors", () => {
	test("converts OpenTUI terminal colors to DevEnv theme colors", () => {
		expect(terminalColorsToThemeColors(terminalColors())).toEqual({
			foreground: "#aabbcc",
			background: "#112233",
			palette: Array.from(
				{ length: 16 },
				(_, idx) => `#${idx.toString(16).repeat(6).slice(0, 6)}`,
			),
		});
	});

	test("omits missing or invalid foreground, background, and palette", () => {
		expect(
			terminalColorsToThemeColors(
				terminalColors({
					palette: [null, "not-a-color", "#123456"],
					defaultForeground: null,
					defaultBackground: "rgb:00/00/00",
				}),
			),
		).toEqual({
			foreground: undefined,
			background: undefined,
			palette: ["#123456"],
		});
	});

	test("falls back to empty colors when unavailable", () => {
		expect(terminalColorsToThemeColors(null)).toEqual({});
	});
});

describe("loadRendererThemeColors", () => {
	test("uses renderer getPalette with bounded timeout", async () => {
		const calls: unknown[] = [];
		const colors = await loadRendererThemeColors(
			{
				getPalette: async (options) => {
					calls.push(options);
					return terminalColors();
				},
			},
			123,
		);

		expect(calls).toEqual([{ size: 16, timeout: 123 }]);
		expect(colors.foreground).toBe("#aabbcc");
	});

	test("returns fallback colors when renderer palette fails", async () => {
		const colors = await loadRendererThemeColors({
			getPalette: async () => {
				throw new Error("palette failed");
			},
		});

		expect(colors).toEqual({});
	});
});
