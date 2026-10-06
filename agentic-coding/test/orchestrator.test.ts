// Home Orchestrator boundary: the orchestrator capability, its server-side
// route/action policy, the human-review gate pin, and the orchestrator config.
// Runs a real loopback server with injected operations, like server-api.test.ts.

import { describe, expect, test } from "bun:test";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	authorizeRequest,
	createInstanceAuthority,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import type { ServerOperations, StartOptions } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	orchestratorActionRefusal,
	orchestratorRouteAllowed,
} from "../src/server/orchestrator-policy.ts";
import { orchestratorHostEnv } from "../src/tui/orchestrator/session.ts";
import {
	parseAgentsConfig,
	withHumanReviewGates,
} from "../src/workflow/profiles.ts";

const view = (step: string) =>
	({
		workflowId: "wf-1",
		revision: 3,
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		availableActions: [],
	}) as unknown as WorkflowView;

function operations(
	step: string,
	calls: { actions: string[]; starts: Array<StartOptions | undefined> },
): ServerOperations {
	const ops: Partial<ServerOperations> = {
		view: () => view(step),
		action: (request) => {
			calls.actions.push(request.actionId);
			return view(step);
		},
		start: async (request, options) => {
			calls.starts.push(options);
			return `started ${request.workflowId}`;
		},
		runObservation: async () => [],
		saveAgents: () => {
			throw new Error("must not be reached");
		},
	};
	return ops as ServerOperations;
}

async function withServer<T>(
	step: string,
	run: (
		server: Awaited<ReturnType<typeof startWorkflowServer>>,
		calls: { actions: string[]; starts: Array<StartOptions | undefined> },
	) => Promise<T>,
): Promise<T> {
	const calls = { actions: [] as string[], starts: [] as StartOptions[] };
	const server = await startWorkflowServer({
		operations: operations(step, calls),
	});
	try {
		return await run(server, calls);
	} finally {
		await server.stop();
	}
}

const post = (token: string, body: unknown): RequestInit => ({
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify(body),
});

describe("orchestrator capability", () => {
	test("is derived from, but never equal to, the instance token", () => {
		const authority = createInstanceAuthority();
		const derived = orchestratorTokenFor(authority.token);
		expect(derived).not.toBe(authority.token);
		expect(orchestratorTokenFor(authority.token)).toBe(derived);
		const request = (token: string) =>
			new Request("http://127.0.0.1/api/v1/health", {
				headers: { authorization: `Bearer ${token}` },
			});
		expect(authorizeRequest(request(authority.token), authority)).toBe(
			"operator",
		);
		expect(authorizeRequest(request(derived), authority)).toBe("orchestrator");
		expect(() =>
			authorizeRequest(request(orchestratorTokenFor(derived)), authority),
		).toThrow("invalid instance capability");
	});

	test("the host environment drops every operator capability", () => {
		const env = orchestratorHostEnv({
			PATH: "/bin",
			AGENTIC_WORKFLOW_TOKEN: "secret",
			AGENTIC_DEVENV_TOKEN: "secret",
			AGENTIC_WORKFLOW_URL: "http://x",
		});
		expect(env).toEqual({ PATH: "/bin" });
	});
});

