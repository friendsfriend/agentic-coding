import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderApi } from "../src/adapters/http/provider-api.ts";
import { readProviderConfigs } from "../src/configuration/providers.ts";
import type { ProviderConfig } from "../src/domain/provider.ts";

const github: ProviderConfig = {
	name: "github-fixture",
	type: "github",
	baseUrl: "https://api.github.example",
	username: "fixture",
	tokenRef: "GH_TOKEN",
};
const gitlab: ProviderConfig = {
	name: "gitlab-fixture",
	type: "gitlab",
	baseUrl: "https://gitlab.example",
	username: "Fixture User",
	tokenRef: "GL_TOKEN",
};
const tokens = {
	get: (reference: string) =>
		reference === "GH_TOKEN"
			? "gh-secret-value"
			: reference === "GL_TOKEN"
				? "gl-secret-value"
				: undefined,
};

function response(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("provider reads are bounded, mapped and never expose tokens", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.endsWith("/api/graphql") && init?.method === "POST") {
			return response({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [
									{
										id: "THREAD1",
										isResolved: true,
										comments: {
											nodes: [
												{
													databaseId: 31,
													body: "note gh-secret-value",
													author: { login: "reviewer" },
													url: "https://github.com/org/repo/pull/7#note",
													createdAt: "2026-01-01T00:00:00Z",
												},
											],
										},
									},
								],
							},
						},
					},
				},
			});
		}
		if (url.includes("/search/repositories")) {
			return response({
				items: [
					{
						full_name: "org/repo",
						name: "repo",
						description: "fixture repo",
						html_url: "https://github.com/org/repo",
						default_branch: "main",
					},
				],
			});
		}
		if (url.endsWith("/pulls/7")) {
			return response({
				number: 7,
				title: "detail",
				state: "open",
				user: { login: "author" },
				head: { ref: "feature", sha: "a".repeat(40) },
				base: { ref: "main" },
				html_url: "https://github.com/org/repo/pull/7",
				body: "description gh-secret-value",
				additions: 3,
				deletions: 1,
				changed_files: 2,
				created_at: "2026-01-01T00:00:00Z",
			});
		}
		if (url.includes("/pulls/7/files")) {
			return response([
				{
					filename: "src/a.ts",
					status: "modified",
					additions: 2,
					deletions: 1,
					patch: "@@ -1 +1 @@",
				},
			]);
		}
		if (url.includes("/pulls/7/commits")) {
			return response([
				{
					sha: "a".repeat(40),
					commit: {
						message: "change",
						author: { name: "author", date: "2026-01-01T00:00:00Z" },
					},
				},
			]);
		}
		if (url.includes("/pulls/7/comments")) {
			return response([
				{
					id: 31,
					body: "note gh-secret-value",
					user: { login: "reviewer" },
					html_url: "https://github.com/org/repo/pull/7#note",
					created_at: "2026-01-01T00:00:00Z",
				},
			]);
		}
		if (url.includes("/pulls")) {
			return response([
				{
					number: 7,
					title: "title gh-secret-value",
					state: "open",
					user: { login: "author" },
					head: { ref: "feature" },
					base: { ref: "main" },
					html_url: "https://github.com/org/repo/pull/7",
				},
			]);
		}
		if (url.includes("/issues/8/comments")) {
			return response([
				{
					id: 51,
					body: "issue comment",
					user: { login: "reviewer" },
					html_url: "https://github.com/org/repo/issues/8#comment",
					created_at: "2026-01-01T00:00:00Z",
				},
			]);
		}
		if (url.endsWith("/issues/8")) {
			return response({
				number: 8,
				title: "issue detail",
				state: "open",
				user: { login: "author" },
				labels: [{ name: "bug" }],
				html_url: "https://github.com/org/repo/issues/8",
				body: "issue body",
				created_at: "2026-01-01T00:00:00Z",
			});
		}
		if (url.includes("/issues")) {
			return response([
				{
					number: 8,
					title: "issue",
					state: "open",
					user: { login: "author" },
					labels: [{ name: "bug" }],
					html_url: "https://github.com/org/repo/issues/8",
				},
				{ number: 9, pull_request: {} },
			]);
		}
		if (url.includes("/actions/jobs/12/logs")) {
			return new Response("log line gh-secret-value\n", { status: 200 });
		}
		if (url.includes("/actions/runs/")) {
			return response({
				jobs: [
					{
						id: 12,
						name: "test",
						status: "completed",
						conclusion: "success",
						html_url: "https://github.com/org/repo/actions/12",
					},
				],
			});
		}
		if (url.includes("/actions/runs")) {
			return response({
				workflow_runs: [
					{
						id: 11,
						display_title: "CI",
						status: "completed",
						conclusion: "success",
						head_branch: "main",
						html_url: "https://github.com/org/repo/actions/11",
						updated_at: "2026-01-01T00:00:00Z",
					},
				],
			});
		}
		return response({});
	}) as typeof fetch;
	const api = createProviderApi([github, gitlab], tokens, fetchImpl);
	const signal = new AbortController().signal;
	const providers = api.list();
	expect(providers).toEqual([
		{
			name: "github-fixture",
			type: "github",
			baseUrl: "https://api.github.example",
			username: "fixture",
			hasToken: true,
		},
		expect.objectContaining({ name: "gitlab-fixture", hasToken: true }),
	]);
	expect(JSON.stringify(providers)).not.toContain("secret");

	const repositories = await api.repositories(
		"github-fixture",
		"org repo",
		signal,
	);
	expect(repositories).toEqual([
		{
			reference: "org/repo",
			name: "repo",
			description: "fixture repo",
			url: "https://github.com/org/repo",
			defaultBranch: "main",
		},
	]);
	expect(calls[0]?.url).toContain("q=org%20repo");
	expect(calls[0]?.init?.headers).toMatchObject({
		Authorization: "Bearer gh-secret-value",
	});

	const changes = await api.changes(
		"github-fixture",
		"org/repo",
		"open",
		signal,
	);
	expect(changes[0]).toMatchObject({
		number: 7,
		title: "title [REDACTED]",
		sourceBranch: "feature",
		targetBranch: "main",
		author: "author",
	});
	expect(JSON.stringify(changes)).not.toContain("gh-secret-value");
	expect(calls.some((call) => call.url.includes("/repos/org/repo/pulls"))).toBe(
		true,
	);

	const issues = await api.issues("github-fixture", "org/repo", "all", signal);
	expect(issues.map((issue) => issue.number)).toEqual([8]);
	expect(issues[0]?.labels).toEqual(["bug"]);

	const pipelines = await api.pipelines("github-fixture", "org/repo", signal);
	expect(pipelines[0]).toMatchObject({
		id: 11,
		name: "CI",
		status: "completed",
		conclusion: "success",
		ref: "main",
	});
	const jobs = await api.jobs("github-fixture", "org/repo", 11, signal);
	expect(jobs[0]).toMatchObject({
		id: 12,
		name: "test",
		status: "completed",
		conclusion: "success",
	});

	const change = await api.change("github-fixture", "org/repo", 7, signal);
	expect(change).toMatchObject({
		title: "detail",
		body: "description [REDACTED]",
		additions: 3,
		deletions: 1,
		changedFiles: 2,
		headSha: "a".repeat(40),
	});
	const files = await api.changeFiles("github-fixture", "org/repo", 7, signal);
	expect(files).toMatchObject({
		truncated: false,
		files: [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
				patch: "@@ -1 +1 @@",
			},
		],
	});
	const versions = await api.changeVersions(
		"github-fixture",
		"org/repo",
		7,
		signal,
	);
	expect(versions[0]).toMatchObject({
		sha: "a".repeat(40),
		message: "change",
		author: "author",
	});
	const issue = await api.issue("github-fixture", "org/repo", 8, signal);
	expect(issue).toMatchObject({
		number: 8,
		title: "issue detail",
		body: "issue body",
		labels: ["bug"],
	});
	const issueComments = await api.issueComments(
		"github-fixture",
		"org/repo",
		8,
		signal,
	);
	expect(issueComments[0]).toMatchObject({
		id: "51",
		author: "reviewer",
		body: "issue comment",
	});
	const discussions = await api.discussions(
		"github-fixture",
		"org/repo",
		7,
		signal,
	);
	expect(discussions[0]).toMatchObject({
		id: "31",
		threadId: "THREAD1",
		author: "reviewer",
		body: "note [REDACTED]",
		resolved: true,
	});
	const logs = await api.jobLogs("github-fixture", "org/repo", 12, signal);
	expect(logs).toMatchObject({
		output: "log line [REDACTED]\n",
		truncated: false,
	});
});

