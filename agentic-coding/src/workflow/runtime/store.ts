// SQLite persistence: schema DDL, row mapping, open/close, and the
// snapshot/run/effect read-write helpers every other runtime module builds
// on. Also owns the small pure snapshot-structure invariants
// (validateStructure/validateSnapshot/validateEffect/actions/requireRevision)
// and the observational snapshot read path. None of these touch anything
// outside `registry` + already-open `db` state, so they sit at the bottom of
// the dependency graph alongside row IO rather than needing a home in a higher
// tier. Moved out of runtime.ts
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
import { decodeSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import {
	canonicalStorePath,
	guardStoreFile,
	verifyCanonicalStorePath,
} from "./targets.ts";

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

export const STORE_SCHEMA_VERSION = 4;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS workflow_instances(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation));
CREATE TABLE IF NOT EXISTS workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision));
CREATE TABLE IF NOT EXISTS workflow_outbox(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS workflow_security_audit(id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT NOT NULL, subject TEXT, diagnostic TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_migration_diagnostics(change_id TEXT PRIMARY KEY, repository TEXT NOT NULL, diagnostic TEXT NOT NULL, source_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status ON workflow_runs(workflow_id,status);
CREATE INDEX IF NOT EXISTS workflow_outbox_ready ON workflow_outbox(status,next_attempt_at,lease_expires_at);
`;

const REQUIRED_TABLES = [
	"workflow_instances",
	"workflow_runs",
	"workflow_events",
	"workflow_outbox",
	"workflow_security_audit",
	"workflow_migration_diagnostics",
];
const CURRENT_COLUMNS: Record<string, string[]> = {
	workflow_instances: [
		"id",
		"change_id",
		"repository",
		"worktree",
		"definition_id",
		"definition_version",
		"definition_digest",
		"revision",
		"status",
		"current_step",
		"snapshot_json",
		"created_at",
		"updated_at",
	],
	workflow_runs: [
		"id",
		"workflow_id",
		"step_id",
		"role",
		"generation",
		"attempt",
		"status",
		"profile_json",
		"issued_revision",
		"allowed_outcomes_json",
		"capability_hash",
		"capability_expires_at",
		"assignment_path",
		"output_path",
		"output_schema_id",
		"output_schema_version",
		"output_digest",
		"handle_json",
		"created_at",
		"completed_at",
	],
	workflow_events: [
		"workflow_id",
		"revision",
		"type",
		"actor_json",
		"data_json",
		"at",
	],
	workflow_outbox: [
		"id",
		"workflow_id",
		"revision",
		"kind",
		"idempotency_key",
		"payload_json",
		"status",
		"attempts",
		"max_attempts",
		"lease",
		"lease_expires_at",
		"next_attempt_at",
		"last_error",
	],
	workflow_security_audit: [
		"id",
		"workflow_id",
		"kind",
		"subject",
		"diagnostic",
		"at",
	],
	workflow_migration_diagnostics: [
		"change_id",
		"repository",
		"diagnostic",
		"source_json",
		"created_at",
	],
};

function guardedDatabase(
	repo: string,
	file: string,
	options: { create?: boolean; readonly?: boolean },
): Database {
	const guard = guardStoreFile(
		file,
		options.create === true,
		options.readonly === true,
	);
	try {
		const guardedStat = fs.fstatSync(guard);
		// Keep SQLite on descriptor's stable inode. Hard-link aliases make SQLite
		// race journal/shared-memory files on macOS (`SQLITE_IOERR_VNODE`).
		const db = new Database(
			`file:${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${guard}`,
			options.readonly === true ? { readonly: true } : { create: true },
		);
		try {
			db.exec("PRAGMA busy_timeout=10000");
			db.query("PRAGMA schema_version").get();
			if (options.readonly !== true) db.exec("PRAGMA journal_mode=MEMORY");
			const openedStat = fs.fstatSync(guard);
			if (
				openedStat.dev !== guardedStat.dev ||
				openedStat.ino !== guardedStat.ino
			)
				throw new WorkflowRuntimeError(
					"path-security",
					"workflow store changed while opening",
				);
			verifyCanonicalStorePath(repo, file);
			const close = db.close.bind(db);
			Object.defineProperty(db, "close", {
				value: () => {
					try {
						close();
					} finally {
						fs.closeSync(guard);
					}
				},
			});
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	} catch (error) {
		try {
			fs.closeSync(guard);
		} catch {
			/* guard already closed */
		}
		throw error;
	}
}

function pragmaVersion(db: Database): number {
	const row = db.query("PRAGMA user_version").get() as {
		user_version?: number;
	};
	return Number(row.user_version ?? 0);
}
function setPragmaVersion(db: Database, version: number): void {
	db.exec(`PRAGMA user_version = ${version}`);
}
function columns(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
		).map((column) => column.name),
	);
}
function tableNames(db: Database): Set<string> {
	return new Set(
		(
			db
				.query("SELECT name FROM sqlite_master WHERE type='table'")
				.all() as Array<{
				name: string;
			}>
		)
			.map((row) => row.name)
			.filter((name) => !name.startsWith("sqlite_")),
	);
}
function tableSql(db: Database, table: string): string {
	return (
		(
			db
				.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
				.get(table) as { sql?: string } | null
		)?.sql ?? ""
	)
		.replace(/["`]/g, "")
		.replace(/\s+/g, " ")
		.toUpperCase();
}
function validateCanonicalShape(db: Database, allowHistorical = false): void {
	const instanceSql = tableSql(db, "workflow_instances");
	const legacyIdentity = /CHANGE_ID\s+TEXT\s+NOT\s+NULL\s+UNIQUE/.test(
		instanceSql,
	);
	const legacyChildren = [
		"workflow_runs",
		"workflow_events",
		"workflow_outbox",
	].some((table) => /WORKFLOW_INSTANCES_LEGACY/.test(tableSql(db, table)));
	const runColumns = columns(db, "workflow_runs");
	const legacyRuns =
		!runColumns.has("issued_revision") &&
		!runColumns.has("allowed_outcomes_json");
	const reference = new Database(":memory:");
	try {
		reference.exec(SCHEMA_DDL);
		const objects = (source: Database) =>
			(
				source
					.query(
						"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
					)
					.all() as Array<{
					type: string;
					name: string;
					tbl_name: string;
					sql: string | null;
				}>
			).map((object) => ({
				type: object.type,
				name: object.name,
				tbl_name: object.tbl_name,
				sql: object.sql?.replace(/\s+/g, " ").toUpperCase() ?? null,
			}));
		const actualObjects = objects(db);
		const expectedObjects = objects(reference);
		const legacyObject = actualObjects.find(
			(object) => object.type === "table" && object.name === "workflows",
		);
		if (
			legacyObject &&
			tableSql(db, "workflows") !==
				"CREATE TABLE WORKFLOWS(CHANGE_ID TEXT PRIMARY KEY,STATE TEXT NOT NULL)"
		)
			throw new WorkflowRuntimeError(
				"migration-required",
				"unsupported legacy workflows table",
			);
		const objectKey = (object: ReturnType<typeof objects>[number]) =>
			`${object.type}:${object.name}`;
		const actualKeys = actualObjects.map(objectKey);
		const expectedKeys = expectedObjects.map(objectKey);
		if (legacyObject && !expectedKeys.includes("table:workflows"))
			expectedKeys.push("table:workflows");
		expectedKeys.sort();
		if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
			throw new WorkflowRuntimeError(
				"migration-required",
				"unsupported unversioned schema objects",
			);
		for (const table of REQUIRED_TABLES) {
			const expectedSql = tableSql(reference, table);
			const actualSql = tableSql(db, table);
			const normalizedMigratedRunSql = actualSql
				.replace(
					/ISSUED_REVISION INTEGER NOT NULL DEFAULT 0/,
					"ISSUED_REVISION INTEGER NOT NULL",
				)
				.replace(
					/ALLOWED_OUTCOMES_JSON TEXT NOT NULL DEFAULT '["COMPLETE","BLOCKED","FAILED"]'/,
					"ALLOWED_OUTCOMES_JSON TEXT NOT NULL",
				);
			const normalizedLegacyRunSql = expectedSql
				.replace(", ISSUED_REVISION INTEGER NOT NULL", "")
				.replace(", ALLOWED_OUTCOMES_JSON TEXT NOT NULL", "");
			const normalizedLegacySql = actualSql.replace(
				/CHANGE_ID\s+TEXT\s+NOT\s+NULL\s+UNIQUE/,
				"CHANGE_ID TEXT NULL",
			);
			if (
				actualSql !== expectedSql &&
				!(
					allowHistorical &&
					table === "workflow_instances" &&
					legacyIdentity &&
					normalizedLegacySql === expectedSql
				) &&
				!(
					(allowHistorical &&
						table === "workflow_runs" &&
						legacyRuns &&
						actualSql === normalizedLegacyRunSql) ||
					(table === "workflow_runs" &&
						normalizedMigratedRunSql === expectedSql)
				) &&
				!(
					allowHistorical &&
					legacyChildren &&
					["workflow_runs", "workflow_events", "workflow_outbox"].includes(
						table,
					) &&
					actualSql.replace(
						/WORKFLOW_INSTANCES_LEGACY/g,
						"WORKFLOW_INSTANCES",
					) === expectedSql
				)
			)
				throw new WorkflowRuntimeError(
					"migration-required",
					`unsupported table definition in ${table}`,
				);
		}
	} finally {
		reference.close();
	}
	const types: Record<string, Record<string, string>> = {
		workflow_instances: {
			id: "TEXT",
			change_id: "TEXT",
			repository: "TEXT",
			worktree: "TEXT",
			definition_id: "TEXT",
			definition_version: "INTEGER",
			definition_digest: "TEXT",
			revision: "INTEGER",
			status: "TEXT",
			current_step: "TEXT",
			snapshot_json: "TEXT",
			created_at: "TEXT",
			updated_at: "TEXT",
		},
		workflow_runs: {
			id: "TEXT",
			workflow_id: "TEXT",
			step_id: "TEXT",
			role: "TEXT",
			generation: "INTEGER",
			attempt: "INTEGER",
			status: "TEXT",
			profile_json: "TEXT",
			issued_revision: "INTEGER",
			allowed_outcomes_json: "TEXT",
			capability_hash: "TEXT",
			capability_expires_at: "TEXT",
			assignment_path: "TEXT",
			output_path: "TEXT",
			output_schema_id: "TEXT",
			output_schema_version: "INTEGER",
			output_digest: "TEXT",
			handle_json: "TEXT",
			created_at: "TEXT",
			completed_at: "TEXT",
		},
		workflow_events: {
			workflow_id: "TEXT",
			revision: "INTEGER",
			type: "TEXT",
			actor_json: "TEXT",
			data_json: "TEXT",
			at: "TEXT",
		},
		workflow_outbox: {
			id: "TEXT",
			workflow_id: "TEXT",
			revision: "INTEGER",
			kind: "TEXT",
			idempotency_key: "TEXT",
			payload_json: "TEXT",
			status: "TEXT",
			attempts: "INTEGER",
			max_attempts: "INTEGER",
			lease: "TEXT",
			lease_expires_at: "TEXT",
			next_attempt_at: "TEXT",
			last_error: "TEXT",
		},
		workflow_security_audit: {
			id: "TEXT",
			workflow_id: "TEXT",
			kind: "TEXT",
			subject: "TEXT",
			diagnostic: "TEXT",
			at: "TEXT",
		},
		workflow_migration_diagnostics: {
			change_id: "TEXT",
			repository: "TEXT",
			diagnostic: "TEXT",
			source_json: "TEXT",
			created_at: "TEXT",
		},
	};
	for (const [table, expected] of Object.entries(types)) {
		const info = db.query(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
			type: string;
			pk: number;
		}>;
		const optional =
			table === "workflow_runs"
				? new Set(["issued_revision", "allowed_outcomes_json"])
				: new Set<string>();
		const actualNames = info.map((column) => column.name);
		const expectedNames = Object.keys(expected).filter(
			(name) =>
				!optional.has(name) || info.some((column) => column.name === name),
		);
		if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported column order in ${table}`,
			);
		const actual = new Map(info.map((column) => [column.name, column]));
		for (const [name, type] of Object.entries(expected)) {
			const column = actual.get(name);
			if (!column && optional.has(name)) continue;
			if (!column || column.type.toUpperCase() !== type)
				throw new WorkflowRuntimeError(
					"migration-required",
					`unsupported unversioned column definition: ${table}.${name}`,
				);
		}
		const missing = Object.keys(expected).filter((name) => !actual.has(name));
		if (
			missing.some((name) => !optional.has(name)) ||
			actual.size !== Object.keys(expected).length - missing.length
		)
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported unversioned columns in ${table}`,
			);
	}
	const primaryKeys = [
		["workflow_instances", "id"],
		["workflow_runs", "id"],
		["workflow_events", "workflow_id", "revision"],
		["workflow_outbox", "id"],
		["workflow_security_audit", "id"],
		["workflow_migration_diagnostics", "change_id"],
	];
	for (const [table, ...names] of primaryKeys) {
		const actual = (
			db.query(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
				pk: number;
			}>
		)
			.filter((column) => column.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((column) => column.name);
		if (JSON.stringify(actual) !== JSON.stringify(names))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported primary key in ${table}`,
			);
	}
	const signatures: Record<string, RegExp[]> = {
		workflow_instances: [
			/CHECK\s*\(DEFINITION_VERSION\s*>\s*0\)/,
			/CHECK\s*\(REVISION\s*>=\s*0\)/,
			/CHECK\s*\(STATUS\s+IN\s*\('ACTIVE','PAUSED','ATTENTION-REQUIRED','COMPLETED','CLOSED'\)\)/,
		],
		workflow_runs: [
			/CHECK\s*\(GENERATION\s*>\s*0\)/,
			/CHECK\s*\(ATTEMPT\s*>\s*0\)/,
			/CHECK\s*\(STATUS\s+IN\s*\('PENDING','WORKING','COMPLETED','BLOCKED','FAILED','EXPIRED'\)\)/,
			/UNIQUE\s*\(WORKFLOW_ID\s*,\s*ID\s*,\s*GENERATION\)/,
		],
		workflow_outbox: [
			/IDEMPOTENCY_KEY\s+TEXT\s+NOT\s+NULL\s+UNIQUE/,
			/CHECK\s*\(MAX_ATTEMPTS\s*>\s*0\)/,
			/CHECK\s*\(STATUS\s+IN\s*\('PENDING','RUNNING','RETRY','COMPLETED','FAILED','EXPIRED'\)\)/,
		],
	};
	for (const [table, rules] of Object.entries(signatures))
		if (rules.some((rule) => !rule.test(tableSql(db, table))))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported constraints in ${table}`,
			);
	for (const table of ["workflow_runs", "workflow_events", "workflow_outbox"]) {
		const foreignKeys = db
			.query(`PRAGMA foreign_key_list(${table})`)
			.all() as Array<{ from: string; table: string; to: string }>;
		if (
			!foreignKeys.some(
				(key) =>
					key.from === "workflow_id" &&
					key.to === "id" &&
					["workflow_instances", "workflow_instances_legacy"].includes(
						key.table,
					),
			)
		)
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported foreign key in ${table}`,
			);
	}
	for (const [table, index, expectedColumns] of [
		[
			"workflow_runs",
			"workflow_runs_workflow_status",
			["workflow_id", "status"],
		],
		[
			"workflow_outbox",
			"workflow_outbox_ready",
			["status", "next_attempt_at", "lease_expires_at"],
		],
	] as const) {
		const indexes = db.query(`PRAGMA index_list(${table})`).all() as Array<{
			name: string;
		}>;
		if (!indexes.some((item) => item.name === index))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported index in ${table}`,
			);
		const actualColumns = (
			db.query(`PRAGMA index_info(${index})`).all() as Array<{
				name: string;
				seq: number;
			}>
		)
			.sort((a, b) => a.seq - b.seq)
			.map((item) => item.name);
		if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported index columns in ${table}`,
			);
	}
}
function classifyUnversioned(db: Database): number {
	const names = tableNames(db);
	const allowed = new Set([...REQUIRED_TABLES, "workflows"]);
	const unknown = [...names].filter((name) => !allowed.has(name));
	if (unknown.length)
		throw new WorkflowRuntimeError(
			"migration-required",
			`unsupported unversioned store tables: ${unknown.join(", ")}`,
		);
	if (names.size === 0) return 0;
	if (names.size === 1 && names.has("workflows")) {
		const legacyColumns = columns(db, "workflows");
		if (
			legacyColumns.size !== 2 ||
			!legacyColumns.has("change_id") ||
			!legacyColumns.has("state") ||
			!/(?:CHANGE_ID\s+TEXT\s+PRIMARY KEY|PRIMARY KEY\s*\(\s*CHANGE_ID\s*\))/i.test(
				tableSql(db, "workflows"),
			)
		)
			throw new WorkflowRuntimeError(
				"migration-required",
				"unsupported legacy workflows table",
			);
		return 0;
	}
	if (REQUIRED_TABLES.some((table) => !names.has(table)))
		throw new WorkflowRuntimeError(
			"migration-required",
			"unversioned store has an incomplete canonical schema",
		);
	validateCanonicalShape(db, true);
	for (const [table, expected] of Object.entries(CURRENT_COLUMNS)) {
		const actual = columns(db, table);
		const missing = expected.filter((column) => !actual.has(column));
		const supportedMissing =
			table === "workflow_runs"
				? ["issued_revision", "allowed_outcomes_json"]
				: [];
		if (missing.some((column) => !supportedMissing.includes(column)))
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported unversioned columns in ${table}`,
			);
		if (actual.size > expected.length)
			throw new WorkflowRuntimeError(
				"migration-required",
				`unsupported unversioned columns in ${table}`,
			);
	}
	const runColumns = columns(db, "workflow_runs");
	if (
		!runColumns.has("issued_revision") ||
		!runColumns.has("allowed_outcomes_json")
	)
		return 1;
	const instanceSql =
		(
			db
				.query(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_instances'",
				)
				.get() as { sql?: string } | null
		)?.sql ?? "";
	const childSql = ["workflow_runs", "workflow_events", "workflow_outbox"].map(
		(table) =>
			(
				db
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
					.get(table) as { sql?: string } | null
			)?.sql ?? "",
	);
	const hasLegacyChild = childSql.some((sql) =>
		/workflow_instances_legacy/i.test(sql),
	);
	if (/change_id\s+TEXT\s+NULL/i.test(instanceSql) && !hasLegacyChild) {
		foreignKeyCheck(db);
		return 4;
	}
	return 2;
}

