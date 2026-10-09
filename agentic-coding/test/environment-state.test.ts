// Bun-owned environment state: cross-runtime fixture compatibility
// (`port-project-catalog-and-state-to-bun`, tasks 1.2, 2.3-2.6, 4.1).
//
// Every fixture under `test/fixtures/environment/<name>/` was created by the
// Go release it is named after (see `server/pkg/state/fixtures_test.go`) and
// comes with the `expected.json` contract the Go writer emitted. Opening a
// fixture with Bun must yield exactly the contents the Go counterpart
// produced, including nullability, ordering, retention and the migration-7
// move of output events.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppRunTargetInfo } from "../src/server/environment/state-store.ts";
import {
	backupPathFor,
	EnvironmentStateError,
	EnvironmentStateReadOnlyError,
	EnvironmentStateStore,
	EnvironmentStateVersionError,
	migrateToVersion,
	SCHEMA_VERSION,
} from "../src/server/environment/state-store.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");

interface FixtureExpectation {
	schemaVersion: number;
	apps: Array<{
		ident: string;
		branch: string;
		activeWorktree: string;
		mainWorktreeBranch: string;
		runTarget: AppRunTargetInfo | null;
	}>;
	scriptHistory: Record<string, Array<Record<string, string>>>;
	actionEvents: string[];
	actionLogEvents: Record<string, string[]>;
	dependencyLeases: Array<{
		targetId: string;
		ownerRunId: string;
		ownerApp: string;
		lifecycle: string;
		updatedAt: string;
	}>;
}

function readExpectation(name: string): FixtureExpectation {
	return JSON.parse(
		fs.readFileSync(path.join(FIXTURES, name, "expected.json"), "utf8"),
	) as FixtureExpectation;
}

function sourceSchemaVersion(name: string): number {
	// The partial-v4 database has no committed schema_meta version, so the
	// migration cannot attribute a versioned backup to it.
	return name === "partial-v4" ? 0 : readExpectation(name).schemaVersion;
}

/** Copy a fixture so the migration under test never rewrites the checked-in
 * database, preserving WAL sidecars when present. */
function copyFixture(name: string): { dir: string; dbPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `env-fixture-${name}-`));
	for (const entry of fs.readdirSync(path.join(FIXTURES, name))) {
		if (entry === "expected.json") continue;
		fs.copyFileSync(path.join(FIXTURES, name, entry), path.join(dir, entry));
	}
	return { dir, dbPath: path.join(dir, "state.db") };
}

/**
 * Shift every stored event/lease timestamp forward so the newest row is "now",
 * preserving the relative offsets ordering and cursor semantics depend on.
 *
 * Action events expire after 24 hours, so a fixture captured on a fixed date
 * would legitimately read as empty today; shifting keeps the captured ordering
 * and nullability contract testable without editing the fixture file itself.
 * Tables a fixture predates are skipped.
 */
function ageEventTimestampsToNow(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		const tableExists = (table: string): boolean =>
			db
				.query(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
				)
				.get(table) !== null;
		const shift = (
			table: string,
			column: string,
			keyColumns: string[],
		): void => {
			if (!tableExists(table)) return;
			const rows = db
				.query(`SELECT ${[...keyColumns, column].join(", ")} FROM ${table}`)
				.all() as Array<Record<string, string>>;
			const stamps = rows
				.map((row) => Date.parse(row[column] ?? ""))
				.filter((value) => Number.isFinite(value));
			if (stamps.length === 0) return;
			// Anchor a minute in the past so "just written" rows stay strictly newer.
			const delta = Date.now() - 60_000 - Math.max(...stamps);
			const update = db.prepare(
				`UPDATE ${table} SET ${column} = ? WHERE ${keyColumns
					.map((name) => `${name} = ?`)
					.join(" AND ")}`,
			);
			for (const row of rows) {
				const parsed = Date.parse(row[column] ?? "");
				if (!Number.isFinite(parsed)) continue;
				update.run(
					`${new Date(parsed + delta).toISOString().slice(0, 23)}Z`,
					...keyColumns.map((name) => row[name]),
				);
			}
		};
		shift("action_events", "created_at", ["id"]);
		shift("action_log_events", "created_at", ["id"]);
	} finally {
		db.close();
	}
}

