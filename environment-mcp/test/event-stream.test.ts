import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSharedServer } from "../src/services/shared-server.ts";

test("authenticated SSE sends a snapshot frame", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-events-")),
	);
	const repository = path.join(root, "repo");
	const configDir = path.join(root, "config");
	const state = path.join(root, "state");
	const clients = path.join(root, "clients.json");
	const tokenFile = path.join(root, "token");
	for (const directory of [repository, configDir, state])
		fs.mkdirSync(directory, { mode: directory === state ? 0o700 : 0o755 });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [repository] }),
	);
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [{ id: "alpha", repository, targets: [] }],
		}),
	);
	const token = "e".repeat(64);
	fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	fs.writeFileSync(
		clients,
		JSON.stringify({
			version: 1,
			clients: [{ id: "client", repositories: [repository], tokenFile }],
		}),
	);
	const server = await startSharedServer({
		configDir,
		directory: state,
		clients,
		port: 0,
		idleTimeoutSec: 0,
	});
	try {
		const response = await fetch(`${new URL(server.url).origin}/events`, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "text/event-stream",
			},
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected event body");
		const { value } = await reader.read();
		const frame = new TextDecoder().decode(value);
		expect(frame).toContain("event: snapshot");
		expect(frame).toContain('"type":"snapshot"');
		await reader.cancel().catch(() => {});
	} finally {
		await server.stop();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