test("GitLab reads use project-scoped paths and merge-request filters", async () => {
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("/api/v4/projects?search="))
			return response([
				{
					path_with_namespace: "group/sub/repo",
					name: "repo",
					description: "gitlab fixture",
					web_url: "https://gitlab.example/group/sub/repo",
					default_branch: "main",
				},
			]);
		if (url.includes("/merge_requests/4/changes"))
			return response({
				changes: [
					{
						old_path: "src/a.ts",
						new_path: "src/a.ts",
						diff: "@@ -1 +1 @@",
					},
				],
			});
		if (url.includes("/merge_requests/4/versions"))
			return response([
				{
					id: 1,
					head_commit_sha: "b".repeat(40),
					created_at: "2026-01-01T00:00:00Z",
				},
			]);
		if (url.includes("/merge_requests/4/discussions"))
			return response([
				{
					id: "d1",
					notes: [
						{
							id: 41,
							body: "note",
							author: { username: "reviewer" },
							resolved: true,
							created_at: "2026-01-01T00:00:00Z",
						},
					],
				},
			]);
		if (url.endsWith("/merge_requests/4"))
			return response({
				iid: 4,
				title: "MR detail",
				state: "opened",
				author: { username: "author" },
				source_branch: "feature",
				target_branch: "main",
				web_url: "https://gitlab.example/group/sub/repo/-/merge_requests/4",
				description: "MR body",
				changes_count: "3",
				diff_refs: { head_sha: "b".repeat(40) },
			});
		if (url.includes("/merge_requests"))
			return response([
				{
					iid: 4,
					title: "MR",
					state: "opened",
					author: { username: "author" },
					source_branch: "feature",
					target_branch: "main",
					web_url: "https://gitlab.example/group/sub/repo/-/merge_requests/4",
				},
			]);
		if (url.includes("/jobs/21/trace"))
			return new Response("gitlab log line\n", { status: 200 });
		if (url.includes("/pipelines/") && url.includes("/jobs"))
			return response([
				{
					id: 21,
					name: "unit",
					status: "success",
					stage: "test",
					web_url: "https://gitlab.example/jobs/21",
				},
			]);
		if (url.includes("/pipelines"))
			return response([
				{
					id: 20,
					ref: "main",
					status: "success",
					web_url: "https://gitlab.example/pipelines/20",
					updated_at: "2026-01-01T00:00:00Z",
				},
			]);
		if (url.includes("/issues/5/notes"))
			return response([
				{
					id: 61,
					body: "issue note",
					author: { username: "reviewer" },
					created_at: "2026-01-01T00:00:00Z",
				},
			]);
		if (url.endsWith("/issues/5"))
			return response({
				iid: 5,
				title: "issue detail",
				state: "opened",
				author: { username: "author" },
				labels: ["bug"],
				web_url: "https://gitlab.example/issues/5",
				description: "issue body",
			});
		if (url.includes("/issues"))
			return response([
				{
					iid: 5,
					title: "issue",
					state: url.includes("state=closed") ? "closed" : "opened",
					author: { username: "author" },
					labels: ["bug"],
					web_url: "https://gitlab.example/issues/5",
				},
			]);
		return response({});
	}) as typeof fetch;
	const api = createProviderApi([gitlab], tokens, fetchImpl);
	const signal = new AbortController().signal;

	await api.repositories("gitlab-fixture", "repo", signal);
	expect(calls[0]).toContain("/api/v4/projects?search=repo");

	const changes = await api.changes(
		"gitlab-fixture",
		"group/sub/repo",
		"open",
		signal,
	);
	expect(calls[1]).toContain(
		"/api/v4/projects/group%2Fsub%2Frepo/merge_requests",
	);
	expect(calls[1]).toContain("state=opened");
	expect(changes[0]).toMatchObject({ number: 4, state: "open" });

	const issues = await api.issues(
		"gitlab-fixture",
		"group/sub/repo",
		"closed",
		signal,
	);
	expect(calls[2]).toContain("state=closed");
	expect(issues[0]?.state).toBe("closed");

	const pipelines = await api.pipelines(
		"gitlab-fixture",
		"group/sub/repo",
		signal,
	);
	expect(pipelines[0]).toMatchObject({
		id: 20,
		name: "main",
		status: "success",
	});
	const jobs = await api.jobs("gitlab-fixture", "group/sub/repo", 20, signal);
	expect(jobs[0]).toMatchObject({ id: 21, stage: "test", status: "success" });

	const detail = await api.change(
		"gitlab-fixture",
		"group/sub/repo",
		4,
		signal,
	);
	expect(detail).toMatchObject({
		title: "MR detail",
		body: "MR body",
		changedFiles: 3,
		headSha: "b".repeat(40),
		state: "open",
	});
	const files = await api.changeFiles(
		"gitlab-fixture",
		"group/sub/repo",
		4,
		signal,
	);
	expect(files.files[0]).toMatchObject({
		path: "src/a.ts",
		status: "modified",
		patch: "@@ -1 +1 @@",
	});
	const versions = await api.changeVersions(
		"gitlab-fixture",
		"group/sub/repo",
		4,
		signal,
	);
	expect(versions[0]).toMatchObject({ sha: "b".repeat(40) });
	const issue = await api.issue("gitlab-fixture", "group/sub/repo", 5, signal);
	expect(issue).toMatchObject({
		title: "issue detail",
		body: "issue body",
		labels: ["bug"],
	});
	const issueComments = await api.issueComments(
		"gitlab-fixture",
		"group/sub/repo",
		5,
		signal,
	);
	expect(issueComments[0]).toMatchObject({
		id: "61",
		author: "reviewer",
		body: "issue note",
	});
	const discussions = await api.discussions(
		"gitlab-fixture",
		"group/sub/repo",
		4,
		signal,
	);
	expect(discussions[0]).toMatchObject({
		id: "41",
		author: "reviewer",
		body: "note",
		resolved: true,
	});
	const logs = await api.jobLogs(
		"gitlab-fixture",
		"group/sub/repo",
		21,
		signal,
	);
	expect(logs).toMatchObject({ output: "gitlab log line\n", truncated: false });
});

