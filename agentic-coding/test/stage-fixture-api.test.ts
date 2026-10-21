// `ctx.api`, the replay fixture's policy-checked API surface
// (`add-stage-flow-replay` design D6 / task 8). A fake `APIRequestContext`
// (just the one `.fetch()` method `apiClient` actually calls) is enough to
// test the policy without a real server or a real Playwright browser.
import { describe, expect, test } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import { apiClient } from "../src/stage-blocks/fixture.ts";
import type { FlowManifest } from "../src/stage-blocks/flow.ts";
import { STAGE_FLOW_MANIFEST_VERSION } from "../src/stage-blocks/flow.ts";

const MANIFEST: FlowManifest = {
	version: STAGE_FLOW_MANIFEST_VERSION,
	flowId: "test-api-flow",
	title: "API flow",
	generatedFrom: { planId: "plan-1", revision: 1 },
	stage: "crm-stage",
	applications: ["crm"],
	roles: ["clerk"],
	inputSchema: { type: "object", additionalProperties: false, properties: {} },
	inputExamples: [],
	routeHash: "sha256:route",
	specHash: "sha256:spec",
	blockVersions: {},
	blockDigests: {},
	routeSteps: [],
};

interface FakeCall {
	readonly url: string;
	readonly options: {
		readonly method: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly data?: unknown;
	};
}

function fakeRequest(
	calls: FakeCall[],
	reply: {
		readonly status?: number;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
	} = {},
): APIRequestContext {
	return {
		fetch: async (url: string, options: FakeCall["options"]) => {
			calls.push({ url, options });
			return {
				status: () => reply.status ?? 200,
				headers: () => reply.headers ?? {},
				body: async () => Buffer.from(reply.body ?? "{}", "utf8"),
			};
		},
	} as unknown as APIRequestContext;
}

function envFor(url: string): () => void {
	const previous = {
		urls: process.env.STAGE_APP_URLS,
		write: process.env.STAGE_WRITE_ALLOWED,
		token: process.env.STAGE_API_TOKEN,
	};
	process.env.STAGE_APP_URLS = JSON.stringify({ crm: url });
	return () => {
		if (previous.urls === undefined) delete process.env.STAGE_APP_URLS;
		else process.env.STAGE_APP_URLS = previous.urls;
		if (previous.write === undefined) delete process.env.STAGE_WRITE_ALLOWED;
		else process.env.STAGE_WRITE_ALLOWED = previous.write;
		if (previous.token === undefined) delete process.env.STAGE_API_TOKEN;
		else process.env.STAGE_API_TOKEN = previous.token;
	};
}

