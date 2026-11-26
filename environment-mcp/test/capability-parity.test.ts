import { expect, test } from "bun:test";
import fs from "node:fs";
import type { GitDiffSide } from "../src/domain/git-status.ts";
import {
	createCapabilities,
	type EnvironmentCapabilities,
} from "../src/interface/capabilities.ts";
import { describeAction } from "../src/interface/descriptors.ts";
import { mcpToolSurface } from "../src/mcp/tool-surface.ts";
import { createUiCapabilityApi } from "../src/ui/capability-api.ts";

const fakeCatalog = { list: () => ({ mode: "fixture" }) } as never;
const fakeExecution = {
	admit: async () => ({ id: "operation" }),
	execute: async () => ({ receipt: null }),
	wait: async () => ({ receipt: null }),
	status: async () => ({ owned: [] }),
	containerStats: async () => ({
		containers: [],
		unavailable: 0,
		note: "",
	}),
	stop: async () => ({ stopped: [] }),
	logs: async () => ({ output: "" }),
	history: async () => ({ operations: [], total: 0, nextOffset: null }),
} as never;

function fixture(): EnvironmentCapabilities {
	return createCapabilities({
		catalog: fakeCatalog,
		repositories: ["/fixture/repo"],
		execution: fakeExecution,
		gitActions: {
			branches: async (repository) => ({
				repository,
				branches: [],
			}),
			worktrees: async (repository) => ({
				repository,
				worktrees: [],
			}),
			remotes: async (repository) => ({
				repository,
				remotes: [],
			}),
			log: async (repository) => ({
				repository,
				commits: [],
			}),
			commit: async (repository, sha) => ({
				repository,
				sha,
				shortSha: sha.slice(0, 8),
				subject: "",
				author: "",
				parents: [],
				body: "",
				files: [],
				diff: "",
				truncated: false,
			}),
			tags: async (repository) => ({
				repository,
				tags: [],
			}),
			stashes: async (repository) => ({
				repository,
				stashes: [],
			}),
			run: async (repository, request) => ({
				repository,
				action: request.action,
				status: "completed",
				output: "",
				truncated: false,
			}),
			write: async (repository, request, requestId, confirm) =>
				confirm
					? {
							status: "completed",
							digest: confirm,
							outcome: {
								repository,
								action: request.action,
								status: "completed",
								output: "",
								truncated: false,
							},
						}
					: {
							status: "confirmation-required",
							digest: "0".repeat(64),
							intent: {
								repository,
								action: request.action,
								target: requestId,
							},
						},
		},
		git: {
			status: async () => [],
			changes: async (repository) => ({
				repository,
				changes: [],
				truncated: false,
			}),
			diff: async (repository, path, _signal, side: GitDiffSide = "all") => ({
				repository,
				path,
				side,
				diff: "",
				binary: false,
				truncated: false,
				note: "no-change",
			}),
		},
		config: {
			revision: () => ({
				digest: "a".repeat(64),
				apps: 1,
				targets: 2,
				repositories: ["/fixture/repo"],
			}),
			preview: () => ({
				status: "confirmation-required",
				expectedDigest: "a".repeat(64),
				nextDigest: "b".repeat(64),
				confirm: "c".repeat(64),
				summary: "create app",
			}),
			apply: async () => ({
				status: "completed",
				digest: "b".repeat(64),
				summary: "created",
			}),
		},
		kubernetes: {
			list: () => [
				{
					id: "devenv",
					context: "kind-devenv",
					repositories: ["/fixture/repo"],
				},
			],
			resources: async (_repositories, cluster, namespace) => ({
				cluster,
				namespace,
				output: "",
				truncated: false,
				items: [],
			}),
			namespaces: async (_repositories, cluster) => ({
				cluster,
				namespaces: [],
			}),
			events: async (_repositories, cluster, namespace) => ({
				cluster,
				namespace,
				output: "",
				truncated: false,
				events: [],
			}),
			describe: async (_repositories, cluster, namespace, kind, name) => ({
				cluster,
				namespace,
				kind,
				name,
				output: "",
				truncated: false,
			}),
			podLogs: async (_repositories, cluster, namespace, pod, container) => ({
				cluster,
				namespace,
				pod,
				...(container ? { container } : {}),
				output: "",
				truncated: false,
			}),
		},
		providers: {
			list: () => [
				{
					name: "github-fixture",
					type: "github" as const,
					baseUrl: "https://api.github.example",
					username: "fixture",
					hasToken: true,
				},
			],
			repositories: async () => [],
			changes: async () => [],
			issues: async () => [],
			pipelines: async () => [],
			jobs: async () => [],
			change: async (_provider, _repository, number) => ({
				id: `github-change-${number}`,
				number,
				title: "",
				state: "open",
				sourceBranch: "",
				targetBranch: "",
				author: "",
				url: "",
				body: "",
			}),
			changeFiles: async () => ({ files: [], truncated: false }),
			changeVersions: async () => [],
			issue: async (_provider, _repository, number) => ({
				id: `github-issue-${number}`,
				number,
				title: "",
				state: "open",
				author: "",
				labels: [],
				url: "",
				body: "",
			}),
			discussions: async () => [],
			issueComments: async () => [],
			jobLogs: async () => ({ output: "", truncated: false }),
			write: async (intent) => ({
				status: "confirmation-required",
				digest: "a".repeat(64),
				intent: {
					provider: intent.provider,
					action: intent.action,
					target: "fixture:1",
				},
			}),
			writes: () => [],
		},
		refresh: () => ({ refreshed: true }),
	});
}