function foreignKeyCheck(db: Database): void {
	const invalid = db.query("PRAGMA foreign_key_check").all();
	if (invalid.length)
		throw new WorkflowRuntimeError(
			"migration-required",
			`foreign-key check failed (${invalid.length} invalid references)`,
		);
}

function migrateVersion(db: Database, from: number): void {
	if (from === 1) {
		db.exec("DROP INDEX IF EXISTS workflow_runs_workflow_status");
		db.exec("ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy");
		db.exec(
			"CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation))",
		);
		db.exec(
			'INSERT INTO workflow_runs (id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at) SELECT id,workflow_id,step_id,role,generation,attempt,status,profile_json,0,\'["complete","blocked","failed"]\',capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at FROM workflow_runs_legacy',
		);
		db.exec("DROP TABLE workflow_runs_legacy");
		return;
	}
	if (from === 2) {
		const sql =
			(
				db
					.query(
						"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_instances'",
					)
					.get() as { sql?: string } | null
			)?.sql ?? "";
		if (/change_id\s+TEXT\s+NULL/i.test(sql)) return;
		db.exec(
			`CREATE TABLE workflow_instances_new(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		);
		db.exec(
			"INSERT INTO workflow_instances_new (id,change_id,repository,worktree,definition_id,definition_version,definition_digest,revision,status,current_step,snapshot_json,created_at,updated_at) SELECT id,change_id,repository,worktree,definition_id,definition_version,definition_digest,revision,status,current_step,snapshot_json,created_at,updated_at FROM workflow_instances",
		);
		db.exec("DROP TABLE workflow_instances");
		db.exec("ALTER TABLE workflow_instances_new RENAME TO workflow_instances");
		return;
	}
	if (from === 3) {
		const children = {
			workflow_runs:
				"id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation)",
			workflow_events:
				"workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision)",
			workflow_outbox:
				"id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT",
		};
		for (const [table, ddl] of Object.entries(children)) {
			const sql =
				(
					db
						.query(
							"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
						)
						.get(table) as { sql?: string } | null
				)?.sql ?? "";
			if (!/workflow_instances_legacy/i.test(sql)) continue;
			db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
			db.exec(`CREATE TABLE ${table}(${ddl})`);
			const mappings: Record<string, string> = {
				workflow_runs:
					"id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at",
				workflow_events: "workflow_id,revision,type,actor_json,data_json,at",
				workflow_outbox:
					"id,workflow_id,revision,kind,idempotency_key,payload_json,status,attempts,max_attempts,lease,lease_expires_at,next_attempt_at,last_error",
			};
			const mapping = mappings[table];
			if (!mapping) throw new Error(`missing migration mapping for ${table}`);
			db.exec(
				`INSERT INTO ${table} (${mapping}) SELECT ${mapping} FROM ${table}_legacy`,
			);
			db.exec(`DROP TABLE ${table}_legacy`);
		}
		db.exec(
			"CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status ON workflow_runs(workflow_id,status)",
		);
		db.exec(
			"CREATE INDEX IF NOT EXISTS workflow_outbox_ready ON workflow_outbox(status,next_attempt_at,lease_expires_at)",
		);
		return;
	}
	if (from === 4) {
		foreignKeyCheck(db);
		return;
	}
	throw new WorkflowRuntimeError(
		"unsupported-version",
		`unsupported workflow store version: ${from}`,
	);
}

export function initializeStore(repo: string): void {
	const file = canonicalStorePath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = guardedDatabase(repo, file, { create: true });
	db.exec("PRAGMA busy_timeout=10000");
	try {
		verifyCanonicalStorePath(repo, file);
		const initialVersion = pragmaVersion(db);
		if (initialVersion > STORE_SCHEMA_VERSION)
			throw new WorkflowRuntimeError(
				"unsupported-version",
				`unsupported workflow store version: ${initialVersion}`,
			);
		for (;;) {
			const observed = pragmaVersion(db);
			if (observed > STORE_SCHEMA_VERSION)
				throw new WorkflowRuntimeError(
					"unsupported-version",
					`unsupported workflow store version: ${observed}`,
				);
			if (observed === STORE_SCHEMA_VERSION) {
				validateCanonicalShape(db);
				foreignKeyCheck(db);
				return;
			}
			if (observed === 0) {
				db.exec("BEGIN IMMEDIATE");
				try {
					const locked = pragmaVersion(db);
					if (locked !== 0) {
						db.exec("COMMIT");
						continue;
					}
					const baseline = classifyUnversioned(db);
					if (baseline === 0) {
						db.exec(SCHEMA_DDL);
						setPragmaVersion(db, STORE_SCHEMA_VERSION);
					} else setPragmaVersion(db, baseline);
					foreignKeyCheck(db);
					db.exec("COMMIT");
				} catch (error) {
					rollback(db);
					throw error;
				}
				continue;
			}
			const foreignKeysOff = observed === 2 || observed === 3;
			if (foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
			try {
				db.exec("BEGIN IMMEDIATE");
				const locked = pragmaVersion(db);
				if (locked !== observed) {
					db.exec("COMMIT");
					continue;
				}
				migrateVersion(db, observed);
				setPragmaVersion(db, observed + 1);
				foreignKeyCheck(db);
				db.exec("COMMIT");
			} catch (error) {
				rollback(db);
				throw error;
			} finally {
				if (foreignKeysOff) db.exec("PRAGMA foreign_keys=ON");
			}
		}
	} finally {
		db.close();
	}
}

function openStoreWithMode(repo: string, readonly: boolean): Database {
	const file = canonicalStorePath(repo);
	if (!fs.existsSync(file))
		throw new WorkflowRuntimeError(
			"migration-required",
			"workflow store is absent; initialize the store before writing",
		);
	const db = guardedDatabase(repo, file, { readonly });
	db.exec("PRAGMA busy_timeout=10000");
	if (!readonly) db.exec("PRAGMA foreign_keys=ON");
	try {
		verifyCanonicalStorePath(repo, file);
		const version = pragmaVersion(db);
		if (version !== STORE_SCHEMA_VERSION)
			throw new WorkflowRuntimeError(
				version > STORE_SCHEMA_VERSION
					? "unsupported-version"
					: "migration-required",
				`workflow store requires initialization (version ${version})`,
			);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function openStore(repo: string): Database {
	return openStoreWithMode(repo, false);
}

/** Open a validated store without taking SQLite's writer lock or running any
 * schema/import work. Observation must use this boundary. */
export function openReadStore(repo: string): Database {
	return openStoreWithMode(repo, true);
}

export interface ObservedStore {
	version: number;
	legacyChangeIds: string[];
}
export function observedStore(repo: string): ObservedStore | undefined {
	const file = canonicalStorePath(repo);
	if (!fs.existsSync(file)) return undefined;
	const db = guardedDatabase(repo, file, { readonly: true });
	try {
		verifyCanonicalStorePath(repo, file);
		const version = pragmaVersion(db);
		return { version, legacyChangeIds: [] };
	} finally {
		db.close();
	}
}

// Lease heartbeats run frequently while an effect is active. Reuse the
// already-initialized store schema without repeating openStore's migration and
// DDL bootstrap on every heartbeat.
function openLeaseStore(repo: string): Database {
	const file = canonicalStorePath(repo);
	if (!fs.existsSync(file))
		throw new WorkflowRuntimeError("not-found", "workflow store is absent");
	const db = guardedDatabase(repo, file, {});
	db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000");
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
	const db = openReadStore(repo);
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
	const db = openReadStore(repo);
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
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
): WorkflowActionView[] {
	if (snapshot.status === "paused")
		return [{ id: "resume", label: "Resume", confirmation: "confirm" }];
	return (
		registry
			.stepForDefinition(definition, snapshot.currentStep)
			.behavior?.developerActions?.({
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
		registry.stepForDefinition(definition, snapshot.currentStep).actor !==
			"agent" &&
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
	decodeSnapshot(JSON.parse(json(snapshot)));
	if (snapshot.definition.digest !== definition.digest)
		throw new WorkflowRuntimeError(
			"pin-mismatch",
			"pinned definition digest unavailable",
		);
	if (
		JSON.stringify(snapshot.definition.stepRefs ?? null) !==
		JSON.stringify(definition.stepRefs ?? null)
	)
		throw new WorkflowRuntimeError(
			"pin-mismatch",
			"pinned step compatibility references unavailable",
		);
	for (const stepId of definition.steps)
		registry.stepForDefinition(definition, stepId);
	validateStructure(snapshot, definition, runs, registry);
}
export function validateEffect(
	row: EffectRow,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	runs: WorkflowRun[],
	registry: WorkflowRegistry,
): void {
	if (!EFFECT_KINDS.has(row.kind as EffectKind))
		throw new WorkflowRuntimeError(
			"invalid-state",
			`unknown effect kind: ${row.kind}`,
		);
	const payload = JSON.parse(row.payload_json) as {
		runId?: unknown;
		questionId?: unknown;
	};
	const allowed = registry
		.stepForDefinition(definition, snapshot.currentStep)
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
		snapshot.currentStep === definition.initial;
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
		// A peer-question prompt deliberately targets a completed run at a
		// different step. It stays legal for as long as the addressed record
		// exists, even after the question resolves: the execute handler re-checks
		// the record and no-ops, so a resolved question can never abort a claim
		// transaction by leaving its prompt row behind.
		const consultTarget =
			row.kind === "agent.prompt" &&
			typeof payload.questionId === "string" &&
			snapshot.developerDialogue.some(
				(item) =>
					item.id === payload.questionId && item.targetRunId === payload.runId,
			);
		if (
			!run ||
			(!consultTarget &&
				(!ACTIVE_RUN.has(run.status) ||
					!snapshot.step.activeRunIds.includes(run.id) ||
					run.stepId !== snapshot.currentStep))
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
		const snapshot = decodeSnapshot(JSON.parse(row.snapshot_json));
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
export function dueQuestionTimers(
	repo: string,
	now: Date,
	limit: number,
): Array<{ workflowId: string; questionId: string; timerNonce: string }> {
	const db = openReadStore(repo);
	try {
		const result: Array<{
			workflowId: string;
			questionId: string;
			timerNonce: string;
		}> = [];
		const rows = db
			.query(`
				SELECT i.id AS workflow_id,
					json_extract(q.value, '$.id') AS question_id,
					json_extract(q.value, '$.timerNonce') AS timer_nonce
				FROM workflow_instances i, json_each(i.snapshot_json, '$.developerDialogue') q
				WHERE json_extract(q.value, '$.status') = 'pending'
					AND json_extract(q.value, '$.timerNonce') IS NOT NULL
					AND json_extract(q.value, '$.expiresAt') <= ?
				ORDER BY json_extract(q.value, '$.expiresAt')
				LIMIT ?
			`)
			.all(now.toISOString(), limit) as Array<{
			workflow_id: string;
			question_id: string;
			timer_nonce: string;
		}>;
		for (const row of rows) {
			result.push({
				workflowId: row.workflow_id,
				questionId: row.question_id,
				timerNonce: row.timer_nonce,
			});
		}
		return result;
	} finally {
		db.close();
	}
}

export function getSnapshot(
	repo: string,
	workflowId: string,
	_registry: WorkflowRegistry,
	_now: () => Date,
): WorkflowSnapshot {
	const db = openReadStore(repo);
	try {
		return decodeSnapshot(JSON.parse(instance(db, workflowId).snapshot_json));
	} finally {
		db.close();
	}
}