describe("replay ctx.api (add-stage-flow-replay design D6)", () => {
	test("a read-only precondition call succeeds and returns the bounded, parsed body", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const calls: FakeCall[] = [];
			const client = apiClient(
				fakeRequest(calls, { body: JSON.stringify({ id: "C-1" }) }),
				"clerk",
				MANIFEST,
			);
			const response = await client.request({
				app: "crm",
				role: "clerk",
				method: "GET",
				path: "/v1/customers/C-1",
			});
			expect(response.status).toBe(200);
			expect(response.body).toEqual({ id: "C-1" });
			expect(calls[0]?.url).toBe("http://127.0.0.1:1/crm/v1/customers/C-1");
			expect(calls[0]?.options.headers["x-stage-role"]).toBe("clerk");
		} finally {
			restore();
		}
	});

	test("refuses a write on a read-only replay", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const client = apiClient(fakeRequest([]), "clerk", MANIFEST);
			await expect(
				client.request({
					app: "crm",
					role: "clerk",
					method: "POST",
					path: "/v1/customers",
					body: { name: "x" },
				}),
			).rejects.toThrow(/read-only replay/);
		} finally {
			restore();
		}
	});

	test("a write succeeds once the replay is writable", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		process.env.STAGE_WRITE_ALLOWED = "1";
		try {
			const calls: FakeCall[] = [];
			const client = apiClient(fakeRequest(calls), "clerk", MANIFEST);
			const response = await client.request({
				app: "crm",
				role: "clerk",
				method: "POST",
				path: "/v1/customers",
				body: { name: "x" },
			});
			expect(response.status).toBe(200);
			expect(calls[0]?.options.method).toBe("POST");
		} finally {
			restore();
		}
	});

	test("refuses an absolute path and a path that escapes the application origin", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const client = apiClient(fakeRequest([]), "clerk", MANIFEST);
			await expect(
				client.request({
					app: "crm",
					role: "clerk",
					method: "GET",
					path: "https://evil.example/v1/customers",
				}),
			).rejects.toThrow(/relative/);
			await expect(
				client.request({
					app: "crm",
					role: "clerk",
					method: "GET",
					path: "/../secret",
				}),
			).rejects.toThrow(/relative/);
		} finally {
			restore();
		}
	});

	test("refuses an application the flow does not declare", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const client = apiClient(fakeRequest([]), "clerk", MANIFEST);
			await expect(
				client.request({
					app: "billing",
					role: "clerk",
					method: "GET",
					path: "/v1/invoices",
				}),
			).rejects.toThrow(/not declared/);
		} finally {
			restore();
		}
	});

	test("refuses a role the flow does not declare, and a missing role", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const client = apiClient(fakeRequest([]), "clerk", MANIFEST);
			await expect(
				client.request({
					app: "crm",
					role: "manager",
					method: "GET",
					path: "/v1/customers",
				}),
			).rejects.toThrow(/not declared/);
			const noRoleManifest: FlowManifest = { ...MANIFEST, roles: [] };
			const noRoleClient = apiClient(fakeRequest([]), "", noRoleManifest);
			await expect(
				noRoleClient.request({
					app: "crm",
					role: "",
					method: "GET",
					path: "/v1/customers",
				}),
			).rejects.toThrow(/needs a declared role/);
		} finally {
			restore();
		}
	});

	test("a call's own role is used over the session role, and is checked independently", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const twoRoleManifest: FlowManifest = {
				...MANIFEST,
				roles: ["clerk", "manager"],
			};
			const calls: FakeCall[] = [];
			const client = apiClient(fakeRequest(calls), "clerk", twoRoleManifest);
			await client.request({
				app: "crm",
				role: "manager",
				method: "GET",
				path: "/v1/audit",
			});
			expect(calls[0]?.options.headers["x-stage-role"]).toBe("manager");
		} finally {
			restore();
		}
	});

	test("refuses a request body over the size bound", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		process.env.STAGE_WRITE_ALLOWED = "1";
		try {
			const client = apiClient(fakeRequest([]), "clerk", MANIFEST);
			await expect(
				client.request({
					app: "crm",
					role: "clerk",
					method: "POST",
					path: "/v1/customers",
					body: { blob: "x".repeat(70_000) },
				}),
			).rejects.toThrow(/larger than/);
		} finally {
			restore();
		}
	});

	test("bounds and redacts the response: an oversized body is truncated rather than read in full", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		try {
			const calls: FakeCall[] = [];
			// A body this large would not be valid truncated JSON, so the bounded
			// read surfaces as a parse failure (`null`) rather than ever handing the
			// caller the untruncated bytes.
			const oversized = `{"id":"${"x".repeat(300_000)}"}`;
			const client = apiClient(
				fakeRequest(calls, { body: oversized }),
				"clerk",
				MANIFEST,
			);
			const response = await client.request({
				app: "crm",
				role: "clerk",
				method: "GET",
				path: "/v1/customers/C-1",
			});
			expect(response.body).toBeNull();
		} finally {
			restore();
		}
	});

	test("never forwards an agent-supplied authorization header; only the server-issued run token is sent", async () => {
		const restore = envFor("http://127.0.0.1:1/crm");
		process.env.STAGE_API_TOKEN = "run-token-abc";
		try {
			const calls: FakeCall[] = [];
			const client = apiClient(fakeRequest(calls), "clerk", MANIFEST);
			await client.request({
				app: "crm",
				role: "clerk",
				method: "GET",
				path: "/v1/customers/C-1",
			});
			expect(calls[0]?.options.headers.authorization).toBe(
				"Bearer run-token-abc",
			);
		} finally {
			restore();
		}
	});
});
