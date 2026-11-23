import { expect, test } from "bun:test";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createDockerInspectionAdapter } from "../src/adapters/docker/container-inspection.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import { dockerServiceBindingSchema } from "../src/configuration/service-binding.ts";
import { createDependencyBindingService } from "../src/services/dependency-binding-service.ts";

const binding = {
	kind: "docker-container",
	socket: "/configured/docker.sock",
	containerName: "postgres",
	image: "postgres:17.4",
	labels: {
		"com.docker.compose.project": "existing-mocked",
		"com.docker.compose.service": "postgres",
	},
	network: { name: "existing-mocked_devenv-local", alias: "postgres" },
	readiness: "healthy",
};

test("configured service bindings require explicit identity, connectivity and readiness, never caller ownership", () => {
	expect(dockerServiceBindingSchema.parse(binding)).toMatchObject({
		containerName: "postgres",
		readiness: "healthy",
	});
	for (const input of [
		{ ...binding, labels: {} },
		{ ...binding, ownedByController: true },
		{ ...binding, network: { name: "existing" } },
	])
		expect(dockerServiceBindingSchema.safeParse(input).success).toBe(false);
	const manifest = {
		version: 1,
		repositories: ["/repo"],
		services: [{ id: "postgres", runtime: "compose", binding }],
		apps: [],
	};
	expect(serverManifestSchema.safeParse(manifest).success).toBe(false);
});

test("dependency preparation freezes borrowed identity, redacts inspection data and refuses stale or unavailable services without mutation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-"));
	const socket = path.join(root, "s");
	const methods: string[] = [];
	let status = 200,
		containerId = "a".repeat(64),
		healthy = true,
		oversized = false;
	const secret = "private-database-env-must-not-leak";
	const server = createServer((request, response) => {
		methods.push(request.method ?? "unknown");
		response.writeHead(status, { "content-type": "application/json" });
		response.end(
			oversized
				? " ".repeat(262145)
				: JSON.stringify({
						Id: containerId,
						Created: "2026-01-01T00:00:00Z",
						Name: "/postgres",
						Image: `sha256:${"b".repeat(64)}`,
						Config: {
							Image: "postgres:17.4",
							Labels: binding.labels,
							Env: [`PASSWORD=${secret}`],
						},
						State: {
							StartedAt: "2026-01-01T00:01:00Z",
							Running: true,
							Paused: false,
							Restarting: false,
							Dead: false,
							Health: {
								Status: healthy ? "healthy" : "unhealthy",
								Log: [{ Output: secret }],
							},
						},
						NetworkSettings: {
							Networks: {
								[binding.network.name]: {
									NetworkID: "c".repeat(64),
									Aliases: ["postgres"],
								},
							},
						},
					}),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	try {
		const manifest = serverManifestSchema.parse({
			version: 1,
			repositories: ["/repo"],
			services: [
				{ id: "postgres", runtime: "docker", binding: { ...binding, socket } },
			],
			apps: [
				{
					id: "api",
					repository: "/repo",
					targets: [
						{
							id: "mocked",
							action: "run",
							runtime: "compose",
							dependsOn: [{ service: "postgres" }],
						},
						{
							id: "external",
							action: "run",
							runtime: "compose",
							dependsOn: [{ service: "postgres", lifecycle: "external" }],
						},
						{
							id: "owned",
							action: "run",
							runtime: "compose",
							dependsOn: [{ service: "postgres", lifecycle: "owned" }],
						},
					],
				},
			],
		});
		const adapter = createDockerInspectionAdapter();
		const service = createDependencyBindingService(manifest, "/repo", adapter);
		const signal = new AbortController().signal;
		const prepared = await service.prepare("api", "mocked", signal);
		expect(JSON.parse(prepared.plan)).toMatchObject({
			dependencies: [
				{
					service: "postgres",
					action: "reuse",
					cleanup: "never",
					identity: { container: containerId, network: "c".repeat(64) },
				},
			],
		});
		expect(prepared.plan).not.toContain(secret);
		expect(await service.revalidate(prepared, signal)).toBe(prepared);
		await expect(service.revalidate({ ...prepared }, signal)).rejects.toThrow(
			"dependency-preparation-unavailable",
		);
		await expect(service.prepare("api", "owned", signal)).rejects.toThrow(
			"dependency-owner-unavailable",
		);
		containerId = "d".repeat(64);
		await expect(service.revalidate(prepared, signal)).rejects.toThrow(
			"dependency-generation-changed",
		);
		healthy = false;
		await expect(service.prepare("api", "mocked", signal)).rejects.toThrow(
			"dependency-not-ready",
		);
		status = 404;
		await expect(service.prepare("api", "mocked", signal)).rejects.toThrow(
			"dependency-start-required",
		);
		await expect(service.prepare("api", "external", signal)).rejects.toThrow(
			"external-unavailable",
		);
		status = 500;
		await expect(service.prepare("api", "mocked", signal)).rejects.toThrow(
			"dependency-observation-unavailable",
		);
		status = 200;
		oversized = true;
		await expect(service.prepare("api", "mocked", signal)).rejects.toThrow(
			"dependency-observation-unavailable",
		);
		expect(methods.every((method) => method === "GET")).toBe(true);
		expect(() =>
			createDependencyBindingService(manifest, "/foreign", adapter),
		).toThrow("dependency-owner-unavailable");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
});
