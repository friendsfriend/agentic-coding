import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort, ProcessHandle } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("direct shell run keeps process ownership, logs and stop in the scope", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-process-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	const script = path.join(repository, "run.sh");
	fs.writeFileSync(script, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
	for (const args of [
		["init", "--quiet"],
		["add", "run.sh"],
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
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		apps: [
			{
				id: "web",
				repository,
				targets: [
					{
						id: "dev",
						action: "run",
						runtime: "shell",
						executable: {
							kind: "process",
							program: script,
							args: [],
							readyText: "ready",
							telemetry: "otlp-http-json",
							timeoutSec: 5,
						},
					},
				],
			},
		],
	});
	const linked = path.join(root, "linked");
	const worktree = Bun.spawnSync(
		[
			"git",
			"-C",
			repository,
			"worktree",
			"add",
			"--quiet",
			"-b",
			"linked",
			linked,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	if (worktree.exitCode !== 0) throw new Error("Fixture worktree failed");
	let stopped = 0;
	let exited = false;
	let startedCwd: string | undefined;
	let startedProgram: string | undefined;
	let telemetryEnvironment: Record<string, string> | undefined;
	const handle: ProcessHandle = {
		pid: 4242,
		async ready() {
			return true;
		},
		output: () => "ready\nline",
		exited: () => exited,
		exitCode: () => (exited ? 0 : null),
		async stop() {
			stopped++;
			exited = true;
			return true;
		},
	};
	const executor: ExecutionPort = {
		async processStart({ executable, cwd, env }) {
			startedCwd = cwd;
			startedProgram = executable.program;
			telemetryEnvironment = env;
			return handle;
		},
		async command() {
			throw new Error("unexpected command");
		},
		async dockerBuild() {
			throw new Error("unexpected build");
		},
		async composeUp() {
			throw new Error("unexpected compose");
		},
		async composeContainers() {
			throw new Error("unexpected compose");
		},
		async containersReady() {
			return {
				readiness: "unknown" as const,
				source: "docker-running" as const,
			};
		},
		async stopContainers() {
			return [];
		},
		async logs() {
			throw new Error("unexpected container logs");
		},
	};
	const journal = openOperationJournal(state, [repository]);
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		{ inspect: async () => ({ status: "absent" as const }) },
		executor,
		{ get: () => undefined },
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		await expect(
			agent.admit(
				"unrelated-worktree",
				{ app: "web", target: "dev", worktree: root },
				signal,
			),
		).rejects.toMatchObject({ code: "worktree-unsupported" });
		const operation = await agent.admit(
			"process",
			{ app: "web", target: "dev", worktree: linked },
			signal,
		);
		await agent.execute(operation.id, signal);
		const receipt = (await agent.wait(operation.id, 5, signal)).receipt;
		expect(receipt).toMatchObject({
			status: "completed",
			kind: "process",
			pid: 4242,
			readiness: "ready",
			readinessSource: "text",
		});
		expect(startedCwd).toBe(linked);
		expect(startedProgram).toBe(path.join(linked, "run.sh"));
		expect(agent.status().owned).toMatchObject([
			{ app: "web", kind: "process", runtimeId: "pid:4242" },
		]);
		expect(await agent.logs("web", 50, signal)).toMatchObject({
			historical: false,
			output: expect.stringContaining("ready"),
		});
		expect(await agent.logs("web", 50, signal, "line")).toMatchObject({
			historical: false,
			output: "line",
		});
		if (!telemetryEnvironment) throw new Error("Missing telemetry environment");
		const authorization = decodeURIComponent(
			telemetryEnvironment.OTEL_EXPORTER_OTLP_HEADERS.split("=")
				.slice(1)
				.join("="),
		);
		expect(
			(
				await fetch(
					`${telemetryEnvironment.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`,
					{
						method: "POST",
						headers: {
							authorization,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							resourceLogs: [
								{
									scopeLogs: [
										{
											logRecords: [
												{
													body: { stringValue: "telemetry line" },
												},
											],
										},
									],
								},
							],
						}),
					},
				)
			).status,
		).toBe(200);
		expect(agent.telemetry("web")).toMatchObject({
			app: "web",
			logs: [expect.objectContaining({ body: "telemetry line" })],
		});
		expect(await agent.stop("web", signal)).toMatchObject({
			stopped: ["pid:4242"],
			remaining: 0,
			retainedLogsAvailable: true,
		});
		expect(stopped).toBe(1);
		expect(agent.status().owned).toEqual([]);
		expect(await agent.logs("web", 50, signal)).toMatchObject({
			historical: true,
			output: expect.stringContaining("line"),
		});
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
