import { afterEach, expect, test } from "bun:test";
import { digest } from "../src/config.ts";
import type { ProviderQuery } from "../src/protocol/index.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const seenAuth: string[] = [];
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		seenAuth.push(request.headers.get("authorization") ?? "");
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname);
		if (path === "/search/repositories")
			return Response.json({
				items: [
					{ full_name: "o/r", description: "d", html_url: "https://h/u" },
				],
			});
		if (path === "/repos/o/r/pulls")
			return Response.json([
				{
					number: 7,
					title: "t",
					state: "open",
					head: { ref: "f" },
					base: { ref: "main" },
					user: { login: "a" },
					html_url: "https://h/pr",
				},
			]);
		if (request.method === "POST" && path === "/repos/o/r/issues/7/comments")
			return Response.json({ id: 1, html_url: "https://h/c" });
		if (path === "/projects/o/r/issues")
			return Response.json([
				{
					iid: 3,
					title: "i",
					state: "opened",
					author: { username: "b" },
					labels: ["bug"],
					web_url: "https://h/i",
				},
			]);
		if (path === "/repos/o/r/actions/runs")
			return Response.json({
				workflow_runs: [
					{ id: 9, name: "ci", status: "completed", html_url: "https://h/j" },
				],
			});
		if (request.method === "POST" && path === "/repos/o/r/actions/runs/9/retry")
			return Response.json({ id: 9, status: "requested" });
		return new Response("no stub", { status: 500 });
	},
});
afterEach(() => {
	seenAuth.length = 0;
	delete process.env.PROVIDER_TEST_TOKEN;
});
const setup = async () => {
	const { app, config } = await fixture(true);
	process.env.PROVIDER_TEST_TOKEN = "stub-secret";
	config.providers.push(
		{
			name: "gh",
			type: "github",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "u",
			tokenRef: "PROVIDER_TEST_TOKEN",
		},
		{
			name: "gl",
			type: "gitlab",
			baseUrl: `http://127.0.0.1:${stub.port}`,
			username: "",
			tokenRef: "PROVIDER_TEST_TOKEN",
		},
	);
	const host = serve(app);
	const headers = {
		Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
		"Content-Type": "application/json",
	};
	const api = (route: string, body?: unknown) =>
		fetch(new URL(route, host.url), {
			method: body === undefined ? "GET" : "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { app, host, api };
};
const approval = (
	op: string,
	target: string,
	payload: Record<string, unknown>,
) => ({
	op,
	target,
	payload,
	approve: digest(JSON.stringify({ op, target, payload })),
});
test("registry projects token presence without values", async () => {
	const { app, host, api } = await setup();
	try {
		const listed = await (await api("/api/providers")).json();
		expect(listed).toEqual([
			{
				name: "gh",
				type: "github",
				baseUrl: `http://127.0.0.1:${stub.port}`,
				username: "u",
				has_token: true,
			},
			{
				name: "gl",
				type: "gitlab",
				baseUrl: `http://127.0.0.1:${stub.port}`,
				username: "",
				has_token: true,
			},
		]);
		expect(JSON.stringify(listed)).not.toContain("stub-secret");
	} finally {
		host.stop();
		await app.close();
	}
});
test("unknown and tokenless providers fail closed", async () => {
	const { app, host, api } = await setup();
	try {
		const unknown = await api("/api/providers/nope/changes?repo=o%2Fr");
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toContain("Unknown provider");
		delete process.env.PROVIDER_TEST_TOKEN;
		const tokenless = await api("/api/providers/gl/changes?repo=o%2Fr");
		expect(tokenless.status).toBe(400);
		expect(await tokenless.text()).toContain("no configured token");
	} finally {
		host.stop();
		await app.close();
	}
});
test("reads map both hosts to one model over Bearer auth", async () => {
	const { app, host, api } = await setup();
	const client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const registry = await client.call("providers.read", {});
		expect(registry.map((entry) => [entry.name, entry.has_token])).toEqual([
			["gh", true],
			["gl", true],
		]);
		expect(JSON.stringify(registry)).not.toContain("stub-secret");
		expect(seenAuth).toEqual([]);
		const search = await (
			await api("/api/providers/gh/repos/search", { query: "r" })
		).json();
		expect(search).toEqual([
			{ full_name: "o/r", description: "d", html_url: "https://h/u" },
		]);
		expect(seenAuth[0]).toBe("Bearer stub-secret");
		const changes = await (
			await api("/api/providers/gh/changes?repo=o%2Fr")
		).json();
		expect(changes).toEqual([
			{
				id: "github-change-7",
				number: 7,
				title: "t",
				state: "open",
				sourceBranch: "f",
				targetBranch: "main",
				author: "a",
				url: "https://h/pr",
			},
		]);
		const issues = await (
			await api("/api/providers/gl/issues?repo=o%2Fr")
		).json();
		expect(issues).toEqual([
			{
				id: "gitlab-issue-3",
				number: 3,
				title: "i",
				state: "opened",
				author: "b",
				labels: ["bug"],
				url: "https://h/i",
			},
		]);
		expect(
			await client.call("providers.inspect", {
				provider: "gh",
				operation: "repos",
				query: "r",
			}),
		).toEqual({ provider: "gh", operation: "repos", value: search });
		expect(
			await client.call("providers.inspect", {
				provider: "gh",
				operation: "changes",
				repo: "o/r",
			}),
		).toEqual({ provider: "gh", operation: "changes", value: changes });
		expect(
			await client.call("providers.inspect", {
				provider: "gl",
				operation: "issues",
				repo: "o/r",
			}),
		).toEqual({ provider: "gl", operation: "issues", value: issues });
		const calls = seenAuth.length;
		await expect(
			client.call("providers.inspect", {
				provider: "nope",
				operation: "changes",
				repo: "o/r",
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("providers.inspect", {
				provider: "gh",
				operation: "change",
				repo: "o/r",
				number: 0,
			}),
		).rejects.toThrow("Native operation refused");
		delete process.env.PROVIDER_TEST_TOKEN;
		await expect(
			client.call("providers.inspect", {
				provider: "gh",
				operation: "changes",
				repo: "o/r",
			}),
		).rejects.toThrow("Native operation refused");
		expect(seenAuth.length).toBe(calls);
		// Deliberately malformed wire request: the authenticated gateway cannot forward writes or arbitrary fields.
		await expect(
			client.call("providers.inspect", {
				provider: "gh",
				operation: "comment",
				repo: "o/r",
			} as unknown as ProviderQuery),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("providers.inspect", {
				provider: "gh",
				operation: "changes",
				repo: "o/r",
				body: "never send",
			} as ProviderQuery),
		).rejects.toThrow("Native operation refused");
		expect(seenAuth.length).toBe(calls);
	} finally {
		client.close();
		await host.stop();
		await app.close();
	}
});
test("writes need exact approval and replay safely", async () => {
	const { app, host, api } = await setup();
	try {
		const payload = { body: "hello" };
		const unapproved = await api("/api/providers/gh/changes/comment", {
			requestId: "w1",
			...approval("comment-change", "o/r#7", payload),
			approve: "0".repeat(64),
		});
		expect(unapproved.status).toBe(400);
		expect(await unapproved.text()).toContain("exact payload digest");
		const good = {
			requestId: "w1",
			...approval("comment-change", "o/r#7", payload),
		};
		const first = await (
			await api("/api/providers/gh/changes/comment", good)
		).json();
		expect(first).toEqual({ id: 1, html_url: "https://h/c" });
		const replay = await (
			await api("/api/providers/gh/changes/comment", good)
		).json();
		expect(replay).toEqual(first);
		const reuse = await api("/api/providers/gh/changes/comment", {
			requestId: "w1",
			...approval("comment-change", "o/r#7", { body: "other" }),
		});
		expect(reuse.status).toBe(400);
		expect(await reuse.text()).toContain("reused for different input");
		const retry = await (
			await api("/api/providers/gh/pipelines/retry", {
				requestId: "w2",
				...approval("retry-job", "o/r#9", {}),
			})
		).json();
		expect(retry).toEqual({ id: 9, status: "requested" });
	} finally {
		host.stop();
		await app.close();
	}
});
