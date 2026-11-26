import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configByteLimit } from "../src/configuration/read-json.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";
import { decideDependencyUse } from "../src/domain/dependency-policy.ts";
import { createCatalogService } from "../src/services/catalog-service.ts";

test("v1 dependency policy reuses shared/external services without granting cleanup", () => {
	const ready = {
		state: "ready",
		identityMatches: true,
		ownedByController: false,
	} as const;
	for (const lifecycle of ["shared", "external"] as const)
		expect(decideDependencyUse(lifecycle, ready)).toEqual({
			action: "reuse",
			cleanup: "never",
		});
	expect(decideDependencyUse("owned", ready)).toMatchObject({
		action: "refuse",
		cleanup: "never",
	});
	expect(
		decideDependencyUse("owned", { ...ready, ownedByController: true }),
	).toEqual({ action: "reuse", cleanup: "when-unreferenced" });
	expect(decideDependencyUse("shared", { state: "absent" })).toEqual({
		action: "start",
		cleanup: "never",
	});
	expect(decideDependencyUse("external", { state: "absent" })).toMatchObject({
		action: "refuse",
	});
	expect(decideDependencyUse("shared", { state: "unknown" })).toMatchObject({
		action: "refuse",
	});
	expect(
		decideDependencyUse("shared", { ...ready, identityMatches: false }),
	).toMatchObject({ action: "refuse" });
	expect(
		decideDependencyUse("external", { ...ready, state: "unready" }),
	).toEqual({ action: "wait", cleanup: "never" });
});

test("the standalone manifest validates selection and defaults dependencies to shared", () => {
	const manifest = {
		version: 1,
		repositories: ["/repo"],
		services: [{ id: "postgres", runtime: "docker" }],
		apps: [
			{
				id: "api",
				repository: "/repo",
				defaults: { run: "mocked" },
				targets: [
					{
						id: "mocked",
						action: "run",
						runtime: "compose",
						dependsOn: [{ service: "postgres" }],
					},
				],
			},
		],
	};
	expect(
		serverManifestSchema.parse(manifest).apps[0]?.targets[0]?.dependsOn[0]
			?.lifecycle,
	).toBe("shared");
	expect(
		serverManifestSchema.safeParse({ ...manifest, services: [] }).success,
	).toBe(false);
	expect(
		serverManifestSchema.safeParse({ ...manifest, principal: "operator" })
			.success,
	).toBe(false);
	expect(
		serverManifestSchema.safeParse({
			...manifest,
			apps: [{ ...manifest.apps[0], defaults: { build: "mocked" } }],
		}).success,
	).toBe(false);
});

test("copied build speaks real stdio MCP outside the checkout with no sibling packages or resource effects", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "standalone-environment-")),
	);
	const repository = path.join(root, "repo"),
		config = path.join(root, "environments.json"),
		artifact = path.join(root, "server.js");
	fs.mkdirSync(repository);
	fs.copyFileSync(new URL("../dist/cli.js", import.meta.url), artifact);
	const secret = "fixture-value-withheld",
		marker = path.join(root, "must-not-run");
	const apps = Array.from({ length: 41 }, (_, index) => ({
		id: `app-${index}`,
		kind: "app",
		repository,
		targets: [
			{
				id: "mocked",
				action: "run",
				runtime: "compose",
				command: `touch ${marker}`,
				environment: { TOKEN: secret },
			},
		],
	}));
	fs.writeFileSync(
		config,
		`${JSON.stringify({ version: 1, projects: apps })}${" ".repeat(70000)}`,
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			artifact,
			"--format",
			"v2-catalog",
			"--config",
			config,
			"--repository",
			repository,
		],
		cwd: root,
		stderr: "pipe",
	});
	let diagnostics = "";
	transport.stderr?.on("data", (value) => {
		diagnostics += String(value);
	});
	const client = new Client({ name: "standalone-fixture", version: "1.0.0" });
	try {
		await client.connect(transport);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			"env_list",
			"env_git_changes",
			"env_git_diff",
			"env_git",
			"env_git_branches",
			"env_git_worktrees",
			"env_git_remotes",
			"env_git_tags",
			"env_git_stashes",
		]);
		const result = await client.callTool({
			name: "env_list",
			arguments: { offset: 40 },
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			total: 41,
			nextOffset: null,
			executionAvailable: false,
			validation: "v2-catalog-metadata-only",
			apps: [{ id: "app-40" }],
		});
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain("touch ");
		expect(
			(
				await client.callTool({
					name: "env_list",
					arguments: { repository: root },
				})
			).isError,
		).toBe(true);
		expect(
			(
				await client.callTool({
					name: "env_list",
					arguments: { owner: "foreign" },
				})
			).isError,
		).toBe(true);
		fs.writeFileSync(config, " ".repeat(configByteLimit + 1));
		expect(
			(await client.callTool({ name: "env_list", arguments: {} })).isError,
		).toBe(true);
		fs.writeFileSync(
			config,
			JSON.stringify({
				version: 1,
				repositories: [repository],
				services: [],
				apps: [{ id: "api", repository, targets: [] }],
			}),
		);
		const standard = createCatalogService({
			file: config,
			format: "manifest",
			repositories: [],
		});
		expect(standard.list({ offset: 0, limit: 10 })).toMatchObject({
			total: 1,
			validation: "manifest-only",
		});
		fs.writeFileSync(
			config,
			JSON.stringify({ version: 1, repositories: [root], apps: [] }),
		);
		expect(() => standard.list({ offset: 0, limit: 10 })).toThrow(
			"allowlist changed",
		);
		expect(fs.existsSync(marker)).toBe(false);
		expect(diagnostics).toBe("");
	} finally {
		await client.close();
		await transport.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
