// The `operator.repair`, `operator.repin`, and `operator.resume` reducers,
// grouped together since they share repair/repin plumbing (expiring active
// runs, re-entering a step, clearing attention). Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type {
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { boundedSummary } from "../../../contracts/workflow-events.ts";
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

/** The repair record's own bounds. The reason is free text a developer typed, so
 * it is bounded and credential-masked exactly like every other recorded detail
 * (`boundedSummary`), and the id lists are capped so one repair can never grow
 * the snapshot beyond a fixed budget. */
const MAX_REPAIR_REASON_CHARS = 160;
const MAX_REPAIR_IDS = 32;

function boundedIds(ids: readonly string[]): string[] {
	return [...new Set(ids)].slice(0, MAX_REPAIR_IDS);
}

/** The effects that were open when the repair started. What it actually expired
 * is read back afterwards from these ids, so the record names the effects this
 * repair retired instead of re-stating each statement's own `WHERE` clause. */
function openEffectIds(db: Database, workflowId: string): string[] {
	return (
		db
			.query(
				"SELECT id FROM workflow_outbox WHERE workflow_id=? AND status IN ('pending','retry','running') ORDER BY rowid",
			)
			.all(workflowId) as { id: string }[]
	).map((row) => row.id);
}

function expiredEffectIds(db: Database, ids: readonly string[]): string[] {
	const statement = db.query("SELECT status FROM workflow_outbox WHERE id=?");
	return ids.filter(
		(id) =>
			(statement.get(id) as { status: string } | null)?.status === "expired",
	);
}

/** How many repairs this workflow has now recorded, the one being committed
 * included: the repair count is a property of the workflow's history, so it is
 * counted from the events rather than kept as a second, drifting field. */
function repairCount(db: Database, workflowId: string): number {
	const row = db
		.query(
			"SELECT COUNT(*) AS count FROM workflow_events WHERE workflow_id=? AND type='operator.repair'",
		)
		.get(workflowId) as { count: number } | null;
	return (row?.count ?? 0) + 1;
}

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
	// What the repair is about to retire and expire, captured before it is
	// applied, so the committed record names the repair's effect and not only its
	// target (efficiency backlog item 11).
	const retiredRuns = [...snapshot.step.activeRunIds];
	const openEffects = openEffectIds(db, snapshot.workflowId);
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
		if (request.debugRunId) {
			const retired = db
				.query(
					"UPDATE workflow_runs SET status='expired',capability_hash='',completed_at=? WHERE id=? AND status IN ('pending','working')",
				)
				.run(nowIso(now), request.debugRunId);
			if (retired.changes > 0) retiredRuns.push(request.debugRunId);
		}
	}
	// Keep the debug-request lifecycle effects: their stable idempotency keys are
	// the durable entry contract for the delegated run's launch and for the
	// report's delivery, exactly as this reducer already keeps the other
	// non-run lifecycle effects above. Expiring them would strand a request the
	// caller already collected.
	db.query(
		"UPDATE workflow_outbox SET status='expired', lease=NULL, lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind NOT IN ('debug.request.run','debug.request.deliver')",
	).run(snapshot.workflowId);
	const expiredEffects = expiredEffectIds(db, openEffects);
	const count = repairCount(db, snapshot.workflowId);
	// The reason is free text: it is bounded and credential-masked here, once,
	// and the same string is what the snapshot, the committed event and the
	// telemetry payload all carry.
	const reason = boundedSummary(command.reason, MAX_REPAIR_REASON_CHARS) ?? "";
	const source = snapshot.currentStep;
	snapshot.currentStep = command.targetStep;
	snapshot.metadata.stepEnteredAt = nowIso(now);
	snapshot.status = "active";
	snapshot.step = freshStep(snapshot.step.attempt + 1);
	snapshot.repaired = {
		reason,
		fromStep: source,
		at: nowIso(now),
		expiredEffects: boundedIds(expiredEffects),
		retiredRuns: boundedIds(retiredRuns),
		count,
	};
	snapshot.attention = [];
	enterStep(db, snapshot, definition, registry, now);
	return {
		type: "operator.repair",
		actor: { kind: "operator" },
		data: {
			source,
			target: command.targetStep,
			reason,
			repairCount: count,
			expiredEffects: boundedIds(expiredEffects),
			retiredRuns: boundedIds(retiredRuns),
		},
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
