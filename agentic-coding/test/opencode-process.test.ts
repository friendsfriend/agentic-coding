import { expect, test } from "bun:test";
import { startOpenCode } from "../src/tui/otel/app/opencode-process.ts";

test("OpenCode reports a missing project directory before spawning a PTY", () => {
	const cwd = `/nonexistent-opencode-project-${crypto.randomUUID()}`;
	expect(() =>
		startOpenCode({ cwd, cols: 80, rows: 24, onData: () => {} }),
	).toThrow(
		`OpenCode project directory does not exist or is not accessible: ${JSON.stringify(cwd)}`,
	);
});
