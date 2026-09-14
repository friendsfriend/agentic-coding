// Bun-owned environment state store: `$DEVENV_HOME/db/state.db`.
//
// Ported from `server/pkg/state/store.go` (`port-project-catalog-and-state-to-bun`,
// tasks 2.3-2.6). The on-disk schema, identity semantics, history ordering,
// retention and lease persistence are preserved exactly; the whole migration
// runs in one immediate transaction so an interrupted upgrade yields either the
// old committed schema or the new one, never a partial mixture.
//
// The workflow (`herdr.db`) and telemetry databases are separate domains and
// are never opened here.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 7;

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

export interface StoreOptions {
	/** Take a consistent backup before the first write to an older schema.
	 * Disabled only by callers that already hold a verified backup. */
	backup?: boolean;
	/** Overridable for tests that must not depend on the wall clock. */
	now?: () => Date;
}

/** Timestamp format Go writes for `since`/`before` comparisons. */
export function actionEventTimestamp(at: Date): string {
	return `${at.toISOString().slice(0, 23)}Z`;
}

// ---- Migrations ----
//
// The DDL is the historical Go migration sequence verbatim, so a database
// created by any supported Go release continues to migrate identically.

interface Migration {
	version: number;
	apply: (db: Database) => void;
}

function columnExists(db: Database, table: string, column: string): boolean {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
	}>;
	return rows.some((row) => row.name === column);
}

/** `ALTER TABLE ... ADD COLUMN` is only replayed when the column is missing,
 * so a database interrupted between the ALTER statements and the version write
 * still migrates to the current schema instead of failing. */
function addColumnIfMissing(db: Database, column: string): void {
	const name = column.split(" ")[0] ?? "";
	if (columnExists(db, "app_state", name)) return;
	db.exec(`ALTER TABLE app_state ADD COLUMN ${column}`);
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		apply: (db) =>
			db.exec(`
				CREATE TABLE IF NOT EXISTS app_state (
					ident           TEXT PRIMARY KEY,
					branch          TEXT NOT NULL DEFAULT '',
					active_worktree TEXT NOT NULL DEFAULT '',
					updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
				)
			`),
	},
	{
		version: 2,
		apply: (db) =>
			addColumnIfMissing(db, "main_worktree_branch TEXT NOT NULL DEFAULT ''"),
	},
	{
		version: 3,
		apply: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS script_args_history (
					id                   INTEGER PRIMARY KEY AUTOINCREMENT,
					script_relative_path TEXT NOT NULL,
					args_json            TEXT NOT NULL,
					created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
				)
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_script_args_history_path_id
				ON script_args_history(script_relative_path, id DESC)
			`);
		},
	},
	{
		version: 4,
		apply: (db) => {
			for (const column of [
				"run_target_runtime TEXT NOT NULL DEFAULT ''",
				"run_target_launch_mode TEXT NOT NULL DEFAULT ''",
				"run_target_label TEXT NOT NULL DEFAULT ''",
				"run_target_profile TEXT NOT NULL DEFAULT ''",
				"run_target_id TEXT NOT NULL DEFAULT ''",
				"run_target_source_path TEXT NOT NULL DEFAULT ''",
				"run_target_started_at TEXT NOT NULL DEFAULT ''",
				"run_target_display TEXT NOT NULL DEFAULT ''",
			])
				addColumnIfMissing(db, column);
		},
	},
	{
		version: 5,
		apply: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS action_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_json TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				)
			`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_action_events_id ON action_events(id)`,
			);
		},
	},
	{
		version: 6,
		apply: (db) =>
			db.exec(
				`CREATE TABLE IF NOT EXISTS dependency_leases (target_id TEXT NOT NULL, owner_run_id TEXT NOT NULL, owner_app TEXT NOT NULL, lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(target_id, owner_run_id))`,
			),
	},
	{
		version: 7,
		apply: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS action_log_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL,
					step_id TEXT NOT NULL,
					event_json TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
				)
			`);
			db.exec(
				`CREATE INDEX IF NOT EXISTS idx_action_log_events_run_step_id ON action_log_events(run_id, step_id, id)`,
			);
			const rows = db
				.query(
					`SELECT id, event_json, created_at FROM action_events ORDER BY id`,
				)
				.all() as Array<{
				id: number;
				event_json: string;
				created_at: string;
			}>;
			for (const row of rows) {
				let event: {
					type?: string;
					properties?: { runId?: string; stepId?: string };
				};
				try {
					event = JSON.parse(row.event_json) as typeof event;
				} catch {
					continue;
				}
				if (
					(event.type !== "action.command.output" &&
						event.type !== "action.step.output") ||
					!event.properties?.runId ||
					!event.properties.stepId
				)
					continue;
				db.prepare(
					`INSERT INTO action_log_events (run_id, step_id, event_json, created_at) VALUES (?, ?, ?, ?)`,
				).run(
					event.properties.runId,
					event.properties.stepId,
					row.event_json,
					row.created_at,
				);
				db.prepare(`DELETE FROM action_events WHERE id = ?`).run(row.id);
			}
		},
	},
];

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

