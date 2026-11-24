import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("issued operations expose redacted live output and clear it on settle", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-live-")),
	);
	const repository = path.join(root, "repo");
	const state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	for (const args of [
		["init", "--quiet"],
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--quiet",
			"-m",
			"fixture",
		],
	]) {
		const child = Bun.spawnSync(["git", "-C", repository, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (child.exitCode !== 0) throw new Error("Fixture Git failed");
	}
	const secret = "live-progress-credential-value";
	process.env.MCP_TEST_LIVE_SECRET = secret;
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		apps: [
			{
				id: "api",
				repository,
				targets: [
					{
						id: "build",
						action: "build",
						runtime: "shell",
						executable: {
							kind: "command",
							program: "/bin/echo",
							args: ["built"],
							envRefs: { TOKEN: "MCP_TEST_LIVE_SECRET" },
						},
					},
				],
			},
		],
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const executor: ExecutionPort = {
		async command({ onOutput, env, redact }) {
			onOutput?.(`live ${env.TOKEN}\n${"x".repeat(70000)}\n`);
			await gate;
			return {
				exitCode: 0,
				timedOut: false,
				output: redact(`live ${env.TOKEN}\n${"x".repeat(70000)}\n`),
				truncated: false,
			};
		},
		async dockerBuild() {
			throw new Error("unused");
		},
		async composeUp() {
			throw new Error("unused");
		},
		async composeContainers() {
			throw new Error("unused");
		},
		async containersReady() {
			throw new Error("unused");
		},
		async probeEndpoints() {
			throw new Error("unused");
		},
		async stopContainers() {
			throw new Error("unused");
		},
		async logs() {
			throw new Error("unused");
		},
	};
	const journal = openOperationJournal(state, [repository]);
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		{
			async inspect() {
				return { status: "absent" as const };
			},
		},
		executor,
		{ get: (reference: string) => process.env[reference] },
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		const admitted = await agent.admit(
			"live",
			{ app: "api", target: "build" },
			signal,
		);
		await agent.execute(admitted.id, signal);
		const opened = agent.read(admitted.id);
		if (!opened.progress) throw new Error("expected live progress");
		expect(opened.progress.text).toContain("live");
		expect(opened.progress.text).not.toContain(secret);
		expect(opened.progress.text).toContain("[REDACTED]");
		expect(opened.progress.text.length).toBe(64 * 1024);
		const remaining = agent.read(admitted.id, opened.progress.offset);
		if (!remaining.progress) throw new Error("expected remaining progress");
		expect(remaining.progress.text).toContain("x");
		expect(remaining.progress.offset).toBeGreaterThan(opened.progress.offset);
		expect(
			agent.read(admitted.id, remaining.progress.offset).progress?.text,
		).toBe("");
		release();
		const settled = await agent.wait(admitted.id, 5, signal);
		expect(settled.receipt).toMatchObject({
			status: "completed",
			kind: "command",
			exitCode: 0,
		});
		expect(agent.read(admitted.id).progress).toBeUndefined();
	} finally {
		delete process.env.MCP_TEST_LIVE_SECRET;
	}
});
