// The current store version boundary (remove-legacy-migration-logic): a fresh
// store is created directly at the frozen schema version, an existing current
// store opens untouched, and every other persisted version is refused without
// modifying the file. Replaces the former workflow-migration suite.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	canonicalStorePath,
	initializeStore,
	STORE_SCHEMA_VERSION,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

function repo(): string {
	return createTempRepoFixture("store-version-", repoPreset.empty);
}

/** The store shape a version-6 reader depends on: objects, rows and pragma. */
function storeShape(root: string): unknown {
	const db = new Database(canonicalStorePath(root), { readonly: true });
	try {
		return {
			version: (
				db.query("PRAGMA user_version").get() as { user_version: number }
			).user_version,
			objects: db
				.query(
					"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
				)
				.all(),
			instances: db.query("SELECT * FROM workflow_instances ORDER BY id").all(),
			runs: db.query("SELECT id,workflow_id,status FROM workflow_runs").all(),
			events: db.query("SELECT * FROM workflow_events").all(),
			outbox: db
				.query("SELECT id,kind,status FROM workflow_outbox ORDER BY id")
				.all(),
		};
	} finally {
		db.close();
	}
}

function storeBytes(root: string): string {
	return fs.readFileSync(canonicalStorePath(root)).toString("base64");
}

function seedCurrentRows(root: string): void {
	const db = new Database(canonicalStorePath(root));
	db.query(
		"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"wf-1",
		"change-1",
		root,
		root,
		"no-openspec",
		1,
		"definition-digest",
		1,
		"active",
		"core.implementation",
		"{}",
		"2026-01-01T00:00:00.000Z",
		"2026-01-01T00:00:00.000Z",
	);
	db.query(
		"INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"run-1",
		"wf-1",
		"core.implementation",
		"worker",
		1,
		1,
		"pending",
		"{}",
		1,
		'["complete"]',
		"capability-hash",
		"2026-01-01T01:00:00.000Z",
		path.join(root, "assignment.md"),
		null,
		null,
		null,
		null,
		null,
		"2026-01-01T00:00:00.000Z",
		null,
	);
	db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
		"wf-1",
		1,
		"seed",
		'{"kind":"test"}',
		'{"value":"preserved"}',
		"2026-01-01T00:00:00.000Z",
	);
	db.query(
		"INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"effect-1",
		"wf-1",
		1,
		"agent.stop",
		"stop-1",
		'{"runId":"run-1"}',
		"pending",
		0,
		3,
		null,
		null,
		null,
		null,
	);
	db.close();
}

/** Rewrite the persisted version without touching anything else. */
function setVersion(root: string, version: number): void {
	const db = new Database(canonicalStorePath(root));
	db.exec(`PRAGMA user_version=${version}`);
	db.close();
}

