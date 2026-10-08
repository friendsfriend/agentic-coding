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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 8;

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

export interface PortAllocationRecord {
	instanceId: string;
	name: string;
	port: number;
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
	{
		version: 8,
		apply: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS env_instances (
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
				)
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS port_allocations (
					instance_id TEXT NOT NULL REFERENCES env_instances(id) ON DELETE CASCADE,
					name TEXT NOT NULL,
					port INTEGER NOT NULL UNIQUE,
					PRIMARY KEY(instance_id, name)
				)
			`);
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

		const initial = readSchemaVersion(db);
		if (initial > SCHEMA_VERSION) {
			db.close();
			throw new EnvironmentStateVersionError(
				initial,
				`state: database schema ${initial} is newer than the supported ${SCHEMA_VERSION}; refusing to modify it`,
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

		let backupPath: string | undefined;
		if (
			initial > 0 &&
			initial < SCHEMA_VERSION &&
			options.backup !== false &&
			existed
		) {
			try {
				backupPath = takeBackup(db, dbPath, initial);
			} catch (error) {
				// Another opener may have completed this migration after `initial`
				// was read but while VACUUM INTO was producing its backup. In that
				// case there is no v7 migration left for this opener to protect.
				if (readSchemaVersion(db) < SCHEMA_VERSION) {
					db.close();
					throw new EnvironmentStateError(
						`state: failed to write pre-upgrade backup: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
			}
		}

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
				 WHERE owner=? AND app=? AND status IN ('stopped', 'failed')`,
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
		releasePorts: boolean,
	): boolean {
		let changed = false;
		this.transaction(() => {
			const result = this.db
				.query(
					`UPDATE env_instances SET status = ?, last_activity_at = ? WHERE id = ? AND status = ?`,
				)
				.run(status, at, id, expectedStatus);
			changed = result.changes > 0;
			if (changed && releasePorts)
				this.db
					.query(`DELETE FROM port_allocations WHERE instance_id = ?`)
					.run(id);
		});
		return changed;
	}

	releasePortAllocationsIfStatus(instanceId: string, status: string): boolean {
		const result = this.db
			.query(
				`DELETE FROM port_allocations WHERE instance_id = ? AND EXISTS (SELECT 1 FROM env_instances WHERE id = ? AND status = ?)`,
			)
			.run(instanceId, instanceId, status);
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

	getPortAllocations(instanceId?: string): PortAllocationRecord[] {
		const rows =
			instanceId === undefined
				? (this.db
						.query(
							`SELECT instance_id, name, port FROM port_allocations ORDER BY port`,
						)
						.all() as Array<{
						instance_id: string;
						name: string;
						port: number;
					}>)
				: (this.db
						.query(
							`SELECT instance_id, name, port FROM port_allocations WHERE instance_id = ? ORDER BY name`,
						)
						.all(instanceId) as Array<{
						instance_id: string;
						name: string;
						port: number;
					}>);
		return rows.map((row) => ({
			instanceId: row.instance_id,
			name: row.name,
			port: row.port,
		}));
	}

	setPortAllocation(allocation: PortAllocationRecord): boolean {
		try {
			this.db
				.prepare(
					`INSERT INTO port_allocations (instance_id, name, port) VALUES (?, ?, ?)
				 ON CONFLICT(instance_id, name) DO UPDATE SET port=excluded.port`,
				)
				.run(allocation.instanceId, allocation.name, allocation.port);
			return true;
		} catch (error) {
			if (
				error instanceof Error &&
				/UNIQUE constraint failed: port_allocations.port/.test(error.message)
			)
				return false;
			throw new EnvironmentStateError(
				`state: failed to persist port allocation for ${JSON.stringify(allocation.instanceId)}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	deletePortAllocations(instanceId: string): void {
		this.db
			.query(`DELETE FROM port_allocations WHERE instance_id = ?`)
			.run(instanceId);
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

/** Validate the existing backup before advertising or reusing it. */
function verifiedBackup(file: string, fromVersion: number): boolean {
	let backup: Database | undefined;
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		backup = new Database(file, { readonly: true });
		if (readSchemaVersion(backup) !== fromVersion) return false;
		integrityCheck(backup);
		return true;
	} catch {
		return false;
	} finally {
		backup?.close();
	}
}

function removeBlockingBackupDirectory(file: string): void {
	try {
		const stat = fs.lstatSync(file);
		if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmdirSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Consistent pre-upgrade backup via `VACUUM INTO` (safe with WAL and other
 * connections, unlike a file copy). The final name is published only after
 * integrity and schema-version verification, so a crash cannot leave a partial
 * file that a later open mistakes for the rollback copy. */
function takeBackup(db: Database, dbPath: string, fromVersion: number): string {
	const target = backupPathFor(dbPath, fromVersion);
	if (verifiedBackup(target, fromVersion)) return target;
	try {
		const stat = fs.lstatSync(target);
		if (stat.isDirectory() && !stat.isSymbolicLink())
			removeBlockingBackupDirectory(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		db.prepare(`VACUUM INTO ?`).run(temporary);
		if (!verifiedBackup(temporary, fromVersion))
			throw new EnvironmentStateError(
				`state: pre-upgrade backup failed verification for schema ${fromVersion}`,
			);
		fs.renameSync(temporary, target);
		if (!verifiedBackup(target, fromVersion))
			throw new EnvironmentStateError(
				`state: published pre-upgrade backup failed verification for schema ${fromVersion}`,
			);
		return target;
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
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
