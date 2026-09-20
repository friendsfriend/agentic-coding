import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BackendClient, BackendClientError } from "../../src/server/client.ts";

/**
 * The client is the dashboard's only data surface: every response is decoded
 * with a contract schema, so an invalid payload must fail here (task 2.3)
 * rather than reaching a projection as `undefined`.
 */
/** Patch fetch for one test. `afterEach` restores it, so a stubbed response can
 * never leak into another test file in the same process. */
function stubFetch(payload: unknown, status = 200): void {
	spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			new Response(JSON.stringify(payload), {
				status,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	);
}

function clientAgainst(payload: unknown, status = 200): BackendClient {
	stubFetch(payload, status);
	return new BackendClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t",
		ownerId: "o",
	});
}

afterEach(() => {
	// every patched global is released before the next file runs
	spyOn(globalThis, "fetch").mockRestore();
});

const VALID_VIEW = {
	workflowId: "wf-1",
	changeId: "change-1",
	revision: 1,
	definition: { id: "core", version: 1, digest: "d", label: "Core" },
	status: "active",
	repository: "/repo",
	worktree: "/repo",
	branch: "main",
	baseCommit: "abc",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	currentStep: {
		id: "core.plan",
		label: "Plan",
		attempt: 1,
		enteredAt: "2026-01-01T00:00:00.000Z",
	},
	runs: [],
	routing: {},
	effects: [],
	observations: [],
	health: { valid: true, attention: [] },
	availableActions: [],
};

describe("client response decoding", () => {
	test("accepts a contract-shaped view", async () => {
		const client = clientAgainst({ ok: true, value: VALID_VIEW });
		const view = await client.view("/repo", "wf-1");
		expect(view.workflowId).toBe("wf-1");
		expect(view.health.valid).toBe(true);
	});

	test("rejects a view with a missing required field", async () => {
		const { changeId: _drop, ...partial } = VALID_VIEW;
		const client = clientAgainst({ ok: true, value: partial });
		await expect(client.view("/repo", "wf-1")).rejects.toThrow(
			/invalid core\.workflow-view payload/,
		);
	});

	test("rejects a view whose field has the wrong type", async () => {
		const client = clientAgainst({
			ok: true,
			value: { ...VALID_VIEW, revision: "three" },
		});
		const failure = await client.view("/repo", "wf-1").catch((e) => e);
		expect(failure).toBeInstanceOf(BackendClientError);
		expect((failure as BackendClientError).code).toBe("invalid-response");
	});

	test("rejects a malformed envelope instead of treating it as data", async () => {
		const client = clientAgainst({ value: VALID_VIEW });
		const failure = await client.view("/repo", "wf-1").catch((e) => e);
		expect(failure).toBeInstanceOf(BackendClientError);
		expect((failure as BackendClientError).message).toContain(
			"malformed envelope",
		);
	});

	test("surfaces a structured error payload as the error code", async () => {
		const client = clientAgainst(
			{ ok: false, error: { code: "stale-revision", message: "revision 3" } },
			409,
		);
		const failure = await client.view("/repo", "wf-1").catch((e) => e);
		expect(failure).toBeInstanceOf(BackendClientError);
		expect((failure as BackendClientError).code).toBe("stale-revision");
		expect((failure as BackendClientError).status).toBe(409);
	});

	test("rejects a non-JSON body", async () => {
		spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response("<html>nope</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				})) as unknown as typeof fetch,
		);
		const client = new BackendClient({
			baseUrl: "http://127.0.0.1:1",
			token: "t",
			ownerId: "o",
		});
		const failure = await client.view("/repo", "wf-1").catch((e) => e);
		expect((failure as BackendClientError).code).toBe("invalid-response");
	});

	test("decodes the trace list page", async () => {
		const client = clientAgainst({
			ok: true,
			value: {
				items: [
					{
						changeId: "change-1",
						spanCount: 3,
						errorCount: 0,
						startNanos: "1",
						endNanos: "2",
						agents: ["planner"],
					},
				],
				total: 1,
				page: 1,
				perPage: 50,
			},
		});
		const page = await client.telemetryTraces({ page: 1 });
		expect(page.items[0]?.changeId).toBe("change-1");
	});
});
