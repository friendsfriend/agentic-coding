import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalColors } from "@opentui/core";
import {
	setActiveThemeName,
	setCustomThemes,
	setSystemTheme,
	themeColor,
	themeColorForTheme,
	themeNames,
} from "@ui";
import {
	loadCustomThemes,
	loadThemeName,
	saveThemeName,
	themeSettingsPath,
} from "../../src/tui/dash/theme-settings";
import {
	buildSystemTheme,
	captureRendererPalette,
	terminalColorsToThemeColors,
} from "../../src/tui/dash/ui/terminal-colors";

const pad = (value: number) => value.toString(16).padStart(2, "0");

const terminalColors = (
	overrides: Partial<TerminalColors> = {},
): TerminalColors => ({
	palette: Array.from(
		{ length: 16 },
		(_, idx) => `#${pad(idx)}${pad(idx)}${pad(idx)}`,
	),
	defaultForeground: "#aabbcc",
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

const capturePalette = {
	ansi: [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	],
	fg: "#ffffff",
	bg: "#101010",
};

describe("terminalColorsToThemeColors", () => {
	it("normalizes renderer colors and drops invalid entries", () => {
		expect(terminalColorsToThemeColors(terminalColors())).toEqual({
			foreground: "#aabbcc",
			background: "#112233",
			palette: Array.from(
				{ length: 16 },
				(_, idx) => `#${pad(idx)}${pad(idx)}${pad(idx)}`,
			),
		});
		expect(
			terminalColorsToThemeColors(
				terminalColors({
					palette: [null, "not-a-color", "#123456"] as unknown as string[],
					defaultForeground: null,
					defaultBackground: null,
				}),
			),
		).toEqual({
			foreground: undefined,
			background: undefined,
			palette: [undefined, undefined, "#123456"],
		});
	});
});

describe("captureRendererPalette", () => {
	it("captures a valid palette from the renderer palette API", async () => {
		const result = await captureRendererPalette({
			getPalette: async () => terminalColors(),
		});
		expect(result?.fg).toBe("#aabbcc");
		expect(result?.bg).toBe("#112233");
		expect(result?.ansi).toHaveLength(16);
	});

	it("keeps unanswered palette slots on their original ANSI index", async () => {
		const result = await captureRendererPalette({
			getPalette: async () =>
				terminalColors({
					palette: ["#111111", null, "#333333"] as unknown as string[],
				}),
		});
		expect(result?.ansi).toHaveLength(16);
		expect(result?.ansi[0]).toBe("#111111");
		// Slot 1 was unanswered, so it falls back per index rather than shifting
		// the captured slot 2 color down into it.
		expect(result?.ansi[1]).toBe("#800000");
		expect(result?.ansi[2]).toBe("#333333");
	});

	it("returns null when the renderer has no palette API (headless)", async () => {
		expect(await captureRendererPalette({})).toBeNull();
	});

	it("returns null when the renderer query rejects", async () => {
		expect(
			await captureRendererPalette({
				getPalette: async () => {
					throw new Error("no tty");
				},
			}),
		).toBeNull();
	});

	it("returns null when the query resolves without usable colors", async () => {
		expect(
			await captureRendererPalette({
				getPalette: async () =>
					terminalColors({
						palette: [],
						defaultForeground: null,
						defaultBackground: null,
					}),
			}),
		).toBeNull();
		// The real renderer answers a headless/timed-out query with a 16-slot
		// all-null palette, not an empty array: it must not register `system`
		// from the hardcoded ANSI fallbacks.
		expect(
			await captureRendererPalette({
				getPalette: async () =>
					terminalColors({
						palette: Array.from(
							{ length: 16 },
							() => null,
						) as unknown as string[],
						defaultForeground: null,
						defaultBackground: null,
					}),
			}),
		).toBeNull();
	});

	it("times out a hung query instead of blocking startup", async () => {
		const result = await captureRendererPalette(
			{ getPalette: () => new Promise<TerminalColors>(() => {}) },
			10,
		);
		expect(result).toBeNull();
	});
});

describe("buildSystemTheme", () => {
	it("maps background and text from the default fg/bg", () => {
		const theme = buildSystemTheme(capturePalette);
		expect(theme.theme.background).toBe("#101010");
		expect(theme.theme.text).toBe("#ffffff");
	});

	it("maps semantic keys from the ANSI palette", () => {
		const theme = buildSystemTheme(capturePalette);
		expect(theme.theme.error).toBe("#800000");
		expect(theme.theme.success).toBe("#008000");
		expect(theme.theme.warning).toBe("#808000");
		expect(theme.theme.primary).toBe("#000080");
		expect(theme.theme.accent).toBe("#800080");
		expect(theme.theme.info).toBe("#008080");
		expect(theme.theme.secondary).toBe("#0000ff");
		expect(theme.theme.textMuted).toBe("#808080");
	});

	it("derives surfaces and borders distinct from the background", () => {
		const theme = buildSystemTheme(capturePalette);
		for (const key of [
			"backgroundPanel",
			"backgroundElement",
			"border",
			"borderActive",
			"borderSubtle",
		]) {
			expect(theme.theme[key]).toBeTruthy();
			expect(theme.theme[key]).not.toBe("#101010");
		}
		expect(theme.theme.borderActive).not.toBe(theme.theme.border);
	});

	it("maps diff/markdown/syntax keys to captured-derived colors", () => {
		const theme = buildSystemTheme(capturePalette);
		expect(theme.theme.diffAdded).toBe(theme.theme.success);
		expect(theme.theme.diffRemoved).toBe(theme.theme.error);
		expect(theme.theme.diffContext).toBe(theme.theme.textMuted);
		expect(theme.theme.syntaxKeyword).toBe(theme.theme.accent);
		expect(theme.theme.syntaxString).toBe(theme.theme.success);
		expect(theme.theme.markdownHeading).toBe(theme.theme.accent);
	});

	it("covers every theme key with a concrete #rrggbb value", () => {
		const theme = buildSystemTheme(capturePalette);
		const keys = Object.keys(theme.theme);
		expect(keys.length).toBeGreaterThan(20);
		for (const key of keys) {
			const value = theme.theme[key];
			expect(value).toBeTypeOf("string");
			expect(value).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe("UI preferences", () => {
	let dir: string;
	let previousConfigDir: string | undefined;
	let previousLegacy: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ui-prefs-"));
		previousConfigDir = process.env.DEVENV_CONFIG_DIR;
		previousLegacy = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.DEVENV_CONFIG_DIR = dir;
		delete process.env.HERDR_WORKFLOW_CONFIG;
	});

	afterEach(() => {
		if (previousConfigDir === undefined) delete process.env.DEVENV_CONFIG_DIR;
		else process.env.DEVENV_CONFIG_DIR = previousConfigDir;
		if (previousLegacy === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousLegacy;
		rmSync(dir, { recursive: true, force: true });
	});

	it("canonical selection takes precedence over the legacy file", () => {
		writeFileSync(themeSettingsPath(), JSON.stringify({ theme: "nord" }));
		const legacy = join(dir, "herdr-workflow.toml");
		writeFileSync(legacy, '[ui]\ntheme = "dracula"\n');
		process.env.HERDR_WORKFLOW_CONFIG = legacy;
		expect(loadThemeName()).toBe("nord");
	});

	it("imports a valid legacy selection preserving unrelated keys", () => {
		const canonical = join(dir, "tui.json");
		writeFileSync(canonical, JSON.stringify({ fontSize: 13 }));
		const legacy = join(dir, "herdr-workflow.toml");
		writeFileSync(legacy, `[ui]\ntheme = "dracula"\n`);
		process.env.HERDR_WORKFLOW_CONFIG = legacy;
		expect(loadThemeName()).toBe("dracula");
		expect(JSON.parse(String(readFileSync(canonical)))).toEqual({
			fontSize: 13,
			theme: "dracula",
		});
	});

	it("defaults to catppuccin with no canonical or legacy selection", () => {
		// Point the legacy path at a file that cannot exist so the assertion is
		// independent of the developer's real ~/dotfiles config.
		process.env.HERDR_WORKFLOW_CONFIG = join(dir, "missing-legacy.toml");
		expect(loadThemeName()).toBe("catppuccin");
	});

	it("keeps a persisted system selection that is not captured yet", () => {
		// `system` is only registered after a successful capture, but a saved
		// selection must survive a capture failure instead of being replaced by
		// the legacy file.
		writeFileSync(themeSettingsPath(), JSON.stringify({ theme: "system" }));
		const legacy = join(dir, "herdr-workflow.toml");
		writeFileSync(legacy, '[ui]\ntheme = "dracula"\n');
		process.env.HERDR_WORKFLOW_CONFIG = legacy;
		expect(loadThemeName()).toBe("catppuccin");
		expect(JSON.parse(String(readFileSync(themeSettingsPath())))).toEqual({
			theme: "system",
		});
	});

	it("ignores a legacy `theme` key outside the [ui] table", () => {
		const legacy = join(dir, "herdr-workflow.toml");
		writeFileSync(
			legacy,
			'[ui]\nfontSize = 12\n\n[workflow]\ntheme = "dracula"\n',
		);
		process.env.HERDR_WORKFLOW_CONFIG = legacy;
		expect(loadThemeName()).toBe("catppuccin");
	});

	it("ignores a legacy `system` name that was never captured", () => {
		const legacy = join(dir, "herdr-workflow.toml");
		writeFileSync(legacy, '[ui]\ntheme = "system"\n');
		process.env.HERDR_WORKFLOW_CONFIG = legacy;
		expect(loadThemeName()).toBe("catppuccin");
	});

	it("saves atomically while preserving unrelated keys", () => {
		writeFileSync(themeSettingsPath(), JSON.stringify({ keymap: "vim" }));
		saveThemeName("nord");
		expect(JSON.parse(String(readFileSync(themeSettingsPath())))).toEqual({
			keymap: "vim",
			theme: "nord",
		});
	});

	it("rejects an invalid theme name without touching the saved file", () => {
		writeFileSync(themeSettingsPath(), JSON.stringify({ theme: "nord" }));
		expect(() => saveThemeName("not-a-theme")).toThrow();
		expect(JSON.parse(String(readFileSync(themeSettingsPath())))).toEqual({
			theme: "nord",
		});
	});

	it("loads valid custom themes and rejects reserved or colliding names", () => {
		const themes = join(dir, "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(
			join(themes, "my-theme.json"),
			JSON.stringify({ theme: { text: "#ffffff" } }),
		);
		writeFileSync(
			join(themes, "system.json"),
			JSON.stringify({ theme: { text: "#000000" } }),
		);
		writeFileSync(
			join(themes, "nord.json"),
			JSON.stringify({ theme: { text: "#123456" } }),
		);
		// Names that exist on Object.prototype must still load: the duplicate
		// check must test own keys, not the prototype chain.
		writeFileSync(
			join(themes, "constructor.json"),
			JSON.stringify({ theme: { text: "#abcdef" } }),
		);
		writeFileSync(
			join(themes, "toString.json"),
			JSON.stringify({ theme: { text: "#fedcba" } }),
		);
		const loaded = loadCustomThemes();
		expect(Object.keys(loaded).sort()).toEqual([
			"constructor",
			"my-theme",
			"toString",
		]);
		expect(setActiveThemeName("my-theme")).toBe(true);
		expect(setActiveThemeName("constructor")).toBe(true);
		expect(themeColorForTheme("constructor", "text", "fallback")).toBe(
			"#abcdef",
		);
		expect(themeColorForTheme("toString", "text", "fallback")).toBe("#fedcba");
		// A colliding custom file never overwrites the bundled theme.
		expect(themeNames).toContain("nord");
		expect(themeColorForTheme("nord", "text", "fallback")).not.toBe("#123456");
		setCustomThemes({});
	});
});

describe("system theme registration", () => {
	let dir: string;
	let previousConfigDir: string | undefined;

	const built = buildSystemTheme({
		ansi: Array.from({ length: 16 }, (_, i) => `#${pad(i)}${pad(i)}${pad(i)}`),
		fg: "#f0f0f0",
		bg: "#101010",
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "system-theme-config-"));
		previousConfigDir = process.env.DEVENV_CONFIG_DIR;
		process.env.DEVENV_CONFIG_DIR = dir;
	});

	afterEach(() => {
		setSystemTheme(undefined);
		setActiveThemeName("catppuccin");
		if (previousConfigDir === undefined) delete process.env.DEVENV_CONFIG_DIR;
		else process.env.DEVENV_CONFIG_DIR = previousConfigDir;
		rmSync(dir, { recursive: true, force: true });
	});

	afterAll(() => {
		setSystemTheme(undefined);
		setActiveThemeName("catppuccin");
	});

	it("is offered, selectable, and resolves captured colors once registered", () => {
		expect(themeNames).not.toContain("system");
		setSystemTheme(built);
		expect(themeNames).toContain("system");
		expect(setActiveThemeName("system")).toBe(true);
		expect(themeColor("background", "fallback")).toBe("#101010");
		expect(themeColor("text", "fallback")).toBe("#f0f0f0");
		expect(themeColor("error", "fallback")).toBe("#010101");
		expect(themeColorForTheme("system", "primary", "fallback")).toBe("#040404");
	});

	it("is absent and unselectable when no system theme is registered", () => {
		setSystemTheme(undefined);
		expect(themeNames).not.toContain("system");
		expect(setActiveThemeName("system")).toBe(false);
		// Selection falls back to the default theme, not the captured palette.
		expect(themeColor("background", "fallback")).toBe(
			themeColorForTheme("catppuccin", "background", "fallback"),
		);
		expect(themeColorForTheme("system", "primary", "fallback")).toBe(
			"fallback",
		);
	});

	it("round-trips a saved `system` selection through persistence", () => {
		setSystemTheme(built);
		saveThemeName("system");
		expect(loadThemeName()).toBe("system");
	});
});
