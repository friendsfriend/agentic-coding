// The `operator.repair`, `operator.repin`, and `operator.resume` reducers,
// grouped together since they share repair/repin plumbing (expiring active
// runs, re-entering a step, clearing attention). Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import {
	redactSecrets,
	type WorkflowCommand,
	type WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { boundedSummary } from "../../../contracts/workflow-events.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { openDebugRequestsForWorkflow } from "../debug-requests.ts";
import { enterStep, expireRuns, freshStep } from "../kernel.ts";
import { inspectRecovery, requireRecoveryText } from "../recovery.ts";
import {
	effects,
	nowIso,
	requireRevision,
	runs,
	validateStructure,
} from "../store.ts";

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
	const boundedRecovery =
		command.principal === "orchestrator" || command.recovery !== undefined;
	if (boundedRecovery && command.targetStep !== snapshot.currentStep)
		throw new WorkflowRuntimeError(
			"invalid-repair",
			"Cross-step repair is not supported for orchestrator recovery; use the developer's manual repair UI.",
		);
	// Human-directed step selection is distinct from automated recovery. It may
	// retire unstarted work and revisit completed phases, but never interrupts a
	// working agent, steals a lease, or abandons a pending question/debug request.
	if (!boundedRecovery) {
		const refusal =
			snapshot.status === "closed"
				? "A closed workflow cannot be repaired."
				: runs(db, snapshot.workflowId).some((run) => run.status === "working")
					? "A worker or debug run is still working; stop it before manual repair."
					: effects(db, snapshot.workflowId).some(
								(effect) => effect.status === "running",
							)
						? "An effect is leased; wait for it to settle before manual repair."
						: openDebugRequestsForWorkflow(db, snapshot.workflowId).length > 0
							? "A debug request is still open; collect or cancel it first."
							: snapshot.developerDialogue.some(
										(question) => question.status === "pending",
									)
								? "A question is pending; resolve it before manual repair."
								: undefined;
		if (refusal) throw new WorkflowRuntimeError("invalid-repair", refusal);
	}
	const preview = inspectRecovery(db, snapshot, definition, registry);
	if (boundedRecovery && !preview.eligible)
		throw new WorkflowRuntimeError(
			"invalid-repair",
			preview.refusals.join(" "),
		);
	if (
		command.principal === "orchestrator" &&
		(snapshot.metadata.startedBy !== "orchestrator" || !command.recovery)
	)
		throw new WorkflowRuntimeError(
			"invalid-repair",
			"Orchestrator recovery requires an owned workflow and an inspected recovery request.",
		);
	if (command.recovery) {
		if (
			command.recovery.previewId !== preview.previewId ||
			command.recovery.operation !== preview.operation
		)
			throw new WorkflowRuntimeError(
				"invalid-repair",
				"Recovery preview no longer matches; inspect again.",
			);
		requireRecoveryText(command.reason, 160, "reason");
	}
	// Keep structured references/newlines intact. Do not silently truncate an
	// instruction (including one whose masking expands beyond the bound).
	const instruction = command.recovery
		? requireRecoveryText(
				redactSecrets(
					requireRecoveryText(
						command.recovery.instruction,
						8000,
						"instruction",
					),
				),
				8000,
				"masked instruction",
			)
		: undefined;
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
	const retiredRuns = preview.affectedRuns;
	const openEffects = openEffectIds(db, snapshot.workflowId);
	expireRuns(db, snapshot, now);
	// The checks in this transaction refused working runs, open debug requests
	// and leases. Retire only unclaimed work; never steal lifecycle work or
	// rewrite a terminal blocked/failed outcome.
	db.query(
		"UPDATE workflow_outbox SET status='expired', lease=NULL, lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry')",
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
	const prior = snapshot.step;
	snapshot.step = freshStep(prior.attempt + 1);
	if (source === command.targetStep) {
		if (prior.context !== undefined) snapshot.step.context = prior.context;
		if (prior.mode !== undefined) snapshot.step.mode = prior.mode;
	}
	snapshot.repaired = {
		reason,
		fromStep: source,
		at: nowIso(now),
		expiredEffects: boundedIds(expiredEffects),
		retiredRuns: boundedIds(retiredRuns),
		count,
		...(command.recovery
			? {
					recovery: {
						principal: command.principal ?? "operator",
						instruction: instruction ?? "",
						attempt: snapshot.step.attempt,
						revision: command.revision,
						previewId: preview.previewId,
						operation: preview.operation,
					},
				}
			: {}),
	};
	snapshot.attention = [];
	enterStep(db, snapshot, definition, registry, now);
	return {
		type: "operator.repair",
		actor: {
			kind: "operator",
			...(command.principal === "orchestrator"
				? { principal: "orchestrator" }
				: {}),
		},
		data: {
			...(snapshot.repaired.recovery
				? { recovery: snapshot.repaired.recovery }
				: {}),
			counts: preview.counts,
			consequences: boundedRecovery
				? preview.consequences
				: [
						"Developer-selected step re-entry; prior outcomes, evidence and audit history are retained.",
						"Unclaimed work is retired; no working agent or leased effect is interrupted.",
					],
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
