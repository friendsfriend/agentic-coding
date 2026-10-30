import { expect, test } from "bun:test";
import type { DashboardGateway } from "../src/contracts/gateway.ts";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	attachWorkflowHome,
	attachWorkflowHomeFromTranscript,
} from "../src/tui/orchestrator/clarifications.ts";
import { orchestratorSessionCommands } from "../src/tui/orchestrator/session-commands.ts";

function fixture() {
	const actions: Parameters<DashboardGateway["action"]>[0][] = [];
	const reads: string[][] = [];
	const at = "2026-01-01T00:00:00Z";
	const view: WorkflowView = {
		workflowId: "question-workflow",
		changeId: "change",
		revision: 3,
		definition: { id: "core", version: 1, digest: "fixture", label: "Fixture" },
		status: "active",
		repository: "/disposable",
		worktree: "/disposable",
		branch: "fixture",
		baseCommit: "fixture",
		runs: [],
		health: { valid: true, attention: [] },
		availableActions: [],
		createdAt: at,
		updatedAt: at,
		currentStep: {
			id: "core.implementation",
			label: "Implementation",
			attempt: 1,
			enteredAt: at,
		},
		routing: { defaultProfile: "test", routes: [] },
		effects: [],
		observations: [],
	};
	const gateway = {
		view: async (repo: string, workflowId: string) => {
			reads.push([repo, workflowId]);
			return view;
		},
		action: async (request: Parameters<DashboardGateway["action"]>[0]) => {
			actions.push(request);
			return view;
		},
	};
	let opens = 0;
	const selected = {
		runId: "selected-run",
		conversationId: "selected-conversation",
		hostSocket: "/disposable/host.sock",
	};
	const dependencies = {
		open: async () => {
			opens++;
			return selected;
		},
		hostIdentity: async () => "selected-host",
	};
	return {
		gateway,
		actions,
		reads,
		view,
		selected,
		dependencies,
		opens: () => opens,
	};
}

test("explicit transcript command captures the selected Home and exact workflow/revision without starting or navigating", async () => {
	const f = fixture();
	let command: string | undefined;
	const commands = orchestratorSessionCommands(
		() => {
			throw new Error("must not create a conversation");
		},
		(argument) => {
			command = argument;
		},
	);
	const attach = commands.find((item) => item.name === "/attach");
	expect(attach?.acceptsArguments).toBe(true);
	attach?.run("question-workflow /disposable/project with spaces");
	await attachWorkflowHomeFromTranscript(
		f.gateway,
		command,
		"/other-visible-repo",
		f.dependencies,
	);
	expect(f.opens()).toBe(1);
	expect(f.reads).toEqual([
		["/disposable/project with spaces", "question-workflow"],
	]);
	expect(f.actions).toEqual([
		{
			repo: "/disposable/project with spaces",
			workflowId: "question-workflow",
			revision: f.view.revision,
			actionId: "clarification.attach",
			input: {
				hostId: "selected-host",
				conversationId: "selected-conversation",
				homeRunId: "selected-run",
			},
		},
	]);
});

test("unassigned or malformed transcript intent changes no custody; missing native identity fails closed", async () => {
	const f = fixture();
	for (const command of [undefined, "", "../other", "not/an/id"])
		await expect(
			attachWorkflowHomeFromTranscript(
				f.gateway,
				command,
				"/disposable",
				f.dependencies,
			),
		).rejects.toThrow("explicit workflow id");
	expect(f.opens()).toBe(0);
	expect(f.actions).toEqual([]);
	await expect(
		attachWorkflowHome(
			f.gateway,
			{ repo: "/disposable", workflowId: "workflow", revision: 1 },
			{
				open: async () => ({
					runId: "legacy-run",
					hostSocket: "/disposable/host.sock",
				}),
				hostIdentity: async () => "host",
			},
		),
	).rejects.toThrow();
	expect(f.actions).toEqual([]);
});
