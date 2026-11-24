import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { networkName } from "../src/configuration/network-name.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import type { ExecutionPort } from "../src/domain/execution.ts";
import { createExecutionService } from "../src/services/execution-service.ts";
import { openOperationJournal } from "../src/services/operation-journal.ts";

test("a network-only target creates the exact bridge and members join without owning it", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-service-")),
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
	const network = networkName("infra", "net");
	const containerId = "f".repeat(64);
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: [repository],
		services: [],
		apps: [
			{
				id: "infra",
				repository,
				targets: [
					{
						id: "net",
						action: "run",
						runtime: "compose",
						executable: {
							kind: "network-only",
							provider: "docker",
							socket: "/configured-only/docker.sock",
							network,
							app: "infra",
							target: "net",
							timeoutSec: 30,
						},
					},
				],
			},
			{
				id: "api",
				repository,
				targets: [
					{
						id: "run",
						action: "run",
						runtime: "compose",
						prerequisites: [{ app: "infra", target: "net" }],
						executable: {
							kind: "compose",
							provider: "docker",
							socket: "/configured-only/docker.sock",
							source: "services:\n  api:\n    image: example:latest\n",
							project: "environment-mcp",
							services: ["api"],
							envRefs: {},
							serviceEnvRefs: {},
							networkFrom: { app: "infra", target: "net", network },
							timeoutSec: 30,
						},
					},
				],
			},
		],
	});
	const calls: string[] = [];
	let networkCreated = false;
	let removed = false;
	const executor = {
		async networkCreate({ executable }: { executable: { network: string } }) {
			calls.push(`network:create:${executable.network}`);
			networkCreated = true;
			removed = false;
			return {
				networkId: "n".repeat(64),
				output: "created",
				truncated: false,
			};
		},
		async networkInspect({ name }: { name: string }) {
			calls.push(`network:inspect:${name}`);
			if (!networkCreated || removed) return null;
			return {
				id: "n".repeat(64),
				name,
				labels: {
					"environment-mcp": "true",
					"environment-mcp-app": "infra",
					"environment-mcp-target": "net",
				},
				containers: [],
			};
		},
		async networkConnect({
			networkId,
			containers,
		}: {
			networkId: string;
			containers: string[];
		}) {
			calls.push(`network:connect:${networkId}:${containers.join(",")}`);
			return containers;
		},
		async networkRemove({ networkId }: { networkId: string }) {
			calls.push(`network:remove:${networkId}`);
			removed = true;
			return true;
		},
		async composeUp() {
			calls.push("compose:up");
			return { exitCode: 0, timedOut: false, output: "up", truncated: false };
		},
		async composeContainers() {
			calls.push("compose:ps");
			return [containerId];
		},
		async containersReady() {
			return { readiness: "ready" as const, source: "docker-running" as const };
		},
		async stopContainers({ containers }: { containers: string[] }) {
			calls.push(`containers:stop:${containers.join(",")}`);
			return containers;
		},
		async logs() {
			return "member log";
		},
	} as unknown as ExecutionPort;
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
		const member = await agent.admit(
			"member",
			{ app: "api", target: "run" },
			signal,
		);
		await agent.execute(member.id, signal);
		expect((await agent.wait(member.id, 5, signal)).receipt).toMatchObject({
			status: "completed",
			kind: "compose",
			containers: [containerId],
		});
		expect(calls).toContain(`network:create:${network}`);
		expect(calls).toContain(`network:connect:${"n".repeat(64)}:${containerId}`);
		expect(agent.status().owned).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ app: "api", kind: "network" }),
				expect.objectContaining({ app: "api", kind: "container" }),
			]),
		);
		const stopped = await agent.stop("api", signal);
		expect(stopped).toMatchObject({ remaining: 0 });
		expect(stopped.stopped).toEqual(
			expect.arrayContaining([containerId.slice(0, 12), network]),
		);
		expect(calls).toContain(`network:remove:${"n".repeat(64)}`);
		const networkRun = await agent.admit(
			"network",
			{ app: "infra", target: "net" },
			signal,
		);
		await agent.execute(networkRun.id, signal);
		expect((await agent.wait(networkRun.id, 5, signal)).receipt).toMatchObject({
			status: "completed",
			kind: "network",
			networkId: "n".repeat(64),
			name: network,
			readinessSource: "docker-network",
		});
		expect(await agent.logs("infra", 20, signal)).toMatchObject({
			output: expect.stringContaining("network-only"),
		});
		expect(await agent.stop("infra", signal)).toMatchObject({
			stopped: [network],
			remaining: 0,
		});
		expect(agent.status().owned).toEqual([]);
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
