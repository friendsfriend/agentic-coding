import { describe, expect, test } from "bun:test";
import { ansiToStyledText, stripAnsi } from "./ansiToStyledText";

function firstChunk(result: ReturnType<typeof ansiToStyledText>) {
	if (!result) throw new Error("expected StyledText");
	return result.chunks[0];
}

describe("stripAnsi", () => {
	test("returns input unchanged when no escapes present", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
		expect(stripAnsi("")).toBe("");
	});

	test("strips standard 16-colour SGR sequences", () => {
		expect(stripAnsi("\x1b[36mhello\x1b[0m")).toBe("hello");
		expect(stripAnsi("\x1b[33m11:39:58\x1b[0;39m")).toBe("11:39:58");
	});

	test("strips compound reset codes like 0;39", () => {
		expect(stripAnsi("\x1b[0;39mtext\x1b[0m")).toBe("text");
	});

	test("strips the exact log format seen in real output", () => {
		const line =
			"\x1b[36m \x1b[0;39m  \x1b[33m11:39:58.669\x1b[0;39m  \x1b[34mINFO\x1b[0;39m  message";
		expect(stripAnsi(line)).toBe("   11:39:58.669  INFO  message");
	});

	test("strips 256-colour codes", () => {
		expect(stripAnsi("\x1b[38;5;200mtext\x1b[0m")).toBe("text");
	});

	test("strips truecolour codes", () => {
		expect(stripAnsi("\x1b[38;2;255;128;0mtext\x1b[0m")).toBe("text");
	});
});

describe("ansiToStyledText", () => {
	test("returns null for plain text (no escape sequences)", () => {
		expect(ansiToStyledText("hello world")).toBeNull();
		expect(ansiToStyledText("")).toBeNull();
	});

	test("returns null when escape sequences produce no visible chunks", () => {
		expect(ansiToStyledText("\x1b[0m")).toBeNull();
	});

	test("parses single-colour sequence into one chunk with fg set", () => {
		const result = ansiToStyledText("\x1b[36mhello\x1b[0m");
		expect(result).not.toBeNull();
		expect(result?.chunks).toHaveLength(1);
		const chunk = firstChunk(result);
		expect(chunk.text).toBe("hello");
		expect(chunk.fg).toBeDefined();
	});

	test("parses multi-segment line — each segment gets correct fg", () => {
		const line =
			"\x1b[36m \x1b[0;39m  \x1b[33m11:39:58.669\x1b[0;39m  \x1b[34mINFO\x1b[0;39m  message";
		const result = ansiToStyledText(line);
		expect(result).not.toBeNull();

		const chunks = result?.chunks ?? [];
		const texts = chunks.map((c) => c.text);
		const joined = texts.join("");
		expect(joined).toBe("   11:39:58.669  INFO  message");

		expect(chunks[0]?.text).toBe(" ");
		expect(chunks[0]?.fg).toBeDefined();

		const tsChunk = chunks.find((c) => c.text === "11:39:58.669");
		expect(tsChunk).toBeDefined();
		expect(tsChunk?.fg).toBeDefined();

		const infoChunk = chunks.find((c) => c.text === "INFO");
		expect(infoChunk).toBeDefined();
		expect(infoChunk?.fg).toBeDefined();
	});

	test("compound reset code 0;39 clears fg for subsequent text", () => {
		const result = ansiToStyledText("\x1b[36mcolored\x1b[0;39m plain");
		expect(result).not.toBeNull();
		const chunks = result?.chunks ?? [];

		const coloredChunk = chunks.find((c) => c.text === "colored");
		expect(coloredChunk?.fg).toBeDefined();

		const plainChunk = chunks.find((c) => c.text === " plain");
		expect(plainChunk).toBeDefined();
		expect(plainChunk?.fg).toBeUndefined();
	});

	test("bold attribute is captured in chunk", () => {
		const result = ansiToStyledText("\x1b[1mBOLD\x1b[0m");
		expect(result).not.toBeNull();
		const chunk = firstChunk(result);
		expect(chunk.text).toBe("BOLD");
		expect(chunk.attributes).toBeDefined();
		expect((chunk.attributes ?? 0) & 1).toBeTruthy();
	});

	test("256-colour fg is parsed correctly", () => {
		const result = ansiToStyledText("\x1b[38;5;82mgreen\x1b[0m");
		expect(result).not.toBeNull();
		const chunk = firstChunk(result);
		expect(chunk.text).toBe("green");
		expect(chunk.fg).toBeDefined();
	});

	test("truecolour fg is parsed correctly", () => {
		const result = ansiToStyledText("\x1b[38;2;255;128;0morange\x1b[0m");
		expect(result).not.toBeNull();
		const chunk = firstChunk(result);
		expect(chunk.text).toBe("orange");
		expect(chunk.fg).toBeDefined();
	});

	test("bg colour is captured in chunk", () => {
		const result = ansiToStyledText("\x1b[41mred bg\x1b[0m");
		expect(result).not.toBeNull();
		const chunk = firstChunk(result);
		expect(chunk.bg).toBeDefined();
	});

	test("text after all resets has no fg/bg/attributes", () => {
		const result = ansiToStyledText("\x1b[36mcolored\x1b[0m plain");
		const plainChunk = result?.chunks.find((c) => c.text === " plain");
		expect(plainChunk).toBeDefined();
		expect(plainChunk?.fg).toBeUndefined();
		expect(plainChunk?.bg).toBeUndefined();
		expect(plainChunk?.attributes).toBeUndefined();
	});
});
