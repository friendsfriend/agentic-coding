import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSharedServer } from "../src/services/shared-server.ts";
import { createHttpUiCapabilityApi } from "../src/ui/http-capability-api.ts";

test("the live idle reaper closes a clean scope and the next execution reopens it", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-idle-server-")),
	);
	const repository = path.join(root, "repo");
	const configDir = path.join(root, "config");
	const state = path.join(root, "state");
	const clients = path.join(root, "clients.json");
	const tokenFile = path.join(root, "token");
	for (const directory of [repository, configDir, state])
		fs.mkdirSync(directory, { mode: directory === state ? 0o700 : 0o755 });
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
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [repository] }),
	);
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					repository,
					targets: [
						{
							id: "run",
							action: "run",
							runtime: "shell",
							command: "true",
						},
					],
				},
			],
		}),
	);
	const token = "i".repeat(64);
	fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	fs.writeFileSync(
		clients,
		JSON.stringify({
			version: 1,
			clients: [{ id: "client", repository, tokenFile }],
		}),
	);
	const server = await startSharedServer({
		configDir,
		directory: state,
		clients,
		port: 0,
		operatorPort: 0,
		idleTimeoutSec: 1,
	});
	const api = createHttpUiCapabilityApi({ url: server.url, token });
	try {
		const initial = await api.invoke("env_status", {});
		expect(initial.scope).toMatchObject({ state: "active" });
		await Bun.sleep(2_500);
		const closed = await api.invoke("env_status", {});
		expect(closed.scope).toMatchObject({ state: "closed" });
		await api.invoke("env_list", { limit: 1 });
		expect((await api.invoke("env_status", {})).scope).toMatchObject({
			state: "closed",
		});
		const operation = await api.invoke("env_execute", {
			app: "api",
			target: "run",
			requestId: "idle-reopen",
		});
		expect(operation).toMatchObject({ state: "awaiting-approval" });
		expect((await api.invoke("env_status", {})).scope).toMatchObject({
			state: "active",
		});
	} finally {
		await server.stop();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
