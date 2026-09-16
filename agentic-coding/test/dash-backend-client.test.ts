// Dashboard mutation transport test (expose-unified-bun-backend, task 2.6):
// once a backend client is configured, the dashboard mutation wrappers cross
// the typed API instead of calling the in-process application directly.
import { afterEach, describe, expect, test } from "bun:test";
import {
	backendClient,
	clearBackendClient,
	configureBackendClient,
} from "../src/server/client.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	answerQuestion,
	applyRepair,
	loadVerifierFindingsAsync,
	loadVerifierReportAsync,
	requestWorkflowExecutionAsync,
	runWorkflow,
	saveDeveloperReview,
	startWorkflow,
} from "../src/tui/dash/observations.ts";
import type { WorkflowView } from "../src/workflow/contracts.ts";

const view = { workflowId: "wf-1", revision: 7 } as unknown as WorkflowView;

interface Calls {
	action?: unknown;
	question?: unknown;
	repair?: unknown;
	start?: unknown;
	saveReview?: unknown;
	execute?: unknown;
	saveAgents?: unknown;
	observation?: unknown;
}

function recordingOperations(calls: Calls): ServerOperations {
	return {
		runObservation: async (observation) => {
			calls.observation = observation;
			if ((observation as { kind: string }).kind === "verifier-findings")
				return { title: "verifier-1", events: [] };
			return { title: "verifier-1", content: "PASS" };
		},
		listViews: () => [],
		view: () => view,
		action: (request) => {
			calls.action = request;
			return view;
		},
		start: async (request) => {
			calls.start = request;
			return `started ${request.workflowId}`;
		},
		repair: (request) => {
			calls.repair = request;
			return view;
		},
		question: (request) => {
			calls.question = request;
			return view;
		},
		saveReview: async (request) => {
			calls.saveReview = request;
		},
		execute: (request) => {
			calls.execute = request;
		},
		handoff: async () => view,
		saveAgents: (request) => {
			calls.saveAgents = request;
		},
		loadAgents: () => ({
			agents: { profiles: {} },
			provenance: { source: "default", files: [] },
			conflicts: [],
			revision: "stub-revision",
		}),
		agentQuestion: async () => "answer",
		researchHandoff: async () => view,
	};
}

afterEach(() => {
	clearBackendClient();
});

describe("dashboard mutations cross the typed backend API", () => {
	test("repair, question, action and start reach the server operations", async () => {
		const calls: Calls = {};
		const server = await startWorkflowServer({
			operations: recordingOperations(calls),
		});
		try {
			configureBackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "test-owner",
			});
			await applyRepair("/repo", "wf-1", 3, "core.implementation", "why");
			await answerQuestion("/repo", "wf-1", 4, "q-1", {
				kind: "option",
				value: "yes",
			});
			await runWorkflow("approve", "/repo", "wf-1", 5);
			await startWorkflow({
				repo: "/repo",
				ticket: "",
				workflowId: "wf-2",
				mode: "worktree",
			});
			const findings = await loadVerifierFindingsAsync(
				"/repo",
				"wf-1",
				"verifier-1",
			);
			const report = await loadVerifierReportAsync(
				"/repo",
				"wf-1",
				"verifier-1",
			);
			await saveDeveloperReview("/repo", "wf-1", []);
			await requestWorkflowExecutionAsync("/repo", "wf-1");
			await backendClient()?.saveAgents(
				{ kind: "delete-preset", name: "legacy" },
				"/repo",
			);
			expect(findings?.title).toBe("verifier-1");
			expect(report.content).toBe("PASS");
			expect(calls.observation).toMatchObject({
				kind: "verifier-report",
				repo: "/repo",
				role: "verifier-1",
			});
			expect(calls.repair).toMatchObject({
				repo: "/repo",
				workflowId: "wf-1",
				revision: 3,
				targetStep: "core.implementation",
				reason: "why",
			});
			expect(calls.question).toMatchObject({
				workflowId: "wf-1",
				questionId: "q-1",
			});
			expect(calls.action).toMatchObject({ actionId: "approve", revision: 5 });
			expect(calls.start).toMatchObject({ workflowId: "wf-2" });
			expect(calls.saveReview).toMatchObject({
				repo: "/repo",
				workflowId: "wf-1",
				kind: "developer",
			});
			expect(calls.execute).toMatchObject({
				repo: "/repo",
				workflowId: "wf-1",
			});
			expect(calls.saveAgents).toMatchObject({
				repository: "/repo",
				mutation: { kind: "delete-preset", name: "legacy" },
			});
		} finally {
			await server.stop();
		}
	});
});
