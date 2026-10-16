// Bun-owned environment state at its current schema version: an empty database
// is created directly with the current DDL, an existing current database is
// opened untouched, and every other persisted version is refused without being
// modified. The Go-era older-schema fixtures and their migration contracts are
// gone with the migration path.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	EnvironmentStateError,
	EnvironmentStateReadOnlyError,
	EnvironmentStateStore,
	EnvironmentStateVersionError,
	SCHEMA_VERSION,
} from "../src/server/environment/state-store.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");

/** A disposable current-format fixture: the store's own creation path. */
function currentFixture(): { dir: string; dbPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-current-"));
	const store = EnvironmentStateStore.open(dir);
	store.close();
	return { dir, dbPath: path.join(dir, "state.db") };
}

function dumpStore(dbPath: string): unknown {
	const db = new Database(dbPath, { readonly: true });
	try {
		return {
			objects: db
				.query(
					"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
				)
				.all(),
			apps: db.query("SELECT * FROM app_state ORDER BY ident").all(),
			instances: db.query("SELECT * FROM env_instances ORDER BY id").all(),
			leases: db
				.query("SELECT * FROM dependency_leases ORDER BY target_id")
				.all(),
			version: db
				.query("SELECT value FROM schema_meta WHERE key='version'")
				.get(),
		};
	} finally {
		db.close();
	}
}

function storeBytes(dbPath: string): string {
	return fs.readFileSync(dbPath).toString("base64");
}

