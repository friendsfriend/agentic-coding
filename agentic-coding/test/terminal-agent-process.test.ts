import { expect, test } from "bun:test";
import {
	startOpenCode,
	startPi,
} from "../src/tui/otel/app/terminal-agent-process.ts";

test("OpenCode reports a missing project directory before spawning a PTY", () => {
	const cwd = `/nonexistent-opencode-project-${crypto.randomUUID()}`;
	expect(() =>
		startOpenCode({ cwd, cols: 80, rows: 24, onData: () => {} }),
	).toThrow(
		`OpenCode project directory does not exist or is not accessible: ${JSON.stringify(cwd)}`,
	);
});

test("Pi reports a missing project directory before spawning a PTY", () => {
	const cwd = `/nonexistent-pi-project-${crypto.randomUUID()}`;
	expect(() => startPi({ cwd, cols: 80, rows: 24, onData: () => {} })).toThrow(
		`Pi project directory does not exist or is not accessible: ${JSON.stringify(cwd)}`,
	);
});
