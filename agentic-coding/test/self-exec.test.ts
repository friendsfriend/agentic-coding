// Self-re-exec discrimination: a compiled binary must run itself, a source run
// must re-exec the CLI entry. Getting this wrong makes `agentic-coding workflow
// start` hand its own path as the first argument and the detached drain answers
// `unknown agentic-coding command: <path>`, so the workflow never spawns.
import { describe, expect, test } from "bun:test";
import { isCompiledBinary, selfExecEntry } from "../src/self-exec.ts";

describe("self re-exec entry", () => {
	test("a single-file compile reports $bunfs", () => {
		expect(isCompiledBinary("$bunfs/root/agentic-coding", "/usr/bin/bun")).toBe(
			true,
		);
		expect(
			selfExecEntry("$bunfs/root/agentic-coding", "/usr/bin/bun"),
		).toBeUndefined();
	});

	test("a bundled build reports its executable path, not $bunfs", () => {
		// The regression: `Bun.main` is the executable path here, and passing it
		// as the first argument is an unknown command.
		expect(
			isCompiledBinary(
				"/Users/u/agentic-coding/dist/agentic-coding",
				"/Users/u/agentic-coding/dist/agentic-coding",
			),
		).toBe(true);
		expect(
			selfExecEntry(
				"/Users/u/agentic-coding/dist/agentic-coding",
				"/Users/u/agentic-coding/dist/agentic-coding",
			),
		).toBeUndefined();
	});

	test("a source run re-execs the CLI entry", () => {
		expect(isCompiledBinary("/pkg/src/cli.ts", "/usr/bin/bun")).toBe(false);
		expect(selfExecEntry("/pkg/src/cli.ts", "/usr/bin/bun")).toBe(
			"/pkg/src/cli.ts",
		);
	});
});