test("MCP and UI expose exactly the same capabilities from one registry", async () => {
	const capabilities = fixture();
	const mcp = mcpToolSurface(capabilities);
	const ui = createUiCapabilityApi(capabilities);
	const signal = new AbortController().signal;
	const actions = await ui.list();
	const names = capabilities.list().map((capability) => capability.name);
	expect(mcp.map((tool) => tool.name)).toEqual(names);
	expect(actions.map((action) => action.name)).toEqual(names);
	expect(new Set(names).size).toBe(names.length);
	expect(names).toContain("env_refresh");
	expect(names).toContain("env_container_stats");
	expect(names).toContain("env_providers");
	expect(names).toContain("env_provider_repository");
	expect(names).toContain("env_provider_pipelines");
	expect(names).toContain("env_provider_change");
	expect(names).toContain("env_provider_job_logs");
	expect(names).toContain("env_provider_comment_change");
	expect(names).toContain("env_provider_approve_change");
	expect(names).toContain("env_provider_cancel_pipeline");
	expect(names).toContain("env_provider_merge_change");
	expect(names).toContain("env_provider_set_issue_state");
	expect(names).toContain("env_provider_rebase_change");
	expect(names).toContain("env_provider_unapprove_change");
	expect(names).toContain("env_provider_reply_discussion");
	expect(names).toContain("env_provider_set_discussion_resolved");
	expect(names).toContain("env_provider_add_labels");
	expect(names).toContain("env_provider_set_assignees");
	expect(names).toContain("env_provider_retry_job");
	expect(names).toContain("env_provider_writes");
	expect(names).toContain("env_config_revision");
	expect(names).toContain("env_app_create");
	expect(names).toContain("env_target_update");
	expect(names).toContain("env_clusters");
	expect(names).toContain("env_cluster_resources");
	expect(names).toContain("env_cluster_namespaces");
	expect(names).toContain("env_cluster_events");
	expect(names).toContain("env_cluster_describe");
	expect(names).toContain("env_pod_logs");
	expect(await capabilities.invoke("env_providers", {}, { signal })).toEqual({
		providers: [
			expect.objectContaining({
				name: "github-fixture",
				hasToken: true,
			}),
		],
	});
	expect(
		await capabilities.invoke(
			"env_provider_repository",
			{ repository: "/fixture/repo" },
			{ signal },
		),
	).toEqual({ repository: "/fixture/repo", matches: [] });
	expect(
		await capabilities.invoke(
			"env_provider_repository",
			{ repository: "/outside/repo", session: true },
			{ signal },
		),
	).toEqual({ repository: "/outside/repo", matches: [] });
	expect(
		await capabilities.invoke("env_config_revision", {}, { signal }),
	).toEqual({
		digest: "a".repeat(64),
		apps: 1,
		targets: 2,
		repositories: ["/fixture/repo"],
	});
	expect(await capabilities.invoke("env_clusters", {}, { signal })).toEqual({
		clusters: [
			{
				id: "devenv",
				context: "kind-devenv",
				repositories: ["/fixture/repo"],
			},
		],
	});
	expect(
		await capabilities.invoke(
			"env_provider_change",
			{ provider: "github-fixture", repository: "org/repo", number: 1 },
			{ signal },
		),
	).toMatchObject({ change: { number: 1 } });
	expect(
		names.some((name) => /^env_(approve|reject|decision)/.test(name)),
	).toBe(false);
	for (const tool of mcp) {
		const capability = capabilities
			.list()
			.find((item) => item.name === tool.name);
		const action = actions.find((item) => item.name === tool.name);
		expect(action).toBeDefined();
		if (!capability || !action) throw new Error("Missing parity fixture");
		expect(tool.config.inputSchema).toBe(capability.inputSchema);
		expect(action.inputSchema).toEqual(describeAction(capability).inputSchema);
		expect(action.label.length).toBeGreaterThan(0);
	}
});

