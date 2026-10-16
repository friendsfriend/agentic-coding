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
} from "../../contracts/workflow.ts";
import { normalizeRuntimeId } from "../../contracts/workflow.ts";
import { decodeSnapshot, WorkflowRuntimeError } from "../contracts.ts";
import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { DEBUG_ROLE } from "../steps/debug.ts";
import { DEBUG_INVESTIGATE_STEP } from "./debug-requests.ts";
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
	"model.classify",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
	"environment.teardown",
	"environment.setup-guard",
	"environment.validate",
	"environment.promote",
	"environment.setup-stage",
	"environment.setup-smoke",
	"environment.setup-rollback",
	"environment.setup-cleanup",
	"debug.request.run",
	"debug.request.deliver",
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

export const STORE_SCHEMA_VERSION = 6;

/** The content-addressed custom workflow definitions (store v6). */
const DEFINITIONS_DDL =
	"CREATE TABLE IF NOT EXISTS workflow_definitions(digest TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL CHECK(version = 1), manifest_json TEXT NOT NULL, origin_json TEXT NOT NULL, created_at TEXT NOT NULL)";

/** The delegated debug requests (store v6). */
const DEBUG_REQUESTS_DDL =
	"CREATE TABLE IF NOT EXISTS debug_requests(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), caller_run_id TEXT NOT NULL, caller_role TEXT NOT NULL, goal TEXT NOT NULL, context TEXT, apps_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')), debug_run_id TEXT, baseline_ref TEXT, baseline_files_json TEXT, report_path TEXT, changed_files_json TEXT, created_at TEXT NOT NULL, finished_at TEXT, delivered_at TEXT)";

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS workflow_instances(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation));
CREATE TABLE IF NOT EXISTS workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision));
CREATE TABLE IF NOT EXISTS workflow_outbox(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS workflow_security_audit(id TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT NOT NULL, subject TEXT, diagnostic TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_migration_diagnostics(change_id TEXT PRIMARY KEY, repository TEXT NOT NULL, diagnostic TEXT NOT NULL, source_json TEXT, created_at TEXT NOT NULL);
${DEFINITIONS_DDL};
${DEBUG_REQUESTS_DDL};
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
/** The v6 definition table. */
const DEFINITIONS_TABLE = "workflow_definitions";
/** The v6 debug-request table. */
const DEBUG_REQUESTS_TABLE = "debug_requests";
const KNOWN_TABLES = [
	...REQUIRED_TABLES,
	DEFINITIONS_TABLE,
	DEBUG_REQUESTS_TABLE,
];

/**
 * Pins a store to the MEMORY journal mode. SQLite derives its `-wal`/`-shm`
 * paths from the filename it is handed, so a store opened through
 * `/dev/fd/<n>` can never reach them and a WAL store fails every guarded open
 * with SQLite's `unable to open database file`. One connection through the
 * store's real path checkpoints it and pins it to MEMORY, the journal mode the
 * guarded open needs because it runs no sidecar files at all. Read-only
 * observation cannot convert a store, so it reports the store instead of
 * passing SQLite's message through.
 */
function adoptMemoryJournal(
	file: string,
	guard: number,
	readonly: boolean,
): void {
	const header = Buffer.alloc(2);
	if (fs.readSync(guard, header, 0, 2, 18) !== 2) return;
	if (header[0] !== 0x02 || header[1] !== 0x02) return;
	if (readonly)
		throw new WorkflowRuntimeError(
			"invalid-state",
			`workflow store ${JSON.stringify(file)} is still in WAL mode; it has to be opened for writing before it can be observed`,
		);
	const db = new Database(file, { create: true });
	try {
		db.exec("PRAGMA busy_timeout=10000");
		db.exec("PRAGMA journal_mode=MEMORY");
	} finally {
		db.close();
	}
}

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
		adoptMemoryJournal(file, guard, options.readonly === true);
		// Keep SQLite on descriptor's stable inode. Hard-link aliases make SQLite
		// race journal/shared-memory files on macOS (`SQLITE_IOERR_VNODE`).
		const db = new Database(
			`${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${guard}`,
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
/** Whether an unknown table holds any row. The identifier comes from
 * `sqlite_master`, so it is quoted defensively. */
function tableHasRows(db: Database, table: string): boolean {
	const identifier = `"${table.replace(/"/g, '""')}"`;
	return Boolean(db.query(`SELECT 1 FROM ${identifier} LIMIT 1`).get());
}
function tableSql(db: Database, table: string): string {
	return (
		(
			(
				db
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
					.get(table) as { sql?: string } | null
			)?.sql ?? ""
		)
			.replace(/["`]/g, "")
			.replace(/\s+/g, " ")
			// SQLite stores the statement text as it was written, so two identical
			// schemas differ only in spacing. Compare structure, not formatting:
			// collapse whitespace around the punctuation every DDL form shares.
			.replace(/\s*([(),])\s*/g, "$1")
			.toUpperCase()
	);
}
/** Fold the historical DEFAULT clauses of the two run columns onto the current
 * DDL text. A store an earlier build migrated carries
 * `issued_revision INTEGER NOT NULL DEFAULT 0` and
 * `allowed_outcomes_json TEXT NOT NULL DEFAULT '["COMPLETE","BLOCKED","FAILED"]'`;
 * the columns are the same columns, so the store opens unchanged instead of
 * being refused. */
function foldLegacyRunDefaults(sql: string): string {
	return sql
		.replace(
			/ISSUED_REVISION INTEGER NOT NULL DEFAULT 0/g,
			"ISSUED_REVISION INTEGER NOT NULL",
		)
		.replace(
			/ALLOWED_OUTCOMES_JSON TEXT NOT NULL DEFAULT '\[COMPLETE,BLOCKED,FAILED\]'/g,
			"ALLOWED_OUTCOMES_JSON TEXT NOT NULL",
		);
}

/** Tables written by this build's own retired paths. Their rows are import
 * residue no reader in this build touches, so they are stepped over whatever
 * they hold: a version-6 store that went through the retired legacy import
 * carries a populated `workflows` table and must keep opening. */
const RETIRED_TABLES = new Set(["workflows"]);

/** The legacy `workflows` DDL the retired import wrote. A tolerated table that
 * is not this shape is a foreign table wearing a known name, and fails closed. */
const RETIRED_WORKFLOWS_DDL =
	"CREATE TABLE WORKFLOWS(CHANGE_ID TEXT PRIMARY KEY,STATE TEXT NOT NULL)";

/** Tables this build does not know but can safely step over: not part of the
 * canonical schema and holding no rows, so nothing can misread them — plus the
 * retired tables above. Only a store that already carries the canonical schema
 * can step over anything; a file without it is not this build's store, whatever
 * else it contains. */
function ignorableTables(db: Database, names: Set<string>): Set<string> {
	if (REQUIRED_TABLES.some((table) => !names.has(table))) return new Set();
	const tolerated = new Set<string>();
	for (const name of names) {
		if (KNOWN_TABLES.includes(name)) continue;
		if (RETIRED_TABLES.has(name)) {
			// The retired table keeps its own DDL: anything else under that name is
			// not the residue this build wrote.
			if (tableSql(db, name) !== RETIRED_WORKFLOWS_DDL)
				throw new WorkflowRuntimeError(
					"unsupported-version",
					`unsupported table definition in ${name}`,
				);
			tolerated.add(name);
			continue;
		}
		if (!tableHasRows(db, name)) tolerated.add(name);
	}
	return tolerated;
}
/** Validate a store's canonical shape against the current schema.
 *
 * A store this build did not write — a drifted DDL, a missing object, a foreign
 * table holding rows — is refused rather than interpreted: there is no
 * historical shape to step over. */
function validateCanonicalShape(db: Database): void {
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
		// An empty table from another feature (or another build) is not part of
		// the schema under validation, so neither it nor its indexes take part in
		// the object comparison. A table with rows stays in and fails the set
		// comparison below.
		const ignored = ignorableTables(
			db,
			new Set(actualObjects.map((object) => object.tbl_name)),
		);
		const compared = actualObjects.filter(
			(object) => !ignored.has(object.tbl_name),
		);
		const objectKey = (object: ReturnType<typeof objects>[number]) =>
			`${object.type}:${object.name}`;
		const actualKeys = compared.map(objectKey).sort();
		const expectedKeys = expectedObjects.map(objectKey).sort();
		if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
			throw new WorkflowRuntimeError(
				"unsupported-version",
				"unsupported workflow store schema objects",
			);
		// A store migrated by an earlier build can carry the run DDL that build
		// wrote: the two columns with their historical DEFAULT clauses. Folding
		// those defaults onto the current DDL accepts the store without
		// rewriting it.
		for (const table of [
			...REQUIRED_TABLES,
			DEFINITIONS_TABLE,
			DEBUG_REQUESTS_TABLE,
		])
			if (
				foldLegacyRunDefaults(tableSql(db, table)) !==
				tableSql(reference, table)
			)
				throw new WorkflowRuntimeError(
					"unsupported-version",
					`unsupported table definition in ${table}`,
				);
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
		workflow_definitions: {
			digest: "TEXT",
			id: "TEXT",
			version: "INTEGER",
			manifest_json: "TEXT",
			origin_json: "TEXT",
			created_at: "TEXT",
		},
		debug_requests: {
			id: "TEXT",
			workflow_id: "TEXT",
			caller_run_id: "TEXT",
			caller_role: "TEXT",
			goal: "TEXT",
			context: "TEXT",
			apps_json: "TEXT",
			status: "TEXT",
			debug_run_id: "TEXT",
			baseline_ref: "TEXT",
			baseline_files_json: "TEXT",
			report_path: "TEXT",
			changed_files_json: "TEXT",
			created_at: "TEXT",
			finished_at: "TEXT",
			delivered_at: "TEXT",
		},
	};
	for (const [table, expected] of Object.entries(types)) {
		const info = db.query(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
			type: string;
			pk: number;
		}>;
		const actualNames = info.map((column) => column.name);
		const expectedNames = Object.keys(expected);
		if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
			throw new WorkflowRuntimeError(
				"unsupported-version",
				`unsupported column order in ${table}`,
			);
		const actual = new Map(info.map((column) => [column.name, column]));
		for (const [name, type] of Object.entries(expected)) {
			const column = actual.get(name);
			if (!column || column.type.toUpperCase() !== type)
				throw new WorkflowRuntimeError(
					"unsupported-version",
					`unsupported column definition: ${table}.${name}`,
				);
		}
		if (actual.size !== Object.keys(expected).length)
			throw new WorkflowRuntimeError(
				"unsupported-version",
				`unsupported columns in ${table}`,
			);
	}
	const primaryKeys = [
		["workflow_instances", "id"],
		["workflow_runs", "id"],
		["workflow_events", "workflow_id", "revision"],
		["workflow_outbox", "id"],
		["workflow_security_audit", "id"],
		["workflow_migration_diagnostics", "change_id"],
		["workflow_definitions", "digest"],
		["debug_requests", "id"],
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
				"unsupported-version",
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
		workflow_definitions: [/CHECK\s*\(VERSION\s*=\s*1\)/],
		debug_requests: [
			/CHECK\s*\(STATUS\s+IN\s*\('QUEUED','RUNNING','DONE','FAILED','CANCELLED'\)\)/,
		],
	};
	for (const [table, rules] of Object.entries(signatures)) {
		if (rules.some((rule) => !rule.test(tableSql(db, table))))
			throw new WorkflowRuntimeError(
				"unsupported-version",
				`unsupported constraints in ${table}`,
			);
	}
	for (const table of ["workflow_runs", "workflow_events", "workflow_outbox"]) {
		const foreignKeys = db
			.query(`PRAGMA foreign_key_list(${table})`)
			.all() as Array<{ from: string; table: string; to: string }>;
		if (
			!foreignKeys.some(
				(key) =>
					key.from === "workflow_id" &&
					key.to === "id" &&
					key.table === "workflow_instances",
			)
		)
			throw new WorkflowRuntimeError(
				"unsupported-version",
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
	] as ReadonlyArray<readonly [string, string, readonly string[]]>) {
		const indexes = db.query(`PRAGMA index_list(${table})`).all() as Array<{
			name: string;
		}>;
		if (!indexes.some((item) => item.name === index))
			throw new WorkflowRuntimeError(
				"unsupported-version",
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
				"unsupported-version",
				`unsupported index columns in ${table}`,
			);
	}
}
function foreignKeyCheck(db: Database): void {
	const invalid = db.query("PRAGMA foreign_key_check").all();
	if (invalid.length)
		throw new WorkflowRuntimeError(
			"unsupported-version",
			`foreign-key check failed (${invalid.length} invalid references)`,
		);
}

/** The one refusal every store this build cannot read produces, raised before
 * any DDL, transaction or row write. */
export function unsupportedStoreVersion(version: number): WorkflowRuntimeError {
	return new WorkflowRuntimeError(
		"unsupported-version",
		`unsupported workflow store version ${version}; this build only reads version ${STORE_SCHEMA_VERSION}`,
	);
}

/** The persisted `PRAGMA user_version`, read straight from the SQLite file
 * header so a store this build refuses is never opened — and therefore never
 * mutated. `undefined` means the file is absent or too small to carry a
 * version. */
function fileVersion(file: string): number | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const header = Buffer.alloc(4);
		return fs.readSync(fd, header, 0, 4, 60) === 4
			? header.readUInt32BE(0)
			: undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Whether an existing file carries any schema at all, read without opening it
 * for writing: a genuinely empty file is initialized, a file with tables is a
 * store this build did not write. */
function fileHasSchema(file: string): boolean {
	const db = new Database(file, { readonly: true });
	try {
		return tableNames(db).size > 0;
	} finally {
		db.close();
	}
}

export function initializeStore(repo: string): void {
	const file = canonicalStorePath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const persisted = fileVersion(file);
	if (
		persisted !== undefined &&
		persisted !== 0 &&
		persisted !== STORE_SCHEMA_VERSION
	)
		throw unsupportedStoreVersion(persisted);
	// A store written without a version is not this build's format either: it
	// is refused rather than classified and adopted. A probe that cannot read
	// the schema at all (a WAL store without a writable `-shm`, a non-SQLite
	// file, or a concurrent writer holding the lock) is not a genuinely empty
	// store, so it is refused with the same one message instead of surfacing
	// SQLite's error.
	if (persisted === 0) {
		let empty = false;
		try {
			empty = !fileHasSchema(file);
		} catch {
			empty = false;
		}
		if (!empty) throw unsupportedStoreVersion(0);
	}
	const db = guardedDatabase(repo, file, { create: true });
	db.exec("PRAGMA busy_timeout=10000");
	try {
		verifyCanonicalStorePath(repo, file);
		for (;;) {
			const observed = pragmaVersion(db);
			if (observed === STORE_SCHEMA_VERSION) {
				validateCanonicalShape(db);
				foreignKeyCheck(db);
				return;
			}
			if (observed !== 0) throw unsupportedStoreVersion(observed);
			db.exec("BEGIN IMMEDIATE");
			try {
				const locked = pragmaVersion(db);
				if (locked !== 0) {
					db.exec("COMMIT");
					continue;
				}
				// Re-check under the writer lock: two initializers can both read
				// version 0 before either commits, and the loser must not overwrite
				// the winner's schema.
				if (tableNames(db).size > 0) throw unsupportedStoreVersion(0);
				db.exec(SCHEMA_DDL);
				setPragmaVersion(db, STORE_SCHEMA_VERSION);
				foreignKeyCheck(db);
				db.exec("COMMIT");
			} catch (error) {
				rollback(db);
				throw error;
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
			"not-found",
			"workflow store is absent; initialize the store before writing",
		);
	const db = guardedDatabase(repo, file, { readonly });
	db.exec("PRAGMA busy_timeout=10000");
	if (!readonly) db.exec("PRAGMA foreign_keys=ON");
	try {
		verifyCanonicalStorePath(repo, file);
		const version = pragmaVersion(db);
		if (version !== STORE_SCHEMA_VERSION)
			throw unsupportedStoreVersion(version);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function openStore(repo: string): Database {
	return openStoreWithMode(repo, false);
}

/** The ids of every workflow the store still knows, read without creating,
 * locking or converting storage. `undefined` means the store could not be read
 * at all, so a caller that sweeps state by workflow id must not conclude that
 * nothing is known. */
export function knownWorkflowIds(repo: string): Set<string> | undefined {
	if (!fs.existsSync(canonicalStorePath(repo))) return new Set();
	let db: Database | undefined;
	try {
		db = openReadStore(repo);
		const rows = db
			.query<{ id: string }, []>("SELECT id FROM workflow_instances")
			.all();
		return new Set(rows.map((row) => row.id));
	} catch {
		return undefined;
	} finally {
		try {
			db?.close();
		} catch {
			// A store that cannot be closed still answered.
		}
	}
}

/** Open a validated store without taking SQLite's writer lock or running any
 * schema/import work. Observation must use this boundary. */
export function openReadStore(repo: string): Database {
	return openStoreWithMode(repo, true);
}

export interface ObservedStore {
	version: number;
}
/** The store file's persisted version without opening it: an observation never
 * creates, locks or converts storage. */
export function observedStore(repo: string): ObservedStore | undefined {
	const file = canonicalStorePath(repo);
	if (!fs.existsSync(file)) return undefined;
	return { version: fileVersion(file) ?? 0 };
}

// Lease heartbeats run frequently while an effect is active. Reuse the
// already-initialized store schema without repeating openStore's schema/import
// work on every heartbeat.
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
		// A run persisted before the multiplexer removal pins a retired runtime;
		// normalize it on read so the run still loads and resumes on the durable
		// host.
		profile: {
			...JSON.parse(row.profile_json),
			runtime: normalizeRuntimeId(
				(JSON.parse(row.profile_json) as { runtime?: unknown }).runtime,
			),
		},
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
		...(row.handle_json
			? {
					handle: {
						...JSON.parse(row.handle_json),
						runtime: normalizeRuntimeId(
							(JSON.parse(row.handle_json) as { runtime?: unknown }).runtime,
						),
					},
				}
			: {}),
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

export interface DefinitionRow {
	digest: string;
	id: string;
	version: number;
	manifest_json: string;
	origin_json: string;
	created_at: string;
}
/** The stored custom definition for an identity, or undefined. Identity is
 * content-addressed, so at most one row can match. */
export function storedDefinition(
	db: Database,
	id: string,
	version: number,
): DefinitionRow | undefined {
	return (
		(db
			.query("SELECT * FROM workflow_definitions WHERE id=? AND version=?")
			.get(id, version) as DefinitionRow | null) ?? undefined
	);
}
/** Insert a definition, or return the identical row another definition already
 * stored: identical manifests share one content-addressed identity, so storing
 * the same manifest twice must not fail on the unique key. The check and the
 * insert share one writer transaction, so two concurrent `define` runs
 * converge on one row instead of racing the unique constraint. A row under the
 * same identifier with a different digest, or under the same digest with a
 * different identifier or version, is a collision and fails closed. */
export function insertDefinition(db: Database, row: DefinitionRow): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const existing = db
			.query(
				"SELECT id,digest,version FROM workflow_definitions WHERE id=? OR digest=?",
			)
			.get(row.id, row.digest) as {
			id: string;
			digest: string;
			version: number;
		} | null;
		if (existing) {
			if (
				existing.id !== row.id ||
				existing.digest !== row.digest ||
				existing.version !== row.version
			)
				throw new WorkflowRuntimeError(
					"pin-mismatch",
					`workflow definition identity collision: ${row.id}`,
				);
			db.exec("COMMIT");
			return;
		}
		db.query("INSERT INTO workflow_definitions VALUES (?,?,?,?,?,?)").run(
			row.digest,
			row.id,
			row.version,
			row.manifest_json,
			row.origin_json,
			row.created_at,
		);
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		throw error;
	}
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

/** Delete one workflow and every row that belongs to it, children first so the
 * foreign keys never see a dangling reference. Returns the number of instances
 * removed: 0 means the workflow was already gone, which a caller reports as
 * not-found instead of silently succeeding. The migration-diagnostics table is
 * keyed by change id and describes no current workflow, so it is left alone. */
export function deleteWorkflowRows(db: Database, id: string): number {
	db.query("DELETE FROM workflow_events WHERE workflow_id=?").run(id);
	db.query("DELETE FROM workflow_runs WHERE workflow_id=?").run(id);
	db.query("DELETE FROM debug_requests WHERE workflow_id=?").run(id);
	db.query("DELETE FROM workflow_outbox WHERE workflow_id=?").run(id);
	db.query("DELETE FROM workflow_security_audit WHERE workflow_id=?").run(id);
	return Number(
		db.query("DELETE FROM workflow_instances WHERE id=?").run(id).changes,
	);
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
export function effectOwnsLease(
	repo: string,
	effectId: string,
	lease: string,
): boolean {
	const db = openLeaseStore(repo);
	try {
		return Boolean(
			db
				.query(
					"SELECT 1 FROM workflow_outbox WHERE id=? AND status='running' AND lease=?",
				)
				.get(effectId, lease),
		);
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
					"SELECT 1 FROM workflow_outbox WHERE id=? AND status='running' AND lease=? AND lease_expires_at>? AND COALESCE(json_extract(payload_json,'$.cancelRequested'),0)<>1",
				)
				.get(effectId, lease, nowIso(now)),
		);
	} finally {
		db.close();
	}
}

export function acknowledgeCancelledEffect(
	repo: string,
	effectId: string,
	lease: string,
): void {
	const db = openLeaseStore(repo);
	try {
		db.query(
			"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND lease=? AND COALESCE(json_extract(payload_json,'$.cancelRequested'),0)=1",
		).run(effectId, lease);
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
				"UPDATE workflow_outbox SET lease_expires_at=? WHERE id=? AND status='running' AND lease=? AND lease_expires_at>? AND COALESCE(json_extract(payload_json,'$.cancelRequested'),0)<>1",
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
				traits: effectiveFamilyTraits(definition),
			}) ?? []
	);
}
/** Whether a run is a workflow's delegated debug side run
 * (add-debug-subagent-requests). Such a run is created beside the caller's
 * step: it runs the `debug` family's investigation step under the `debug`
 * role, is deliberately **not** part of `snapshot.step.activeRunIds`, and never
 * advances the caller's step. The routing, active-run and handoff invariants
 * below are the step machinery's, so they do not apply to it.
 *
 * The definition is what tells the two apart: a `debug` workflow's own
 * investigation run executes a `debug.investigate` step its definition
 * declares, while a delegated side run executes that step for a definition that
 * does not declare it at all. */
export function isDebugSideRun(
	run: { stepId: string; role: string },
	definition: { steps: readonly string[] },
): boolean {
	return (
		run.role === DEBUG_ROLE &&
		run.stepId === DEBUG_INVESTIGATE_STEP &&
		!definition.steps.includes(run.stepId)
	);
}

/** The two lifecycle effects a debug request emits. They are enqueued by the
 * CLI command and by the delegated run's handoff at whatever step the caller
 * workflow happens to be in, exactly like `environment.teardown`. */
export function isDebugRequestEffect(kind: string): boolean {
	return kind === "debug.request.run" || kind === "debug.request.deliver";
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
		// A preset switch intentionally changes the profile for future runs. Old
		// completed/expired runs retain their original profile as historical
		// evidence; only runs that can still execute must match current routing.
		if (!ACTIVE_RUN.has(run.status)) continue;
		// A delegated debug side run is not routed by the caller's step table: it
		// runs a foreign step (debug.investigate) under its own role.
		if (isDebugSideRun(run, definition)) continue;
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
			// Its own code, so the claim path can park the owning workflow instead of
			// failing the whole store read (`add-environment-setup-workflow`).
			"unknown-effect-kind",
			`unknown effect kind: ${row.kind}`,
		);
	const payload = JSON.parse(row.payload_json) as {
		runId?: unknown;
		questionId?: unknown;
		cancelRequested?: unknown;
		debugRequestId?: unknown;
	};
	const allowed = registry
		.stepForDefinition(definition, snapshot.currentStep)
		.allowedEffects.includes(row.kind);
	// An edge effect is enqueued while advancing into its destination step, so
	// it stays pending at that step and nowhere else. Judging it only by the
	// step's `allowedEffects` would reject the promotion edges that deliberately
	// enqueue into a step whose contract they do not broaden — the wiki approval
	// promotion into delivery/completion, and, with per-step routing, into the
	// routing step that now precedes archive. A row is therefore also legal at
	// the current step when one of that step's own inbound edges declares it.
	const declaredInbound = definition.edges.some(
		(edge) =>
			edge.to === snapshot.currentStep &&
			(edge.effects ?? []).some((effect) => effect.kind === row.kind),
	);
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
	// Two lifecycle effects are enqueued outside the contract of whatever step the
	// workflow happens to be in. `agent.stop` retires an obsolete launch; the
	// owner-bound `environment.teardown` is emitted when the workflow is closed
	// and when it is deleted, and a delete can land at any step. Judging either by
	// the current step's `allowedEffects` would refuse the row — and, at claim
	// time, break the drain of the whole store rather than the one effect.
	const stepIndependent =
		row.kind === "agent.stop" ||
		row.kind === "environment.teardown" ||
		// The env-setup family's close removes its staged configuration root: a
		// complete copy of the live configuration that must not outlive the
		// workflow that owns it.
		row.kind === "environment.setup-cleanup" ||
		// The debug-request lifecycle is emitted by the CLI and by the delegated
		// run's own handoff, neither of which moves the caller's step.
		isDebugRequestEffect(row.kind);
	if (
		!allowed &&
		!declaredInbound &&
		!setupBeforeEntry &&
		!researchSetup &&
		!stepIndependent
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
		const cancelledLaunch =
			row.kind === "agent.launch" && payload.cancelRequested === true;
		// A delegated debug side run addresses a run that is deliberately outside
		// the caller's step machinery, so the active-run/current-step invariants
		// are the wrong question for it; the run's own existence and status are.
		const debugSideRun =
			row.kind === "agent.launch" &&
			Boolean(run && isDebugSideRun(run, definition)) &&
			payload.debugRequestId !== undefined;
		if (
			!run ||
			(!consultTarget &&
				!cancelledLaunch &&
				!debugSideRun &&
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
	/** Resolve a pinned definition by identity. Injected rather than imported so
	 * `store.ts` stays at the bottom of the runtime dependency graph (the
	 * resolver itself reads this module), while a caller holding the store still
	 * resolves through the one definition resolver
	 * (persist-custom-workflow-definitions). */
	resolve: (
		id: string,
		version: number,
		expectedDigest?: string,
	) => Readonly<CompiledWorkflowDefinition>,
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
		const definition = resolve(
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
