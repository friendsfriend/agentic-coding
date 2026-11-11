import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { git } from "../src/git.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { DevEnvClient } from "../src/tui/features/environments/core/client.ts";
import { GatewayBackend } from "../src/tui/features/environments/gateway-backend.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(() => {
	delete process.env.WORKBENCH_TOKEN;
	return cleanup();
});

const seen: { method: string; path: string; token: string; body: string }[] =
	[];
const issue = (state: string, labels: string[] = []) => ({
	id: 30,
	iid: 3,
	title: "Broken login",
	description: "token stub-workbench-secret leaked",
	state,
	web_url: "https://gitlab.invalid/group/api/-/issues/3",
	author: { name: "Dev", username: "dev" },
	labels,
	assignees: [],
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
});
const mergeRequest = {
	id: 70,
	iid: 7,
	title: "Feature",
	description: "",
	source_branch: "feature/login",
	target_branch: "develop",
	state: "opened",
	web_url: "https://gitlab.invalid/group/api/-/merge_requests/7",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	author: { name: "Dev", username: "dev" },
	head_pipeline: { id: 11, status: "failed", web_url: "https://p" },
	merge_status: "can_be_merged",
	detailed_merge_status: "mergeable",
	draft: false,
	work_in_progress: false,
	has_conflicts: false,
	blocking_discussions_resolved: true,
	rebase_in_progress: false,
	merge_error: "",
};
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = decodeURIComponent(url.pathname);
		seen.push({
			method: request.method,
			path: `${route}${url.search}`,
			token: request.headers.get("private-token") ?? "",
			body: await request.text(),
		});
		const base = "/api/v4/projects/group/api";
		if (route === `${base}/merge_requests` && request.method === "GET")
			return Response.json(
				url.searchParams.get("source_branch") === "feature/login"
					? [mergeRequest]
					: [],
				{ headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" } },
			);
		if (route === `${base}/merge_requests/7`)
			return Response.json(mergeRequest);
		if (route === `${base}/merge_requests/7/approvals`)
			return Response.json({
				approvals_required: 1,
				approvals_left: 1,
				approved_by: [],
			});
		if (route === `${base}/merge_requests/7/approve`)
			return Response.json({ id: 70 }, { status: 201 });
		if (route === `${base}/issues` && request.method === "GET")
			return Response.json([issue("opened")], {
				headers: { "X-Total": "1", "X-Total-Pages": "1", "X-Page": "1" },
			});
		if (route === `${base}/issues/3` && request.method === "PUT") {
			const body = JSON.parse(seen.at(-1)?.body ?? "{}") as {
				state_event?: string;
				labels?: string | string[];
			};
			return Response.json(
				issue(
					body.state_event === "close" ? "closed" : "opened",
					typeof body.labels === "string"
						? body.labels.split(",")
						: (body.labels ?? []),
				),
			);
		}
		if (route === `${base}/issues/3/notes` && request.method === "POST")
			return Response.json(
				{
					id: 5,
					body: "Looks good",
					author: { name: "Dev", username: "dev" },
					created_at: "2026-01-03T00:00:00Z",
					updated_at: "2026-01-03T00:00:00Z",
					system: false,
				},
				{ status: 201 },
			);
		if (route === `${base}/pipelines/11/jobs`)
			return Response.json([
				{
					id: 99,
					name: "test",
					stage: "test",
					status: "failed",
					web_url: "https://j",
					pipeline: { id: 11 },
				},
			]);
		if (route === `${base}/jobs/99/trace`)
			return new Response("step 1\nstep 2 stub-workbench-secret\n");
		if (route === `${base}/jobs/99/retry`)
			return Response.json({ id: 100 }, { status: 201 });
		return Response.json({ message: "404 Not Found" }, { status: 404 });
	},
});

test("restored v1 change requests, issues and CI act on the provider serving the app's origin through the gateway", async () => {
	const { app, config } = await fixture(false, (config) => {
		config.profiles = [];
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						targets: [],
					},
				],
			}),
		);
		config.providers.push({
			name: "gl",
			type: "gitlab",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "dev",
			tokenRef: "WORKBENCH_TOKEN",
		});
	});
	process.env.WORKBENCH_TOKEN = "stub-workbench-secret";
	const repository = config.repositories[0] ?? "";
	await git(repository, [
		"remote",
		"add",
		"origin",
		`http://127.0.0.1:${stub.port}/group/api.git`,
	]);
	const host = serve(app),
		connection = new ClientConnection(host.client),
		client = new DevEnvClient(new GatewayBackend(connection, () => {}));
	try {
		connection.connect();
		await eventually(
			async () => connection.state,
			(state) => state !== null,
		);
		expect((await client.getApps())[0]).toMatchObject({
			ident: "api",
			provider: "gl",
			sourceType: "gitlab",
		});
		expect(
			(await client.getProviders()).map((provider) => provider.name),
		).toEqual(["gl"]);
		// v1: "current" change requests need a feature branch.
		expect(
			(await client.getChangeRequests("api", "opened", "current", "gitlab"))
				.items,
		).toEqual([]);
		await git(repository, ["checkout", "-b", "feature/login"]);
		const changes = await client.getChangeRequests(
			"api",
			"opened",
			"current",
			"gitlab",
		);
		expect(changes.items[0]).toMatchObject({
			iid: 7,
			source_branch: "feature/login",
			default_branch: "feature/login",
			head_pipeline: { id: 11, status: "failed" },
		});
		const issues = await client.getIssues("api", "all", "gitlab");
		expect(issues.items[0]).toMatchObject({ iid: 3, state: "opened" });
		expect(JSON.stringify(issues)).not.toContain("stub-workbench-secret");
		expect(
			await client.setIssueLabels("api", 3, "gitlab", ["bug", "p1"]),
		).toMatchObject({ labels: ["bug", "p1"] });
		expect(await client.closeIssue("api", 3, "gitlab")).toMatchObject({
			state: "closed",
		});
		expect(
			await client.addIssueComment("api", 3, "gitlab", "Looks good"),
		).toMatchObject({ id: 5, body: "Looks good" });
		await client.approveChangeRequest("api", 7, "gitlab");
		const jobs = await client.getPipelineJobs("api", 11, "gitlab");
		expect(jobs[0]).toMatchObject({ id: 99, status: "failed" });
		const log = await client.getJobLogs("api", 99, "gitlab");
		expect(log).toContain("step 2 <redacted>");
		await client.retryJob("api", 99);
		await expect(client.rebaseCR("api", 404)).rejects.toThrow(
			"change request not found",
		);
		expect(seen.every((entry) => entry.token === "stub-workbench-secret")).toBe(
			true,
		);
		expect(
			seen
				.filter((entry) => entry.method !== "GET")
				.map((entry) => `${entry.method} ${entry.path}`),
		).toEqual([
			"PUT /api/v4/projects/group/api/issues/3",
			"PUT /api/v4/projects/group/api/issues/3",
			"POST /api/v4/projects/group/api/issues/3/notes",
			"POST /api/v4/projects/group/api/merge_requests/7/approve",
			"POST /api/v4/projects/group/api/jobs/99/retry",
			"PUT /api/v4/projects/group/api/merge_requests/404/rebase",
		]);
		delete process.env.WORKBENCH_TOKEN;
		await expect(client.getIssues("api", "all", "gitlab")).rejects.toThrow(
			'no token configured for provider "gl"',
		);
	} finally {
		connection.close();
		await host.stop();
	}
}, 20000);
