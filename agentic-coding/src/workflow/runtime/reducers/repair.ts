// The `operator.repair`, `operator.repin`, and `operator.resume` reducers,
// grouped together since they share repair/repin plumbing (expiring active
// runs, re-entering a step, clearing attention). Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type {
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import {
	openDebugRequestsForWorkflow,
	updateDebugRequest,
} from "../debug-requests.ts";
import { enterStep, expireRuns, freshStep } from "../kernel.ts";
import { nowIso, requireRevision, runs, validateStructure } from "../store.ts";

export function repin(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "operator.repin" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	requireRevision(snapshot, command.revision);
	const runList = runs(db, snapshot.workflowId);
	validateStructure(snapshot, definition, runList, registry);
	const previous = snapshot.definition.digest;
	snapshot.definition = { ...snapshot.definition, digest: definition.digest };
	snapshot.repinned = { fromDigest: previous, at: nowIso(now) };
	return {
		type: "operator.repin",
		actor: { kind: "operator" },
		data: { from: previous, to: definition.digest },
	};
}

export function repair(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "operator.repair" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	requireRevision(snapshot, command.revision);
	if (
		!definition.steps.includes(command.targetStep) ||
		definition.terminal.includes(command.targetStep) ||
		registry.stepForDefinition(definition, command.targetStep).actor ===
			"system"
	)
		throw new WorkflowRuntimeError(
			"invalid-repair",
			`incompatible repair target: ${command.targetStep}`,
		);
	expireRuns(db, snapshot, now);
	// A repair re-enters the step with a fresh attempt, so the retired run's open
	// debug requests are closed in the same transaction: an open request whose
	// lifecycle effect was expired could never advance again, and it would hold
	// one of the workflow's two open slots forever.
	for (const request of openDebugRequestsForWorkflow(db, snapshot.workflowId)) {
		updateDebugRequest(db, request.id, {
			status: "cancelled",
			finishedAt: nowIso(now),
		});
		if (request.debugRunId)
			db.query(
				"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
			).run(nowIso(now), request.debugRunId);
	}
	// Keep the debug-request lifecycle effects: their stable idempotency keys are
	// the durable entry contract for the delegated run's launch and for the
	// report's delivery, exactly as this reducer already keeps the other
	// non-run lifecycle effects above. Expiring them would strand a request the
	// caller already collected.
	db.query(
		"UPDATE workflow_outbox SET status='expired', lease=NULL, lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind NOT IN ('debug.request.run','debug.request.deliver')",
	).run(snapshot.workflowId);
	const source = snapshot.currentStep;
	snapshot.currentStep = command.targetStep;
	snapshot.metadata.stepEnteredAt = nowIso(now);
	snapshot.status = "active";
	snapshot.step = freshStep(snapshot.step.attempt + 1);
	snapshot.repaired = {
		reason: command.reason,
		fromStep: source,
		at: nowIso(now),
	};
	snapshot.attention = [];
	enterStep(db, snapshot, definition, registry, now);
	return {
		type: "operator.repair",
		actor: { kind: "operator" },
		data: { source, target: command.targetStep, reason: command.reason },
	};
}

export function resume(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "operator.resume" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	requireRevision(snapshot, command.revision);
	if (snapshot.status !== "paused")
		throw new WorkflowRuntimeError(
			"unavailable",
			"resume requires paused workflow",
			snapshot.revision,
		);
	snapshot.status = "active";
	snapshot.attention = [];
	enterStep(db, snapshot, definition, registry, now);
	return {
		type: "workflow.resumed",
		actor: { kind: "operator" },
		data: { step: snapshot.currentStep },
	};
}