function ensureSchemaMeta(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
}

function integrityCheck(db: Database): void {
	const rows = db.query(`PRAGMA integrity_check`).all() as Array<{
		integrity_check?: string;
	}>;
	const result = rows.map((row) => row.integrity_check ?? "").join(",");
	if (result !== "ok")
		throw new EnvironmentStateError(
			`state: integrity check failed after migration: ${result}`,
		);
}

/** Path of the verified pre-upgrade backup for `fromVersion`. */
export function backupPathFor(dbPath: string, fromVersion: number): string {
	return `${dbPath}.backup-v${fromVersion}`;
}

export class EnvironmentStateStore {
	private readonly db: Database;
	private readonly dbPath: string;
	readonly schemaVersion: number;
	/** Consistent pre-upgrade backup this open took, when it migrated. */
	readonly backupPath?: string;
	readonly readOnly: boolean;

	private constructor(
		db: Database,
		dbPath: string,
		schemaVersion: number,
		readOnly: boolean,
		backupPath?: string,
	) {
		this.db = db;
		this.dbPath = dbPath;
		this.schemaVersion = schemaVersion;
		this.readOnly = readOnly;
		this.backupPath = backupPath;
	}

	/**
	 * Open (creating if needed) `dbDir/state.db` and migrate it to the current
	 * schema. The migration transaction is `BEGIN IMMEDIATE`, so two runtimes
	 * racing a first upgrade serialize on the SQLite write lock and the second
	 * one re-reads the committed version instead of replaying migrations.
	 */
	static open(
		dbDir: string,
		options: StoreOptions = {},
	): EnvironmentStateStore {
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
		const existed = fs.existsSync(dbPath);
		let db: Database;
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
			db.exec("PRAGMA journal_mode=WAL");
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

		const initial = readSchemaVersion(db);
		if (initial > SCHEMA_VERSION) {
			db.close();
			throw new EnvironmentStateVersionError(
				initial,
				`state: database schema ${initial} is newer than the supported ${SCHEMA_VERSION}; refusing to modify it`,
			);
		}

		let backupPath: string | undefined;
		if (
			initial > 0 &&
			initial < SCHEMA_VERSION &&
			options.backup !== false &&
			existed
		)
			backupPath = takeBackup(db, dbPath, initial);

		if (initial < SCHEMA_VERSION) {
			try {
				migrate(db);
			} catch (error) {
				db.close();
				throw error instanceof EnvironmentStateError
					? error
					: new EnvironmentStateError(
							`state: schema migration failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
			}
		}
		integrityCheck(db);
		return new EnvironmentStateStore(
			db,
			dbPath,
			SCHEMA_VERSION,
			false,
			backupPath,
		);
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
		if (version < SCHEMA_VERSION) {
			db.close();
			throw new EnvironmentStateReadOnlyError(
				`state: read-only observation requires a current schema (database schema ${version} is older than ${SCHEMA_VERSION})`,
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

/** Consistent pre-upgrade backup via `VACUUM INTO` (safe with WAL and other
 * connections, unlike a file copy). Only the first backup for a version is
 * kept, so a repeated interrupted upgrade cannot overwrite a good copy with a
 * half-migrated one. */
function takeBackup(db: Database, dbPath: string, fromVersion: number): string {
	const target = backupPathFor(dbPath, fromVersion);
	if (fs.existsSync(target)) return target;
	db.prepare(`VACUUM INTO ?`).run(target);
	return target;
}

function migrate(db: Database): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		ensureSchemaMeta(db);
		// Re-read inside the write transaction: another runtime may have
		// committed the migration while this one was waiting for the lock.
		const version = readSchemaVersion(db);
		if (version > SCHEMA_VERSION)
			throw new EnvironmentStateVersionError(
				version,
				`state: database schema ${version} is newer than the supported ${SCHEMA_VERSION}; refusing to modify it`,
			);
		for (const migration of MIGRATIONS) {
			if (migration.version <= version) continue;
			migration.apply(db);
		}
		db.prepare(
			`INSERT INTO schema_meta (key, value) VALUES ('version', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(String(SCHEMA_VERSION));
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