/** Rewrite the persisted schema version without touching anything else. */
function setVersion(dbPath: string, version: number): void {
	const db = new Database(dbPath);
	try {
		db.prepare(
			"INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run(String(version));
	} finally {
		db.close();
	}
}

describe("environment state version boundary", () => {
	test("an empty directory is created directly at the current version", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-fresh-"));
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				expect(store.schemaVersion).toBe(SCHEMA_VERSION);
			} finally {
				store.close();
			}
			const dbPath = path.join(dir, "state.db");
			const db = new Database(dbPath, { readonly: true });
			try {
				expect(
					db
						.query(
							"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
						)
						.all(),
				).toEqual([
					{ name: "action_events" },
					{ name: "action_log_events" },
					{ name: "app_state" },
					{ name: "dependency_leases" },
					{ name: "env_instances" },
					{ name: "schema_meta" },
					{ name: "script_args_history" },
				]);
			} finally {
				db.close();
			}
			// Creating state never publishes a pre-upgrade backup.
			expect(
				fs.readdirSync(dir).filter((entry) => entry.includes("backup")),
			).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an existing current database is opened with its schema, rows and version preserved", () => {
		const { dir, dbPath } = currentFixture();
		try {
			const writer = EnvironmentStateStore.open(dir);
			writer.setAppState({
				ident: "leased-app",
				branch: "feature/x",
				activeWorktree: "feature/x",
				mainWorktreeBranch: "main",
			});
			writer.setDependencyLease({
				targetId: "lease:queue",
				ownerRunId: "run-C",
				ownerApp: "leased-app",
				lifecycle: "owned",
				updatedAt: "2024-04-05T06:07:12Z",
			});
			writer.close();

			const before = dumpStore(dbPath);
			const bytes = storeBytes(dbPath);
			const reopened = EnvironmentStateStore.open(dir);
			try {
				expect(reopened.schemaVersion).toBe(SCHEMA_VERSION);
				expect(reopened.getAppState("leased-app")).toEqual({
					ident: "leased-app",
					branch: "feature/x",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				});
				expect(reopened.getDependencyLeases()).toHaveLength(1);
			} finally {
				reopened.close();
			}
			expect(dumpStore(dbPath)).toEqual(before);
			expect(storeBytes(dbPath)).toBe(bytes);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an older persisted version is refused without modifying the database", () => {
		for (const version of [1, 5, 7, SCHEMA_VERSION - 1]) {
			const { dir, dbPath } = currentFixture();
			try {
				setVersion(dbPath, version);
				const before = dumpStore(dbPath);
				const bytes = storeBytes(dbPath);
				expect(() => EnvironmentStateStore.open(dir)).toThrow(
					EnvironmentStateVersionError,
				);
				expect(() => EnvironmentStateStore.open(dir)).toThrow(
					new RegExp(
						`state: database schema ${version} is not the supported ${SCHEMA_VERSION}`,
					),
				);
				expect(dumpStore(dbPath)).toEqual(before);
				expect(storeBytes(dbPath)).toBe(bytes);
				expect(
					fs.readdirSync(dir).filter((entry) => entry.includes("backup")),
				).toEqual([]);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	test("a future schema fails closed without modification", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-future-"));
		try {
			for (const entry of fs.readdirSync(path.join(FIXTURES, "future"))) {
				if (entry === "expected.json") continue;
				fs.copyFileSync(
					path.join(FIXTURES, "future", entry),
					path.join(dir, entry),
				);
			}
			const dbPath = path.join(dir, "state.db");
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
			expect(
				fs.readdirSync(dir).filter((entry) => entry.includes("backup")),
			).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a database with tables and no version marker is refused", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-unversioned-"));
		try {
			const dbPath = path.join(dir, "state.db");
			const db = new Database(dbPath, { create: true });
			db.exec("CREATE TABLE app_state (ident TEXT PRIMARY KEY)");
			db.query("INSERT INTO app_state VALUES (?)").run("legacy-app");
			db.close();
			const before = fs.readFileSync(dbPath);
			expect(() => EnvironmentStateStore.open(dir)).toThrow(
				EnvironmentStateVersionError,
			);
			expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
			const check = new Database(dbPath, { readonly: true });
			try {
				expect(check.query("SELECT ident FROM app_state").all()).toEqual([
					{ ident: "legacy-app" },
				]);
			} finally {
				check.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read-only open refuses a missing or non-current database", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "env-empty-"));
		try {
			expect(() => EnvironmentStateStore.openReadOnly(empty)).toThrow(
				EnvironmentStateReadOnlyError,
			);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
		const { dir, dbPath } = currentFixture();
		try {
			EnvironmentStateStore.open(dir).close();
			setVersion(dbPath, SCHEMA_VERSION - 1);
			expect(() => EnvironmentStateStore.openReadOnly(dir)).toThrow(
				EnvironmentStateReadOnlyError,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read-only open observes a current database without writing", () => {
		const { dir, dbPath } = currentFixture();
		try {
			const writer = EnvironmentStateStore.open(dir);
			writer.setBranch("migrated-app", "feature/read-only");
			writer.close();
			const before = fs.readFileSync(dbPath);
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
			expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("concurrent opens serialize on the creation write transaction", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-concurrent-"));
		try {
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
				expect(reopened.schemaVersion).toBe(SCHEMA_VERSION);
			} finally {
				reopened.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("environment state operations", () => {
	test("app state and run targets round-trip without value drift", () => {
		const { dir } = currentFixture();
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				// Nullability: an empty runtime column reads as absent, never as an
				// empty record.
				expect(store.getAppRunTargetInfo("not-configured")).toBeUndefined();
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
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("script history keeps newest-first ordering, limits and retention", () => {
		const { dir } = currentFixture();
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
				expect(store.getScriptArgsHistory("scripts/deploy.sh", 50)).toEqual([]);
				store.addScriptArgsHistory("scripts/deploy.sh", { run: "a" }, 3);
				expect(store.getScriptArgsHistory("scripts/deploy.sh", 50)).toEqual([
					{ run: "a" },
				]);
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("dependency leases survive interrupted and repeated logical operations", () => {
		const { dir } = currentFixture();
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
			expect(first.getDependencyLeases()).toEqual([
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
			// leases and still opens the current schema.
			const second = EnvironmentStateStore.open(dir);
			try {
				expect(second.getDependencyLeases()).toHaveLength(1);
				second.deleteDependencyLease("lease:queue", "run-C");
				second.deleteDependencyLease("lease:queue", "run-C");
				expect(second.getDependencyLeases()).toHaveLength(0);
			} finally {
				second.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("action events keep newest-first limits and max-entry trimming", () => {
		const { dir } = currentFixture();
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				const events = ["a", "b", "c", "d"].map(
					(name) =>
						`{"type":"action.run.started","properties":{"name":"${name}"}}`,
				);
				for (const event of events) store.addActionEvent(event, 3);
				// `maxEntries` trims to the newest three, and the newest `limit` are
				// returned oldest-first within the window.
				expect(store.getActionEvents(50)).toEqual(events.slice(1));
				expect(store.getActionEvents(2)).toEqual(events.slice(2));
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("action log events keep per-run and per-step cursors", () => {
		const { dir } = currentFixture();
		try {
			const store = EnvironmentStateStore.open(dir);
			try {
				store.addActionLogEvent(
					"run-A",
					"step-a",
					'{"type":"action.command.output","properties":{"runId":"run-A","stepId":"step-a","text":"alpha"}}',
				);
				store.addActionLogEvent(
					"run-A",
					"step-b",
					'{"type":"action.step.output","properties":{"runId":"run-A","stepId":"step-b","text":"beta"}}',
				);
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

	test("a failed open never wraps an unrelated error as a version refusal", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-broken-"));
		try {
			fs.writeFileSync(path.join(dir, "state.db"), "not a database");
			expect(() => EnvironmentStateStore.open(dir)).toThrow(
				EnvironmentStateError,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
