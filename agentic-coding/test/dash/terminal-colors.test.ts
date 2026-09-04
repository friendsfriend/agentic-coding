import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadThemeName,
	saveThemeName,
} from "../../src/tui/dash/theme-settings";
import {
	buildSystemTheme,
	parseOscReply,
	readTerminalPalette,
} from "../../src/tui/dash/ui/terminal-colors";
import {
	setActiveThemeName,
	setSystemTheme,
	themeColor,
	themeColorForTheme,
	themeNames,
} from "../../src/tui/dash/ui/theme";

/** Fake data source satisfying ByteSource; tests drive it with emit(). */
class FakeSource {
	private listeners = new Set<(chunk: Buffer) => void>();
	removedListeners = 0;

	on(event: "data", listener: (chunk: Buffer) => void): this {
		if (event === "data") this.listeners.add(listener);
		return this;
	}

	removeListener(event: "data", listener: (chunk: Buffer) => void): this {
		if (event === "data") {
			this.listeners.delete(listener);
			this.removedListeners += 1;
		}
		return this;
	}

	emit(text: string) {
		const chunk = Buffer.from(text, "latin1");
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

const BEL = "\x07";
const ST = "\x1b\\";
const ansiReply = (index: number, rgb: string) =>
	`\x1b]4;${index};rgb:${rgb}${BEL}`;
const fgReply = (rgb: string) => `\x1b]10;rgb:${rgb}${BEL}`;
const bgReply = (rgb: string) => `\x1b]11;rgb:${rgb}${BEL}`;
const pad = (value: number) => value.toString(16).padStart(2, "0");

/** All 18 expected replies; ANSI entry i is `#i_i_i_` (16-bit `iiff` channels). */
const fullReplyStream = (prefix = "") =>
	prefix +
	Array.from({ length: 16 }, (_, i) =>
		ansiReply(i, `${pad(i)}ff/${pad(i)}ff/${pad(i)}ff`),
	).join("") +
	fgReply("ffff/ffff/ffff") +
	bgReply("0000/0000/0000");

describe("parseOscReply", () => {
	it("parses a BEL-terminated OSC 4 reply into the ANSI code and hex", () => {
		expect(parseOscReply(`\x1b]4;3;rgb:8080/8080/8080${BEL}`)).toEqual({
			osc: 4,
			code: 3,
			hex: "#808080",
		});
	});

	it("tolerates the ST terminator", () => {
		expect(parseOscReply(`\x1b]4;3;rgb:8080/8080/8080${ST}`)).toEqual({
			osc: 4,
			code: 3,
			hex: "#808080",
		});
	});

	it("downscales 16-bit-per-channel values to #rrggbb", () => {
		expect(parseOscReply(`\x1b]4;3;rgb:cd00/cd00/cd00${BEL}`)).toEqual({
			osc: 4,
			code: 3,
			hex: "#cdcdcd",
		});
	});

	it("accepts 8-bit-per-channel values", () => {
		expect(parseOscReply(`\x1b]4;5;rgb:cd/cd/cd${BEL}`)).toEqual({
			osc: 4,
			code: 5,
			hex: "#cdcdcd",
		});
	});

	it("parses OSC 10 (fg) and OSC 11 (bg) replies", () => {
		expect(parseOscReply(`\x1b]10;rgb:ffff/ffff/ffff${BEL}`)).toEqual({
			osc: 10,
			code: 10,
			hex: "#ffffff",
		});
		expect(parseOscReply(`\x1b]11;rgb:0000/0000/0000${BEL}`)).toEqual({
			osc: 11,
			code: 11,
			hex: "#000000",
		});
	});

	it("handles rgba replies and uppercase hex", () => {
		expect(parseOscReply(`\x1b]4;3;rgba:8080/8080/8080/ffff${BEL}`)).toEqual({
			osc: 4,
			code: 3,
			hex: "#808080",
		});
		expect(parseOscReply(`\x1b]4;1;rgb:FF00/0000/0000${BEL}`)).toEqual({
			osc: 4,
			code: 1,
			hex: "#ff0000",
		});
	});

	it("returns null for malformed, partial, or non-color input", () => {
		expect(parseOscReply("no osc here")).toBeNull();
		expect(parseOscReply(`\x1b]4;3;rgb:8080/8080/8080`)).toBeNull();
		expect(parseOscReply(`\x1b]4;3;nope${BEL}`)).toBeNull();
		expect(parseOscReply(`\x1b]4;rgb:8080/8080/8080${BEL}`)).toBeNull();
		expect(parseOscReply(`\x1b]5;3;rgb:8080/8080/8080${BEL}`)).toBeNull();
		expect(parseOscReply(`\x1b]4;3;rgb:8/80/80${BEL}`)).toBeNull();
		expect(parseOscReply(`\x1b]4;3;rgb:8080/8080${BEL}`)).toBeNull();
	});
});

describe("readTerminalPalette", () => {
	it("captures the palette when all replies arrive in one chunk", async () => {
		const source = new FakeSource();
		const promise = readTerminalPalette(source, 100);
		source.emit(fullReplyStream());
		const result = await promise;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.palette.fg).toBe("#ffffff");
		expect(result.palette.bg).toBe("#000000");
		expect(result.palette.ansi).toHaveLength(16);
		expect(result.palette.ansi[0]).toBe("#000000");
		expect(result.palette.ansi[10]).toBe("#0a0a0a");
		expect(result.palette.ansi[11]).toBe("#0b0b0b");
		expect(result.palette.ansi[15]).toBe("#0f0f0f");
	});

	it("assembles replies split across chunks and skips leading noise", async () => {
		const source = new FakeSource();
		const promise = readTerminalPalette(source, 100);
		const stream = fullReplyStream("noise-bytes-before");
		const splitAt = Math.floor(stream.length / 2);
		source.emit(stream.slice(0, splitAt));
		source.emit(stream.slice(splitAt));
		const result = await promise;
		expect(result).toEqual({
			ok: true,
			palette: {
				ansi: Array.from(
					{ length: 16 },
					(_, i) => `#${pad(i)}${pad(i)}${pad(i)}`,
				),
				fg: "#ffffff",
				bg: "#000000",
			},
		});
	});

	it("times out with { ok: false } when the terminal never answers", async () => {
		const source = new FakeSource();
		const result = await readTerminalPalette(source, 20);
		expect(result).toEqual({ ok: false });
		expect(source.removedListeners).toBe(1);
	});

	it("returns { ok: false } on timeout even with a partial palette", async () => {
		const source = new FakeSource();
		const promise = readTerminalPalette(source, 20);
		source.emit(
			ansiReply(0, "0100/0100/0100") + ansiReply(1, "0101/0101/0101"),
		);
		const result = await promise;
		expect(result).toEqual({ ok: false });
	});
});

describe("buildSystemTheme", () => {
	const palette = {
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

	it("maps background and text from the default fg/bg", () => {
		const theme = buildSystemTheme(palette);
		expect(theme.theme.background).toBe("#101010");
		expect(theme.theme.text).toBe("#ffffff");
	});

	it("maps semantic keys from the ANSI palette", () => {
		const theme = buildSystemTheme(palette);
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
		const theme = buildSystemTheme(palette);
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
		const theme = buildSystemTheme(palette);
		expect(theme.theme.diffAdded).toBe(theme.theme.success);
		expect(theme.theme.diffRemoved).toBe(theme.theme.error);
		expect(theme.theme.diffContext).toBe(theme.theme.textMuted);
		expect(theme.theme.syntaxKeyword).toBe(theme.theme.accent);
		expect(theme.theme.syntaxString).toBe(theme.theme.success);
		expect(theme.theme.markdownHeading).toBe(theme.theme.accent);
	});

	it("covers every theme key with a concrete #rrggbb value", () => {
		const theme = buildSystemTheme(palette);
		const keys = Object.keys(theme.theme);
		expect(keys.length).toBeGreaterThan(20);
		for (const key of keys) {
			const value = theme.theme[key];
			expect(value).toBeTypeOf("string");
			expect(value).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe("system theme registration", () => {
	const built = buildSystemTheme({
		ansi: Array.from({ length: 16 }, (_, i) => `#${pad(i)}${pad(i)}${pad(i)}`),
		fg: "#f0f0f0",
		bg: "#101010",
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

	it("falls back to the default theme when a saved `system` name has no captured theme", () => {
		const dir = mkdtempSync(join(tmpdir(), "system-theme-config-"));
		const file = join(dir, "herdr-workflow.toml");
		writeFileSync(file, '[ui]\ntheme = "system"\n');
		try {
			process.env.HERDR_WORKFLOW_CONFIG = file;
			expect(loadThemeName()).toBe("catppuccin");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips a saved `system` selection through persistence when registered", () => {
		setSystemTheme(built);
		const dir = mkdtempSync(join(tmpdir(), "system-theme-config-"));
		const file = join(dir, "herdr-workflow.toml");
		try {
			process.env.HERDR_WORKFLOW_CONFIG = file;
			saveThemeName("system");
			expect(loadThemeName()).toBe("system");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
