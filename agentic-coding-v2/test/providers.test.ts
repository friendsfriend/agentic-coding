import { afterEach, expect, test } from "bun:test";
import { digest } from "../src/config.ts";
import type { ProviderQuery } from "../src/protocol/index.ts";
import type { ProviderActionIntent } from "../src/protocol/provider-actions.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const seenAuth: string[] = [];
const seenWrites: { method: string; path: string; body: unknown }[] = [];
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		seenAuth.push(request.headers.get("authorization") ?? "");
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname);
		if (request.method !== "GET")
			seenWrites.push({
				method: request.method,
				path,
				body: await request
					.clone()
					.json()
					.catch(() => null),
			});
		if (path === "/repos/o/r/pulls/7")
			return Response.json({ head: { sha: "a".repeat(40) } });
		if (request.method === "POST" && path === "/repos/o/r/pulls/7/reviews")
			return Response.json({
				id: 4,
				state: "APPROVED",
				commit_id: "a".repeat(40),
			});
		if (
			request.method === "POST" &&
			path === "/repos/o/r/actions/runs/42/cancel"
		)
			return new Response("dispatch outcome unknown", { status: 500 });
		if (
			request.method === "POST" &&
			path === "/repos/o/r/actions/runs/43/cancel"
		)
			return new Response(null, { status: 204 });
		if (request.method === "PUT" && path === "/projects/o/r/issues/3")
			return Response.json({ id: 3, state: "closed" });
		if (
			request.method === "POST" &&
			path === "/projects/o/r/merge_requests/7/notes"
		) {
			process.env.PROVIDER_TEST_TOKEN = "rotated-stub-secret";
			return Response.json({ id: 2, body: "stub-secret" });
		}
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
		if (request.method === "POST" && path === "/repos/o/r/actions/runs/9/rerun")
			return Response.json({ id: 9, status: "requested" });
		return new Response("no stub", { status: 500 });
	},
});
afterEach(() => {
	seenAuth.length = 0;
	seenWrites.length = 0;
	delete process.env.PROVIDER_TEST_TOKEN;
});
const setup = async () => {
	const { app, config, open } = await fixture(true);
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
	return { app, host, api, config, open };
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
test("authenticated native intentions bind destination, consume once and never publish token echoes", async () => {
	const { app, host, config } = await setup();
	const client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const intent: ProviderActionIntent = {
			provider: "gh",
			operation: "comment-change",
			repo: "o/r",
			number: 7,
			payload: { body: "hello" },
			requestId: "native-comment",
		};
		await expect(
			client.call("providers.preview", {
				...intent,
				payload: { body: "stub-secret" },
			}),
		).rejects.toThrow("Native operation refused");
		const route = { ...intent, route: "/arbitrary" };
		await expect(client.call("providers.preview", route)).rejects.toThrow(
			"Native operation refused",
		);
		const candidate = await client.call("providers.preview", intent);
		expect(seenAuth).toEqual([]);
		expect(candidate.snapshot).toContain("hello");
		expect(candidate.snapshot).not.toContain("stub-secret");
		const confirmation = {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		};
		await expect(
			client.call("providers.apply", {
				...confirmation,
				approval: `approve:${"0".repeat(64)}`,
			}),
		).rejects.toThrow("Native operation refused");
		const changedPayload = { ...confirmation, payload: { body: "other" } };
		await expect(
			client.call("providers.apply", changedPayload),
		).rejects.toThrow("Native operation refused");
		expect(seenWrites).toEqual([]);
		const receipt = await client.call("providers.apply", confirmation);
		expect(receipt.status).toBe("acknowledged");
		expect(receipt.destination).toContain(
			String(new URL(host.client.url).hostname),
		);
		expect(seenWrites).toEqual([
			{
				method: "POST",
				path: "/repos/o/r/issues/7/comments",
				body: { body: "hello" },
			},
		]);
		await expect(client.call("providers.apply", confirmation)).rejects.toThrow(
			"Native operation refused",
		);
		await expect(client.call("providers.preview", intent)).rejects.toThrow(
			"Native operation refused",
		);
		expect(seenWrites.length).toBe(1);
		const changedDestination = await client.call("providers.preview", {
			...intent,
			requestId: "new-destination",
		});
		const configured = config.providers.find((entry) => entry.name === "gh");
		if (!configured) throw new Error("Fixture provider missing");
		const originalUrl = configured.baseUrl;
		configured.baseUrl = "http://127.0.0.1:9";
		await expect(
			client.call("providers.apply", {
				id: changedDestination.id,
				approval: `approve:${changedDestination.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		configured.baseUrl = originalUrl;
		expect(seenWrites.length).toBe(1);
		const echo = await client.call("providers.preview", {
			...intent,
			provider: "gl",
			requestId: "redacted-echo",
		});
		const echoed = await client.call("providers.apply", {
			id: echo.id,
			approval: `approve:${echo.digest}`,
		});
		expect(echoed.status).toBe("acknowledged");
		expect(JSON.stringify(echoed)).not.toContain("stub-secret");
		expect(
			JSON.stringify(
				await client.call("providers.receipt", {
					provider: "gl",
					requestId: "redacted-echo",
				}),
			),
		).not.toContain("stub-secret");
	} finally {
		client.close();
		host.stop();
		await app.close();
	}
});
test("native uncertain attempts survive reopen and are never redispatched", async () => {
	const { app, host, open } = await setup();
	const client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const intent: ProviderActionIntent = {
			provider: "gh",
			operation: "cancel-job",
			repo: "o/r",
			number: 42,
			payload: {},
			requestId: "uncertain-cancel",
		};
		const candidate = await client.call("providers.preview", intent);
		const receipt = await client.call("providers.apply", {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		});
		expect(receipt.status).toBe("uncertain");
		expect(receipt.result).toBeNull();
		expect(seenWrites.length).toBe(1);
		await expect(client.call("providers.preview", intent)).rejects.toThrow(
			"Native operation refused",
		);
		expect(
			await client.call("providers.receipt", {
				provider: "gh",
				requestId: intent.requestId,
			}),
		).toEqual(receipt);
		client.close();
		host.stop();
		await app.close();
		const reopened = await open(),
			secondHost = serve(reopened),
			second = new ClientConnection(secondHost.client);
		try {
			second.connect();
			await eventually(
				async () => second.state,
				(state) => state !== null,
			);
			expect(
				await second.call("providers.actions", { provider: "gh" }),
			).toEqual([receipt]);
			await expect(second.call("providers.preview", intent)).rejects.toThrow(
				"Native operation refused",
			);
			expect(seenWrites.length).toBe(1);
		} finally {
			second.close();
			secondHost.stop();
			await reopened.close();
		}
	} finally {
		client.close();
		host.stop();
		await app.close();
	}
});
test("native approval binds reviewed SHA; CI 204 and GitLab PUT acknowledge without claiming completion", async () => {
	const { app, host } = await setup();
	const client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const intent: ProviderActionIntent = {
			provider: "gh",
			operation: "approve-exact-change",
			repo: "o/r",
			number: 7,
			payload: { sha: "b".repeat(40) },
			requestId: "stale-head",
		};
		const stale = await client.call("providers.preview", intent);
		expect(
			(
				await client.call("providers.apply", {
					id: stale.id,
					approval: `approve:${stale.digest}`,
				})
			).status,
		).toBe("uncertain");
		expect(seenWrites).toEqual([]);
		const candidate = await client.call("providers.preview", {
			...intent,
			payload: { sha: "a".repeat(40) },
			requestId: "exact-head",
		});
		const approved = await client.call("providers.apply", {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		});
		expect(approved.status).toBe("acknowledged");
		expect(seenWrites[0]).toEqual({
			method: "POST",
			path: "/repos/o/r/pulls/7/reviews",
			body: { event: "APPROVE", commit_id: "a".repeat(40) },
		});
		const cancel = await client.call("providers.preview", {
			...intent,
			operation: "cancel-job",
			number: 43,
			payload: {},
			requestId: "accepted-cancel",
		});
		const accepted = await client.call("providers.apply", {
			id: cancel.id,
			approval: `approve:${cancel.digest}`,
		});
		expect(accepted.status).toBe("acknowledged");
		expect(accepted.result).toEqual({});
		const close = await client.call("providers.preview", {
			...intent,
			provider: "gl",
			operation: "close-issue",
			number: 3,
			payload: {},
			requestId: "close-issue",
		});
		expect(
			(
				await client.call("providers.apply", {
					id: close.id,
					approval: `approve:${close.digest}`,
				})
			).status,
		).toBe("acknowledged");
		expect(seenWrites.at(-1)).toEqual({
			method: "PUT",
			path: "/projects/o/r/issues/3",
			body: { state_event: "close" },
		});
	} finally {
		client.close();
		host.stop();
		await app.close();
	}
});
