// SQLite persistence: schema DDL, row mapping, open/close, and the
// snapshot/run/effect read-write helpers every other runtime module builds
// on. Also owns the small pure snapshot-structure invariants
// (validateStructure/validateSnapshot/validateEffect/actions/requireRevision)
// and the due-question-expiry read path (expireDueQuestions/getSnapshot):
// none of these touch anything outside `registry` + already-open `db` state,
// so they sit at the bottom of the dependency graph alongside row IO rather
// than needing a home in a higher tier. Moved out of runtime.ts
// (split-workflow-god-modules).
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
	EffectKind,
	JsonValue,
	WorkflowActionView,
	WorkflowEffect,
	WorkflowRun,
	WorkflowSnapshot,
} from "../contracts.ts";
import { parseSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { canonicalStorePath } from "./targets.ts";

export const ACTIVE_RUN = new Set(["pending", "working"]);
export const EFFECT_KINDS = new Set<EffectKind>([
	"workspace.setup",
	"artifact.write",
	"agent.launch",
	"agent.prompt",
	"agent.stop",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
]);

export function nowIso(now: () => Date): string {
	return now().toISOString();
}
export function json(value: unknown): string {
	return JSON.stringify(value);
}
export function payload(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export function boundedError(value: unknown): string {
	const text =
		value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: JSON.stringify(value);
	return (text || "unknown error").slice(0, 2048);
}
export function rollback(db: Database): void {
	try {
		db.exec("ROLLBACK");
	} catch {
		/* no transaction */
	}
}
export function tableExists(db: Database, name: string): boolean {
	return Boolean(
		db
			.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(name),
	);
}

export function openStore(repo: string): Database {
	const file = canonicalStorePath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file, { create: true });
	db.exec(
		"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL",
	);
	db.exec(`
CREATE TABLE IF NOT EXISTS workflow_instances(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation));
CREATE TABLE IF NOT EXISTS workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision));
CREATE TABLE IF NOT EXISTS workflow_outbox(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS workflow_security_audit(id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT NOT NULL, subject TEXT, diagnostic TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_migration_diagnostics(change_id TEXT PRIMARY KEY, repository TEXT NOT NULL, diagnostic TEXT NOT NULL, source_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status ON workflow_runs(workflow_id,status);
CREATE INDEX IF NOT EXISTS workflow_outbox_ready ON workflow_outbox(status,next_attempt_at,lease_expires_at);
`);
	const runColumns = new Set(
		(
			db.query("PRAGMA table_info(workflow_runs)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	if (!runColumns.has("issued_revision"))
		db.exec(
			"ALTER TABLE workflow_runs ADD COLUMN issued_revision INTEGER NOT NULL DEFAULT 0",
		);
	if (!runColumns.has("allowed_outcomes_json"))
		db.exec(
			`ALTER TABLE workflow_runs ADD COLUMN allowed_outcomes_json TEXT NOT NULL DEFAULT '["complete","blocked","failed"]'`,
		);
	// Workflow identity is now the user-supplied workflow id (the row primary
	// key); `change_id` is the planner-recorded primary change, empty until the
	// plan step. Pre-identity-store databases declare the column
	// `change_id TEXT NOT NULL UNIQUE` (start-time change id); rebuild the row
	// table so an initially-empty recorded change id cannot collide on the old
	// unique constraint, retaining every row unchanged. The rebuild drops and
	// recreates the parent table in place (FKs are disabled around it), so the
	// child tables' references keep resolving to the rebuilt table.
	const instanceDdl = db
		.query(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_instances'",
		)
		.get() as { sql: string } | null;
	if (instanceDdl && !/change_id\s+TEXT\s+NULL/.test(instanceDdl.sql)) {
		db.exec("PRAGMA foreign_keys=OFF");
		try {
			db.exec("BEGIN IMMEDIATE");
			db.exec(`
CREATE TABLE workflow_instances_new(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
			db.exec(
				"INSERT INTO workflow_instances_new SELECT * FROM workflow_instances",
			);
			db.exec("DROP TABLE workflow_instances");
			db.exec(
				"ALTER TABLE workflow_instances_new RENAME TO workflow_instances",
			);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.exec("PRAGMA foreign_keys=ON");
		}
	}
	// SQLite's `ALTER TABLE ... RENAME` rewrites other tables' foreign-key
	// clauses to follow the renamed table, and that rewrite is NOT reverted if
	// the surrounding transaction rolls back (a documented SQLite quirk). A
	// store that ever ran a rename-based rebuild can therefore carry child
	// tables still referencing `workflow_instances_legacy`. Rebuild those
	// children against the canonical schema so writes keep enforcing the real
	// parent reference. Skipped when every child already references
	// `workflow_instances`.
	const CHILD_TABLES = {
		workflow_runs:
			"id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation)",
		workflow_events:
			"workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision)",
		workflow_outbox:
			"id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT",
	} as const;
	for (const [child, columns] of Object.entries(CHILD_TABLES)) {
		const childDdl = db
			.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
			.get(child) as { sql: string } | null;
		if (
			!childDdl ||
			!/REFERENCES\s+"workflow_instances_legacy"/.test(childDdl.sql ?? "")
		)
			continue;
		db.exec("PRAGMA foreign_keys=OFF");
		try {
			db.exec("BEGIN IMMEDIATE");
			db.exec(`ALTER TABLE ${child} RENAME TO ${child}_legacy`);
			db.exec(`CREATE TABLE ${child}(${columns})`);
			db.exec(`INSERT INTO ${child} SELECT * FROM ${child}_legacy`);
			db.exec(`DROP TABLE ${child}_legacy`);
			if (child === "workflow_runs")
				db.exec(
					"CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status ON workflow_runs(workflow_id,status)",
				);
			if (child === "workflow_outbox")
				db.exec(
					"CREATE INDEX IF NOT EXISTS workflow_outbox_ready ON workflow_outbox(status,next_attempt_at,lease_expires_at)",
				);
			db.exec("COMMIT");
		} catch (error) {
			rollback(db);
			throw error;
		} finally {
			db.exec("PRAGMA foreign_keys=ON");
		}
	}
	return db;
}

// Lease heartbeats run frequently while an effect is active. Reuse the
// already-initialized store schema without repeating openStore's migration and
// DDL bootstrap on every heartbeat.
function openLeaseStore(repo: string): Database {
	const db = new Database(canonicalStorePath(repo), { create: true });
	db.exec("PRAGMA busy_timeout=10000");
	return db;
}

export interface InstanceRow {
	id: string;
	change_id: string;
	definition_id: string;
	definition_version: number;
	definition_digest: string;
	revision: number;
	snapshot_json: string;
}
export interface RunRow {
	id: string;
	workflow_id: string;
	step_id: string;
	role: string;
	generation: number;
	attempt: number;
	status: WorkflowRun["status"];
	profile_json: string;
	issued_revision: number;
	allowed_outcomes_json: string;
	capability_hash: string;
	capability_expires_at: string;
	assignment_path: string;
	output_path: string | null;
	output_schema_id: string | null;
	output_schema_version: number | null;
	output_digest: string | null;
	handle_json: string | null;
	created_at: string;
	completed_at: string | null;
}
export interface EffectRow {
	id: string;
	workflow_id: string;
	revision: number;
	kind: EffectKind;
	idempotency_key: string;
	payload_json: string;
	status: WorkflowEffect["status"];
	attempts: number;
	max_attempts: number;
	lease: string | null;
	lease_expires_at: string | null;
	next_attempt_at: string | null;
	last_error: string | null;
}
export function runFromRow(row: RunRow): WorkflowRun {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		stepId: row.step_id,
		role: row.role,
		generation: row.generation,
		attempt: row.attempt,
		status: row.status,
		profile: JSON.parse(row.profile_json),
		issuedRevision: row.issued_revision,
		allowedOutcomes: JSON.parse(row.allowed_outcomes_json),
		capabilityHash: row.capability_hash,
		capabilityExpiresAt: row.capability_expires_at,
		assignmentPath: row.assignment_path,
		...(row.output_path ? { outputPath: row.output_path } : {}),
		...(row.output_schema_id && row.output_schema_version
			? {
					outputSchema: {
						id: row.output_schema_id,
						version: row.output_schema_version,
					},
				}
			: {}),
		...(row.output_digest ? { outputDigest: row.output_digest } : {}),
		...(row.handle_json ? { handle: JSON.parse(row.handle_json) } : {}),
		createdAt: row.created_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
	};
}
export function effectFromRow(row: EffectRow): WorkflowEffect {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		revision: row.revision,
		kind: row.kind,
		idempotencyKey: row.idempotency_key,
		payload: JSON.parse(row.payload_json),
		status: row.status,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		...(row.lease ? { lease: row.lease } : {}),
		...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
		...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
		...(row.last_error ? { lastError: row.last_error } : {}),
	};
}

export function instance(db: Database, id: string): InstanceRow {
	const row = db
		.query("SELECT * FROM workflow_instances WHERE id=?")
		.get(id) as InstanceRow | null;
	if (!row)
		throw new WorkflowRuntimeError("not-found", `workflow not found: ${id}`);
	return row;
}
export function runs(db: Database, id: string): WorkflowRun[] {
	return (
		db
			.query("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY rowid")
			.all(id) as RunRow[]
	).map(runFromRow);
}
export function effects(db: Database, id: string): WorkflowEffect[] {
	return (
		db
			.query("SELECT * FROM workflow_outbox WHERE workflow_id=? ORDER BY rowid")
			.all(id) as EffectRow[]
	).map(effectFromRow);
}
export function writeSnapshot(db: Database, snapshot: WorkflowSnapshot): void {
	db.query(
		"UPDATE workflow_instances SET revision=?,status=?,current_step=?,snapshot_json=?,updated_at=? WHERE id=?",
	).run(
		snapshot.revision,
		snapshot.status,
		snapshot.currentStep,
		json(snapshot),
		snapshot.metadata.updatedAt,
		snapshot.workflowId,
	);
}
export function getRun(repo: string, runId: string): WorkflowRun {
	const db = openStore(repo);
	try {
		const row = db
			.query("SELECT * FROM workflow_runs WHERE id=?")
			.get(runId) as RunRow | null;
		if (!row)
			throw new WorkflowRuntimeError("not-found", `run not found: ${runId}`);
		return runFromRow(row);
	} finally {
		db.close();
	}
}
// See runtime.ts's original doc comment (preserved on the WorkflowEngine
// public method) for why this resolves by (workflowId, stepId, role) rather
// than a client-supplied runId/generation/token.
export function activeRunForRole(
	repo: string,
	workflowId: string,
	stepId: string,
	role: string,
): WorkflowRun {
	const db = openStore(repo);
	try {
		const row = db
			.query(
				"SELECT * FROM workflow_runs WHERE workflow_id=? AND step_id=? AND role=? AND status='working' ORDER BY rowid DESC LIMIT 1",
			)
			.get(workflowId, stepId, role) as RunRow | null;
		if (!row)
			throw new WorkflowRuntimeError(
				"not-found",
				`no active run for ${stepId}/${role}`,
			);
		return runFromRow(row);
	} finally {
		db.close();
	}
}
export function effectIsLive(
	repo: string,
	effectId: string,
	lease: string,
	now: () => Date,
): boolean {
	const db = openLeaseStore(repo);
	try {
		return Boolean(
			db
				.query(
					"SELECT 1 FROM workflow_outbox WHERE id=? AND status='running' AND lease=? AND lease_expires_at>?",
				)
				.get(effectId, lease, nowIso(now)),
		);
	} finally {
		db.close();
	}
}

export function renewEffect(
	repo: string,
	effectId: string,
	lease: string,
	leaseMs: number,
	now: () => Date,
): boolean {
	const db = openLeaseStore(repo);
	try {
		const at = now();
		const result = db
			.query(
				"UPDATE workflow_outbox SET lease_expires_at=? WHERE id=? AND status='running' AND lease=? AND lease_expires_at>?",
			)
			.run(
				new Date(at.getTime() + leaseMs).toISOString(),
				effectId,
				lease,
				at.toISOString(),
			);
		return result.changes === 1;
	} finally {
		db.close();
	}
}

export function requireRevision(
	snapshot: WorkflowSnapshot,
	revision: number,
): void {
	if (snapshot.revision !== revision)
		throw new WorkflowRuntimeError(
			"revision-conflict",
			`stale revision ${revision}; current ${snapshot.revision}`,
			snapshot.revision,
		);
}
export function actions(
	snapshot: WorkflowSnapshot,
	registry: WorkflowRegistry,
): WorkflowActionView[] {
	if (snapshot.status === "paused")
		return [{ id: "resume", label: "Resume", confirmation: "confirm" }];
	return (
		registry.step(snapshot.currentStep).behavior?.developerActions?.({
			snapshot,
		}) ?? []
	);
}
export function validateStructure(
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	runs: WorkflowRun[],
	registry: WorkflowRegistry,
): void {
	if (!definition.steps.includes(snapshot.currentStep))
		throw new WorkflowRuntimeError(
			"invalid-state",
			`step not in pinned definition: ${snapshot.currentStep}`,
		);
	const byId = new Map(runs.map((run) => [run.id, run]));
	for (const run of runs) {
		const route = snapshot.routing.routes.find(
			(item) =>
				item.stepId === run.stepId &&
				(item.role === undefined || item.role === run.role),
		);
		if (!route || route.profile.digest !== run.profile.digest)
			throw new WorkflowRuntimeError(
				"invalid-state",
				`run routing invariant failed: ${run.id}`,
			);
	}
	for (const id of snapshot.step.activeRunIds) {
		const run = byId.get(id);
		if (
			!run ||
			run.workflowId !== snapshot.workflowId ||
			run.stepId !== snapshot.currentStep ||
			!ACTIVE_RUN.has(run.status)
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				`active run invariant failed: ${id}`,
			);
	}
	if (
		registry.step(snapshot.currentStep).actor !== "agent" &&
		snapshot.step.activeRunIds.length
	)
		throw new WorkflowRuntimeError(
			"invalid-state",
			"non-agent step has active runs",
		);
}
export function validateSnapshot(
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	runs: WorkflowRun[],
	registry: WorkflowRegistry,
): void {
	parseSnapshot(JSON.parse(json(snapshot)));
	if (snapshot.definition.digest !== definition.digest)
		throw new WorkflowRuntimeError(
			"pin-mismatch",
			"pinned definition digest unavailable",
		);
	validateStructure(snapshot, definition, runs, registry);
}
export function validateEffect(
	row: EffectRow,
	snapshot: WorkflowSnapshot,
	runs: WorkflowRun[],
	registry: WorkflowRegistry,
): void {
	if (!EFFECT_KINDS.has(row.kind as EffectKind))
		throw new WorkflowRuntimeError(
			"invalid-state",
			`unknown effect kind: ${row.kind}`,
		);
	const payload = JSON.parse(row.payload_json) as { runId?: unknown };
	const allowed = registry
		.step(snapshot.currentStep)
		.allowedEffects.includes(row.kind);
	// Edge effects are enqueued while advancing into delivery. Keep the
	// approval promotion legal without broadening delivery's effect contract.
	const wikiPromotionAtDelivery =
		row.kind === "wiki.verify" && snapshot.currentStep === "core.delivery";
	const wikiPromotionAtCompletion =
		row.kind === "wiki.verify" &&
		snapshot.definition.id === "wiki-comments" &&
		snapshot.currentStep === "core.completed";
	const researchWikiPromotion =
		row.kind === "wiki.verify" &&
		snapshot.definition.id === "research" &&
		snapshot.currentStep === "core.completed";
	const setupBeforeEntry =
		row.kind === "workspace.setup" &&
		!snapshot.step.activeRunIds.length &&
		snapshot.revision === 0;
	// Research deliberately starts its agent only after the repository-neutral
	// workspace setup effect completes. The workflow can receive other
	// revisions while that effect is pending, so keep that setup effect legal
	// for the active research step instead of incorrectly treating it as stale.
	const researchSetup =
		row.kind === "workspace.setup" &&
		snapshot.definition.id === "research" &&
		snapshot.currentStep === "core.research";
	if (
		!allowed &&
		!wikiPromotionAtDelivery &&
		!wikiPromotionAtCompletion &&
		!researchWikiPromotion &&
		!setupBeforeEntry &&
		!researchSetup &&
		row.kind !== "agent.stop"
	)
		throw new WorkflowRuntimeError(
			"invalid-state",
			`effect ${row.kind} is illegal at ${snapshot.currentStep}`,
		);
	if (["artifact.write", "agent.launch", "agent.prompt"].includes(row.kind)) {
		const run = runs.find((item) => item.id === payload.runId);
		if (
			!run ||
			!ACTIVE_RUN.has(run.status) ||
			!snapshot.step.activeRunIds.includes(run.id) ||
			run.stepId !== snapshot.currentStep
		)
			throw new WorkflowRuntimeError(
				"invalid-state",
				`effect run invariant failed: ${row.id}`,
			);
	}
	if (
		row.kind === "agent.stop" &&
		(typeof payload.runId !== "string" ||
			!runs.some((run) => run.id === payload.runId))
	)
		throw new WorkflowRuntimeError(
			"invalid-state",
			`stop effect run missing: ${row.id}`,
		);
}
export function expireDueQuestions(
	db: Database,
	workflowId: string,
	registry: WorkflowRegistry,
	now: () => Date,
): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const row = instance(db, workflowId);
		const snapshot = parseSnapshot(JSON.parse(row.snapshot_json));
		const due = snapshot.developerDialogue.filter(
			(item) =>
				item.status === "pending" &&
				Date.parse(item.expiresAt) <= now().getTime(),
		);
		if (!due.length) {
			db.exec("COMMIT");
			return;
		}
		const groups = new Set(due.map((item) => item.groupId).filter(Boolean));
		const dueIds = new Set(due.map((item) => item.id));
		const expiredIds = new Set(dueIds);
		const at = nowIso(now);
		for (const item of snapshot.developerDialogue) {
			if (
				item.status === "pending" &&
				(dueIds.has(item.id) ||
					(item.groupId !== undefined && groups.has(item.groupId)))
			) {
				item.status = "expired";
				item.answeredAt = at;
				item.answer = { kind: "cancel" };
				expiredIds.add(item.id);
			}
		}
		const definition = registry.definition(
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		validateSnapshot(snapshot, definition, runs(db, workflowId), registry);
		snapshot.revision += 1;
		snapshot.metadata.updatedAt = at;
		writeSnapshot(db, snapshot);
		db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
			snapshot.workflowId,
			snapshot.revision,
			"developer.question.expired",
			json({ kind: "system" }),
			json({ questionIds: [...expiredIds], outcome: "expired" }),
			at,
		);
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		throw error;
	}
}
export function getSnapshot(
	repo: string,
	workflowId: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowSnapshot {
	const db = openStore(repo);
	try {
		expireDueQuestions(db, workflowId, registry, now);
		return parseSnapshot(JSON.parse(instance(db, workflowId).snapshot_json));
	} finally {
		db.close();
	}
}