describe("orchestrator policy", () => {
	test("routes: observe, start and manage only", () => {
		expect(orchestratorRouteAllowed("POST", "/api/v1/workflow/start")).toBe(
			true,
		);
		expect(orchestratorRouteAllowed("get", "/api/v1/workflow/view")).toBe(true);
		for (const [method, path] of [
			["POST", "/api/v1/workflow/question"],
			["POST", "/api/v1/workflow/review-save"],
			["POST", "/api/v1/workflow/repair"],
			["POST", "/api/v1/workflow/delete"],
			["POST", "/api/v1/config/agents"],
			["POST", "/api/v1/agent/handoff"],
			["POST", "/api/v1/credentials/respond"],
			["GET", "/api/providers"],
		] as const)
			expect(orchestratorRouteAllowed(method, path)).toBe(false);
	});

	test("review decisions stay with the developer", () => {
		for (const action of [
			"approve-plan",
			"reject-plan",
			"review-comments",
			"approve-wiki",
		])
			expect(orchestratorActionRefusal(action, "core.implementation")).toBe(
				`action ${action} is reserved for the developer`,
			);
		expect(orchestratorActionRefusal("close", "core.wiki-approval")).toContain(
			"developer review",
		);
		expect(
			orchestratorActionRefusal("approve-review", "core.developer-review"),
		).toContain("developer review");
	});

	test("recovery and lifecycle actions are allowed", () => {
		expect(
			orchestratorActionRefusal("resume", "core.plan-approval"),
		).toBeUndefined();
		expect(
			orchestratorActionRefusal("retry-effect:abc", "core.developer-review"),
		).toBeUndefined();
		expect(
			orchestratorActionRefusal("switch-preset", "core.implementation"),
		).toBeUndefined();
		expect(
			orchestratorActionRefusal("close", "core.completed"),
		).toBeUndefined();
		expect(
			orchestratorActionRefusal("create-pr", "core.completed"),
		).toBeUndefined();
	});
});

describe("orchestrator over the transport", () => {
	test("a forbidden route is 403 and never reaches the operation", async () => {
		await withServer("core.implementation", async (server) => {
			const response = await fetch(
				`${server.url}/api/v1/config/agents`,
				post(orchestratorTokenFor(server.token), { mutation: {} }),
			);
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: { code: string } };
			expect(body.error.code).toBe("orchestrator-forbidden");
		});
	});

	test("an approval at a review step is refused; the operator may still act", async () => {
		await withServer("core.plan-approval", async (server, calls) => {
			const request = {
				repo: "/repo",
				workflowId: "wf-1",
				revision: 3,
				actionId: "approve-plan",
			};
			const refused = await fetch(
				`${server.url}/api/v1/workflow/action`,
				post(orchestratorTokenFor(server.token), request),
			);
			expect(refused.status).toBe(403);
			expect(calls.actions).toEqual([]);
			const operator = await fetch(
				`${server.url}/api/v1/workflow/action`,
				post(server.token, request),
			);
			expect(operator.status).toBe(200);
			expect(calls.actions).toEqual(["approve-plan"]);
		});
	});

	test("orchestrator starts pin the human review gates; operator starts do not", async () => {
		await withServer("core.implementation", async (server, calls) => {
			const request = {
				repo: "/repo",
				workflowId: "wf-2",
				mode: "worktree",
				workflowType: "openspec",
				task: "x",
			};
			const started = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(orchestratorTokenFor(server.token), request),
			);
			expect(started.status).toBe(200);
			await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, request),
			);
			expect(calls.starts).toEqual([
				{ enforceHumanReviewGates: true },
				undefined,
			]);
			// A wire field cannot request (or suppress) the pin: the transport
			// rejects it and only the principal decides.
			const smuggled = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, { ...request, enforceHumanReviewGates: false }),
			);
			expect(smuggled.status).toBe(400);
			expect(calls.starts).toHaveLength(2);
		});
	});
});

describe("orchestrator configuration", () => {
	test("[agents.orchestrator] parses model and thinking and refuses typos", () => {
		expect(
			parseAgentsConfig({
				orchestrator: { model: "anthropic/claude", thinking: "high" },
			}).orchestrator,
		).toEqual({ model: "anthropic/claude", thinking: "high" });
		expect(() => parseAgentsConfig({ orchestrator: { modle: "x" } })).toThrow(
			"unsupported key modle",
		);
		expect(() => parseAgentsConfig({ orchestrator: { model: "" } })).toThrow(
			"non-empty string",
		);
	});

	test("human review gates are forced to always", () => {
		expect(
			withHumanReviewGates({
				planApproval: "auto",
				verification: "auto",
				developerReview: "auto",
				wiki: "auto",
			}),
		).toEqual({
			planApproval: "always",
			verification: "auto",
			developerReview: "always",
			wiki: "always",
		});
	});
});
