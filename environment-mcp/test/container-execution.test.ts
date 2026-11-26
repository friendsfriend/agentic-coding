import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readContainerStats } from "../src/adapters/docker/container-stats.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("container stats derive bounded CPU, memory, network and PID values", () => {
	const stats = readContainerStats({
		read: "2026-01-01T00:00:00Z",
		cpu_stats: {
			cpu_usage: { total_usage: 300 },
			system_cpu_usage: 1300,
			online_cpus: 2,
		},
		precpu_stats: {
			cpu_usage: { total_usage: 100 },
			system_cpu_usage: 1000,
		},
		memory_stats: {
			usage: 4096,
			limit: 8192,
			stats: { cache: 1024 },
		},
		networks: {
			eth0: { rx_bytes: 10, tx_bytes: 20 },
			eth1: { rx_bytes: 5, tx_bytes: 7 },
		},
		pids_stats: { current: 3 },
	});
	expect(stats).toEqual({
		cpuPercent: 133.33,
		memoryUsageBytes: 3072,
		memoryLimitBytes: 8192,
		memoryPercent: 37.5,
		networkRxBytes: 15,
		networkTxBytes: 27,
		pids: 3,
		readAt: "2026-01-01T00:00:00Z",
	});
	expect(
		readContainerStats({
			cpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 1 },
			precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 1 },
		}),
	).toEqual({});
});

test("direct container run records identity, readiness, logs and owned stop", async () => {
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
	const statsCalls: string[] = [];
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
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		{ inspect: async () => ({ status: "absent" as const }) },
		executor,
		{ get: () => undefined },
		{
			containerStats: {
				async stats(_provider, _socket, container) {
					statsCalls.push(container);
					return {
						cpuPercent: 2.5,
						memoryUsageBytes: 1024,
						memoryLimitBytes: 4096,
						memoryPercent: 25,
						networkRxBytes: 10,
						networkTxBytes: 20,
						pids: 3,
					};
				},
			},
		},
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		const operation = await agent.admit(
			"container",
			{ app: "web", target: "container" },
			signal,
		);
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
		expect(await agent.containerStats(signal)).toMatchObject({
			containers: [
				{
					container: containerId,
					app: "web",
					provider: "docker",
					cpuPercent: 2.5,
					memoryUsageBytes: 1024,
					pids: 3,
				},
			],
			unavailable: 0,
		});
		expect(statsCalls).toEqual([containerId]);
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
		expect(await agent.containerStats(signal)).toMatchObject({
			containers: [],
			unavailable: 0,
		});
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
