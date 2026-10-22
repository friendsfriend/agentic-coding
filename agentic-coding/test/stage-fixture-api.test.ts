// `ctx.api`, the replay fixture's policy-checked API surface
// (`add-stage-flow-replay` design D6 / task 8). A fake `APIRequestContext`
// (just the one `.fetch()` method `apiClient` actually calls) is enough to
// test the policy without a real server or a real Playwright browser.
import { describe, expect, test } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import {
	apiClient,
	pageAdapter,
	type RehearsalEvent,
	type RehearsalStepResult,
	rehearsalOutcome,
	unrecordedFailure,
} from "../src/stage-blocks/fixture.ts";
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

describe("the replay fixture's locator", () => {
	function fakePage(calls: string[]) {
		const locator = {
			click: async () => {
				calls.push("click");
			},
			fill: async (value: string) => {
				calls.push(`fill:${value}`);
			},
			pressSequentially: async (value: string, options: { delay?: number }) => {
				calls.push(`type:${value}@${options.delay ?? 0}`);
			},
			press: async (key: string) => {
				calls.push(`press:${key}`);
			},
			selectOption: async () => {
				calls.push("select");
			},
			textContent: async () => "text",
			innerText: async () => "text",
			isVisible: async () => true,
			waitFor: async () => undefined,
		};
		return {
			url: () => "https://crm.test/",
			title: async () => "CRM",
			goto: async (url: string) => {
				calls.push(`goto:${url}`);
			},
			getByLabel: () => locator,
			getByTestId: () => locator,
			getByText: () => locator,
			getByRole: () => locator,
			locator: () => locator,
			reload: async () => undefined,
			waitForTimeout: async () => undefined,
		};
	}

	test("type presses keys one by one while fill replaces the value", async () => {
		const calls: string[] = [];
		const page = pageAdapter(
			fakePage(calls) as unknown as Parameters<typeof pageAdapter>[0],
		);
		const field = page.getByLabel("Password");
		await field.fill("secret-1");
		await field.type("secret-1");
		await field.type("slow", { delayMs: 25 });
		expect(calls).toEqual(["fill:secret-1", "type:secret-1@0", "type:slow@25"]);
	});
});

describe("a replay's assembled result", () => {
	const outcome = (input: {
		readonly status: string | undefined;
		readonly events?: readonly RehearsalEvent[];
		readonly steps?: readonly RehearsalStepResult[];
		readonly openRoute?: {
			readonly index: number;
			readonly routeStepId: string;
			readonly block: string;
			readonly version: string;
			readonly subStep?: string;
		};
	}) =>
		rehearsalOutcome({
			manifest: MANIFEST,
			inputsHash: "sha256:inputs",
			startedAt: "2026-01-01T00:00:00.000Z",
			durationMs: 15_000,
			events: [],
			steps: [],
			...input,
		});

	const failedStep: RehearsalStepResult = {
		index: 1,
		routeStepId: "R2",
		block: "crm.customer.open",
		version: "1.0.0",
		status: "failed",
		durationMs: 900,
		error: "the detail page never appeared",
	};

	test("a timeout with no failed block is a failed result naming the step", () => {
		const timedOut = outcome({
			status: "timedOut",
			openRoute: {
				index: 2,
				routeStepId: "R3",
				block: "crm.customer.open",
				version: "1.0.0",
				subStep: "open the customer",
			},
		});
		expect(timedOut.status).toBe("failed");
		expect(timedOut.steps).toEqual([
			expect.objectContaining({
				index: 2,
				routeStepId: "R3",
				block: "crm.customer.open",
				version: "1.0.0",
				status: "failed",
			}),
		]);
		expect(timedOut.events).toHaveLength(1);
		expect(timedOut.error).toContain("timed out");
	});

	test("a pass stays a pass even when an optional group recorded a failure", () => {
		const passed = outcome({
			status: "passed",
			events: [
				{
					index: 1,
					routeStepId: "R2",
					block: "crm.customer.open",
					version: "1.0.0",
					subStep: "dismiss the cookie banner",
					status: "failed",
					durationMs: 10,
					evidence: [],
					error: "no banner",
				},
			],
			steps: [
				{
					index: 1,
					routeStepId: "R2",
					block: "crm.customer.open",
					version: "1.0.0",
					status: "passed",
					durationMs: 900,
				},
			],
		});
		expect(passed.status).toBe("passed");
		// The event is kept as evidence; the block-level result decides the verdict.
		expect(passed.events).toHaveLength(1);
		expect(passed.steps).toHaveLength(1);
		expect(passed.error).toBeUndefined();
	});

	test("a recorded failed block is not counted twice", () => {
		const recorded = outcome({
			status: "timedOut",
			steps: [failedStep],
			openRoute: {
				index: 1,
				routeStepId: "R2",
				block: "crm.customer.open",
				version: "1.0.0",
			},
		});
		expect(recorded.status).toBe("failed");
		expect(recorded.steps).toEqual([failedStep]);
		expect(recorded.events).toEqual([]);
		expect(recorded.error).toBe("the detail page never appeared");
	});
});

describe("a replay that ends without a recorded failure", () => {
	test("names the step it stopped in instead of claiming a pass", () => {
		expect(unrecordedFailure("passed", undefined, 10)).toBeUndefined();
		expect(unrecordedFailure(undefined, undefined, 10)).toBeUndefined();

		const timedOut = unrecordedFailure(
			"timedOut",
			{
				index: 2,
				routeStepId: "R3",
				block: "crm.customer.open",
				version: "1.0.0",
				subStep: "open the customer",
			},
			15_000,
		);
		expect(timedOut).toMatchObject({
			index: 2,
			routeStepId: "R3",
			block: "crm.customer.open",
			version: "1.0.0",
			subStep: "open the customer",
			status: "failed",
			durationMs: 15_000,
		});
		expect(timedOut?.error).toContain("timed out");
		expect(timedOut?.error).toContain("R3");
		expect(timedOut?.error).toContain("open the customer");

		const early = unrecordedFailure("failed", undefined, 3);
		expect(early?.error).toContain("before any route step started");
		expect(early?.routeStepId).toBe("(none)");
	});
});
