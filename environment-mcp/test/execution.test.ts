import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("direct command/compose execution is one-use, fails closed and stops only owned containers", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exec-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state"),
		composeFile = path.join(repository, "compose.yaml");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	fs.writeFileSync(composeFile, "services: {}\n");
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
	const secret = "execution-credential-value";
	process.env.MCP_TEST_EXEC_SECRET = secret;
	const binding = {
		kind: "docker-container",
		socket: "/configured-only/docker.sock",
		containerName: "postgres",
		image: "postgres:17.4",
		labels: { "com.docker.compose.project": "existing-mocked" },
		network: { name: "existing-mocked_devenv-local", alias: "postgres" },
		readiness: "running",
	};
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [{ id: "postgres", runtime: "docker", binding }],
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
							args: ["built", "$MCP_TEST_EXEC_SECRET"],
							envRefs: {},
						},
					},
					{
						id: "failed",
						action: "test",
						runtime: "shell",
						executable: {
							kind: "command",
							program: "/bin/sh",
							args: ["-c", "echo credential $MCP_TEST_EXEC_SECRET; exit 3"],
							envRefs: { TOKEN: "MCP_TEST_EXEC_SECRET" },
						},
					},
					{
						id: "missing-secret",
						action: "run",
						runtime: "shell",
						executable: {
							kind: "process",
							program: "/bin/sh",
							args: ["-lc", "sleep 30"],
							envRefs: { TOKEN: "MISSING_PREFLIGHT_REFERENCE" },
						},
					},
					{
						id: "mocked",
						action: "run",
						runtime: "compose",
						dependsOn: [{ service: "postgres" }],
						endpoints: { api: "http://127.0.0.1:8081/health" },
						endpointServices: { api: "api" },
						executable: {
							kind: "compose",
							socket: "/configured-only/docker.sock",
							file: composeFile,
							project: "fixture",
							services: ["api", "collector"],
							telemetry: {
								protocol: "otlp-http-json",
								collectorService: "collector",
								transport: "tls-host-gateway-v1",
							},
						},
					},
				],
			},
		],
	});
	const containerId = "f".repeat(64);
	const calls: string[] = [];
	let collectorTelemetry = false;
	const containers = {
		async inspect() {
			return {
				status: "present" as const,
				document: {
					Id: "a".repeat(64),
					Name: "/postgres",
					Created: "2026-01-01T00:00:00Z",
					Image: `sha256:${"b".repeat(64)}`,
					Config: { Image: "postgres:17.4", Labels: binding.labels },
					State: {
						Running: true,
						Paused: false,
						Restarting: false,
						Dead: false,
						StartedAt: "2026-01-01T00:01:00Z",
					},
					NetworkSettings: {
						Networks: {
							[binding.network.name]: {
								NetworkID: "c".repeat(64),
								Aliases: ["postgres"],
							},
						},
					},
				},
			};
		},
	};
	const executor: ExecutionPort = {
		async command({ executable, env, redact }) {
			calls.push(`command:${executable.program}`);
			return {
				exitCode: executable.program === "/bin/sh" ? 3 : 0,
				timedOut: false,
				output: redact(
					`output ${env.TOKEN ?? ""} ${executable.args.join(" ")}`,
				),
				truncated: false,
			};
		},
		async dockerBuild({ executable, secrets, redact }) {
			calls.push(`build:${executable.image}`);
			return {
				exitCode: 0,
				timedOut: false,
				output: redact(
					`built ${executable.image} ${Object.values(secrets).join(" ")}`,
				),
				truncated: false,
			};
		},
		async composeUp({ serviceEnv, serviceMounts }) {
			calls.push("compose:up");
			collectorTelemetry =
				Boolean(serviceEnv?.collector?.OTEL_COLLECTOR_CONFIG) &&
				Boolean(serviceMounts?.collector?.[0]?.source.endsWith("ca.pem"));
			return {
				exitCode: 0,
				timedOut: false,
				output: "started",
				truncated: false,
			};
		},
		async composeContainers() {
			calls.push("compose:ps");
			return [containerId];
		},
		async containersReady() {
			return { readiness: "ready" as const, source: "docker-running" as const };
		},
		async probeEndpoints({ endpoints }) {
			calls.push(
				`probe:${endpoints.map((endpoint) => endpoint.name).join(",")}`,
			);
			return Object.fromEntries(
				endpoints.map((endpoint) => [endpoint.name, "ready" as const]),
			);
		},
		async stopContainers({ containers: ids }) {
			calls.push(`stop:${ids.join(",")}`);
			return [...ids];
		},
		async logs({ redact }) {
			return redact(`retained line ${secret}`);
		},
	};
	const journal = openOperationJournal(state, [repository]);
	const scope = journal.createScope("client", repository, "scope");
	const service = createExecutionService(
		manifest,
		journal,
		containers,
		executor,
		{ get: (reference: string) => process.env[reference] },
		{ telemetryDirectory: state },
	);
	const agent = service.bind("client", scope.id);
	const signal = new AbortController().signal;
	try {
		expect(() => manifest.apps[0]?.targets[0]?.executable).not.toThrow();
		await expect(
			agent.admit(
				"missing-secret",
				{ app: "api", target: "missing-secret" },
				signal,
			),
		).rejects.toMatchObject({ code: "secret-reference-unavailable" });
		const build = await agent.admit(
			"build",
			{ app: "api", target: "build" },
			signal,
		);
		expect((await agent.execute(build.id, signal)).receipt).toBeNull();
		expect(await agent.execute(build.id, signal)).toMatchObject({
			receipt: null,
		});
		const built = await agent.wait(build.id, 5, signal);
		expect(built.receipt).toMatchObject({
			status: "completed",
			kind: "command",
			exitCode: 0,
		});
		expect((await agent.execute(build.id, signal)).receipt).toBeNull();
		// One command call only: replay never re-runs.
		expect(calls.filter((call) => call === "command:/bin/echo")).toHaveLength(
			1,
		);
		const failed = await agent.admit(
			"failed",
			{ app: "api", target: "failed" },
			signal,
		);
		await agent.execute(failed.id, signal);
		const failedReceipt = (await agent.wait(failed.id, 5, signal)).receipt;
		expect(failedReceipt).toMatchObject({
			status: "failed",
			kind: "command",
			exitCode: 3,
		});
		expect(JSON.stringify(failedReceipt)).not.toContain(secret);
		expect(JSON.stringify(failedReceipt)).toContain("[REDACTED]");
		const run = await agent.admit(
			"run",
			{ app: "api", target: "mocked" },
			signal,
		);
		await agent.execute(run.id, signal);
		const started = await agent.wait(run.id, 5, signal);
		expect(started.receipt).toMatchObject({
			status: "completed",
			kind: "compose",
			readiness: "ready",
			readinessSource: "endpoint",
			endpoints: [
				{
					name: "api",
					url: "http://127.0.0.1:8081/health",
					status: "ready",
				},
			],
			containers: [containerId],
		});
		expect(calls).toContain("probe:api");
		expect(collectorTelemetry).toBe(true);
		expect(agent.telemetry("api")).toMatchObject({
			transport: "tls-host-gateway-v1",
			traces: [],
		});
		expect(agent.status().owned).toMatchObject([
			{ app: "api", kind: "container", runtimeId: containerId },
		]);
		expect(calls.filter((call) => call === "compose:up")).toHaveLength(1);
		const logs = await agent.logs("api", 50, signal);
		expect(logs).toMatchObject({ historical: false });
		expect(logs.output).toContain("[REDACTED]");
		expect(JSON.stringify(logs)).not.toContain(secret);
		expect(await agent.logs("api", 50, signal, "retained")).toMatchObject({
			historical: false,
			output: expect.stringContaining("retained"),
		});
		expect(await agent.logs("api", 50, signal, "absent")).toMatchObject({
			output: "",
		});
		expect(await agent.stop("api", signal)).toMatchObject({
			stopped: [containerId.slice(0, 12)],
			remaining: 0,
		});
		expect(agent.status().owned).toEqual([]);
		expect(calls).toContain(`stop:${containerId}`);
		expect(agent.telemetry("api")).toMatchObject({
			transport: "tls-host-gateway-v1",
		});
		const retained = await agent.logs("api", 50, signal);
		expect(retained).toMatchObject({ historical: true });
		expect(retained.output).toContain("[REDACTED]");
		expect(JSON.stringify(retained)).not.toContain(secret);
		const history = agent.history();
		expect(history.total).toBe(3);
		expect(
			history.operations.some(
				(operation) =>
					operation.kind === "executable" &&
					operation.state === "completed" &&
					operation.hasResult,
			),
		).toBe(true);
		expect(JSON.stringify(agent.history())).not.toContain("plan");
		// Borrowed PostgreSQL is never in the owned ledger or stop list.
		expect(calls.some((call) => call.includes("postgres"))).toBe(false);
		const next = structuredClone(manifest);
		const command = next.apps[0]?.targets[0]?.executable;
		if (command?.kind !== "command") throw new Error("Missing command fixture");
		command.args = ["refreshed-command"];
		service.refresh(next);
		const refreshed = await agent.executeIntent(
			"refreshed-build",
			{ app: "api", target: "build" },
			signal,
		);
		const completed = await agent.wait(refreshed.operation.id, 5, signal);
		expect(completed.receipt?.output).toContain("refreshed-command");
		const closed = agent.closeScope(scope.revision);
		expect(agent.finishClose(closed.scope.revision, true).state).toBe("closed");
	} finally {
		delete process.env.MCP_TEST_EXEC_SECRET;
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
