// Bun-owned environment state store: `$DEVENV_HOME/db/state.db`.
//
// Ported from `server/pkg/state/store.go` (`port-project-catalog-and-state-to-bun`,
// tasks 2.3-2.6). The on-disk schema, identity semantics, history ordering,
// retention and lease persistence are preserved exactly. A genuinely empty
// database is created directly with the current DDL in one immediate
// transaction; any other persisted version is refused before the journal mode,
// schema or rows are touched, and there is no upgrade step.
//
// The workflow (`herdr.db`) and telemetry databases are separate domains and
// are never opened here.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 9;

/** Statuses that hold an app's slot: the app runs, starts, stops or cannot be
 * observed, so no other owner may start it. A unique partial index on `app`
 * enforces at most one such row per app. */
export const ACTIVE_INSTANCE_STATUSES = [
	"starting",
	"running",
	"stopping",
	"unknown",
] as const;

/** Statuses that release an app's slot. `failed` is terminal-and-unowned (v8
 * treats it as re-claimable), `released-by-developer` is the notice the force
 * release leaves for the holder's next call, and `superseded` is the honest
 * status the v9 collapse gives a parallel-era row it could not observe: the row
 * no longer holds the slot, but nothing claims its run is gone. */
export const INACTIVE_INSTANCE_STATUSES = [
	"stopped",
	"failed",
	"released-by-developer",
	"superseded",
] as const;

const ACTIVE_STATUS_SQL = ACTIVE_INSTANCE_STATUSES.map(
	(status) => `'${status}'`,
).join(", ");
const INACTIVE_STATUS_SQL = INACTIVE_INSTANCE_STATUSES.map(
	(status) => `'${status}'`,
).join(", ");

export class EnvironmentStateError extends Error {
	readonly code: string = "environment-state";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "EnvironmentStateError";
	}
}

/** The database is unreadable for the operation asked of it: missing for a
 * read-only open, or older than the current schema. */
export class EnvironmentStateReadOnlyError extends EnvironmentStateError {
	override readonly code: string = "environment-state-read-only";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "EnvironmentStateReadOnlyError";
	}
}

/** Fail-closed: a database written by a newer release is never touched. */
export class EnvironmentStateVersionError extends EnvironmentStateError {
	override readonly code: string = "environment-state-version";
	readonly foundVersion: number;
	constructor(foundVersion: number, message: string) {
		super(message);
		this.name = "EnvironmentStateVersionError";
		this.foundVersion = foundVersion;
	}
}

export interface AppState {
	ident: string;
	branch: string;
	activeWorktree: string;
	mainWorktreeBranch: string;
}

export interface AppRunTargetInfo {
	runtime: string;
	launchMode: string;
	label: string;
	profile: string;
	targetId: string;
	sourcePath: string;
	startedAt: string;
	display: string;
}

export interface DependencyLease {
	targetId: string;
	ownerRunId: string;
	ownerApp: string;
	lifecycle: string;
	updatedAt: string;
}

export interface EnvironmentInstanceRecord {
	id: string;
	owner: string;
	app: string;
	targetId: string;
	runtime: string;
	checkoutPath: string;
	configOverlay?: string;
	imageTag: string;
	status: string;
	createdAt: string;
	lastActivityAt: string;
}

interface EnvironmentInstanceDbRow {
	id: string;
	owner: string;
	app: string;
	target_id: string;
	runtime: string;
	checkout_path: string;
	config_overlay: string | null;
	image_tag: string;
	status: string;
	created_at: string;
	last_activity_at: string;
}

const ENVIRONMENT_INSTANCE_COLUMNS =
	"id, owner, app, target_id, runtime, checkout_path, config_overlay, image_tag, status, created_at, last_activity_at";

