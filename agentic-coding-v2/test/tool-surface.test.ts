// What a task and an orchestrator are actually offered. Every tool a
// conversation can call comes from an extension, so the file and shell tools are
// declared here as the runtime's own: the tool that runs is the one the runtime
// registered, in the workspace the conversation was configured with.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentTools, createCodingTools } from "../src/agent-tools.ts";
import type { Config } from "../src/config.ts";
import { contained } from "../src/git.ts";

test("a task carries its own tools and an unwrapped copy of the runtime's", () => {
	const extension = createAgentTools(
		{ stateDir: "/tmp" } as Config,
		async () => {
			throw new Error("listing tools runs none");
		},
	);
	// `attach_image` was the image case of the same store: one name remains, and
	// `kind` says which artifact the caller is retaining.
	expect((extension.tools ?? []).map((tool) => tool.name)).toEqual([
		"ask_user_question",
		"request_review",
		"attach_evidence",
	]);
	// No rewritten `execute`, no inserted approval, no replaced replay rule: an
	// interrupted command is never re-run automatically.
	for (const tool of createCodingTools().tools ?? []) {
		expect(tool.replay).toBeUndefined();
		expect(tool.executionMode).toBeUndefined();
	}
	expect((createCodingTools().tools ?? []).map((tool) => tool.name)).toEqual([
		"read",
		"write",
		"edit",
		"bash",
	]);
});

test("a task path still resolves inside its own workspace", () => {
	// Resolved like the runtime does: a symlinked temp root is not an escape.
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-workspace-")),
	);
	try {
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(path.join(root, "src", "file.ts"), "export {};\n");
		expect(contained(root, "src/file.ts")).toBe(
			path.join(root, "src", "file.ts"),
		);
		// A file that does not exist yet is still a valid confined target.
		expect(contained(root, "src/new.ts")).toBe(
			path.join(root, "src", "new.ts"),
		);
		for (const outside of [
			"../escape.ts",
			"/etc/passwd",
			"src/../../escape.ts",
		])
			expect(() => contained(root, outside)).toThrow(
				"Path outside task workspace",
			);
		expect(() => contained(root, ".git/config")).toThrow(
			"Path outside task workspace",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
