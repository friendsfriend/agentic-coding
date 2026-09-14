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
	EnvironmentStateReadOnlyError,
	EnvironmentStateStore,
	EnvironmentStateVersionError,
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
				const expectedVersion = readExpectation(name).schemaVersion;
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
			const before = fs.readFileSync(dbPath);
			expect(() => EnvironmentStateStore.open(dir)).toThrow(
				EnvironmentStateVersionError,
			);
			expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
			expect(fs.existsSync(backupPathFor(dbPath, 99))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("interrupted migration is completed rather than half-applied", () => {
		const { dir } = copyFixture("partial-v4");
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				const expected = readExpectation("partial-v4");
				expect(store.schemaVersion).toBe(SCHEMA_VERSION);
				expect(store.getAppState("half-migrated-app")).toEqual({
					ident: "half-migrated-app",
					branch: "main",
					activeWorktree: "",
					mainWorktreeBranch: "main",
				});
				expect(expected.schemaVersion).toBe(SCHEMA_VERSION);
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
