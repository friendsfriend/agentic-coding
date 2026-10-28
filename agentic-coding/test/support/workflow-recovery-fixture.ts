// Test-store setup only. Human-gate tests used to use arbitrary operator
// repair as a setup shortcut. That shortcut is deliberately no longer public.
import { Database } from "bun:sqlite";
import { resolveDefinition } from "../../src/workflow/runtime/definitions.ts";
import {
	enqueue,
	enterStep,
	freshStep,
} from "../../src/workflow/runtime/kernel.ts";
import { writeSnapshot } from "../../src/workflow/runtime/store.ts";
import {
	canonicalStorePath,
	type WorkflowEngine,
} from "../../src/workflow/runtime.ts";

export function parkFixtureRuns(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
): void {
	const db = new Database(canonicalStorePath(repo));
	db.query(
		"UPDATE workflow_runs SET status='blocked',capability_hash='' WHERE workflow_id=? AND status IN ('pending','working')",
	).run(workflowId);
	db.query(
		"UPDATE workflow_outbox SET status='completed',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status='running'",
	).run(workflowId);
	db.close();
	// Verify the fixture still decodes; the active-reference defect is the
	// supported same-step repair case, not a bypass in production code.
	engine.getSnapshot(repo, workflowId);
}

export function enterFixtureStep(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
	stepId: string,
) {
	const snapshot = engine.getSnapshot(repo, workflowId);
	const db = new Database(canonicalStorePath(repo));
	const definition = resolveDefinition(
		engine.registry,
		db,
		snapshot.definition.id,
		snapshot.definition.version,
		snapshot.definition.digest,
	);
	db.query(
		"UPDATE workflow_runs SET status='expired',capability_hash='' WHERE workflow_id=? AND status IN ('pending','working')",
	).run(workflowId);
	db.query(
		"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running')",
	).run(workflowId);
	snapshot.currentStep = stepId;
	snapshot.step = freshStep(snapshot.step.attempt + 1);
	enterStep(db, snapshot, definition, engine.registry, () => new Date());
	writeSnapshot(db, snapshot);
	db.close();
	return { snapshot, view: engine.status(repo, workflowId) };
}

export function finishPlanFixture(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
) {
	const snapshot = engine.getSnapshot(repo, workflowId);
	const db = new Database(canonicalStorePath(repo));
	snapshot.currentStep = "core.plan";
	snapshot.step.activeRunIds = [];
	db.query(
		"UPDATE workflow_runs SET status='expired',capability_hash='' WHERE workflow_id=? AND status IN ('pending','working')",
	).run(workflowId);
	db.query(
		"UPDATE workflow_outbox SET status='completed',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running')",
	).run(workflowId);
	writeSnapshot(db, snapshot);
	enqueue(
		db,
		snapshot,
		"openspec.validate",
		`test-plan-validated:${workflowId}:${snapshot.revision}`,
		{ changeId: workflowId },
	);
	db.close();
	const effect = engine
		.claimEffects(repo, 100)
		.find((row) => row.kind === "openspec.validate");
	if (!effect?.lease) throw new Error("missing fixture validation effect");
	return engine.dispatch(repo, {
		type: "effect.result",
		effectId: effect.id,
		lease: effect.lease,
		outcome: "complete",
	});
}
