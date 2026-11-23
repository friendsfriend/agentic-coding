import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHttpUiCapabilityApi } from "../src/ui/http-capability-api.ts";

test("the copied standalone CLI shares private state and publishes only a separate operator capability", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shared-")),
	);
	const repository = path.join(root, "repo"),
		directory = path.join(root, "state"),
		configDir = path.join(root, "config"),
		clients = path.join(root, "clients.json"),
		artifact = path.join(root, "server.js");
	fs.mkdirSync(repository);
	fs.mkdirSync(configDir);
	fs.mkdirSync(directory, { mode: 0o700 });
	fs.copyFileSync(new URL("../dist/cli.js", import.meta.url), artifact);
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
					targets: [{ id: "mocked", action: "run", runtime: "compose" }],
				},
			],
		}),
	);
	fs.writeFileSync(
		clients,
		JSON.stringify({
			version: 1,
			clients: [{ id: "fixture", repository, tokenEnv: "MCP_FIXTURE_KEY" }],
		}),
	);
	const token = "z".repeat(64);
	const child = Bun.spawn(
		[
			process.execPath,
			artifact,
			"--serve",
			"--config-dir",
			configDir,
			"--state-dir",
			directory,
			"--clients",
			clients,
		],
		{
			cwd: root,
			env: {
				HOME: root,
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: root,
				MCP_FIXTURE_KEY: token,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const ready = Promise.withResolvers<string>();
	const stdout = new Response(child.stdout).text();
	let diagnostics = "";
	const stderr = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) {
			diagnostics += decoder.decode(chunk, { stream: true });
			const match = /Environment MCP: (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(
				diagnostics,
			);
			if (match?.[1]) ready.resolve(match[1]);
		}
		ready.reject(new Error("Standalone server exited before readiness"));
	})();
	const client = new Client({ name: "shared-cli-fixture", version: "1.0.0" });
	const bridge = new Client({ name: "bridge-fixture", version: "1.0.0" });
	try {
		const url = await ready.promise;
		const accessFile = path.join(directory, "operator-access.json");
		expect(fs.statSync(accessFile).mode & 0o077).toBe(0);
		const access = JSON.parse(fs.readFileSync(accessFile, "utf8")) as {
			url: string;
			token: string;
		};
		expect(access.token).not.toBe(token);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers: { authorization: `Bearer ${token}` } },
			}),
		);
		const ui = createHttpUiCapabilityApi({ url, token });
		const actions = await ui.list();
		const tools = await client.listTools();
		expect(actions.map((action) => action.name)).toEqual(
			tools.tools.map((tool) => tool.name),
		);
		expect(await ui.invoke("env_list", { limit: 1 })).toMatchObject({
			mode: "inspection-only",
			executionAvailable: true,
		});
		const diagnosticsResponse = await fetch(
			`${access.url}/operator/diagnostics?tail=20`,
			{ headers: { authorization: `Bearer ${access.token}` } },
		);
		expect(diagnosticsResponse.status).toBe(200);
		const diagnosticEvents = (await diagnosticsResponse.json()) as {
			events: { event: string; action?: string }[];
		};
		expect(diagnosticEvents.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: "startup" }),
				expect.objectContaining({ event: "capability", action: "env_list" }),
			]),
		);
		expect(JSON.stringify(diagnosticEvents)).not.toContain(token);
		expect(JSON.stringify(diagnosticEvents)).not.toContain(access.token);
		const diagnosticsFile = path.join(directory, "diagnostics.jsonl");
		expect(fs.statSync(diagnosticsFile).mode & 0o077).toBe(0);
		await bridge.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [
					artifact,
					"--connect",
					"--url",
					url,
					"--token-env",
					"MCP_FIXTURE_KEY",
				],
				cwd: root,
				env: {
					HOME: root,
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					TMPDIR: root,
					MCP_FIXTURE_KEY: token,
				},
				stderr: "pipe",
			}),
		);
		expect(
			(await bridge.listTools()).tools.map((tool) => tool.name).sort(),
		).toEqual(tools.tools.map((tool) => tool.name).sort());
		expect(
			(
				await bridge.callTool({
					name: "env_list",
					arguments: { limit: 1 },
				})
			).structuredContent,
		).toMatchObject({ mode: "inspection-only", executionAvailable: true });
		const result = await client.callTool({
			name: "env_prepare_dependencies",
			arguments: { app: "api", target: "mocked", requestId: "review" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			state: "awaiting-approval",
			kind: "dependency-bindings",
		});
		expect(
			(
				await fetch(`${new URL(url).origin}/capabilities`, {
					headers: { authorization: `Bearer ${"x".repeat(64)}` },
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(`${access.url}/operator/operations`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(401);
		await bridge.close();
		await client.close();
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		await stderr;
		expect(await stdout).toBe("");
		expect(diagnostics).not.toContain(token);
		expect(diagnostics).not.toContain(access.token);
		expect(fs.existsSync(accessFile)).toBe(false);
		expect(fs.existsSync(path.join(directory, "controller.lock"))).toBe(false);
	} finally {
		await client.close();
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		await stderr;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
