// The `operator.repair`, `operator.repin`, and `operator.resume` reducers,
// grouped together since they share repair/repin plumbing (expiring active
// runs, re-entering a step, clearing attention). Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type { WorkflowCommand, WorkflowSnapshot } from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { enqueue, enterStep, expireRuns, freshStep } from "../kernel.ts";
import {
	effects,
	nowIso,
	requireRevision,
	runs,
	validateSnapshot,
	validateStructure,
} from "../store.ts";

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

export function migrate(
	db: Database,
	snapshot: WorkflowSnapshot,
	current: CompiledWorkflowDefinition,
	target: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "operator.migrate" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	requireRevision(snapshot, command.revision);
	if (current.id !== target.id || current.version === target.version)
		throw new WorkflowRuntimeError(
			"invalid-migration",
			"migration must target another version of the current workflow",
		);
	if (!command.reason.trim())
		throw new WorkflowRuntimeError(
			"invalid-migration",
			"migration reason is required",
		);
	if (
		JSON.stringify(current.steps) !== JSON.stringify(target.steps) ||
		JSON.stringify(current.edges) !== JSON.stringify(target.edges) ||
		current.initial !== target.initial ||
		JSON.stringify(current.terminal) !== JSON.stringify(target.terminal) ||
		!target.stepRefs
	)
		throw new WorkflowRuntimeError(
			"invalid-migration",
			"migration target changes workflow shape or has no semantic pins",
		);
	registry.stepForDefinition(target, snapshot.currentStep);
	const targetSnapshot = structuredClone(snapshot);
	targetSnapshot.definition = {
		...targetSnapshot.definition,
		version: target.version,
		digest: target.digest,
		stepRefs: target.stepRefs,
	};
	// Validate the persisted state against the target pin before retiring any
	// ownership. The transaction also validates the post-migration state after
	// re-entry, but this preflight keeps an incompatible target from partially
	// changing the workflow before its first mutation.
	validateSnapshot(
		targetSnapshot,
		target,
		runs(db, snapshot.workflowId),
		registry,
	);
	const activeRunIds = [...snapshot.step.activeRunIds];
	const workflowEffects = effects(db, snapshot.workflowId);
	const expiringEffectIds = workflowEffects
		.filter((effect) => {
			if (
				!["pending", "retry", "running"].includes(effect.status) ||
				!["artifact.write", "agent.launch", "agent.prompt"].includes(
					effect.kind,
				)
			)
				return false;
			if (
				typeof effect.payload !== "object" ||
				effect.payload === null ||
				Array.isArray(effect.payload)
			)
				return false;
			const runId = (effect.payload as { runId?: unknown }).runId;
			return typeof runId === "string" && activeRunIds.includes(runId);
		})
		.map((effect) => effect.id);
	const active = runs(db, snapshot.workflowId).filter(
		(run) => activeRunIds.includes(run.id) && run.handle,
	);
	const setupIncomplete = workflowEffects.some(
		(effect) =>
			effect.kind === "workspace.setup" && effect.status !== "completed",
	);
	for (const effect of workflowEffects) {
		if (effect.kind !== "workspace.setup" || effect.status !== "expired")
			continue;
		db.query(
			"UPDATE workflow_outbox SET status='pending', lease=NULL, lease_expires_at=NULL, next_attempt_at=NULL, last_error=NULL WHERE id=? AND status='expired'",
		).run(effect.id);
	}
	const wasPaused = snapshot.status === "paused";
	// expireRuns retires run-owned work. Keep non-run lifecycle effects: their
	// stable idempotency keys are the durable entry contract for delivery,
	// closing, pull-request creation, and workspace setup. Expiring those keys
	// would make enterStep unable to recreate the required effect.
	expireRuns(db, snapshot, now, true);
	for (const run of active)
		enqueue(
			db,
			snapshot,
			"agent.stop",
			`migration:${run.id}:${run.generation}`,
			{
				runId: run.id,
			},
		);
	const from = snapshot.definition;
	const to = {
		id: target.id,
		version: target.version,
		digest: target.digest,
		stepRefs: target.stepRefs,
	};
	snapshot.definition = to;
	snapshot.migrated = { from, to, reason: command.reason, at: nowIso(now) };
	if (snapshot.status === "attention-required") snapshot.status = "active";
	snapshot.attention = [];
	// Migration expires ownership before changing the semantic pin, then
	// immediately re-enters the current step so an active workflow cannot be
	// stranded with no run or effect to make progress. Any non-completed initial
	// setup effect is the gate for the first agent step; retain it and wait for
	// explicit retry/recovery instead of bypassing workspace setup.
	if (!setupIncomplete && !wasPaused)
		enterStep(db, snapshot, target, registry, now);
	return {
		type: "operator.migrate",
		actor: { kind: "operator" },
		data: {
			from,
			to,
			reason: command.reason,
			expiredRuns: activeRunIds,
			expiredEffects: expiringEffectIds,
		},
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
	const staleRuns = runs(db, snapshot.workflowId).filter(
		(run) => snapshot.step.activeRunIds.includes(run.id) && run.handle,
	);
	expireRuns(db, snapshot, now);
	db.query(
		"UPDATE workflow_outbox SET status='expired', lease=NULL, lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running')",
	).run(snapshot.workflowId);
	for (const run of staleRuns)
		enqueue(
			db,
			snapshot,
			"agent.stop",
			`run:${run.id}:stop:${run.generation}`,
			{
				runId: run.id,
			},
		);
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
