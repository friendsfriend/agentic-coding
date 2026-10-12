// Evidence lifecycle in the engine (`add-workflow-evidence-store`, task 1.3):
// `workspace.cleanup` deletes a workflow's evidence with its workspace, and its
// observation reports the remaining work so a cleanup whose checkout already
// equals the repository (or is already gone) still removes the evidence.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { attachEvidence } from "../src/server/evidence/store.ts";
import { registry } from "../src/workflow/cli/registry.ts";
import { agentEffectHandlers } from "../src/workflow/effect-runner.ts";
import type { WorkflowEngine } from "../src/workflow/runtime/engine.ts";
import type { ClaimedEffect } from "../src/workflow/runtime/engine-types.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const WORKFLOW_ID = "wf-evidence";
const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function cleanupHandlerFor(repo: string, worktree: string) {
	const snapshot = {
		workflowId: WORKFLOW_ID,
		metadata: { repository: repo, worktree },
		definition: { id: "feature" },
	} as unknown as WorkflowSnapshot;
	const engine = {
		getSnapshot: () => snapshot,
	} as unknown as WorkflowEngine;
	const effect = {
		id: "effect-1",
		workflowId: WORKFLOW_ID,
		revision: 1,
		kind: "workspace.cleanup",
		idempotencyKey: "workspace:cleanup",
		payload: {},
		status: "pending",
		attempts: 0,
		maxAttempts: 3,
	} as unknown as ClaimedEffect;
	const handler = agentEffectHandlers(repo, engine, {
		registry,
		adapters: new Map(),
	})["workspace.cleanup"];
	if (!handler?.observe) throw new Error("workspace.cleanup has no observe");
	return { effect, observe: handler.observe, execute: handler.execute };
}

async function attachOne(worktree: string): Promise<string> {
	const scope = workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree });
	const source = path.join(worktree, "shot.png");
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(source, PNG);
	await attachEvidence(scope, {
		path: source,
		kind: "screenshot",
		caption: "cleanup fixture",
	});
	return scope.root;
}

describe("workspace.cleanup deletes the workflow's evidence", () => {
	test("a repository-mode workflow still loses its evidence", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cleanup-"));
		try {
			// The checkout *is* the repository, so cleanup has no worktree to
			// remove: the evidence is the whole of its remaining work.
			const evidenceRoot = await attachOne(repo);
			const handler = cleanupHandlerFor(repo, repo);
			expect(await Effect.runPromise(handler.observe(handler.effect))).toBe(
				false,
			);
			expect(await Effect.runPromise(handler.execute(handler.effect))).toEqual({
				cleaned: true,
			});
			expect(fs.existsSync(evidenceRoot)).toBe(false);
			// Idempotent: the same effect observed again is already done.
			expect(await Effect.runPromise(handler.observe(handler.effect))).toBe(
				true,
			);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("a checkout-mode workflow with no evidence is already clean", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cleanup-"));
		const worktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "evidence-worktree-"),
		);
		try {
			// The worktree is gone, and no evidence was ever attached.
			fs.rmSync(worktree, { recursive: true, force: true });
			const handler = cleanupHandlerFor(repo, worktree);
			expect(await Effect.runPromise(handler.observe(handler.effect))).toBe(
				true,
			);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});
});
