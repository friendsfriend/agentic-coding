import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkToolAvailability } from "../src/server/actions/toolcheck.ts";
import { EnvironmentManager } from "../src/server/environment/manager.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import { createIntegrationServices } from "../src/server/integrations/services.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

test("owned server publishes action definitions before clients poll startup", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-startup-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	fs.mkdirSync(path.join(configDir, "apps", "definitions"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(configDir, "apps", "definitions", "demo.json"),
		JSON.stringify({ ident: "demo", displayName: "Demo" }),
	);
	const state = EnvironmentStateStore.open(path.join(homeDir, "db"));
	try {
		const manager = new EnvironmentManager({ configDir, homeDir });
		manager.loadConfig();
		let probes = 0;
		const integrations = createIntegrationServices({
			manager,
			state,
			configDir,
			homeDir,
			tools: async () => {
				probes++;
				return checkToolAvailability({
					lookPath: () => undefined,
					daemonReachable: () => {
						throw new Error("Missing tool must not be probed");
					},
				});
			},
		});
		expect(integrations.actions?.registry.snapshot().version).toBe(0);
		// Starting again with the same published registry must not probe twice.
		for (let attempt = 0; attempt < 2; attempt++) {
			const server = await startWorkflowServer({ integrations, port: 0 });
			try {
				const response = await fetch(
					`${server.url}/api/action-registry/status`,
					{
						headers: { Authorization: `Bearer ${server.token}` },
					},
				);
				expect(response.status).toBe(200);
				const status = await response.json();
				expect(status.available).toBe(true);
				expect(status.actionsCount).toBeGreaterThan(0);
				expect(status.error).toBe("");
			} finally {
				await server.stop();
			}
		}
		expect(probes).toBe(1);
	} finally {
		state.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("container probes run concurrently without blocking the event loop", async () => {
	const started: string[] = [];
	const pending = new Map<string, (available: boolean) => void>();
	const checking = checkToolAvailability({
		lookPath: (name) => `/bin/${name}`,
		daemonReachable: (name) => {
			started.push(name);
			return new Promise<boolean>((resolve) => pending.set(name, resolve));
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		expect(started).toEqual(["docker", "podman"]);
	} finally {
		pending.get("docker")?.(true);
		pending.get("podman")?.(false);
	}
	const tools = await checking;
	expect(tools.docker).toBe(true);
	expect(tools.podman).toBe(false);
	expect(tools.kubectl).toBe(true);
});
