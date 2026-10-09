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
import type {
	ActionOptions,
	AgentConfigRead,
	ServerOperations,
	StartOptions,
} from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	orchestratorActionRefusal,
	orchestratorLaunchRefusal,
	orchestratorRouteAllowed,
} from "../src/server/orchestrator-policy.ts";
import { orchestratorHostEnv } from "../src/tui/orchestrator/session.ts";
import {
	DEFAULT_ORCHESTRATOR_LIMITS,
	DEFAULT_ORCHESTRATOR_MONITOR,
	orchestratorLaunchLimits,
	orchestratorMonitorMode,
	parseAgentsConfig,
	withHumanReviewGates,
} from "../src/workflow/profiles.ts";
import type {
	OrchestratorLaunch,
	OrchestratorLaunchCounts,
} from "../src/workflow/runtime/orchestrator-launches.ts";

const view = (step: string) =>
	({
		workflowId: "wf-1",
		revision: 3,
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		availableActions: [],
	}) as unknown as WorkflowView;

/** Server-decided launch state a transport test can inject: the resolved
 * ceiling the agents read carries (non-default values here are what proves the
 * transport enforces the configured table rather than its defaults), and the
 * counts it reads for the ceiling. */
interface LaunchFixture {
	readonly limits?: { maxActive: number; maxStartsPerDay: number };
	readonly counts?: OrchestratorLaunchCounts;
}

