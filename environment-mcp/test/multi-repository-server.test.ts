import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSharedServer } from "../src/services/shared-server.ts";
import { createHttpUiCapabilityApi } from "../src/ui/http-capability-api.ts";

test("a shared client can bind several repositories with partitioned scopes", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-multi-server-")),
	);
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	const configDir = path.join(root, "config");
	const state = path.join(root, "state");
	const clients = path.join(root, "clients.json");
	const tokenFile = path.join(root, "token");
	for (const directory of [first, second, configDir, state])
		fs.mkdirSync(directory, { mode: directory === state ? 0o700 : 0o755 });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [first, second] }),
	);
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{ id: "alpha", repository: first, targets: [] },
				{ id: "beta", repository: second, targets: [] },
			],
		}),
	);
	const token = "m".repeat(64);
	fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	fs.writeFileSync(
		clients,
		JSON.stringify({
			version: 1,
			clients: [
				{
					id: "client",
					repositories: [first, second],
					tokenFile,
				},
			],
		}),
	);
	const server = await startSharedServer({
		configDir,
		directory: state,
		clients,
		port: 0,
		operatorPort: 0,
		idleTimeoutSec: 0,
	});
	const api = createHttpUiCapabilityApi({ url: server.url, token });
	try {
		expect((await api.list()).map((action) => action.name)).toContain(
			"env_status",
		);
		expect(await api.invoke("env_list", { limit: 10 })).toMatchObject({
			apps: [{ id: "alpha" }, { id: "beta" }],
			total: 2,
		});
		expect(await api.invoke("env_status", {})).toMatchObject({
			scopes: [
				{ repository: first, owned: 0 },
				{ repository: second, owned: 0 },
			],
			owned: [],
		});
		expect(
			await api.invoke("env_status", { repository: second }),
		).toMatchObject({
			scope: { state: "active" },
			owned: [],
		});
	} finally {
		await server.stop();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