function mapEnvironmentInstanceRow(
	row: EnvironmentInstanceDbRow | null,
): EnvironmentInstanceRecord | undefined {
	if (!row) return undefined;
	return {
		id: row.id,
		owner: row.owner,
		app: row.app,
		targetId: row.target_id,
		runtime: row.runtime,
		checkoutPath: row.checkout_path,
		...(row.config_overlay === null
			? {}
			: { configOverlay: row.config_overlay }),
		imageTag: row.image_tag,
		status: row.status,
		createdAt: row.created_at,
		lastActivityAt: row.last_activity_at,
	};
}

/** Timestamp format Go writes for `since`/`before` comparisons. */
export function actionEventTimestamp(at: Date): string {
	return `${at.toISOString().slice(0, 23)}Z`;
}

// ---- Current schema ----
//
// The one schema this build writes. A genuinely empty database is created
// directly with it; an existing database is opened only when it already
// carries this version, so no historical step is ever replayed.

const CURRENT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
CREATE TABLE action_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_json TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				);
CREATE TABLE action_log_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL,
					step_id TEXT NOT NULL,
					event_json TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				);
CREATE TABLE app_state (
					ident           TEXT PRIMARY KEY,
					branch          TEXT NOT NULL DEFAULT '',
					active_worktree TEXT NOT NULL DEFAULT '',
					updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
				, main_worktree_branch TEXT NOT NULL DEFAULT '', run_target_runtime TEXT NOT NULL DEFAULT '', run_target_launch_mode TEXT NOT NULL DEFAULT '', run_target_label TEXT NOT NULL DEFAULT '', run_target_profile TEXT NOT NULL DEFAULT '', run_target_id TEXT NOT NULL DEFAULT '', run_target_source_path TEXT NOT NULL DEFAULT '', run_target_started_at TEXT NOT NULL DEFAULT '', run_target_display TEXT NOT NULL DEFAULT '');
CREATE TABLE dependency_leases (target_id TEXT NOT NULL, owner_run_id TEXT NOT NULL, owner_app TEXT NOT NULL, lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(target_id, owner_run_id));
CREATE TABLE env_instances (
					id TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					app TEXT NOT NULL,
					target_id TEXT NOT NULL,
					runtime TEXT NOT NULL,
					checkout_path TEXT NOT NULL,
					config_overlay TEXT,
					image_tag TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_activity_at TEXT NOT NULL,
					UNIQUE(owner, app)
				);
CREATE TABLE script_args_history (
					id                   INTEGER PRIMARY KEY AUTOINCREMENT,
					script_relative_path TEXT NOT NULL,
					args_json            TEXT NOT NULL,
					created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
				);
CREATE INDEX idx_action_events_id ON action_events(id);
CREATE INDEX idx_action_log_events_run_step_id ON action_log_events(run_id, step_id, id);
CREATE UNIQUE INDEX idx_env_instances_active_app
				 ON env_instances(app)
				 WHERE status IN ('starting', 'running', 'stopping', 'unknown');
CREATE INDEX idx_script_args_history_path_id
				ON script_args_history(script_relative_path, id DESC);
