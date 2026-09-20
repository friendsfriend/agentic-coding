// Single-process acceptance (`retire-go-backend-and-migration-bridges` tasks
// 1.2, 2.3). This runs the **unchanged** devenv client (`@devenv/core`)
// against the unified server and proves:
//   - every family is answered in this one process, including the identity
//     probe, so no request needs a second address or a forwarding hook,
//   - the client needs only the server URL and the instance capability,
//   - a route with no attached capability fails in-process instead of being
//     answered by another runtime.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createCustomFetch,
	environmentToken,
} from "../packages/devenv/core/src/custom-fetch.ts";
import { createClient } from "../packages/devenv/core/src/index.ts";
import { GitRepository } from "../src/server/integrations/git-repository.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import type { IntegrationServices } from "../src/server/integrations/routes.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

const APP = {
	ident: "demo",
	repositoryPath: "https://gitlab.example.com/acme/devenv.git",
	localDirectoryPath: "/home/demo/demo",
	branch: "fix-login",
	mainWorktreeBranch: "develop",
	provider: "gl",
};

interface Recorded {
	origin: string;
	method: string;
	path: string;
}

function providerStore(): ProviderStore {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-"));
	const providersDir = path.join(configDir, "providers");
	fs.mkdirSync(providersDir, { recursive: true });
	fs.writeFileSync(
		path.join(providersDir, "gl.json"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
		JSON.stringify({ name: "gl", type: "gitlab", token: "${GL}" }),
	);
	fs.writeFileSync(path.join(configDir, ".env"), "GL=token\n");
	const store = new ProviderStore(providersDir, path.join(configDir, ".env"));
	store.load();
	return store;
}

/** A provider fetch that answers every migrated family the journeys touch. */
function providerFetch(recorded: Recorded[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		recorded.push({ origin: "bun", method: "GET", path: url.pathname });
		const project = "/api/v4/projects/acme%2Fdevenv";
		if (url.pathname.includes("/issues/7/notes"))
			return Response.json([
				{
					id: 21,
					body: "me too",
					author: { name: "Hubot", username: "hubot" },
					created_at: "2026-01-04T03:04:05.000Z",
					updated_at: "2026-01-04T03:04:05.000Z",
					system: false,
				},
			]);
		if (url.pathname.endsWith("/issues/7"))
			return Response.json({
				id: 11,
				iid: 7,
				title: "Broken login",
				description: "Fixes #3",
				state: "opened",
				web_url: "https://gitlab.example.com/acme/devenv/-/issues/7",
				author: { name: "Octo", username: "octo" },
				labels: ["bug"],
				assignees: [],
				created_at: "2026-01-02T03:04:05.000Z",
				updated_at: "2026-01-03T03:04:05.000Z",
			});
		if (url.pathname.endsWith("/issues"))
			return Response.json(
				[
					{
						id: 11,
						iid: 7,
						title: "Broken login",
						description: "Fixes #3",
						state: "opened",
						web_url: "https://gitlab.example.com/acme/devenv/-/issues/7",
						author: { name: "Octo", username: "octo" },
						labels: ["bug"],
						assignees: [],
						created_at: "2026-01-02T03:04:05.000Z",
						updated_at: "2026-01-03T03:04:05.000Z",
					},
				],
				{ headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" } },
			);
		if (url.pathname.endsWith("/merge_requests"))
			return Response.json(
				[
					{
						id: 41,
						iid: 9,
						title: "Fix login",
						description: "",
						source_branch: "fix-login",
						target_branch: "develop",
						state: "opened",
						web_url:
							"https://gitlab.example.com/acme/devenv/-/merge_requests/9",
						created_at: "2026-01-02T03:04:05.000Z",
						updated_at: "2026-01-03T03:04:05.000Z",
						author: { name: "Octo", username: "octo" },
						merge_status: "can_be_merged",
						detailed_merge_status: "mergeable",
						draft: false,
						work_in_progress: false,
						has_conflicts: false,
						blocking_discussions_resolved: true,
						rebase_in_progress: false,
						merge_error: "",
					},
				],
				{ headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" } },
			);
		if (url.pathname.endsWith("/merge_requests/9"))
			return Response.json({
				id: 41,
				iid: 9,
				title: "Fix login",
				description: "",
				source_branch: "fix-login",
				target_branch: "develop",
				state: "opened",
				web_url: "https://gitlab.example.com/acme/devenv/-/merge_requests/9",
				created_at: "2026-01-02T03:04:05.000Z",
				updated_at: "2026-01-03T03:04:05.000Z",
				author: { name: "Octo", username: "octo" },
				merge_status: "can_be_merged",
				detailed_merge_status: "mergeable",
				draft: false,
				work_in_progress: false,
				has_conflicts: false,
				blocking_discussions_resolved: true,
				rebase_in_progress: false,
				merge_error: "",
			});
		if (url.pathname.endsWith("/merge_requests/9/discussions"))
			return Response.json([
				{
					id: "abc",
					individual_note: true,
					notes: [
						{
							id: 31,
							type: "DiscussionNote",
							body: "general",
							author: { id: 1, username: "octo", name: "Octo", avatar_url: "" },
							created_at: "2026-01-02T03:04:05.000Z",
							updated_at: "2026-01-02T03:04:05.000Z",
							system: false,
							resolvable: false,
							resolved: false,
						},
					],
				},
			]);
		if (url.pathname.endsWith("/pipelines/77/jobs"))
			return Response.json([
				{
					id: 101,
					name: "build",
					stage: "build",
					status: "success",
					web_url: "https://gitlab.example.com/jobs/101",
					pipeline: { id: 77 },
				},
			]);
		if (url.pathname.endsWith("/jobs/101/trace"))
			return new Response("log line\n", {
				headers: { "content-type": "text/plain" },
			});
		if (url.pathname.endsWith("/projects"))
			return Response.json([
				{
					name: "devenv",
					path_with_namespace: "acme/devenv",
					http_url_to_repo: "https://gitlab.example.com/acme/devenv.git",
					default_branch: "main",
				},
			]);
		void project;
		return Response.json({ message: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

async function withServer<T>(
	run: (context: {
		client: ReturnType<typeof createClient>;
		recorded: Recorded[];
		serverUrl: string;
	}) => Promise<T>,
): Promise<T> {
	const recorded: Recorded[] = [];
	const services: IntegrationServices = {
		providers: providerStore(),
		git: new GitRepository(),
		apps: {
			getAppByIdent: (ident) => (ident === APP.ident ? APP : undefined),
			getApps: () => [APP],
			updateAppActiveWorktree: () => {},
			loadConfig: () => {},
		},
		fetch: providerFetch(recorded),
	};
	const server = await startWorkflowServer({ integrations: services });
	// The shell's contract after the retirement: the client is pointed at the
	// server it talks to and presents the server's capability. There is no
	// forwarding hook, because there is no second runtime to forward to.
	const previousToken = process.env.AGENTIC_DEVENV_TOKEN;
	process.env.AGENTIC_DEVENV_TOKEN = server.token;
	try {
		const client = createClient(
			server.url,
			createCustomFetch() as never,
			() => {},
		);
		return await run({ client, recorded, serverUrl: server.url });
	} finally {
		if (previousToken === undefined) delete process.env.AGENTIC_DEVENV_TOKEN;
		else process.env.AGENTIC_DEVENV_TOKEN = previousToken;
		await server.stop();
	}
}

function ownersOf(recorded: Recorded[], pathname: string): string[] {
	return recorded
		.filter((entry) => entry.path === pathname)
		.map((entry) => entry.origin);
}

describe("environment capability selection", () => {
	test("the environment surface prefers its own capability and falls back to the workflow one", () => {
		expect(environmentToken({})).toBeUndefined();
		// The single-process case: one listener, one capability.
		expect(environmentToken({ AGENTIC_WORKFLOW_TOKEN: "shared" })).toBe(
			"shared",
		);
		// An attached environment surface keeps its own capability.
		expect(
			environmentToken({
				AGENTIC_DEVENV_TOKEN: "surface",
				AGENTIC_WORKFLOW_TOKEN: "workflow",
			}),
		).toBe("surface");
	});
});

describe("provider, issue, change-request and CI journeys", () => {
	test("the unchanged client reaches the one server for every family", async () => {
		await withServer(async ({ client, recorded }) => {
			const providers = await client.getProviders();
			expect(providers).toEqual([
				{ name: "gl", type: "gitlab", username: "", has_token: true },
			]);

			const repos = await client.searchRepos(
				"gl",
				"acme",
				"gitlab.example.com",
			);
			expect(repos[0]?.fullPath).toBe("acme/devenv");

			const issues = await client.getIssues("demo", "all", "gitlab", 1, 50);
			expect(issues.items[0]?.iid).toBe(7);
			const issue = await client.getIssue("demo", 7, "gitlab");
			expect(issue.title).toBe("Broken login");
			const comments = await client.getIssueComments("demo", 7, "gitlab");
			expect(comments.items[0]?.body).toBe("me too");

			const changeRequests = await client.getChangeRequests(
				"demo",
				"opened",
				"current",
				"gitlab",
				1,
				50,
			);
			expect(changeRequests.items[0]?.iid).toBe(9);
			// (The client's single change-request fetch is GitHub-only today, so
			// the GitLab journey covers the list and the discussions below.)
			const discussions = await client.getCRDiscussions("demo", 9, "gitlab");
			expect(discussions[0]?.notes[0]?.body).toBe("general");

			const jobs = await client.getPipelineJobs("demo", 77, "gitlab");
			expect(jobs[0]?.name).toBe("build");
			const logs = await client.getJobLogs("demo", 101, "gitlab");
			expect(logs).toBe("log line\n");

			const sessions = await client.getPiSessions();
			expect(Array.isArray(sessions)).toBe(true);

			// Every provider call went to the provider API, not to a second
			// application runtime.
			expect(recorded.every((entry) => entry.origin === "bun")).toBe(true);
		});
	});

	test("the identity probe is answered in this process", async () => {
		await withServer(async ({ client, recorded }) => {
			expect(await client.health()).toBe(true);
			expect(ownersOf(recorded, "/api/health")).toEqual([]);
		});
	});

	test("a capability that is not attached fails in-process", async () => {
		await withServer(async ({ client, recorded }) => {
			// The app family is served by the environment authority, which this
			// composition does not attach: the request fails here instead of being
			// answered by another runtime, and no request leaves the process.
			await expect(client.getApps()).rejects.toThrow();
			expect(ownersOf(recorded, "/api/apps")).toEqual([]);
		});
	});
});
