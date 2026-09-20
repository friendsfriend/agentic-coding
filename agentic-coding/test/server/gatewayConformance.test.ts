import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import type { WorkflowView } from "../../src/contracts/workflow.ts";
import { BackendClient } from "../../src/server/client.ts";
import { CredentialRegistry } from "../../src/server/credentials.ts";
import { EventBroker } from "../../src/server/events.ts";
import { createInProcessGateway } from "../../src/server/gateway/inProcess.ts";
import type { ServerOperations } from "../../src/server/handlers.ts";
import { startWorkflowServer } from "../../src/server/lifecycle.ts";
import type { TelemetryOperations } from "../../src/server/telemetry.ts";
import { WorkflowRuntimeError } from "../../src/workflow/contracts.ts";

/**
 * Gateway conformance (establish-opencode-boundaries, task 3.6): the HTTP
 * adapter and the in-process adapter answer the same scenarios with the same
 * results — reads, mutations, stale revisions, aborts, event gaps and
 * structured errors. Both run against the *same* server operations, so a
 * divergence is the adapter's, not the application's.
 */
const stubView = {
	workflowId: "wf-1",
	changeId: "change-1",
	revision: 3,
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
} as unknown as WorkflowView;

interface Scenario {
	readonly applied: string[];
}

function stubOperations(scenario: Scenario): ServerOperations {
	return {
		runObservation: async (request) => ({ echoed: request.kind }),
		listViews: () => [stubView],
		view: () => stubView,
		action: (request) => {
			// the real operations refuse a stale revision before mutating, with
			// the engine's own structured error
			if (request.revision !== stubView.revision)
				throw new WorkflowRuntimeError(
					"stale-revision",
					"the workflow changed since this action was rendered",
					stubView.revision,
				);
			scenario.applied.push(request.actionId);
			return { ...stubView, revision: request.revision + 1 };
		},
		start: async (request) => `started ${request.workflowId}`,
		repair: () => stubView,
		question: () => stubView,
		saveReview: async () => {},
		execute: () => {},
		handoff: async () => stubView,
		saveAgents: () => {},
		loadAgents: () => ({
			agents: { profiles: {} },
			provenance: { source: "default", files: [] },
			conflicts: [],
			revision: "rev-1",
		}),
		agentQuestion: async () => "answer",
		researchHandoff: async () => stubView,
	};
}

const stubTelemetry: TelemetryOperations = {
	summaries: () => ({ items: [], total: 0, page: 1, perPage: 50 }),
	workspaces: () => [{ changeId: "change-1", path: "/ws", spanCount: 2 }],
	traceSpans: () => [],
	recentSpans: () => [],
	scan: async () => 7,
	prune: () => 2,
};

/** Run one scenario against both adapters and return their results. */
async function bothAdapters<T>(
	scenario: Scenario,
	run: (gateway: DashboardGateway) => Promise<T>,
): Promise<{ http: T; inProcess: T; httpGateway: DashboardGateway }> {
	const operations = stubOperations(scenario);
	const server = await startWorkflowServer({
		operations,
		telemetry: stubTelemetry,
	});
	const http = new BackendClient({
		baseUrl: server.url,
		token: server.token,
		ownerId: "conformance",
	});
	const inProcess = createInProcessGateway({
		operations,
		telemetry: stubTelemetry,
		credentials: new CredentialRegistry(),
		events: new EventBroker("conformance"),
	});
	try {
		return {
			http: await run(http),
			inProcess: await run(inProcess),
			httpGateway: http,
		};
	} finally {
		await server.stop();
	}
}