test("the UI layer has no server, MCP or service-construction dependency", () => {
	const directory = new URL("../src/ui/", import.meta.url);
	const files = fs
		.readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) {
		const source = fs.readFileSync(new URL(file.name, directory), "utf8");
		expect(source).not.toMatch(
			/from "\.\.\/(mcp|services|operator|persistence)\//,
		);
		expect(source).not.toContain("Bun.serve");
		expect(source).not.toContain("createExecutionService");
	}
});

test("entry points do not carry their own action tables", () => {
	for (const file of [
		"src/mcp/create-server.ts",
		"src/mcp/tool-surface.ts",
		"src/ui/capability-api.ts",
	]) {
		const source = fs.readFileSync(
			new URL(`../${file}`, import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(/"env_[a-z_]+"/);
	}
	expect(
		fs.readFileSync(
			new URL("../src/mcp/create-server.ts", import.meta.url),
			"utf8",
		),
	).toContain("mcpToolSurface");
	expect(
		fs.readFileSync(
			new URL("../src/ui/capability-api.ts", import.meta.url),
			"utf8",
		),
	).toContain("capabilities.list()");
});

test("git status is limited to the authenticated repository allowlist", async () => {
	const capabilities = fixture();
	const signal = new AbortController().signal;
	await expect(
		capabilities.invoke(
			"env_git",
			{ repositories: ["/fixture/repo"] },
			{ signal },
		),
	).resolves.toEqual({ repositories: [] });
	await expect(
		capabilities.invoke(
			"env_git",
			{ repositories: ["/fixture/other"] },
			{ signal },
		),
	).rejects.toMatchObject({ code: "repository-unauthorized" });
	await expect(
		capabilities.invoke(
			"env_git_changes",
			{ repository: "/fixture/repo" },
			{ signal },
		),
	).resolves.toMatchObject({ changes: [], truncated: false });
	await expect(
		capabilities.invoke(
			"env_git_diff",
			{ repository: "/fixture/repo", path: "src/a.ts" },
			{ signal },
		),
	).resolves.toMatchObject({ path: "src/a.ts", diff: "" });
	await expect(
		capabilities.invoke(
			"env_git_changes",
			{ repository: "/fixture/other" },
			{ signal },
		),
	).rejects.toMatchObject({ code: "repository-unauthorized" });
	await expect(
		capabilities.invoke(
			"env_git_changes",
			{ repository: "/fixture/outside", session: true },
			{ signal },
		),
	).resolves.toMatchObject({ changes: [] });
	await expect(
		capabilities.invoke(
			"env_git_diff",
			{
				repository: "/fixture/outside",
				path: "src/a.ts",
				side: "staged",
				session: true,
			},
			{ signal },
		),
	).resolves.toMatchObject({ path: "src/a.ts", side: "staged" });
	await expect(
		capabilities.invoke(
			"env_git_remotes",
			{ repository: "/fixture/repo" },
			{ signal },
		),
	).resolves.toMatchObject({ remotes: [] });
	await expect(
		capabilities.invoke(
			"env_git_remotes",
			{ repository: "/fixture/outside", session: true },
			{ signal },
		),
	).resolves.toMatchObject({ remotes: [] });
});
