import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("approved container run records identity, readiness, logs and owned stop", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-container-exec-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state");
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
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		apps: [
			{
				id: "web",
				repository,
				targets: [
					{
						id: "container",
						action: "run",
						runtime: "docker",
						executable: {
							kind: "container-run",
							provider: "docker",
							socket: "/configured-only/docker.sock",
							image: "example:latest",
							name: "environment-mcp-web-container",
							ports: [],
							env: {},
							envRefs: {},
							readiness: "running",
							telemetry: "otlp-http-json",
							timeoutSec: 5,
						},
					},
				],
			},
		],
	});
	const containerId = "d".repeat(64);
	const calls: string[] = [];
	let telemetryEnv: Record<string, string> | undefined;
	let telemetryMount: { certificate: string } | undefined;
	const executor: ExecutionPort = {
		async containerRun(input) {
			calls.push("run");
			telemetryEnv = input.env;
			telemetryMount = input.telemetry;
			return {
				containerId,
				output: "started",
				timedOut: false,
				truncated: false,
			};
		},
		async containersReady() {
			return { readiness: "ready" as const, source: "docker-running" as const };
		},
		async stopContainers({ containers }) {
			calls.push("stop");
			return [...containers];
		},
		async logs({ redact }) {
			return redact("line one\nline two");
		},
		async processStart() {
			throw new Error("unexpected process");
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
	};
	const journal = openOperationJournal(state, [repository]);
	const operator = journal.operator();
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
		const operation = await agent.admit(
			"container",
			{ app: "web", target: "container" },
			signal,
		);
		operator.decide(operation.id, {
			requestId: "approve-container",
			digest: operation.digest,
			revision: operation.revision,
			decision: "approved",
		});
		await agent.execute(operation.id, signal);
		const receipt = (await agent.wait(operation.id, 5, signal)).receipt;
		expect(receipt).toMatchObject({
			status: "completed",
			kind: "container",
			containerId,
			readiness: "ready",
			readinessSource: "docker-running",
		});
		expect(agent.status().owned).toMatchObject([
			{ app: "web", kind: "container", runtimeId: containerId },
		]);
		expect(telemetryEnv).toMatchObject({
			OTEL_EXPORTER_OTLP_CERTIFICATE: "/environment-mcp-otel-ca.pem",
			OTEL_TRACES_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
		});
		expect(telemetryMount?.certificate.endsWith("ca.pem")).toBe(true);
		expect(agent.telemetry("web")).toMatchObject({
			transport: "tls-host-gateway-v1",
		});
		expect(await agent.logs("web", 50, signal)).toMatchObject({
			historical: false,
			output: expect.stringContaining("line one"),
		});
		expect(await agent.stop("web", signal)).toMatchObject({
			stopped: [containerId.slice(0, 12)],
			remaining: 0,
			retainedLogsAvailable: true,
		});
		expect(calls).toEqual(["run", "stop"]);
		expect(agent.status().owned).toEqual([]);
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