`;

/** Whether a database carries no schema at all: an empty file, or one written
 * before this build ever versioned it. */
function isEmptyDatabase(db: Database): boolean {
	const tables = db
		.query(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
		)
		.all() as Array<{ name: string }>;
	return tables.length === 0;
}

/** The persisted schema version read through a read-only handle, or `undefined`
 * when the file is absent or cannot be read read-only (a WAL store without a
 * writable `-shm`). The caller then opens for writing and applies the same
 * guard before any write. */
function probeSchemaVersion(dbPath: string): number | undefined {
	if (!fs.existsSync(dbPath)) return undefined;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		return readSchemaVersion(db);
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

function readSchemaVersion(db: Database): number {
	try {
		const row = db
			.query(`SELECT value FROM schema_meta WHERE key = 'version'`)
			.get() as { value?: string } | null;
		if (!row?.value) return 0;
		const parsed = Number.parseInt(row.value, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	} catch {
		return 0;
	}
}

function integrityCheck(db: Database, dbPath: string): void {
	const rows = db.query(`PRAGMA integrity_check`).all() as Array<{
		integrity_check?: string;
	}>;
	const result = rows.map((row) => row.integrity_check ?? "").join(",");
	if (result !== "ok")
		throw new EnvironmentStateError(
			`state: integrity check failed for ${dbPath}: ${result}; this build cannot repair it, restore the state database from a backup`,
		);
}

export class EnvironmentStateStore {
	private readonly db: Database;
	private readonly dbPath: string;
	readonly schemaVersion: number;
	readonly readOnly: boolean;

	private constructor(
		db: Database,
		dbPath: string,
		schemaVersion: number,
		readOnly: boolean,
	) {
		this.db = db;
		this.dbPath = dbPath;
		this.schemaVersion = schemaVersion;
		this.readOnly = readOnly;
	}

	/**
	 * Open (creating if needed) `dbDir/state.db` at the current schema version.
	 * A genuinely empty database is created directly with the current DDL inside
	 * one `BEGIN IMMEDIATE` transaction, so two runtimes racing a first creation
	 * serialize on the SQLite write lock and the loser adopts the committed
	 * schema instead of recreating it. Any other persisted version is refused
	 * before the journal mode, schema or rows are touched.
	 */
	static open(dbDir: string): EnvironmentStateStore {
		const dbPath = path.join(dbDir, "state.db");
		try {
			fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
		} catch (error) {
			throw new EnvironmentStateError(
				`state: failed to create db directory ${JSON.stringify(dbDir)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		// Probe the persisted version through a read-only handle first, so a
		// database this build refuses is never opened for writing: a read-write
		// open would let SQLite run hot-journal rollback or WAL recovery on it. A
		// probe that cannot read the file (absent, or a store whose journal
		// sidecars are not reachable read-only) falls through to the read-write
		// open, which applies the same guard before any write.
		const probed = probeSchemaVersion(dbPath);
		if (probed !== undefined && probed !== 0 && probed !== SCHEMA_VERSION)
			throw new EnvironmentStateVersionError(
				probed,
				`state: database schema ${probed} is not the supported ${SCHEMA_VERSION}; refusing to modify it`,
			);
		let db: Database | undefined;
		try {
			db = new Database(dbPath, { create: true, readwrite: true });
		} catch (error) {
			throw new EnvironmentStateError(
				`state: failed to open database ${JSON.stringify(dbPath)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		try {
			// These pragmas are connection-local, so the newer-schema guard below
			// remains byte-preserving for databases this binary cannot read.
			db.exec("PRAGMA foreign_keys=ON");
			db.exec("PRAGMA busy_timeout=5000");
		} catch (error) {
			db.close();
			throw new EnvironmentStateError(
				`state: failed to configure database: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		// Read before any write: the version guard is byte-preserving for a
		// database this build cannot read.
		let initial: number;
		let empty: boolean;
		try {
			initial = readSchemaVersion(db);
			empty = initial === 0 && isEmptyDatabase(db);
		} catch (error) {
			db.close();
			throw new EnvironmentStateError(
				`state: failed to read database schema ${JSON.stringify(dbPath)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
		if (initial !== 0 && initial !== SCHEMA_VERSION) {
			db.close();
			throw new EnvironmentStateVersionError(
				initial,
				`state: database schema ${initial} is not the supported ${SCHEMA_VERSION}; refusing to modify it`,
			);
		}
		if (initial === 0 && !empty) {
			db.close();
			throw new EnvironmentStateVersionError(
				0,
				"state: database has no schema version and is not empty; refusing to modify it",
			);
		}
		try {
			db.exec("PRAGMA journal_mode=WAL");
		} catch (error) {
			db.close();
			throw new EnvironmentStateError(
				`state: failed to configure database journal: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (initial === 0) {
			try {
				db.exec("BEGIN IMMEDIATE");
				// Re-read under the writer lock: another runtime may have created
				// the schema while this one was waiting.
				if (readSchemaVersion(db) === 0) {
					db.exec(CURRENT_SCHEMA_DDL);
					db.prepare(
						`INSERT INTO schema_meta (key, value) VALUES ('version', ?)
						 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
					).run(String(SCHEMA_VERSION));
				}
				db.exec("COMMIT");
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				db.close();
				throw error instanceof EnvironmentStateError
					? error
					: new EnvironmentStateError(
							`state: schema creation failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
			}
		}
		integrityCheck(db, dbPath);
		return new EnvironmentStateStore(db, dbPath, SCHEMA_VERSION, false);
	}

	/**
	 * Open an existing database read-only without creating, migrating or
	 * writing it: the bounded catalog/observation path must never mutate the
	 * environment. WAL-aware (unlike `immutable=1`), pinned with `query_only`.
	 */
	static openReadOnly(dbDir: string): EnvironmentStateStore {
		const dbPath = path.join(dbDir, "state.db");
		if (!fs.existsSync(dbPath))
			throw new EnvironmentStateReadOnlyError(
				`state: read-only observation requires an existing database at ${dbPath}`,
			);
		let db: Database;
		try {
			db = new Database(dbPath, { readonly: true });
		} catch (error) {
			throw new EnvironmentStateReadOnlyError(
				`state: failed to open database read-only ${JSON.stringify(dbPath)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
		db.exec("PRAGMA query_only=1");
		const version = readSchemaVersion(db);
		if (version !== SCHEMA_VERSION) {
			db.close();
			throw new EnvironmentStateReadOnlyError(
				`state: read-only observation requires the current schema (database schema ${version} is not ${SCHEMA_VERSION})`,
			);
		}
		return new EnvironmentStateStore(db, dbPath, version, true);
	}

	get file(): string {
		return this.dbPath;
	}

	getAppState(ident: string): AppState {
		const state: AppState = {
			ident,
			branch: "",
			activeWorktree: "",
			mainWorktreeBranch: "",
		};
		const row = this.db
			.query(
				`SELECT branch, active_worktree, main_worktree_branch FROM app_state WHERE ident = ?`,
			)
			.get(ident) as {
			branch: string;
			active_worktree: string;
			main_worktree_branch: string;
		} | null;
		if (!row) return state; // no stored state yet is fine
		state.branch = row.branch;
		state.activeWorktree = row.active_worktree;
		state.mainWorktreeBranch = row.main_worktree_branch;
		return state;
	}

	setBranch(ident: string, branch: string): void {
		this.db
			.query(
				`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
				 VALUES (?, ?, '', '')
				 ON CONFLICT(ident) DO UPDATE SET
					branch     = excluded.branch,
					updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.run(ident, branch);
	}

	setActiveWorktree(ident: string, worktree: string): void {
		this.db
			.query(
				`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
				 VALUES (?, '', ?, '')
				 ON CONFLICT(ident) DO UPDATE SET
					active_worktree = excluded.active_worktree,
					updated_at      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.run(ident, worktree);
	}

	setMainWorktreeBranch(ident: string, branch: string): void {
		this.db
			.query(
				`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
				 VALUES (?, '', '', ?)
				 ON CONFLICT(ident) DO UPDATE SET
					main_worktree_branch = excluded.main_worktree_branch,
					updated_at           = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.run(ident, branch);
	}

	setAppState(state: AppState): void {
		this.db
			.query(
				`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(ident) DO UPDATE SET
					branch               = excluded.branch,
					active_worktree      = excluded.active_worktree,
					main_worktree_branch = excluded.main_worktree_branch,
					updated_at           = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.run(
				state.ident,
				state.branch,
				state.activeWorktree,
				state.mainWorktreeBranch,
			);
	}

	getAppRunTargetInfo(ident: string): AppRunTargetInfo | undefined {
		const row = this.db
			.query(
				`SELECT run_target_runtime, run_target_launch_mode, run_target_label, run_target_profile,
				        run_target_id, run_target_source_path, run_target_started_at, run_target_display
				 FROM app_state WHERE ident = ?`,
			)
			.get(ident) as {
			run_target_runtime: string;
			run_target_launch_mode: string;
			run_target_label: string;
			run_target_profile: string;
			run_target_id: string;
			run_target_source_path: string;
			run_target_started_at: string;
			run_target_display: string;
		} | null;
		if (!row || row.run_target_display === "") return undefined;
		return {
			runtime: row.run_target_runtime,
			launchMode: row.run_target_launch_mode,
			label: row.run_target_label,
			profile: row.run_target_profile,
			targetId: row.run_target_id,
			sourcePath: row.run_target_source_path,
			startedAt: row.run_target_started_at,
			display: row.run_target_display,
		};
	}

	setAppRunTargetInfo(ident: string, info: AppRunTargetInfo): void {
		this.db
			.query(
				`INSERT INTO app_state (
					ident, branch, active_worktree, main_worktree_branch,
					run_target_runtime, run_target_launch_mode, run_target_label, run_target_profile,
					run_target_id, run_target_source_path, run_target_started_at, run_target_display
				 )
				 VALUES (?, '', '', '', ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(ident) DO UPDATE SET
					run_target_runtime     = excluded.run_target_runtime,
					run_target_launch_mode = excluded.run_target_launch_mode,
					run_target_label       = excluded.run_target_label,
					run_target_profile     = excluded.run_target_profile,
					run_target_id          = excluded.run_target_id,
					run_target_source_path = excluded.run_target_source_path,
					run_target_started_at  = excluded.run_target_started_at,
					run_target_display     = excluded.run_target_display,
					updated_at             = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.run(
				ident,
				info.runtime,
				info.launchMode,
				info.label,
				info.profile,
				info.targetId,
				info.sourcePath,
				info.startedAt,
				info.display,
			);
	}

	clearAppRunTargetInfo(ident: string): void {
		this.db
			.query(
				`UPDATE app_state SET
					run_target_runtime = '', run_target_launch_mode = '', run_target_label = '',
					run_target_profile = '', run_target_id = '', run_target_source_path = '',
					run_target_started_at = '', run_target_display = '',
					updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
				 WHERE ident = ?`,
			)
			.run(ident);
	}

	getScriptArgsHistory(
		relativePath: string,
		limit = 50,
	): Array<Record<string, string>> {
		const effective = clampLimit(limit, 50, 200);
		const rows = this.db
			.query(
				`SELECT args_json FROM script_args_history
				 WHERE script_relative_path = ?
				 ORDER BY id DESC LIMIT ?`,
			)
			.all(relativePath, effective) as Array<{ args_json: string }>;
		const history: Array<Record<string, string>> = [];
		for (const row of rows) {
			try {
				history.push(JSON.parse(row.args_json) as Record<string, string>);
			} catch {}
		}
		return history;
	}

	addScriptArgsHistory(
		relativePath: string,
		values: Record<string, string>,
		maxEntries = 50,
	): void {
		const effective = clampLimit(maxEntries, 50, 200);
		const payload = JSON.stringify(values);
		this.transaction(() => {
			this.db
				.query(
					`INSERT INTO script_args_history (script_relative_path, args_json) VALUES (?, ?)`,
				)
				.run(relativePath, payload);
			this.db
				.query(
					`DELETE FROM script_args_history
					 WHERE script_relative_path = ?
					   AND id NOT IN (
						SELECT id FROM script_args_history
						WHERE script_relative_path = ?
						ORDER BY id DESC LIMIT ?
					   )`,
				)
				.run(relativePath, relativePath, effective);
		});
	}

	addActionEvent(eventJson: string, maxEntries = 50000): void {
		this.transaction(() => {
			this.db
				.query(`INSERT INTO action_events (event_json) VALUES (?)`)
				.run(eventJson);
			this.expireActionEvents();
			this.db
				.query(
					`DELETE FROM action_events WHERE id NOT IN (SELECT id FROM action_events ORDER BY id DESC LIMIT ?)`,
				)
				.run(maxEntries);
		});
	}

	getActionEvents(limit = 50000): string[] {
		const effective = clampLimit(limit, 50000, 50000);
		this.expireActionEvents();
		return (
			this.db
				.query(
					`SELECT event_json FROM (SELECT id, event_json FROM action_events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
				)
				.all(effective) as Array<{ event_json: string }>
		).map((row) => row.event_json);
	}

	getActionEventsSince(limit: number, since: Date): string[] {
		return this.actionEventsBetween(limit, since, undefined);
	}

	getActionEventsBetween(limit: number, since: Date, before: Date): string[] {
		return this.actionEventsBetween(limit, since, before);
	}

	addActionLogEvent(
		runId: string,
		stepId: string,
		eventJson: string,
		maxEntries = 50000,
	): void {
		this.transaction(() => {
			this.db
				.query(
					`INSERT INTO action_log_events (run_id, step_id, event_json) VALUES (?, ?, ?)`,
				)
				.run(runId, stepId, eventJson);
			this.expireActionLogEvents();
			this.db
				.query(
					`DELETE FROM action_log_events WHERE id NOT IN (SELECT id FROM action_log_events ORDER BY id DESC LIMIT ?)`,
				)
				.run(maxEntries);
		});
	}

	getActionLogEvents(runId: string, stepId: string, limit = 50000): string[] {
		const effective = clampLimit(limit, 50000, 50000);
		this.expireActionLogEvents();
		const rows = stepId
			? (this.db
					.query(
						`SELECT event_json FROM (SELECT id, event_json FROM action_log_events WHERE run_id = ? AND step_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
					)
					.all(runId, stepId, effective) as Array<{ event_json: string }>)
			: (this.db
					.query(
						`SELECT event_json FROM (SELECT id, event_json FROM action_log_events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
					)
					.all(runId, effective) as Array<{ event_json: string }>);
		return rows.map((row) => row.event_json);
	}

	getEnvironmentInstances(): EnvironmentInstanceRecord[] {
		const rows = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances ORDER BY created_at, id`,
			)
			.all() as EnvironmentInstanceDbRow[];
		return rows.map(
			(row) => mapEnvironmentInstanceRow(row) as EnvironmentInstanceRecord,
		);
	}

	/** The active rows: at most one per app, held regardless of owner. */
	getActiveEnvironmentInstances(): EnvironmentInstanceRecord[] {
		const rows = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances WHERE status IN (${ACTIVE_STATUS_SQL}) ORDER BY created_at, id`,
			)
			.all() as EnvironmentInstanceDbRow[];
		return rows.map(
			(row) => mapEnvironmentInstanceRow(row) as EnvironmentInstanceRecord,
		);
	}

	/**
	 * Parallel-era rows the v9 collapse retired without observing them. Only
	 * `reconcile()` may confirm them as stopped.
	 */
	getSupersededEnvironmentInstances(): EnvironmentInstanceRecord[] {
		const rows = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances WHERE status = 'superseded' ORDER BY created_at, id`,
			)
			.all() as EnvironmentInstanceDbRow[];
		return rows.map(
			(row) => mapEnvironmentInstanceRow(row) as EnvironmentInstanceRecord,
		);
	}

	/** The row that holds `app`, whichever owner it belongs to. */
	findActiveEnvironmentInstance(
		app: string,
	): EnvironmentInstanceRecord | undefined {
		const row = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances WHERE app = ? AND status IN (${ACTIVE_STATUS_SQL}) ORDER BY created_at, id LIMIT 1`,
			)
			.get(app) as EnvironmentInstanceDbRow | null;
		return mapEnvironmentInstanceRow(row);
	}

	getEnvironmentInstance(id: string): EnvironmentInstanceRecord | undefined {
		const row = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances WHERE id = ?`,
			)
			.get(id) as EnvironmentInstanceDbRow | null;
		return mapEnvironmentInstanceRow(row);
	}

	findEnvironmentInstance(
		owner: string,
		app: string,
	): EnvironmentInstanceRecord | undefined {
		const row = this.db
			.query(
				`SELECT ${ENVIRONMENT_INSTANCE_COLUMNS} FROM env_instances WHERE owner = ? AND app = ?`,
			)
			.get(owner, app) as EnvironmentInstanceDbRow | null;
		return mapEnvironmentInstanceRow(row);
	}

	claimEnvironmentInstance(
		instance: EnvironmentInstanceRecord,
	): string | undefined {
		let claimedId: string | undefined;
		this.transaction(() => {
			const inserted = this.db
				.prepare(
					`INSERT OR IGNORE INTO env_instances (id, owner, app, target_id, runtime, checkout_path, config_overlay, image_tag, status, created_at, last_activity_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					instance.id,
					instance.owner,
					instance.app,
					instance.targetId,
					instance.runtime,
					instance.checkoutPath,
					instance.configOverlay ?? null,
					instance.imageTag,
					instance.status,
					instance.createdAt,
					instance.lastActivityAt,
				);
			if (inserted.changes > 0) {
				claimedId = instance.id;
				return;
			}
			const updated = this.db
				.prepare(
					`UPDATE env_instances SET target_id=?, runtime=?, checkout_path=?, config_overlay=?, image_tag=?, status=?, last_activity_at=?
				 WHERE owner=? AND app=? AND status IN (${INACTIVE_STATUS_SQL})`,
				)
				.run(
					instance.targetId,
					instance.runtime,
					instance.checkoutPath,
					instance.configOverlay ?? null,
					instance.imageTag,
					instance.status,
					instance.lastActivityAt,
					instance.owner,
					instance.app,
				);
			if (updated.changes > 0) {
				const row = this.db
					.query(`SELECT id FROM env_instances WHERE owner = ? AND app = ?`)
					.get(instance.owner, instance.app) as { id: string } | null;
				claimedId = row?.id;
			}
		});
		return claimedId;
	}

	setEnvironmentInstance(instance: EnvironmentInstanceRecord): void {
		try {
			this.db
				.prepare(
					`INSERT INTO env_instances (id, owner, app, target_id, runtime, checkout_path, config_overlay, image_tag, status, created_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(owner, app) DO UPDATE SET target_id=excluded.target_id, runtime=excluded.runtime,
			 checkout_path=excluded.checkout_path, config_overlay=excluded.config_overlay,
			 image_tag=excluded.image_tag, status=excluded.status, last_activity_at=excluded.last_activity_at`,
				)
				.run(
					instance.id,
					instance.owner,
					instance.app,
					instance.targetId,
					instance.runtime,
					instance.checkoutPath,
					instance.configOverlay ?? null,
					instance.imageTag,
					instance.status,
					instance.createdAt,
					instance.lastActivityAt,
				);
		} catch (error) {
			throw new EnvironmentStateError(
				`state: failed to upsert environment instance ${JSON.stringify(instance.owner)}/${JSON.stringify(instance.app)}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	claimEnvironmentInstanceStop(id: string, at: string): boolean {
		const result = this.db
			.query(
				`UPDATE env_instances SET status = 'stopping', last_activity_at = ? WHERE id = ? AND status IN ('running', 'unknown', 'failed')`,
			)
			.run(at, id);
		return result.changes > 0;
	}

	compareAndSetEnvironmentInstanceStatus(
		id: string,
		expectedStatus: string,
		status: string,
		at: string,
	): boolean {
		const result = this.db
			.query(
				`UPDATE env_instances SET status = ?, last_activity_at = ? WHERE id = ? AND status = ?`,
			)
			.run(status, at, id, expectedStatus);
		return result.changes > 0;
	}

	transitionEnvironmentInstanceStatus(
		id: string,
		expectedStatus: string,
		status: string,
		at: string,
	): boolean {
		const result = this.db
			.query(
				`UPDATE env_instances SET status = ?, last_activity_at = ? WHERE id = ? AND status = ?`,
			)
			.run(status, at, id, expectedStatus);
		return result.changes > 0;
	}

	updateEnvironmentInstanceStatus(
		id: string,
		status: string,
		at: string,
	): void {
		this.db
			.query(
				`UPDATE env_instances SET status = ?, last_activity_at = ? WHERE id = ?`,
			)
			.run(status, at, id);
	}

	deleteEnvironmentInstanceIfStatus(id: string, status: string): boolean {
		const result = this.db
			.query(`DELETE FROM env_instances WHERE id = ? AND status = ?`)
			.run(id, status);
		return result.changes > 0;
	}

	deleteEnvironmentInstance(id: string): void {
		this.db.query(`DELETE FROM env_instances WHERE id = ?`).run(id);
	}

	getDependencyLeases(): DependencyLease[] {
		const rows = this.db
			.query(
				`SELECT target_id, owner_run_id, owner_app, lifecycle, updated_at FROM dependency_leases`,
			)
			.all() as Array<{
			target_id: string;
			owner_run_id: string;
			owner_app: string;
			lifecycle: string;
			updated_at: string;
		}>;
		return rows.map((row) => ({
			targetId: row.target_id,
			ownerRunId: row.owner_run_id,
			ownerApp: row.owner_app,
			lifecycle: row.lifecycle,
			updatedAt: row.updated_at,
		}));
	}

	setDependencyLease(lease: DependencyLease): void {
		this.db
			.query(
				`INSERT INTO dependency_leases(target_id,owner_run_id,owner_app,lifecycle,updated_at) VALUES(?,?,?,?,?)
				 ON CONFLICT(target_id, owner_run_id) DO UPDATE SET owner_app=excluded.owner_app, lifecycle=excluded.lifecycle, updated_at=excluded.updated_at`,
			)
			.run(
				lease.targetId,
				lease.ownerRunId,
				lease.ownerApp,
				lease.lifecycle,
				lease.updatedAt,
			);
	}

	deleteDependencyLease(targetId: string, ownerRunId: string): void {
		this.db
			.query(
				`DELETE FROM dependency_leases WHERE target_id=? AND owner_run_id=?`,
			)
			.run(targetId, ownerRunId);
	}

	close(): void {
		this.db.close();
	}

	private transaction(work: () => void): void {
		if (this.readOnly)
			throw new EnvironmentStateError("state: this store was opened read-only");
		this.db.exec("BEGIN");
		try {
			work();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error instanceof EnvironmentStateError
				? error
				: new EnvironmentStateError(
						`state: transaction failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
						{ cause: error },
					);
		}
	}

	private actionEventsBetween(
		limit: number,
		since: Date,
		before: Date | undefined,
	): string[] {
		const effective = clampLimit(limit, 50000, 50000);
		this.expireActionEvents();
		let query = `SELECT event_json FROM (SELECT id, event_json FROM action_events WHERE created_at >= ?`;
		const args: Array<string | number> = [actionEventTimestamp(since)];
		if (before) {
			query += ` AND created_at < ?`;
			args.push(actionEventTimestamp(before));
		}
		query += ` ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
		args.push(effective);
		const rows = this.db.query(query).all(...args) as Array<{
			event_json: string;
		}>;
		return rows.map((row) => row.event_json);
	}

	private expireActionEvents(): void {
		this.db.exec(
			`DELETE FROM action_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`,
		);
	}

	private expireActionLogEvents(): void {
		this.db.exec(
			`DELETE FROM action_log_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`,
		);
	}
}

function clampLimit(limit: number, fallback: number, max: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return fallback;
	return Math.min(Math.trunc(limit), max);
}
