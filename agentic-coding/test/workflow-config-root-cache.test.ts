// Focused coverage for the repository-root memo used by config reads: the
// agent configuration editor re-reads config many times per render, so the
// `git rev-parse --git-common-dir` lookup must run once per repository rather
// than once per read.
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigWithProvenance } from "../src/workflow/effects";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

test("repeated config reads resolve the repository git root once", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-root-cache-"));
	roots.push(dir);
	const previousEnv = process.env.HERDR_WORKFLOW_CONFIG;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	let revParseCalls = 0;
	const spy = spyOn(Bun, "spawnSync").mockImplementation((cmd) => {
		const args = Array.isArray(cmd) ? cmd : [];
		if (args.includes("rev-parse")) {
			revParseCalls += 1;
			return {
				stdout: Buffer.from(".git\n"),
				stderr: Buffer.from(""),
				exitCode: 0,
				// biome-ignore lint/suspicious/noExplicitAny: partial spawn result stub
			} as any;
		}
		return {
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
			exitCode: 1,
			// biome-ignore lint/suspicious/noExplicitAny: partial spawn result stub
		} as any;
	});
	try {
		loadConfigWithProvenance(dir);
		loadConfigWithProvenance(dir);
		loadConfigWithProvenance(dir);
		expect(revParseCalls).toBe(1);
	} finally {
		spy.mockRestore();
		if (previousEnv === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousEnv;
	}
});
