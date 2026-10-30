import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	DeveloperDialogueRecord,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import {
	orchestratorTokenFor as orchestratorCapability,
	orchestratorConversationTokenFor as orchestratorConversationCapability,
} from "../src/server/auth.ts";
import {
	clarificationProposalPreview,
	clarificationSources,
} from "../src/server/clarification.ts";
import { acceptedClarificationReplay } from "../src/server/clarification-replay.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { clarificationDigest } from "../src/workflow/runtime/clarification-actions.ts";

function fixture() {
	const identity = { hostId: "home", conversationId: "conversation" };
	const attachment = { ...identity, epoch: 2 };
	const source = {
		kind: "task" as const,
		id: "task",
		digest: clarificationDigest("Agreed task"),
	};
	const question: DeveloperDialogueRecord = {
		id: "q",
		workflowId: "workflow",
		runId: "worker",
		role: "worker",
		stepId: "core.implementation",
		description: "Choose the exact answer",
		options: [],
		targetRole: "orchestrator",
		status: "answered",
		createdAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2026-01-01T00:01:00.000Z",
		answer: { kind: "custom", value: "Exact answer" },
		clarification: {
			attachment,
			delivery: { id: "delivery", status: "accepted" },
			resolution: {
				origin: "grounded-orchestrator",
				rationale: "Agreed task",
				sources: [source],
				receipt: "accepted-receipt",
			},
		},
	};
	// This HTTP boundary fixture is not a fake workflow implementation: action
	// execution must never run for an already committed canonical receipt.
	const view = {
		workflowId: question.workflowId,
		repository: "/fixture",
		revision: 4,
		task: "Agreed task",
		currentStep: { id: question.stepId },
		clarificationAttachment: attachment,
		developerDialogue: [question],
	} as WorkflowView;
	const input = {
		epoch: 2,
		questionId: question.id,
		askingRunId: question.runId,
		homeRunId: "home-run",
		responses: [
			{ questionId: question.id, kind: "custom", value: "Exact answer" },
		],
		rationale: "Agreed task",
		sources: [source],
		receipt: "accepted-receipt",
	};
	return { identity, view, input, question };
}

test("accepted clarification receipt retries are exact, scoped, read-only and preserve the original revision", async () => {
	const { identity, view, input } = fixture();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clarification-receipt-"));
	let mutations = 0;
	const server = await startWorkflowServer({
		configDir: dir,
		operations: {
			view: () => view,
			action: () => {
				mutations++;
				throw new Error("must not mutate an accepted receipt");
			},
		} as unknown as ServerOperations,
	});
	try {
		const request = (token: string, value: unknown) =>
			fetch(`${server.url}/api/v1/workflow/action`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					repo: view.repository,
					workflowId: view.workflowId,
					revision: 3,
					actionId: "clarification.grounded",
					input: value,
				}),
			});
		const token = orchestratorConversationCapability(server.token, identity);
		const response = await request(token, input);
		expect(response.status).toBe(200);
		expect((await response.json()).value.revision).toBe(4);
		expect(mutations).toBe(0);
		expect(
			acceptedClarificationReplay(
				view,
				"clarification.grounded",
				{ ...input, receipt: "conflicting" },
				identity,
			),
		).toBe(false);
		expect(
			acceptedClarificationReplay(
				view,
				"clarification.grounded",
				{
					...input,
					responses: [{ questionId: "q", kind: "custom", value: "different" }],
				},
				identity,
			),
		).toBe(false);
		expect(
			acceptedClarificationReplay(
				view,
				"clarification.grounded",
				{ ...input, epoch: 1 },
				identity,
			),
		).toBe(false);
		const denied = await request(orchestratorCapability(server.token), input);
		expect({ status: denied.status, body: await denied.json() }).toMatchObject({
			status: 403,
		});
		expect(
			(
				await request(
					orchestratorConversationCapability(server.token, {
						...identity,
						conversationId: "foreign",
					}),
					input,
				)
			).status,
		).toBe(403);
		expect(mutations).toBe(0);
	} finally {
		await server.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("source discovery does not upgrade a live design, legacy answer or grounded interpretation to developer authority", () => {
	const { view, question } = fixture();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clarification-sources-"));
	try {
		view.worktree = path.join(dir, "worktree");
		view.changeId = "sample";
		const design = path.join(
			view.worktree,
			"openspec/changes/sample/design.md",
		);
		fs.mkdirSync(path.dirname(design), { recursive: true });
		fs.writeFileSync(design, "Current design bytes, not an approval pin");
		const legacy = {
			...question,
			id: "legacy",
			clarification: undefined,
			targetRole: undefined,
		};
		const confirmed = {
			...question,
			id: "confirmed",
			clarification: {
				attachment: { ...fixture().identity, epoch: 2 },
				delivery: { id: "confirmed", status: "accepted" as const },
				resolution: {
					origin: "confirmed-developer" as const,
					candidateVersion: 1,
					confirmation: { messageId: "7", sequence: 7 },
					receipt: "confirmed",
				},
			},
		};
		view.developerDialogue = [question, legacy, confirmed];
		const sources = clarificationSources(view);
		expect(
			sources.map(({ kind, id, eligible }) => ({ kind, id, eligible })),
		).toEqual([
			{ kind: "task", id: "task", eligible: true },
			{ kind: "design", id: "design.md", eligible: false },
			{ kind: "developer-decision", id: "confirmed", eligible: true },
		]);
		fs.unlinkSync(design);
		fs.writeFileSync(path.join(dir, "outside.md"), "not inside the worktree");
		fs.symlinkSync(path.join(dir, "outside.md"), design);
		expect(
			clarificationSources(view).some((source) => source.kind === "design"),
		).toBe(false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("proposal previews bind the complete exact response to a workflow/question and a new version", () => {
	const { view, input, question } = fixture();
	question.status = "pending";
	const preview = clarificationProposalPreview(view, input);
	expect(preview?.version).toBe(1);
	expect(preview?.text).toContain("workflow / q");
	expect(preview?.text).toContain("Exact answer");
	expect(() =>
		clarificationProposalPreview(view, { ...input, responses: [] }),
	).toThrow();
	const { responses: _responses, ...query } = input;
	expect(clarificationProposalPreview(view, query)).toBeUndefined();
});
