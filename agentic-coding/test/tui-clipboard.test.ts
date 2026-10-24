import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { copyToClipboard } from "../src/tui/clipboard.ts";

type ExecCall = {
	command: string;
	args: string[];
	input?: string;
	stdio?: unknown;
	timeout?: number;
};

const calls: ExecCall[] = [];
let shouldThrow: (command: string) => boolean = () => false;

const originalPlatform = process.platform;
const originalTmux = process.env.TMUX;

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
let whichSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	calls.length = 0;
	shouldThrow = () => false;
	delete process.env.TMUX;
	whichSpy = spyOn(Bun, "which").mockImplementation((command) => command);
	const fakeSpawnSync = (
		command: string,
		args: string[] = [],
		options: { input?: string; stdio?: unknown; timeout?: number } = {},
	) => {
		calls.push({ command, args, ...options });
		return { status: shouldThrow(command) ? 1 : 0 };
	};
	execSpy = spyOn(childProcess, "spawnSync").mockImplementation(
		// biome-ignore lint/suspicious/noExplicitAny: test double loosely matches spawnSync's overloaded real signature.
		fakeSpawnSync as any,
	);
});

afterEach(() => {
	execSpy.mockRestore();
	whichSpy.mockRestore();
	setPlatform(originalPlatform);
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
});

test("macOS uses pbcopy", () => {
	setPlatform("darwin");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls[0]).toMatchObject({
		command: "pbcopy",
		args: [],
		input: "hello",
	});
});

test("Windows uses clip", () => {
	setPlatform("win32");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls[0]).toMatchObject({ command: "clip", args: [], input: "hello" });
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

test("missing helpers are skipped without spawning or reporting an error", () => {
	setPlatform("linux");
	whichSpy.mockImplementation(() => null);
	const { written, restore } = captureStdoutWrites();
	try {
		expect(copyToClipboard("hello")).toBe(true);
	} finally {
		restore();
	}
	expect(calls).toHaveLength(0);
	expect(written).toEqual(["\x1b]52;c;aGVsbG8=\x07"]);
});

test("clipboard helpers have isolated output and a bounded wait", () => {
	setPlatform("linux");
	expect(copyToClipboard("hello")).toBe(true);
	expect(calls[0]?.stdio).toEqual(["pipe", "ignore", "ignore"]);
	expect(calls[0]?.timeout).toBe(1000);
});

test("spawn failures silently fall back to OSC 52", () => {
	setPlatform("linux");
	execSpy.mockImplementation(() => {
		throw new Error("command not available");
	});
	const { written, restore } = captureStdoutWrites();
	try {
		expect(copyToClipboard("hello")).toBe(true);
	} finally {
		restore();
	}
	expect(written).toEqual(["\x1b]52;c;aGVsbG8=\x07"]);
});

test("failed clipboard tools on macOS report failure without terminal output", () => {
	setPlatform("darwin");
	shouldThrow = () => true;
	const { written, restore } = captureStdoutWrites();
	try {
		expect(copyToClipboard("hello")).toBe(false);
	} finally {
		restore();
	}
	expect(written).toEqual([]);
});
