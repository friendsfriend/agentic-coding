import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	piDurableRuntimeDir,
	piDurableSessionFile,
} from "../src/pi-durable-state.ts";
import {
	openPiDurableSession,
	piDurableHostEnv,
} from "../src/tui/pi-durable/session.ts";

test("corrupt active binding fails before starting a host or creating a conversation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-"));
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	try {
		const runtimeDir = piDurableRuntimeDir(root);
		fs.mkdirSync(runtimeDir, { recursive: true });
		const file = piDurableSessionFile(runtimeDir);
		fs.writeFileSync(file, "{broken");
		await expect(openPiDurableSession()).rejects.toThrow(
			"no replacement conversation was created",
		);
		expect(fs.readFileSync(file, "utf8")).toBe("{broken");
		expect(fs.readdirSync(runtimeDir).sort()).toEqual([
			"session.json",
			"sessions.lock",
		]);
	} finally {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("workflowless host still strips operator capabilities without mutating its parent", () => {
	const parent = {
		AGENTIC_WORKFLOW_TOKEN: "synthetic-workflow",
		AGENTIC_ORCHESTRATOR_TOKEN: "synthetic-home",
		AGENTIC_ORCHESTRATOR_URL: "http://example.invalid/home",
		AGENTIC_ENV_TOKEN: "synthetic-env",
		AGENTIC_ENV_URL: "http://example.invalid/env",
		AGENTIC_ENV_OWNER: "synthetic-owner",
		AGENTIC_SERVER_TOKEN: "synthetic-server",
		AGENTIC_DEVENV_TOKEN: "synthetic-environment",
		AGENTIC_WORKFLOW_URL: "http://example.invalid",
		PATH: "/synthetic/bin",
	};
	expect(piDurableHostEnv(parent)).toEqual({ PATH: "/synthetic/bin" });
	expect(parent.AGENTIC_WORKFLOW_TOKEN).toBe("synthetic-workflow");
});
