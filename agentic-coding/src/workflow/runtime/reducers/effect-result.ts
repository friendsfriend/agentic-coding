// The `effect.result` reducer: applies an effect-runner outcome to its
// outbox row and, for the effect kinds that gate a transition
// (workspace.setup, openspec.validate, delivery.commit/push,
// workspace.close), advances the workflow. Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import path from "node:path";
import type { WorkflowCommand, WorkflowSnapshot } from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { enqueue, enterStep, transition } from "../kernel.ts";
import { boundedError, type EffectRow, json } from "../store.ts";

export function effectResult(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "effect.result" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_outbox WHERE id=?")
		.get(command.effectId) as EffectRow | null;
	if (
		!row ||
		row.workflow_id !== snapshot.workflowId ||
		row.status !== "running" ||
		row.lease !== command.lease ||
		Date.parse(row.lease_expires_at ?? "") <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"stale-effect",
			"effect lease is invalid or expired",
		);
	if (command.outcome === "complete") {
		db.query(
			"UPDATE workflow_outbox SET status='completed', lease=NULL, lease_expires_at=NULL WHERE id=?",
		).run(row.id);
		if (row.kind === "agent.launch") {
			const runId = String(
				(JSON.parse(row.payload_json) as { runId?: string }).runId ?? "",
			);
			if (runId && command.data && typeof command.data === "object")
				db.query(
					"UPDATE workflow_runs SET handle_json=?, status='working' WHERE id=? AND status IN ('pending','working')",
				).run(json(command.data), runId);
		}
	} else if (command.outcome === "retry" && row.attempts < row.max_attempts) {
		const next = new Date(
			now().getTime() + Math.min(60_000, 1000 * 2 ** row.attempts),
		).toISOString();
		db.query(
			"UPDATE workflow_outbox SET status='retry', lease=NULL, lease_expires_at=NULL, next_attempt_at=?, last_error=? WHERE id=?",
		).run(next, boundedError(command.data), row.id);
	} else {
		db.query(
			"UPDATE workflow_outbox SET status='failed', lease=NULL, lease_expires_at=NULL, last_error=? WHERE id=?",
		).run(boundedError(command.data), row.id);
		snapshot.status = "attention-required";
		snapshot.attention = [
			`effect ${row.kind} failed: ${boundedError(command.data)}`,
		];
	}
	if (command.outcome === "complete" && row.kind === "workspace.setup") {
		const data =
			command.data && typeof command.data === "object"
				? (command.data as Record<string, unknown>)
				: {};
		if (typeof data.worktree === "string")
			snapshot.metadata.worktree = path.resolve(data.worktree);
		if (typeof data.workspace === "string")
			snapshot.metadata.workspace = data.workspace;
		if (typeof data.branch === "string") snapshot.metadata.branch = data.branch;
		enterStep(db, snapshot, definition, registry, now);
	}
	if (
		command.outcome === "complete" &&
		row.kind === "openspec.validate" &&
		(snapshot.currentStep === "core.plan" ||
			snapshot.currentStep === "fusion.consolidate")
	)
		transition(db, snapshot, definition, "complete", undefined, registry, now);
	if (
		command.outcome === "complete" &&
		snapshot.currentStep === "core.delivery"
	) {
		if (row.kind === "delivery.commit")
			enqueue(
				db,
				snapshot,
				"delivery.push",
				`delivery:${snapshot.workflowId}:push`,
				{
					workflowId: snapshot.workflowId,
				},
			);
		if (row.kind === "delivery.push")
			transition(
				db,
				snapshot,
				definition,
				"complete",
				undefined,
				registry,
				now,
			);
	}
	if (command.outcome === "complete" && row.kind === "workspace.close")
		enqueue(
			db,
			snapshot,
			"workspace.cleanup",
			`workspace:${snapshot.workflowId}:cleanup`,
			{ workflowId: snapshot.workflowId },
		);
	return {
		type: "effect.result",
		actor: { kind: "system", effectId: row.id },
		data: { outcome: command.outcome },
	};
}