function readFixtureState(
	store: EnvironmentStateStore,
	expectation: FixtureExpectation,
) {
	const apps = expectation.apps.map((app) => ({
		state: store.getAppState(app.ident),
		runTarget: store.getAppRunTargetInfo(app.ident),
	}));
	const scriptHistory = Object.fromEntries(
		Object.keys(expectation.scriptHistory).map((relativePath) => [
			relativePath,
			store.getScriptArgsHistory(relativePath, 50),
		]),
	);
	const logEvents = Object.fromEntries(
		Object.keys(expectation.actionLogEvents).map((runId) => [
			runId,
			store.getActionLogEvents(runId, "", 50),
		]),
	);
	return {
		schemaVersion: store.schemaVersion,
		apps,
		scriptHistory,
		actionEvents: store.getActionEvents(50),
		actionLogEvents: logEvents,
		dependencyLeases: store
			.getDependencyLeases()
			.sort((left, right) => left.targetId.localeCompare(right.targetId)),
	};
}

const OUTPUT_EVENT_TYPES = new Set([
	"action.command.output",
	"action.step.output",
]);

/** The post-open contract: the fixture's own contract with migration 7 applied,
 * which moves command/step output events into `action_log_events`. */
function postMigrationExpectation(name: string): FixtureExpectation {
	const expectation = readExpectation(name);
	const actionLogEvents: Record<string, string[]> = {
		...expectation.actionLogEvents,
	};
	const actionEvents: string[] = [];
	for (const event of expectation.actionEvents) {
		const parsed = JSON.parse(event) as {
			type?: string;
			properties?: { runId?: string; stepId?: string };
		};
		if (
			!parsed.type ||
			!OUTPUT_EVENT_TYPES.has(parsed.type) ||
			!parsed.properties?.runId ||
			!parsed.properties.stepId
		) {
			actionEvents.push(event);
			continue;
		}
		const runId = parsed.properties.runId;
		actionLogEvents[runId] = [...(actionLogEvents[runId] ?? []), event];
	}
	return {
		...expectation,
		schemaVersion: SCHEMA_VERSION,
		actionEvents,
		actionLogEvents,
	};
}