test("provider refusals are bounded and do not echo secrets", async () => {
	const signal = new AbortController().signal;
	const missingToken = createProviderApi(
		[{ ...github, tokenRef: "MISSING" }],
		{ get: () => undefined },
		(async () => response({})) as unknown as typeof fetch,
	);
	await expect(
		missingToken.changes("github-fixture", "org/repo", "open", signal),
	).rejects.toMatchObject({ code: "provider-token-unavailable" });
	await expect(
		missingToken.repositories("unknown", "repo", signal),
	).rejects.toMatchObject({ code: "provider-not-configured" });

	const unauthorized = createProviderApi([github], tokens, (async () =>
		response({ message: "gh-secret-value" }, 401)) as unknown as typeof fetch);
	await expect(
		unauthorized.pipelines("github-fixture", "org/repo", signal),
	).rejects.toMatchObject({ code: "provider-unauthorized" });

	const oversized = createProviderApi([github], tokens, (async () =>
		response({
			items: ["x".repeat(1_100_000)],
		})) as unknown as typeof fetch);
	await expect(
		oversized.repositories("github-fixture", "repo", signal),
	).rejects.toMatchObject({ code: "provider-response-too-large" });

	const invalid = createProviderApi([github], tokens, (async () =>
		response({ items: {} })) as unknown as typeof fetch);
	await expect(
		invalid.repositories("github-fixture", "repo", signal),
	).rejects.toMatchObject({ code: "provider-invalid" });

	const bounded = createProviderApi([github], tokens, (async (
		input: string | URL | Request,
	) => {
		const url = String(input);
		if (url.includes("/files"))
			return response([{ filename: "big.ts", patch: "x".repeat(60_000) }]);
		if (url.includes("/logs"))
			return new Response("y".repeat(80_000), { status: 200 });
		return response({});
	}) as unknown as typeof fetch);
	const files = await bounded.changeFiles(
		"github-fixture",
		"org/repo",
		7,
		signal,
	);
	expect(files.truncated).toBe(true);
	expect(files.files[0]?.patch.length).toBeLessThanOrEqual(48 * 1024);
	const logs = await bounded.jobLogs("github-fixture", "org/repo", 12, signal);
	expect(logs.truncated).toBe(true);
	expect(logs.output.length).toBeLessThanOrEqual(64 * 1024);
});

test("provider configuration accepts HTTPS and loopback HTTP only", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-provider-"));
	try {
		fs.writeFileSync(
			path.join(root, "config.json"),
			JSON.stringify({
				providers: [
					{
						name: "github-fixture",
						type: "github",
						baseUrl: "https://api.github.example",
						tokenRef: "GH_TOKEN",
					},
					{
						name: "gitlab-fixture",
						type: "gitlab",
						baseUrl: "http://127.0.0.1:8080",
					},
				],
			}),
		);
		expect(readProviderConfigs(root)).toEqual([
			expect.objectContaining({
				name: "github-fixture",
				baseUrl: "https://api.github.example",
				tokenRef: "GH_TOKEN",
			}),
			expect.objectContaining({
				name: "gitlab-fixture",
				baseUrl: "http://127.0.0.1:8080",
				tokenRef: "",
			}),
		]);
		fs.writeFileSync(
			path.join(root, "config.json"),
			JSON.stringify({
				providers: [
					{
						name: "bad",
						type: "github",
						baseUrl: "http://api.github.example",
					},
				],
			}),
		);
		expect(() => readProviderConfigs(root)).toThrow(
			"Provider base URL must use HTTPS",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
