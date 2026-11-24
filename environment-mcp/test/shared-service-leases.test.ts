import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("controller-wide shared service leases block cleanup until the last dependent stops", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shared-leases-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state"),
		compose = path.join(root, "compose.yaml");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	fs.writeFileSync(compose, "services: {}\n");
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
	const binding = {
		kind: "docker-container",
		socket: "/configured-only/docker.sock",
		containerName: "environment-mcp-postgres",
		image: "postgres:17.4",
		labels: { "com.docker.compose.project": "environment-mcp" },
		network: { name: "environment-mcp", alias: "postgres" },
		readiness: "running",
		start: { app: "infra", target: "start-postgres" },
	} as const;
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [{ id: "postgres", runtime: "docker", binding }],
		apps: [
			{
				id: "infra",
				repository,
				targets: [
					{
						id: "start-postgres",
						action: "run",
						runtime: "compose",
						executable: {
							kind: "compose",
							socket: "/configured-only/docker.sock",
							file: compose,
							project: "environment-mcp",
							services: ["postgres"],
						},
					},
				],
			},
			{
				id: "api",
				repository,
				targets: [
					{
						id: "app",
						action: "run",
						runtime: "compose",
						dependsOn: [{ service: "postgres", lifecycle: "shared" }],
						executable: {
							kind: "compose",
							socket: "/configured-only/docker.sock",
							file: compose,
							project: "environment-mcp",
							services: ["api"],
						},
					},
				],
			},
		],
	});
	const postgresId = "a".repeat(64),
		apiId = "b".repeat(64);
	const containers = {
		async inspect() {
			return {
				status: "present" as const,
				document: {
					Id: postgresId,
					Name: "/environment-mcp-postgres",
					Created: "2026-01-01T00:00:00Z",
					Image: `sha256:${"c".repeat(64)}`,
					Config: {
						Image: binding.image,
						Labels: binding.labels,
					},
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
								NetworkID: "d".repeat(64),
								Aliases: [binding.network.alias],
							},
						},
					},
				},
			};
		},
	};
	const executor: ExecutionPort = {
		async composeUp() {
			return {
				exitCode: 0,
				timedOut: false,
				output: "started",
				truncated: false,
			};
		},
		async composeContainers({ executable }) {
			return executable.services.includes("postgres") ? [postgresId] : [apiId];
		},
		async containersReady() {
			return { readiness: "ready" as const, source: "docker-running" as const };
		},
		async stopContainers({ containers: ids }) {
			return [...ids];
		},
		async logs() {
			return "line";
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
	};
	const journal = openOperationJournal(state, [repository]);
	const infraScope = journal.createScope("infra-client", repository, "infra");
	const apiScope = journal.createScope("api-client", repository, "api");
	const service = createExecutionService(
		manifest,
		journal,
		containers,
		executor,
		{ get: () => undefined },
	);
	const infra = service.bind("infra-client", infraScope.id);
	const api = service.bind("api-client", apiScope.id);
	const signal = new AbortController().signal;
	const run = async (
		session: typeof infra,
		requestId: string,
		app: string,
		target: string,
	) => {
		const operation = await session.admit(requestId, { app, target }, signal);
		await session.execute(operation.id, signal);
		return session.wait(operation.id, 5, signal);
	};
	try {
		expect(
			(await run(infra, "start-pg", "infra", "start-postgres")).receipt,
		).toMatchObject({ status: "completed", kind: "compose" });
		expect(infra.sharedService("postgres")).toMatchObject({
			state: "ready",
			containers: [postgresId],
			leases: [],
		});
		expect((await run(api, "start-api", "api", "app")).receipt).toMatchObject({
			status: "completed",
			kind: "compose",
		});
		expect(infra.sharedService("postgres")?.leases).toMatchObject([
			{ scope: apiScope.id, app: "api", target: "app" },
		]);
		await expect(infra.stop("infra", signal)).rejects.toThrow(
			"cleanup-unavailable",
		);
		expect(infra.sharedService("postgres")?.state).toBe("ready");
		expect(await api.stop("api", signal)).toMatchObject({ remaining: 0 });
		expect(infra.sharedService("postgres")).toMatchObject({
			state: "released",
			leases: [],
			containers: [],
		});
		expect(await infra.stop("infra", signal)).toMatchObject({
			stopped: [],
			remaining: 0,
		});
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