describe("environment state fixtures", () => {
	for (const name of ["v1", "v3", "v5", "v6", "current", "partial-v4"]) {
		test(`${name}: opening yields the Go migration result`, () => {
			const { dir, dbPath } = copyFixture(name);
			try {
				ageEventTimestampsToNow(dbPath);
				const store = EnvironmentStateStore.open(dir);
				try {
					const expected = postMigrationExpectation(name);
					const actual = readFixtureState(store, expected);
					expect(actual.schemaVersion).toBe(SCHEMA_VERSION);
					expect(
						actual.apps.map((entry) => ({
							ident: entry.state.ident,
							branch: entry.state.branch,
							activeWorktree: entry.state.activeWorktree,
							mainWorktreeBranch: entry.state.mainWorktreeBranch,
							runTarget: entry.runTarget ?? null,
						})),
					).toEqual(expected.apps);
					expect(actual.scriptHistory).toEqual(expected.scriptHistory);
					expect(actual.actionEvents).toEqual(expected.actionEvents);
					expect(actual.actionLogEvents).toEqual(expected.actionLogEvents);
					expect(actual.dependencyLeases).toEqual(expected.dependencyLeases);
					// The migration is committed; the version row is current.
					expect(store.getActionEvents(0)).toEqual(expected.actionEvents);
				} finally {
					store.close();
				}
				// An upgrade from an older schema leaves a verified pre-upgrade
				// backup behind, still at the old version.
				const expectedVersion = sourceSchemaVersion(name);
				if (expectedVersion > 0 && expectedVersion < SCHEMA_VERSION) {
					const backup = backupPathFor(dbPath, expectedVersion);
					expect(fs.existsSync(backup)).toBe(true);
					const backedUp = new Database(backup, { readonly: true });
					try {
						const row = backedUp
							.query(`SELECT value FROM schema_meta WHERE key = 'version'`)
							.get() as { value: string };
						expect(Number(row.value)).toBe(expectedVersion);
					} finally {
						backedUp.close();
					}
				}
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("future schema fails closed without modification", () => {
		const { dir, dbPath } = copyFixture("future");
		try {
			const configured = new Database(dbPath);
			try {
				configured.exec("PRAGMA journal_mode=DELETE");
			} finally {
				configured.close();
			}
			fs.rmSync(`${dbPath}-wal`, { force: true });
			fs.rmSync(`${dbPath}-shm`, { force: true });
			const before = fs.readFileSync(dbPath);
			expect(() => EnvironmentStateStore.open(dir)).toThrow(
				EnvironmentStateVersionError,
			);
			expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
			expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
			expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
			expect(fs.existsSync(backupPathFor(dbPath, 99))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a truncated pre-upgrade backup is replaced by a verified copy", () => {
		const { dir, dbPath } = copyFixture("current");
		const backup = backupPathFor(dbPath, 7);
		try {
			fs.writeFileSync(backup, fs.readFileSync(dbPath).subarray(0, 4096));
			const store = EnvironmentStateStore.open(dir);
			try {
				expect(store.backupPath).toBe(backup);
			} finally {
				store.close();
			}
			const verified = new Database(backup, { readonly: true });
			try {
				expect(verified.query("PRAGMA integrity_check").get()).toEqual({
					integrity_check: "ok",
				});
				const version = verified
					.query("SELECT value FROM schema_meta WHERE key='version'")
					.get() as { value: string };
				expect(Number(version.value)).toBe(7);
			} finally {
				verified.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("failed pre-upgrade backup is wrapped and leaves the source database openable", () => {
		const { dir, dbPath } = copyFixture("current");
		const backup = backupPathFor(dbPath, 7);
		try {
			fs.mkdirSync(backup);
			fs.writeFileSync(path.join(backup, "keep"), "not a backup");
			expect(() => EnvironmentStateStore.open(dir)).toThrow(
				EnvironmentStateError,
			);
			const source = new Database(dbPath, { readonly: true });
			try {
				const row = source
					.query("SELECT value FROM schema_meta WHERE key='version'")
					.get() as { value: string };
				expect(Number(row.value)).toBe(7);
			} finally {
				source.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("interrupted migration is completed rather than half-applied", () => {
		const { dir } = copyFixture("partial-v4");
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				expect(store.schemaVersion).toBe(SCHEMA_VERSION);
				expect(store.getAppState("half-migrated-app")).toEqual({
					ident: "half-migrated-app",
					branch: "main",
					activeWorktree: "",
					mainWorktreeBranch: "main",
				});
				expect(postMigrationExpectation("partial-v4").schemaVersion).toBe(
					SCHEMA_VERSION,
				);
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read-only open refuses a missing or older database", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "env-empty-"));
		try {
			expect(() => EnvironmentStateStore.openReadOnly(empty)).toThrow(
				EnvironmentStateReadOnlyError,
			);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
		const { dir } = copyFixture("v1");
		try {
			expect(() => EnvironmentStateStore.openReadOnly(dir)).toThrow(
				EnvironmentStateReadOnlyError,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read-only open observes an already-migrated database without writing", () => {
		const { dir, dbPath } = copyFixture("v1");
		try {
			const migrator = EnvironmentStateStore.open(dir);
			migrator.setBranch("migrated-app", "feature/read-only");
			migrator.close();
			const before = fs.statSync(dbPath).size;
			const store = EnvironmentStateStore.openReadOnly(dir);
			try {
				expect(store.readOnly).toBe(true);
				expect(store.getAppState("migrated-app").branch).toBe(
					"feature/read-only",
				);
				expect(() => store.setBranch("migrated-app", "nope")).toThrow();
			} finally {
				store.close();
			}
			expect(fs.statSync(dbPath).size).toBe(before);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("Go-created rows round-trip through Bun without value drift", () => {
		const { dir, dbPath } = copyFixture("current");
		try {
			ageEventTimestampsToNow(dbPath);
			const store = EnvironmentStateStore.open(dir);
			try {
				// Nullability: an empty runtime column reads as absent, never as
				// an empty record.
				expect(store.getAppRunTargetInfo("not-configured")).toBeUndefined();
				// Exact identities survive a write/read round trip.
				store.setAppState({
					ident: "leased-app",
					branch: "feature/x",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				});
				expect(store.getAppState("leased-app")).toEqual({
					ident: "leased-app",
					branch: "feature/x",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				});
				store.setAppRunTargetInfo("leased-app", {
					runtime: "kubernetes",
					launchMode: "helm",
					label: "cluster",
					profile: "local",
					targetId: "app:cluster",
					sourcePath: "/srv/chart",
					startedAt: "2024-04-05T06:07:08Z",
					display: "kubernetes:cluster",
				});
				expect(store.getAppRunTargetInfo("leased-app")).toEqual({
					runtime: "kubernetes",
					launchMode: "helm",
					label: "cluster",
					profile: "local",
					targetId: "app:cluster",
					sourcePath: "/srv/chart",
					startedAt: "2024-04-05T06:07:08Z",
					display: "kubernetes:cluster",
				});
				store.clearAppRunTargetInfo("leased-app");
				expect(store.getAppRunTargetInfo("leased-app")).toBeUndefined();
				// A timestamp with sub-second precision stays comparable to the
				// Go-written rows around it.
				store.addActionEvent(
					'{"type":"action.run.finished","properties":{}}',
					50000,
				);
				const events = store.getActionEvents(50000);
				expect(events.length).toBe(2);
				const deployEvent =
					'{"type":"action.run.started","properties":{"runId":"run-B","name":"deploy"}}';
				const finishedEvent = '{"type":"action.run.finished","properties":{}}';
				// The cursor is inclusive of `since` and exclusive of `before`.
				expect(
					store.getActionEventsSince(50000, new Date(Date.now() - 30_000)),
				).toEqual([finishedEvent]);
				expect(
					store.getActionEventsBetween(
						50000,
						new Date(Date.now() - 120_000),
						new Date(Date.now() - 30_000),
					),
				).toEqual([deployEvent]);
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("script history keeps newest-first ordering, limits and retention", () => {
		const { dir } = copyFixture("v3");
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				for (let index = 0; index < 6; index++)
					store.addScriptArgsHistory(
						"scripts/build.sh",
						{ run: String(index) },
						3,
					);
				expect(store.getScriptArgsHistory("scripts/build.sh", 50)).toEqual([
					{ run: "5" },
					{ run: "4" },
					{ run: "3" },
				]);
				// A different script keeps its own history.
				expect(store.getScriptArgsHistory("scripts/deploy.sh", 50)).toEqual([
					{},
				]);
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("dependency leases survive interrupted and repeated logical operations", () => {
		const { dir } = copyFixture("v6");
		try {
			const first = EnvironmentStateStore.open(dir);
			first.setDependencyLease({
				targetId: "lease:queue",
				ownerRunId: "run-C",
				ownerApp: "leased-app",
				lifecycle: "owned",
				updatedAt: "2024-04-05T06:07:12Z",
			});
			// Repeating the same logical operation is idempotent, not additive.
			first.setDependencyLease({
				targetId: "lease:queue",
				ownerRunId: "run-C",
				ownerApp: "leased-app",
				lifecycle: "owned",
				updatedAt: "2024-04-05T06:07:13Z",
			});
			expect(
				first
					.getDependencyLeases()
					.filter((lease) => lease.targetId === "lease:queue"),
			).toEqual([
				{
					targetId: "lease:queue",
					ownerRunId: "run-C",
					ownerApp: "leased-app",
					lifecycle: "owned",
					updatedAt: "2024-04-05T06:07:13Z",
				},
			]);
			first.close();

			// Reopening after an interruption (no clean close) keeps committed
			// leases and still migrates/completes the schema.
			const second = EnvironmentStateStore.open(dir);
			try {
				expect(second.getDependencyLeases().length).toBe(3);
				second.deleteDependencyLease("lease:queue", "run-C");
				second.deleteDependencyLease("lease:queue", "run-C");
				expect(second.getDependencyLeases().length).toBe(2);
			} finally {
				second.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("action log events keep per-run and per-step cursors", () => {
		const { dir, dbPath } = copyFixture("current");
		try {
			ageEventTimestampsToNow(dbPath);
			const store = EnvironmentStateStore.open(dir);
			try {
				store.addActionLogEvent(
					"run-A",
					"step-a",
					'{"type":"action.command.output","properties":{"runId":"run-A","stepId":"step-a","text":"delta"}}',
				);
				expect(store.getActionLogEvents("run-A", "step-a", 50)).toHaveLength(2);
				// The step cursor excludes the other step's event.
				expect(store.getActionLogEvents("run-A", "step-b", 50)).toHaveLength(1);
				// Newest `limit` events are returned oldest-first within the window.
				expect(store.getActionLogEvents("run-A", "", 2)).toEqual([
					'{"type":"action.step.output","properties":{"runId":"run-A","stepId":"step-b","text":"beta"}}',
					'{"type":"action.command.output","properties":{"runId":"run-A","stepId":"step-a","text":"delta"}}',
				]);
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	const row = (overrides: Record<string, unknown> = {}) => ({
		id: "id-one",
		owner: "workflow:a",
		app: "shop",
		targetId: "target-one",
		runtime: "docker",
		checkoutPath: "/repo/a",
		imageTag: "tag-one",
		status: "stopped",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	});

	/**
	 * A schema-v8 database: the parallel era's two tables plus its version. The
	 * schema comes from the frozen migration sequence itself, so it cannot drift
	 * from what the v8 release wrote; the rows mirror what it stored (one
	 * `<app>-<instance>` compose project per row, and its port allocations).
	 */
	function seedV8(dir: string): void {
		const db = new Database(path.join(dir, "state.db"));
		try {
			migrateToVersion(db, 8);
			const insert = db.prepare(
				`INSERT INTO env_instances (id, owner, app, target_id, runtime, checkout_path, image_tag, status, created_at, last_activity_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const instance of [
				row({ id: "a-shop", owner: "workflow:a", status: "running" }),
				row({
					id: "b-shop",
					owner: "workflow:b",
					status: "unknown",
					createdAt: "2026-01-02T00:00:00.000Z",
				}),
				row({
					id: "c-api",
					owner: "workflow:c",
					app: "api",
					status: "unknown",
				}),
				row({
					id: "d-api",
					owner: "workflow:d",
					app: "api",
					status: "stopping",
					createdAt: "2026-01-03T00:00:00.000Z",
				}),
			])
				insert.run(
					instance.id,
					instance.owner,
					instance.app,
					instance.targetId,
					instance.runtime,
					instance.checkoutPath,
					instance.imageTag,
					instance.status,
					instance.createdAt,
					instance.lastActivityAt,
				);
			db.prepare(
				`INSERT INTO port_allocations (instance_id, name, port) VALUES (?, ?, ?)`,
			).run("a-shop", "HTTP", 21000);
		} finally {
			db.close();
		}
	}

	test("schema v8 migrates to v9, drops port allocations and retires duplicate active rows", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-state-v9-"));
		const dbPath = path.join(dir, "state.db");
		try {
			seedV8(dir);
			const migrated = EnvironmentStateStore.open(dir);
			try {
				expect(migrated.schemaVersion).toBe(9);
				expect(migrated.backupPath).toBe(backupPathFor(dbPath, 8));
				// One active row per app: the persisted-running row keeps the slot and
				// the others are retired. A retired row is never claimed `stopped` from
				// the database alone, because nothing confirmed its container is gone.
				expect(migrated.findActiveEnvironmentInstance("shop")?.id).toBe(
					"a-shop",
				);
				expect(migrated.getEnvironmentInstance("b-shop")?.status).toBe(
					"superseded",
				);
				expect(
					migrated
						.getSupersededEnvironmentInstances()
						.map((instance) => instance.id)
						.sort(),
				).toEqual(["b-shop", "c-api"]);
				// Without a running row the newest stays active as `unknown`, which
				// blocks the slot until reconcile or force release decides.
				expect(migrated.findActiveEnvironmentInstance("api")?.id).toBe("d-api");
				expect(migrated.findActiveEnvironmentInstance("api")?.status).toBe(
					"unknown",
				);
			} finally {
				migrated.close();
			}

			const raw = new Database(dbPath, { readonly: true });
			try {
				expect(
					raw
						.query(
							`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'port_allocations'`,
						)
						.get(),
				).toBeNull();
				// The v9 index predicate is frozen, so a fresh database and a migrated
				// one agree on the same DDL.
				expect(
					(
						raw
							.query(
								`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_env_instances_active_app'`,
							)
							.get() as { sql: string }
					).sql,
				).toContain("'starting', 'running', 'stopping', 'unknown'");
			} finally {
				raw.close();
			}

			const reopened = EnvironmentStateStore.open(dir);
			try {
				expect(reopened.schemaVersion).toBe(9);
				expect(
					reopened
						.getActiveEnvironmentInstances()
						.map((instance) => instance.id)
						.sort(),
				).toEqual(["a-shop", "d-api"]);
				// The partial index still keeps one active row per app.
				expect(() =>
					reopened.setEnvironmentInstance(
						row({ id: "e-shop", owner: "workflow:e", status: "starting" }),
					),
				).toThrow(EnvironmentStateError);
			} finally {
				reopened.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("migrateToVersion refuses a database that already has a schema", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-state-guard-"));
		const dbPath = path.join(dir, "state.db");
		try {
			const db = new Database(dbPath);
			try {
				migrateToVersion(db, 8);
				// The durable version marker is only ever written on an empty database.
				expect(() => migrateToVersion(db, 9)).toThrow(EnvironmentStateError);
				expect(() => migrateToVersion(db, SCHEMA_VERSION + 1)).toThrow(
					EnvironmentStateError,
				);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("instance reads use durable identities and state conflicts stay typed", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-state-errors-"),
		);
		const store = EnvironmentStateStore.open(dir);
		try {
			const row = {
				id: "id-one",
				owner: "workflow:a",
				app: "shop",
				targetId: "target-one",
				runtime: "docker",
				checkoutPath: "/repo/a",
				imageTag: "tag-one",
				status: "stopped",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastActivityAt: "2026-01-01T00:00:00.000Z",
			};
			store.setEnvironmentInstance(row);
			store.setEnvironmentInstance({
				...row,
				id: "id-two",
				targetId: "target-two",
			});
			expect(
				store.claimEnvironmentInstance({
					...row,
					id: "derived-key",
					status: "starting",
				}),
			).toBe("id-one");
			expect(store.getEnvironmentInstance("id-one")?.status).toBe("starting");
			expect(store.getEnvironmentInstance("id-one")?.targetId).toBe(
				"target-one",
			);
			expect(store.getEnvironmentInstance("id-two")).toBeUndefined();
			expect(store.findEnvironmentInstance("workflow:a", "shop")?.id).toBe(
				"id-one",
			);
			expect(store.findActiveEnvironmentInstance("shop")?.id).toBe("id-one");
			// Another owner cannot take an app while a row holds it.
			expect(
				store.claimEnvironmentInstance({
					...row,
					id: "id-other",
					owner: "workflow:b",
					status: "starting",
				}),
			).toBeUndefined();
			expect(store.findActiveEnvironmentInstance("shop")?.id).toBe("id-one");
			// A terminal status releases the app for the next owner.
			expect(
				store.transitionEnvironmentInstanceStatus(
					"id-one",
					"starting",
					"stopped",
					"2026-01-02T00:00:00.000Z",
				),
			).toBe(true);
			expect(store.findActiveEnvironmentInstance("shop")).toBeUndefined();
			expect(
				store.claimEnvironmentInstance({
					...row,
					id: "id-other",
					owner: "workflow:b",
					status: "starting",
				}),
			).toBe("id-other");
		} finally {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("concurrent opens serialize on the migration write transaction", async () => {
		const { dir, dbPath } = copyFixture("v5");
		try {
			ageEventTimestampsToNow(dbPath);
			const stores = await Promise.all(
				Array.from({ length: 4 }, async () => EnvironmentStateStore.open(dir)),
			);
			try {
				for (const store of stores)
					expect(store.schemaVersion).toBe(SCHEMA_VERSION);
			} finally {
				for (const store of stores) store.close();
			}
			const reopened = EnvironmentStateStore.open(dir);
			try {
				// Migration 7 moved the two output events into action_log_events.
				expect(reopened.getActionEvents(50)).toHaveLength(1);
				expect(reopened.getActionLogEvents("run-1", "", 50)).toHaveLength(2);
			} finally {
				reopened.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
