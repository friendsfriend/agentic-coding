import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { copyToClipboard } from "../src/tui/clipboard";

type ExecCall = { command: string; args: string[]; input?: string };

const calls: ExecCall[] = [];
let shouldThrow: (command: string) => boolean = () => false;

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform });
}

function captureStdoutWrites(): { written: string[]; restore: () => void } {
	const written: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	return {
		written,
		restore: () => {
			process.stdout.write = original;
		},
	};
}

let execSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	calls.length = 0;
	shouldThrow = () => false;
	const fakeExecFileSync = (
		command: string,
		args: string[] = [],
		options: { input?: string } = {},
	) => {
		calls.push({ command, args, input: options?.input });
		if (shouldThrow(command)) throw new Error(`${command}: not found`);
		return Buffer.from("");
	};
	execSpy = spyOn(childProcess, "execFileSync").mockImplementation(
		// biome-ignore lint/suspicious/noExplicitAny: test double loosely matches execFileSync's overloaded real signature.
		fakeExecFileSync as any,
	);
});

afterEach(() => {
	execSpy.mockRestore();
	setPlatform(originalPlatform);
	process.env.TMUX = undefined;
});

test("macOS uses pbcopy", () => {
	setPlatform("darwin");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls).toEqual([{ command: "pbcopy", args: [], input: "hello" }]);
});

test("Windows uses clip", () => {
	setPlatform("win32");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls).toEqual([{ command: "clip", args: [], input: "hello" }]);
});

test("Linux uses wl-copy when it succeeds", () => {
	setPlatform("linux");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls.map((c) => c.command)).toEqual(["wl-copy"]);
});

test("Linux falls back to xclip when wl-copy throws", () => {
	setPlatform("linux");
	shouldThrow = (command) => command === "wl-copy";
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
});

test("Linux falls back to xsel when wl-copy and xclip throw", () => {
	setPlatform("linux");
	shouldThrow = (command) => command === "wl-copy" || command === "xclip";
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls.map((c) => c.command)).toEqual(["wl-copy", "xclip", "xsel"]);
});

test("Linux falls back to OSC 52 and reports success when every command throws", () => {
	setPlatform("linux");
	shouldThrow = () => true;
	const { written, restore } = captureStdoutWrites();
	try {
		expect(copyToClipboard("hello")).toBe(true);
	} finally {
		restore();
	}
	expect(calls.map((c) => c.command)).toEqual(["wl-copy", "xclip", "xsel"]);
	expect(written).toHaveLength(1);
	expect(written[0]).toContain(Buffer.from("hello").toString("base64"));
	expect(written[0]).not.toContain("tmux");
});

test("Linux OSC 52 fallback wraps the sequence for tmux passthrough", () => {
	setPlatform("linux");
	shouldThrow = () => true;
	process.env.TMUX = "1";
	const { written, restore } = captureStdoutWrites();
	try {
		expect(copyToClipboard("hello")).toBe(true);
	} finally {
		restore();
	}
	expect(written[0]).toStartWith("\x1bPtmux;");
	expect(written[0]).toContain(Buffer.from("hello").toString("base64"));
});
