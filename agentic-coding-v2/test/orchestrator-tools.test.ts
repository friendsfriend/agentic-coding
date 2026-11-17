// The orchestrator is a direct conversation: it decides per request whether to act
// in its own checkout or to delegate. These are the pure parts of that contract.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorCodingTools } from "../src/agent-tools.ts";
import { contained } from "../src/git.ts";

test("the orchestrator agent offers file and shell tools next to the orchestrator tools", () => {
	const extension = createOrchestratorCodingTools(async () => "/tmp/checkout"),
		tools = extension.tools ?? [],
		names = tools.map((tool) => tool.name).sort();
	expect(names).toEqual(["bash", "edit", "read", "write"]);
	// A restart must observe the outcome of a command, never re-run it.
	expect(tools.find((tool) => tool.name === "bash")?.replay).toBe("unsafe");
	for (const name of ["read", "write", "edit"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		expect(tool?.parameters).toBeDefined();
		expect(tool?.description?.length).toBeGreaterThan(0);
	}
});

test("an orchestrator tool path stays inside its own checkout", () => {
	// Resolved like the runtime does: a symlinked temp root is not an escape.
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-orchestrator-")),
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
