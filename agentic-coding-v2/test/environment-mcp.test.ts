import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { definitionByteLimit } from "../src/environment/definition-limits.ts";
import { bridgeOptions } from "../src/mcp/bridge.ts";
import { daemonOptions } from "../src/mcp/daemon-options.ts";
import { parseMcpOptions } from "../src/mcp/options.ts";

test("stdio MCP inspects authorized definitions without agent configuration or execution", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-mcp-"));
	const configDir = path.join(root, "config");
	const repository = path.join(root, "repo");
	fs.mkdirSync(configDir);
	fs.mkdirSync(repository);
	const canonicalRepository = fs.realpathSync(repository);
	const secret = "private-environment-value-must-not-leak";
	const marker = path.join(root, "must-not-execute");
	const definitions = {
		version: 1,
		projects: ["api", "web"].map((id) => ({
			id,
			kind: "app",
			repository: canonicalRepository,
			targets: [
				{
					id: "serve",
					action: "run",
					runtime: "shell",
					command: `touch ${marker}`,
					environment: { PUBLIC_SETTING: secret },
					secretRefs: { TOKEN: "PRIVATE_TOKEN" },
				},
			],
		})),
	};
	const definitionsFile = path.join(configDir, "environments.json");
	fs.writeFileSync(definitionsFile, JSON.stringify(definitions));
	// These files deliberately cannot be consumed as agent/provider configuration.
	fs.writeFileSync(path.join(configDir, "config.json"), "not agent JSON");
	fs.writeFileSync(path.join(configDir, ".env"), `PRIVATE_TOKEN=${secret}`);
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({
			packageManager: "bun@1.4.4",
			scripts: { dev: `touch ${marker}` },
		}),
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			fileURLToPath(new URL("../src/mcp/cli.ts", import.meta.url)),
			"--config-dir",
			configDir,
			"--repository",
			repository,
		],
		cwd: repository,
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const client = new Client({ name: "environment-fixture", version: "1.0.0" });
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"env_discover",
			"env_list",
		]);
		expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
			true,
		);
		const listed = await client.callTool({
			name: "env_list",
			arguments: { limit: 1 },
		});
		expect(listed.isError).not.toBe(true);
		expect(listed.structuredContent).toMatchObject({
			mode: "inspection-only",
			executionAvailable: false,
			runtimeChecked: false,
			repositories: [canonicalRepository],
			total: 2,
			nextOffset: 1,
			projects: [{ id: "api", targets: [{ id: "serve", runtime: "shell" }] }],
		});
		expect(JSON.stringify(listed)).not.toContain(secret);
		expect(JSON.stringify(listed)).not.toContain("PRIVATE_TOKEN");
		expect(JSON.stringify(listed)).not.toContain("touch ");
		const next = await client.callTool({
			name: "env_list",
			arguments: { offset: 1 },
		});
		expect(next.structuredContent).toMatchObject({
			projects: [{ id: "web" }],
			nextOffset: null,
		});
		const hints = await client.callTool({
			name: "env_discover",
			arguments: { repository: canonicalRepository },
		});
		expect(hints.structuredContent).toMatchObject({
			executionAvailable: false,
			suggestions: [{ invocation: ["bun", "run", "dev"], trusted: false }],
		});
		expect(JSON.stringify(hints)).not.toContain("touch ");
		const refused = await client.callTool({
			name: "env_discover",
			arguments: { repository: fs.realpathSync(configDir) },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused)).toContain("repository-not-authorized");
		const traversal = await client.callTool({
			name: "env_discover",
			arguments: { repository: canonicalRepository, directory: "../config" },
		});
		expect(traversal.isError).toBe(true);
		const extra = await client.callTool({
			name: "env_list",
			arguments: { owner: "another-task", command: "execute" },
		});
		expect(extra.isError).toBe(true);
		// A complete native installation can exceed the old MCP-only 32-project/
		// 64 KiB limits. Pagination must still reach every configured target.
		const expanded = {
			version: 1,
			projects: Array.from({ length: 41 }, (_, index) => ({
				...definitions.projects[0],
				id: `app-${index}`,
			})),
		};
		fs.writeFileSync(
			definitionsFile,
			`${JSON.stringify(expanded)}${" ".repeat(70000)}`,
		);
		const finalPage = await client.callTool({
			name: "env_list",
			arguments: { offset: 40 },
		});
		expect(finalPage.isError).not.toBe(true);
		expect(finalPage.structuredContent).toMatchObject({
			total: 41,
			nextOffset: null,
			projects: [{ id: "app-40" }],
		});
		expect(JSON.stringify(finalPage)).not.toContain(secret);
		fs.writeFileSync(definitionsFile, " ".repeat(definitionByteLimit + 1));
		expect(
			(await client.callTool({ name: "env_list", arguments: {} })).isError,
		).toBe(true);
		fs.writeFileSync(definitionsFile, `{invalid ${secret}`);
		const invalid = await client.callTool({ name: "env_list", arguments: {} });
		expect(invalid.isError).toBe(true);
		expect(JSON.stringify(invalid)).toContain("catalog-unavailable");
		expect(JSON.stringify(invalid)).not.toContain(secret);
		expect(JSON.stringify(invalid)).not.toContain(configDir);
		expect(fs.existsSync(marker)).toBe(false);
		expect(fs.readdirSync(configDir).sort()).toEqual([
			".env",
			"config.json",
			"environments.json",
		]);
		expect(stderr).toBe("");
	} finally {
		await client.close();
		await transport.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("MCP launch options require explicit absolute authority, not inferred config", () => {
	const serve = [
		"--serve",
		"--config-dir",
		"/config",
		"--state-dir",
		"/state",
		"--clients",
		"/clients.json",
		"--repository",
		"/repo",
	];
	expect(daemonOptions(serve).repositories).toEqual(["/repo"]);
	const repositories = Array.from({ length: 35 }, (_, index) => [
		"--repository",
		`/repo-${index}`,
	]).flat();
	expect(
		parseMcpOptions(["--config-dir", "/config", ...repositories]).repositories,
	).toHaveLength(35);
	expect(
		daemonOptions([...serve.slice(0, -2), ...repositories]).repositories,
	).toHaveLength(35);
	expect(() => daemonOptions([...serve, "--port", "-1"])).toThrow();
	expect(() =>
		daemonOptions(["--serve", "--config-dir", "relative"]),
	).toThrow();
	expect(
		bridgeOptions([
			"--connect",
			"http://127.0.0.1:4123/mcp",
			"--token-env",
			"ENVIRONMENT_TOKEN",
		]).tokenEnv,
	).toBe("ENVIRONMENT_TOKEN");
	for (const url of [
		"https://example.com/mcp",
		"http://token@127.0.0.1:4123/mcp",
		"http://127.0.0.1:4123/mcp?token=secret",
	])
		expect(() =>
			bridgeOptions(["--connect", url, "--token-env", "ENVIRONMENT_TOKEN"]),
		).toThrow();
	expect(
		parseMcpOptions(["--config-dir", "/config", "--repository", "/repo"]),
	).toEqual({
		configDir: "/config",
		repositories: ["/repo"],
	});
	for (const args of [
		[],
		["--config-dir", "/config"],
		["--config-dir", "relative", "--repository", "/repo"],
		[
			"--config-dir",
			"/config",
			"--repository",
			"/repo",
			"--url",
			"https://example.com",
		],
	])
		expect(() => parseMcpOptions(args)).toThrow();
});