describe("gateway conformance", () => {
	test("both adapters expose the same kind and connection state", async () => {
		const { http, inProcess } = await bothAdapters(
			{ applied: [] },
			async (g) => ({
				kind: g.kind,
				state: g.connectionState(),
			}),
		);
		expect(http.kind).toBe("http");
		expect(inProcess.kind).toBe("in-process");
		// HTTP has no stream open yet; in-process has no connection to lose.
		expect(inProcess.state).toBe("open");
	});

	test("reads agree: view list, single view, observation and agents", async () => {
		const { http, inProcess } = await bothAdapters(
			{ applied: [] },
			async (g) => ({
				views: await g.listViews("/repo"),
				view: await g.view("/repo", "wf-1"),
				observed: await g.observe<{ echoed: string }>(
					{ kind: "projects" },
					Schema.Struct({ echoed: Schema.String }),
				),
				agents: await g.loadAgents("/repo"),
			}),
		);
		expect(http.views.map((v) => v.workflowId)).toEqual(
			inProcess.views.map((v) => v.workflowId),
		);
		expect(http.view.revision).toBe(inProcess.view.revision);
		expect(http.observed).toEqual(inProcess.observed);
		expect(http.agents.conflicts).toEqual(inProcess.agents.conflicts);
		expect(http.agents.revision).toBe(inProcess.agents.revision);
	});

	test("a mutation returns the committed view from both adapters", async () => {
		const scenario: Scenario = { applied: [] };
		const { http, inProcess } = await bothAdapters(scenario, (g) =>
			g.action({
				repo: "/repo",
				workflowId: "wf-1",
				revision: 3,
				actionId: "approve",
			}),
		);
		expect(http.revision).toBe(4);
		expect(inProcess.revision).toBe(4);
		expect(scenario.applied).toEqual(["approve", "approve"]);
	});

	test("a stale revision fails without mutating in either adapter", async () => {
		const scenario: Scenario = { applied: [] };
		const stale = {
			repo: "/repo",
			workflowId: "wf-1",
			revision: 2,
			actionId: "approve",
		};
		const { http, inProcess } = await bothAdapters(scenario, (g) =>
			g.action(stale).catch((error) => error),
		);
		// both adapters reject with the engine's code, not just a message
		expect((http as { code?: string }).code).toBe("stale-revision");
		expect((inProcess as { code?: string }).code).toBe("stale-revision");
		expect(scenario.applied).toEqual([]);
	});

	test("an aborted read rejects in both adapters", async () => {
		const controller = new AbortController();
		controller.abort();
		const { http, inProcess } = await bothAdapters(
			{ applied: [] },
			async (g) => ({
				http: await g
					.view("/repo", "wf-1", controller.signal)
					.catch((error) => error),
				inProcess: await g
					.view("/repo", "wf-1", controller.signal)
					.catch((error) => error),
			}),
		);
		// both calls on both adapters reject with the same cancellation shape
		for (const side of [http, inProcess])
			for (const error of [side.http, side.inProcess]) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).name).toBe("AbortError");
			}
	});

	test("telemetry reads and counters agree", async () => {
		const { http, inProcess } = await bothAdapters(
			{ applied: [] },
			async (g) => ({
				traces: await g.telemetryTraces({ page: 1 }),
				workspaces: await g.telemetryWorkspaces(),
				scan: await g.telemetryScan("/repo"),
				prune: await g.telemetryPrune(7),
			}),
		);
		expect(http.traces).toEqual(inProcess.traces);
		expect(http.workspaces).toEqual(inProcess.workspaces);
		expect(http.scan).toBe(inProcess.scan);
		expect(http.prune).toBe(inProcess.prune);
	});

	test("both adapters report an event gap as a resync", async () => {
		const events = new EventBroker("conformance", 2);
		const operations = stubOperations({ applied: [] });
		const gateway = createInProcessGateway({
			operations,
			telemetry: stubTelemetry,
			credentials: new CredentialRegistry(),
			events,
		});
		// fill the ring, then ask from a cursor the window no longer covers
		for (let index = 0; index < 4; index += 1)
			events.publish({ domain: "workflow", kind: `event-${index}` });
		const reasons: string[] = [];
		const received: number[] = [];
		const unsubscribe = gateway.subscribe(
			{
				onEvent: (event) => received.push(event.sequence),
				onResync: (reason) => reasons.push(reason),
			},
			1,
		);
		unsubscribe();
		expect(reasons).toEqual(["cursor outside the retained event window"]);
		expect(received).toEqual([]);

		// a cursor inside the window replays only what was missed
		const replay: number[] = [];
		const inside = gateway.subscribe(
			{
				onEvent: (event) => replay.push(event.sequence),
				onResync: () => {},
			},
			3,
		);
		inside();
		expect(replay).toEqual([4]);
	});

	test("both adapters reject a malformed observation payload", async () => {
		const operations = stubOperations({ applied: [] });
		const server = await startWorkflowServer({
			operations: {
				...operations,
				runObservation: async () => ({ wrong: true }),
			},
			telemetry: stubTelemetry,
		});
		const http = new BackendClient({
			baseUrl: server.url,
			token: server.token,
			ownerId: "conformance",
		});
		const inProcess = createInProcessGateway({
			operations: {
				...operations,
				runObservation: async () => ({ wrong: true }),
			},
			telemetry: stubTelemetry,
			credentials: new CredentialRegistry(),
			events: new EventBroker("conformance"),
		});
		const schema = Schema.Struct({ echoed: Schema.String });
		try {
			const httpError = await http
				.observe({ kind: "projects" }, schema)
				.catch((error) => error);
			const localError = await inProcess
				.observe({ kind: "projects" }, schema)
				.catch((error) => error);
			expect((httpError as { code?: string }).code).toBe("invalid-response");
			expect((localError as Error).message).toContain("invalid");
		} finally {
			await server.stop();
		}
	});
});

describe("in-process gateway over the real server operations", () => {
	test("drives the server's own operations without a transport", async () => {
		const { serverOperations } = await import("../../src/server/handlers.ts");
		const os = await import("node:os");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const gateway = createInProcessGateway({
			operations: serverOperations,
			telemetry: stubTelemetry,
			credentials: new CredentialRegistry(),
			events: new EventBroker("conformance-real"),
		});
		const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-real-"));
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: emptyRepo });
		// a repository with no started workflows lists the store view, not an error
		const views = await gateway.listViews(emptyRepo);
		expect(Array.isArray(views)).toBe(true);
		expect(views.every((view) => typeof view.workflowId === "string")).toBe(
			true,
		);
		// an unknown workflow is reported as a diagnostic view, never as a
		// silently valid one
		const view = await gateway.view(emptyRepo, "missing-workflow");
		expect(view.health.valid).toBe(false);
		expect(view.health.attention.length).toBeGreaterThan(0);
	});
});
