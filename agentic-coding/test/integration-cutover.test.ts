// Route-family cutover acceptance (`port-git-providers-and-ai-to-bun`,
// tasks 5.1, 5.2). This runs the **unchanged** devenv client (`@devenv/core`)
// against the unified Bun server with the cutover transport hooks enabled, and
// proves:
//   - every migrated family is answered by Bun in-process,
//   - an unported family is delegated to the private Go child by the same
//     server, so the client needs no per-family base URL,
//   - the Go child never receives a migrated request: each route has exactly one
//     runtime owner.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createCustomFetch,
	forwardOrigin,
	forwardUrl,
} from "../packages/devenv/core/src/custom-fetch";
import { createClient } from "../packages/devenv/core/src/index";
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

/** A stand-in for the private Go child: it answers the unported families and
 * records everything it is asked for. */
function startStubChild(recorded: Recorded[]): {
	url: string;
	token: string;
	stop(): void;
} {
	const token = "child-token";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			recorded.push({
				origin: "go",
				method: request.method,
				path: url.pathname,
			});
			if (url.pathname === "/api/health")
				return Response.json({ status: "ok", instance: "child" });
			if (url.pathname === "/api/apps")
				return Response.json({
					apps: [
						{
							ident: "demo",
							displayName: "Demo",
							repositoryPath: APP.repositoryPath,
						},
					],
				});
			if (url.pathname === "/api/scripts") return Response.json([]);
			return Response.json(
				{ error: "Not Found", message: "unknown route", code: 404 },
				{ status: 404 },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		token,
		stop: () => server.stop(true),
	};
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

async function withCutover<T>(
	run: (context: {
		client: ReturnType<typeof createClient>;
		recorded: Recorded[];
		serverUrl: string;
		childUrl: string;
	}) => Promise<T>,
): Promise<T> {
	const recorded: Recorded[] = [];
	const child = startStubChild(recorded);
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
	const server = await startWorkflowServer({
		integrations: services,
		environmentBaseUrl: () => child.url,
		environmentToken: () => child.token,
	});
	// The cutover transport hooks the shell sets: the client keeps its original
	// base URL and the token/forward variables decide the owner.
	const previousForward = process.env.AGENTIC_DEVENV_FORWARD_URL;
	const previousToken = process.env.AGENTIC_WORKFLOW_TOKEN;
	process.env.AGENTIC_DEVENV_FORWARD_URL = server.url;
	process.env.AGENTIC_WORKFLOW_TOKEN = server.token;
	try {
		// The client is constructed with the *child's* URL: the cutover is the
		// transport, not a per-family base URL.
		const client = createClient(
			child.url,
			createCustomFetch() as never,
			() => {},
		);
		return await run({
			client,
			recorded,
			serverUrl: server.url,
			childUrl: child.url,
		});
	} finally {
		if (previousForward === undefined)
			delete process.env.AGENTIC_DEVENV_FORWARD_URL;
		else process.env.AGENTIC_DEVENV_FORWARD_URL = previousForward;
		if (previousToken === undefined) delete process.env.AGENTIC_WORKFLOW_TOKEN;
		else process.env.AGENTIC_WORKFLOW_TOKEN = previousToken;
		await server.stop();
		child.stop();
	}
}

function ownersOf(recorded: Recorded[], pathname: string): string[] {
	return recorded
		.filter((entry) => entry.path === pathname)
		.map((entry) => entry.origin);
}

describe("cutover transport hooks", () => {
	test("a forward origin is derived only from a valid URL", () => {
		expect(forwardOrigin({})).toBeUndefined();
		expect(forwardOrigin({ AGENTIC_DEVENV_FORWARD_URL: "" })).toBeUndefined();
		expect(
			forwardOrigin({ AGENTIC_DEVENV_FORWARD_URL: "not a url" }),
		).toBeUndefined();
		expect(
			forwardOrigin({ AGENTIC_DEVENV_FORWARD_URL: "http://127.0.0.1:4051/x" }),
		).toBe("http://127.0.0.1:4051");
	});

	test("forwarding preserves the path and query", () => {
		expect(
			forwardUrl(
				"http://127.0.0.1:4050/api/gitlab/issues?appIdent=demo&page=2",
				"http://127.0.0.1:4051",
			),
		).toBe("http://127.0.0.1:4051/api/gitlab/issues?appIdent=demo&page=2");
	});
});

describe("provider, issue, change-request and CI journeys", () => {
	test("the unchanged client reaches Bun for every migrated family", async () => {
		await withCutover(async ({ client, recorded }) => {
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

			// Nothing on this journey was answered by the Go child.
			expect(recorded.filter((entry) => entry.origin === "go")).toEqual([]);
		});
	});

	test("an unported family is delegated to the Go child by the same server", async () => {
		await withCutover(async ({ client, recorded }) => {
			const apps = await client.getApps();
			expect(apps[0]?.ident).toBe("demo");
			expect(ownersOf(recorded, "/api/apps")).toEqual(["go"]);
		});
	});

	test("each route family has exactly one runtime owner", async () => {
		await withCutover(async ({ client, recorded }) => {
			await client.getProviders();
			await client.getApps();
			await client.getPiSessions();
			// A migrated path is never seen by the child, and a delegated path is
			// never answered in-process: the two runtimes never both handle a
			// request.
			expect(ownersOf(recorded, "/api/providers")).toEqual([]);
			expect(ownersOf(recorded, "/api/pi-sessions")).toEqual([]);
			expect(ownersOf(recorded, "/api/apps")).toEqual(["go"]);
		});
	});

	test("clearing the forward variable rolls the client back to the child", async () => {
		await withCutover(async ({ client, recorded, serverUrl }) => {
			// Bun owns the ported families while the cutover is on.
			await client.getProviders();
			expect(ownersOf(recorded, "/api/providers")).toEqual([]);

			// Rollback: the transport targets the client's own base URL again.
			// The child stub answers 404 for that path, which is the observable
			// proof that the request no longer reaches Bun.
			delete process.env.AGENTIC_DEVENV_FORWARD_URL;
			let status = 0;
			try {
				await client.getProviders();
			} catch {
				status = 1;
			}
			expect(status).toBe(1);
			// After the rollback the child is the one that saw the request.
			expect(ownersOf(recorded, "/api/providers")).toEqual(["go"]);
			void serverUrl;
		});
	});
});