test("an absent store stays observationally absent", () => {
	const root = repo();
	try {
		const views = new WorkflowEngine(registerBuiltins()).list(root);
		expect(views).toHaveLength(1);
		expect(views[0]?.health.diagnostic).toContain("workflow store is absent");
		expect(fs.existsSync(path.join(root, ".herdr-workflow"))).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a fresh store is created directly at the current version, idempotently", () => {
	const root = repo();
	try {
		initializeStore(root);
		const first = storeShape(root);
		initializeStore(root);
		expect((first as { version: number }).version).toBe(STORE_SCHEMA_VERSION);
		expect(storeShape(root)).toEqual(first);
		const db = new Database(canonicalStorePath(root), { readonly: true });
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "debug_requests" },
			{ name: "workflow_definitions" },
			{ name: "workflow_events" },
			{ name: "workflow_instances" },
			{ name: "workflow_migration_diagnostics" },
			{ name: "workflow_outbox" },
			{ name: "workflow_runs" },
			{ name: "workflow_security_audit" },
		]);
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an existing current store opens with every object, row and pragma preserved", () => {
	const root = repo();
	try {
		initializeStore(root);
		seedCurrentRows(root);
		const before = storeShape(root);
		const bytes = storeBytes(root);
		initializeStore(root);
		expect(storeShape(root)).toEqual(before);
		expect(storeBytes(root)).toBe(bytes);
		// A current read and a current write both work on the opened store.
		const engine = new WorkflowEngine(registerBuiltins());
		expect(() => engine.status(root, "wf-1")).not.toThrow();
		const db = new Database(canonicalStorePath(root));
		db.query(
			"UPDATE workflow_runs SET status='working' WHERE id='run-1'",
		).run();
		db.close();
		const after = storeShape(root);
		expect((after as { runs: unknown[] }).runs).toEqual([
			{ id: "run-1", workflow_id: "wf-1", status: "working" },
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an older persisted version is refused by name without modifying the store", () => {
	for (const version of [1, 4, 5]) {
		const root = repo();
		try {
			initializeStore(root);
			seedCurrentRows(root);
			setVersion(root, version);
			const before = storeShape(root);
			const bytes = storeBytes(root);
			expect(() => initializeStore(root)).toThrow(
				new RegExp(
					`unsupported workflow store version ${version}; this build only reads version ${STORE_SCHEMA_VERSION}`,
				),
			);
			expect(storeShape(root)).toEqual(before);
			expect(storeBytes(root)).toBe(bytes);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("a future stored version is refused by name without modifying the store", () => {
	const root = repo();
	try {
		initializeStore(root);
		setVersion(root, STORE_SCHEMA_VERSION + 1);
		const before = storeShape(root);
		const bytes = storeBytes(root);
		expect(() => initializeStore(root)).toThrow(
			new RegExp(
				`unsupported workflow store version ${STORE_SCHEMA_VERSION + 1}; this build only reads version ${STORE_SCHEMA_VERSION}`,
			),
		);
		expect(storeShape(root)).toEqual(before);
		expect(storeBytes(root)).toBe(bytes);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an unversioned store with tables is refused without modifying the store", () => {
	const root = repo();
	try {
		initializeStore(root);
		seedCurrentRows(root);
		setVersion(root, 0);
		const before = storeShape(root);
		const bytes = storeBytes(root);
		expect(() => initializeStore(root)).toThrow(
			/unsupported workflow store version 0; this build only reads version 6/,
		);
		expect(storeShape(root)).toEqual(before);
		expect(storeBytes(root)).toBe(bytes);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a legacy workflows-only store is refused instead of imported", () => {
	const root = repo();
	try {
		fs.mkdirSync(path.dirname(canonicalStorePath(root)), { recursive: true });
		const db = new Database(canonicalStorePath(root), { create: true });
		db.exec(
			"CREATE TABLE workflows(change_id TEXT PRIMARY KEY, state TEXT NOT NULL)",
		);
		db.query("INSERT INTO workflows VALUES (?,?)").run(
			"legacy-change",
			JSON.stringify({ changeId: "legacy-change", phase: "apply" }),
		);
		db.close();
		expect(() => initializeStore(root)).toThrow(
			/unsupported workflow store version 0; this build only reads version 6/,
		);
		const check = new Database(canonicalStorePath(root), { readonly: true });
		expect(check.query("PRAGMA user_version").get()).toEqual({
			user_version: 0,
		});
		expect(check.query("SELECT COUNT(*) count FROM workflows").get()).toEqual({
			count: 1,
		});
		expect(
			check
				.query("SELECT 1 FROM sqlite_master WHERE name='workflow_instances'")
				.get(),
		).toBeNull();
		check.close();
		// Observation never imports it either: the version is reported, not
		// converted.
		const views = new WorkflowEngine(registerBuiltins()).list(root);
		expect(views[0]?.health.diagnostic).toContain(
			"unsupported workflow store version 0",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a current version carrying a drifted canonical shape is refused", () => {
	const root = repo();
	try {
		initializeStore(root);
		const db = new Database(canonicalStorePath(root));
		db.exec("DROP INDEX workflow_runs_workflow_status");
		db.exec(
			"CREATE INDEX workflow_runs_workflow_status ON workflow_runs(status)",
		);
		db.close();
		expect(() => initializeStore(root)).toThrow(
			/unsupported (workflow store schema objects|index columns)/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a current store that still carries the retired workflows table opens unchanged", () => {
	const root = repo();
	try {
		initializeStore(root);
		seedCurrentRows(root);
		// The shape the retired legacy import left behind: a version-6 store whose
		// source `workflows` table still holds one row per migrated workflow.
		const writer = new Database(canonicalStorePath(root));
		writer.exec(
			"CREATE TABLE workflows(change_id TEXT PRIMARY KEY, state TEXT NOT NULL)",
		);
		writer
			.query("INSERT INTO workflows VALUES (?,?)")
			.run(
				"old-change",
				JSON.stringify({ changeId: "old-change", phase: "closed" }),
			);
		writer.close();

		const before = storeShape(root);
		const bytes = storeBytes(root);
		initializeStore(root);
		// The retired table and its row are left exactly as they were, and the
		// current store is unchanged.
		expect(storeShape(root)).toEqual(before);
		expect(storeBytes(root)).toBe(bytes);
		const check = new Database(canonicalStorePath(root), { readonly: true });
		expect(check.query("SELECT COUNT(*) count FROM workflows").get()).toEqual({
			count: 1,
		});
		check.close();
		// A current write path still works on it: initialize runs before every
		// command transaction.
		const engine = new WorkflowEngine(registerBuiltins());
		expect(() => engine.status(root, "wf-1")).not.toThrow();
		const db = new Database(canonicalStorePath(root));
		db.query(
			"UPDATE workflow_runs SET status='working' WHERE id='run-1'",
		).run();
		db.close();
		expect((storeShape(root) as { runs: unknown[] }).runs).toEqual([
			{ id: "run-1", workflow_id: "wf-1", status: "working" },
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a store with the historical run DEFAULT clauses opens unchanged", () => {
	const root = repo();
	try {
		initializeStore(root);
		seedCurrentRows(root);
		// A store an earlier build migrated carries the two run columns with their
		// historical DEFAULT clauses. The columns are the same columns, so the
		// store opens instead of being refused. The historical DDL is derived from
		// the current one so it cannot drift by hand.
		const writer = new Database(canonicalStorePath(root));
		const currentSql = (
			writer
				.query(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'",
				)
				.get() as { sql: string }
		).sql;
		const legacySql = currentSql
			.replace(
				"issued_revision INTEGER NOT NULL",
				"issued_revision INTEGER NOT NULL DEFAULT 0",
			)
			.replace(
				"allowed_outcomes_json TEXT NOT NULL",
				`allowed_outcomes_json TEXT NOT NULL DEFAULT '["complete","blocked","failed"]'`,
			);
		writer.exec("PRAGMA foreign_keys=OFF");
		writer.exec("ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy");
		writer.exec(legacySql);
		writer.exec("INSERT INTO workflow_runs SELECT * FROM workflow_runs_legacy");
		writer.exec("DROP TABLE workflow_runs_legacy");
		// Renaming the table dropped its index with it; the historical store had it.
		writer.exec(
			"CREATE INDEX workflow_runs_workflow_status ON workflow_runs(workflow_id,status)",
		);
		writer.close();

		initializeStore(root);
		const db = new Database(canonicalStorePath(root), { readonly: true });
		expect(
			(
				db
					.query(
						"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_runs'",
					)
					.get() as { sql: string }
			).sql,
		).toContain("DEFAULT 0");
		expect((storeShape(root) as { version: number }).version).toBe(
			STORE_SCHEMA_VERSION,
		);
		expect((storeShape(root) as { runs: unknown[] }).runs).toEqual([
			{ id: "run-1", workflow_id: "wf-1", status: "pending" },
		]);
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a version-0 WAL store and a non-SQLite file are both refused by name", () => {
	// An unreadable probe must not decide the refusal: both shapes produce the one
	// version message, and neither file is modified.
	const wal = repo();
	try {
		const file = canonicalStorePath(wal);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const db = new Database(file, { create: true });
		db.exec("PRAGMA journal_mode=WAL");
		db.exec(
			"CREATE TABLE workflows(change_id TEXT PRIMARY KEY, state TEXT NOT NULL)",
		);
		db.close();
		const before = storeBytes(wal);
		expect(() => initializeStore(wal)).toThrow(
			/unsupported workflow store version 0; this build only reads version 6/,
		);
		expect(storeBytes(wal)).toBe(before);
	} finally {
		fs.rmSync(wal, { recursive: true, force: true });
	}

	const foreign = repo();
	try {
		const file = canonicalStorePath(foreign);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// A 128-byte file whose version bytes are zero but which is not a database.
		fs.writeFileSync(file, Buffer.alloc(128));
		const bytes = storeBytes(foreign);
		expect(() => initializeStore(foreign)).toThrow(
			/unsupported workflow store version 0; this build only reads version 6/,
		);
		expect(storeBytes(foreign)).toBe(bytes);
	} finally {
		fs.rmSync(foreign, { recursive: true, force: true });
	}
});

test("independent initializer processes converge on one committed schema version", async () => {
	const root = repo();
	try {
		const script =
			'import { initializeStore } from "./src/workflow/runtime.ts"; initializeStore(process.argv[1]);';
		const processes = [0, 1].map(() =>
			Bun.spawn(["bun", "-e", script, root], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		expect(
			await Promise.all(processes.map((process) => process.exited)),
		).toEqual([0, 0]);
		expect((storeShape(root) as { version: number }).version).toBe(
			STORE_SCHEMA_VERSION,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent dashboard reads do not race SQLite sidecar files", async () => {
	const root = repo();
	try {
		initializeStore(root);
		const writer =
			'import { openStore } from "./src/workflow/runtime/store.ts"; const db = openStore(process.argv[1]); for (let index = 0; index < 100; index++) db.exec("BEGIN IMMEDIATE; SELECT count(*) FROM workflow_instances; COMMIT"); db.close();';
		const reader =
			'import { openReadStore } from "./src/workflow/runtime/store.ts"; for (let index = 0; index < 100; index++) { const db = openReadStore(process.argv[1]); db.query("SELECT count(*) FROM workflow_instances").all(); db.close(); }';
		const processes = [writer, reader, reader, reader].map((script) =>
			Bun.spawn(["bun", "-e", script, root], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		expect(
			await Promise.all(processes.map((process) => process.exited)),
		).toEqual([0, 0, 0, 0]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