function operations(
	step: string,
	calls: {
		actions: string[];
		actionOptions: Array<ActionOptions | undefined>;
		starts: Array<StartOptions | undefined>;
	},
	launch: LaunchFixture = {},
): ServerOperations {
	const ops: Partial<ServerOperations> = {
		view: () => view(step),
		action: (request, options) => {
			calls.actions.push(request.actionId);
			calls.actionOptions.push(options);
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
		loadAgents: () =>
			({
				agents: {},
				orchestratorLimits: launch.limits ?? DEFAULT_ORCHESTRATOR_LIMITS,
				orchestratorLimitsConfigured: launch.limits !== undefined,
			}) as unknown as AgentConfigRead,
		orchestratorLaunches: () =>
			launch.counts ?? { active: [], recent: [], skipped: [] },
	};
	return ops as ServerOperations;
}

async function withServer<T>(
	step: string,
	run: (
		server: Awaited<ReturnType<typeof startWorkflowServer>>,
		calls: {
			actions: string[];
			actionOptions: Array<ActionOptions | undefined>;
			starts: Array<StartOptions | undefined>;
		},
	) => Promise<T>,
	launch: LaunchFixture = {},
): Promise<T> {
	const calls = {
		actions: [] as string[],
		actionOptions: [] as Array<ActionOptions | undefined>,
		starts: [] as StartOptions[],
	};
	const server = await startWorkflowServer({
		operations: operations(step, calls, launch),
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
		// Shaping a workflow is a read plus a side-effect-free compile: the
		// orchestrator may do both before it starts anything.
		expect(orchestratorRouteAllowed("GET", "/api/v1/workflow/steps")).toBe(
			true,
		);
		expect(
			orchestratorRouteAllowed("POST", "/api/v1/workflow/blueprint/validate"),
		).toBe(true);
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

	test("answering and forwarding routed developer questions is allowed", () => {
		// A developer question can be pending during any step; the orchestrator may
		// answer the ones routed to it or forward them, whatever the current step.
		for (const action of ["answer-question", "forward-question"])
			for (const step of ["core.implementation", "core.developer-review"])
				expect(orchestratorActionRefusal(action, step)).toBeUndefined();
	});

	test("the launch ceiling refuses at the bound and allows below it", () => {
		const launch = (workflowId: string): OrchestratorLaunch => ({
			workflowId,
			repository: "/repo",
			createdAt: "2026-10-06T00:00:00Z",
		});
		const limits = { maxActive: 3, maxStartsPerDay: 20 };
		// Below the active bound: allowed.
		expect(
			orchestratorLaunchRefusal({
				limits,
				active: [launch("a"), launch("b")],
				recent: [launch("a"), launch("b")],
			}),
		).toBeUndefined();
		// At the active bound: refused, naming the limit, the count and the workflows.
		const atActive = orchestratorLaunchRefusal({
			limits,
			active: [launch("a"), launch("b"), launch("c")],
			recent: [launch("a"), launch("b"), launch("c")],
		});
		expect(atActive).toContain("3 of 3 active workflows");
		expect(atActive).toContain("(a, b, c)");
		// Above the active bound: still refused.
		expect(
			orchestratorLaunchRefusal({
				limits,
				active: [launch("a"), launch("b"), launch("c"), launch("d")],
				recent: [],
			}),
		).toContain("4 of 3 active workflows");
		// The trailing-24 h bound applies when the active bound is not reached.
		const daily = orchestratorLaunchRefusal({
			limits: { maxActive: 5, maxStartsPerDay: 2 },
			active: [launch("a")],
			recent: [launch("a"), launch("b")],
		});
		expect(daily).toContain("2 of 2 starts in the last 24 hours");
		expect(daily).toContain("(a, b)");
		expect(
			orchestratorLaunchRefusal({
				limits: { maxActive: 5, maxStartsPerDay: 2 },
				active: [],
				recent: [launch("a")],
			}),
		).toBeUndefined();
		// A skipped store is named so the refusal does not pretend the count is exact.
		expect(
			orchestratorLaunchRefusal({
				limits: { maxActive: 1, maxStartsPerDay: 20 },
				active: [launch("a")],
				recent: [],
				skipped: ["/work/gone"],
			}),
		).toContain("unreadable stores skipped: /work/gone");
		// A large ceiling (or many workflows) cannot make the 409 body unbounded:
		// the named list is capped and the remainder is summarized.
		const many = Array.from({ length: 50 }, (_, index) => launch(`w${index}`));
		const capped = orchestratorLaunchRefusal({
			limits: { maxActive: 50, maxStartsPerDay: 20 },
			active: many,
			recent: [],
		});
		expect(capped).toContain(
			"(w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, … and 40 more)",
		);
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
			// The principal, not the request, decides the pin and the attribution:
			// the operation receives the authenticated principal either way.
			expect(calls.starts).toEqual([
				{ enforceHumanReviewGates: true, principal: "orchestrator" },
				{ principal: "operator" },
			]);
			// A wire field cannot request (or suppress) the pin: the transport
			// rejects it and only the principal decides.
			const smuggled = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, { ...request, enforceHumanReviewGates: false }),
			);
			expect(smuggled.status).toBe(400);
			// Nor can a request claim attribution for itself.
			const claimed = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, { ...request, startedBy: "orchestrator" }),
			);
			expect(claimed.status).toBe(400);
			expect(calls.starts).toHaveLength(2);
		});
	});

	const launch = (workflowId: string): OrchestratorLaunch => ({
		workflowId,
		repository: "/repo",
		createdAt: "2026-10-06T00:00:00Z",
	});
	const startRequest = {
		repo: "/repo",
		workflowId: "wf-3",
		mode: "worktree",
		workflowType: "openspec",
		task: "x",
	};

	test("an orchestrator start at the configured active ceiling is 409 and never reaches the operation", async () => {
		// The ceiling is deliberately not the default 3: a transport that ignored
		// the configured table would allow this start and fail the test.
		await withServer(
			"core.implementation",
			async (server, calls) => {
				const refused = await fetch(
					`${server.url}/api/v1/workflow/start`,
					post(orchestratorTokenFor(server.token), startRequest),
				);
				expect(refused.status).toBe(409);
				const body = (await refused.json()) as {
					error: { code: string; message: string };
				};
				expect(body.error.code).toBe("orchestrator-limit");
				expect(body.error.message).toContain("1 of 1 active workflows");
				expect(body.error.message).toContain("(a)");
				// Refused before `operations.start`: no workflow is created.
				expect(calls.starts).toEqual([]);
				// The developer is never limited or counted.
				const operator = await fetch(
					`${server.url}/api/v1/workflow/start`,
					post(server.token, startRequest),
				);
				expect(operator.status).toBe(200);
				expect(calls.starts).toEqual([{ principal: "operator" }]);
			},
			{
				limits: { maxActive: 1, maxStartsPerDay: 20 },
				counts: { active: [launch("a")], recent: [launch("a")], skipped: [] },
			},
		);
	});

	test("the trailing-24 h ceiling is enforced independently of the active count", async () => {
		await withServer(
			"core.implementation",
			async (server, calls) => {
				const refused = await fetch(
					`${server.url}/api/v1/workflow/start`,
					post(orchestratorTokenFor(server.token), startRequest),
				);
				expect(refused.status).toBe(409);
				const body = (await refused.json()) as {
					error: { code: string; message: string };
				};
				expect(body.error.message).toContain(
					"1 of 1 starts in the last 24 hours",
				);
				expect(body.error.message).toContain("(b)");
				expect(calls.starts).toEqual([]);
			},
			{
				limits: { maxActive: 5, maxStartsPerDay: 1 },
				counts: { active: [], recent: [launch("b")], skipped: [] },
			},
		);
	});

	test("the server decides the acting principal for a workflow action", async () => {
		await withServer("core.implementation", async (server, calls) => {
			const request = {
				repo: "/repo",
				workflowId: "wf-1",
				revision: 3,
				actionId: "resume",
			};
			const orchestrated = await fetch(
				`${server.url}/api/v1/workflow/action`,
				post(orchestratorTokenFor(server.token), request),
			);
			expect(orchestrated.status).toBe(200);
			const operator = await fetch(
				`${server.url}/api/v1/workflow/action`,
				post(server.token, request),
			);
			expect(operator.status).toBe(200);
			expect(calls.actions).toEqual(["resume", "resume"]);
			expect(calls.actionOptions).toEqual([
				{ principal: "orchestrator" },
				{ principal: "operator" },
			]);
			// The principal is not a field of the action contract: a request cannot
			// claim to be the orchestrator and cannot suppress its own label.
			const claimed = await fetch(
				`${server.url}/api/v1/workflow/action`,
				post(server.token, { ...request, principal: "orchestrator" }),
			);
			expect(claimed.status).toBe(400);
			expect(calls.actions).toHaveLength(2);
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

	test("[agents.orchestrator] monitor parses the three modes and defaults to wake", () => {
		expect(
			parseAgentsConfig({ orchestrator: { monitor: "notify" } }).orchestrator,
		).toEqual({ monitor: "notify" });
		for (const mode of ["wake", "notify", "off"] as const)
			expect(
				parseAgentsConfig({ orchestrator: { monitor: mode } }).orchestrator
					?.monitor,
			).toBe(mode);
		expect(() =>
			parseAgentsConfig({ orchestrator: { monitor: "loud" } }),
		).toThrow("must be one of wake, notify, off");
		// Absent — the whole table or just the key — means the default `wake`.
		expect(orchestratorMonitorMode(undefined)).toBe("wake");
		expect(
			orchestratorMonitorMode(parseAgentsConfig({ orchestrator: {} })),
		).toBe("wake");
		expect(
			orchestratorMonitorMode(parseAgentsConfig({ orchestrator: {} })),
		).toBe(DEFAULT_ORCHESTRATOR_MONITOR);
	});

	test("[agents.orchestrator] limits parses positive integers and defaults to 3/20", () => {
		expect(
			parseAgentsConfig({
				orchestrator: { limits: { max_active: 5, max_starts_per_day: 50 } },
			}).orchestrator?.limits,
		).toEqual({ max_active: 5, max_starts_per_day: 50 });
		// Absent — the table, the key, or the whole section — means the defaults.
		expect(orchestratorLaunchLimits(undefined)).toEqual(
			DEFAULT_ORCHESTRATOR_LIMITS,
		);
		expect(
			orchestratorLaunchLimits(parseAgentsConfig({ orchestrator: {} })),
		).toEqual(DEFAULT_ORCHESTRATOR_LIMITS);
		expect(
			orchestratorLaunchLimits(
				parseAgentsConfig({ orchestrator: { limits: { max_active: 1 } } }),
			),
		).toEqual({ maxActive: 1, maxStartsPerDay: 20 });
		expect(
			orchestratorLaunchLimits(
				parseAgentsConfig({
					orchestrator: { limits: { max_starts_per_day: 1 } },
				}),
			),
		).toEqual({ maxActive: 3, maxStartsPerDay: 1 });
		// A non-positive, fractional or non-numeric bound is refused on either key,
		// as is a typo.
		for (const key of ["max_active", "max_starts_per_day"] as const)
			for (const bad of [0, -1, 1.5, "3"])
				expect(() =>
					parseAgentsConfig({ orchestrator: { limits: { [key]: bad } } }),
				).toThrow(`${key} must be a positive integer`);
		expect(() =>
			parseAgentsConfig({ orchestrator: { limits: { maxActive: 3 } } }),
		).toThrow("unsupported key maxActive");
		expect(() => parseAgentsConfig({ orchestrator: { limits: 3 } })).toThrow(
			"must be a table",
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
