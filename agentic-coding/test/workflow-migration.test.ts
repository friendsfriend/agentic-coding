import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	canonicalStorePath,
	initializeStore,
	STORE_SCHEMA_VERSION,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";

function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	return root;
}
function legacy(
	root: string,
	change: string,
	state: Record<string, unknown>,
): void {
	fs.mkdirSync(path.dirname(canonicalStorePath(root)), { recursive: true });
	const db = new Database(canonicalStorePath(root), { create: true });
	db.exec(
		"CREATE TABLE IF NOT EXISTS workflows(change_id TEXT PRIMARY KEY,state TEXT NOT NULL)",
	);
	db.query("INSERT INTO workflows VALUES (?,?)").run(
		change,
		JSON.stringify(state),
	);
	db.close();
}

function seedCanonicalRows(root: string): void {
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

function preservedIdentity(root: string): Record<string, unknown> {
	const db = new Database(canonicalStorePath(root));
	const result = {
		instance: db.query("SELECT id,change_id FROM workflow_instances").get(),
		run: db.query("SELECT id,capability_hash FROM workflow_runs").get(),
		event: db
			.query("SELECT workflow_id,revision,data_json FROM workflow_events")
			.get(),
		outbox: db
			.query("SELECT id,idempotency_key,payload_json FROM workflow_outbox")
			.get(),
	};
	db.close();
	return result;
}

test("missing-store list reports migration-required without creating storage", () => {
	const root = repo();
	try {
		const views = new WorkflowEngine(registerBuiltins()).list(root);
		expect(views).toHaveLength(1);
		expect(views[0]?.definition.id).toBe("migration-required");
		expect(fs.existsSync(path.join(root, ".herdr-workflow"))).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("empty initialization is versioned and idempotent", () => {
	const root = repo();
	try {
		initializeStore(root);
		initializeStore(root);
		const db = new Database(canonicalStorePath(root));
		expect(db.query("PRAGMA user_version").get()).toEqual({
			user_version: STORE_SCHEMA_VERSION,
		});
		expect(
			db
				.query(
					"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('workflow_instances','workflow_runs','workflow_events','workflow_outbox')",
				)
				.get(),
		).toEqual({ count: 4 });
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("supported baselines and current-schema adoption preserve durable identities", () => {
	for (const baseline of [1, 2, 3, 4]) {
		const root = repo();
		try {
			initializeStore(root);
			seedCanonicalRows(root);
			const before = preservedIdentity(root);
			const db = new Database(canonicalStorePath(root));
			db.exec("PRAGMA foreign_keys=OFF");
			if (baseline === 1) {
				db.exec("ALTER TABLE workflow_runs DROP COLUMN issued_revision");
				db.exec("ALTER TABLE workflow_runs DROP COLUMN allowed_outcomes_json");
			} else if (baseline === 2) {
				db.exec(
					"CREATE TABLE workflow_instances_new(id TEXT PRIMARY KEY, change_id TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active','paused','attention-required','completed','closed')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
				);
				db.exec(
					"INSERT INTO workflow_instances_new SELECT * FROM workflow_instances",
				);
				db.exec("DROP TABLE workflow_instances");
				db.exec(
					"ALTER TABLE workflow_instances_new RENAME TO workflow_instances",
				);
			} else if (baseline === 3) {
				db.exec(
					"DROP INDEX workflow_runs_workflow_status; DROP INDEX workflow_outbox_ready",
				);
				db.exec("ALTER TABLE workflow_runs RENAME TO workflow_runs_old");
				db.exec(
					"CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances_legacy(id), step_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('pending','working','completed','blocked','failed','expired')), profile_json TEXT NOT NULL, issued_revision INTEGER NOT NULL, allowed_outcomes_json TEXT NOT NULL, capability_hash TEXT NOT NULL, capability_expires_at TEXT NOT NULL, assignment_path TEXT NOT NULL, output_path TEXT, output_schema_id TEXT, output_schema_version INTEGER, output_digest TEXT, handle_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(workflow_id,id,generation))",
				);
				db.exec(
					"INSERT INTO workflow_runs SELECT * FROM workflow_runs_old; DROP TABLE workflow_runs_old",
				);
				db.exec("ALTER TABLE workflow_events RENAME TO workflow_events_old");
				db.exec(
					"CREATE TABLE workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances_legacy(id), revision INTEGER NOT NULL, type TEXT NOT NULL, actor_json TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workflow_id,revision))",
				);
				db.exec(
					"INSERT INTO workflow_events SELECT * FROM workflow_events_old; DROP TABLE workflow_events_old",
				);
				db.exec("ALTER TABLE workflow_outbox RENAME TO workflow_outbox_old");
				db.exec(
					"CREATE TABLE workflow_outbox(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_instances_legacy(id), revision INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','failed','expired')), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0), lease TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT)",
				);
				db.exec(
					"INSERT INTO workflow_outbox SELECT * FROM workflow_outbox_old; DROP TABLE workflow_outbox_old",
				);
			}
			db.exec(`PRAGMA user_version=${baseline}`);
			db.close();
			initializeStore(root);
			expect(preservedIdentity(root)).toEqual(before);
			const check = new Database(canonicalStorePath(root));
			expect(check.query("PRAGMA user_version").get()).toEqual({
				user_version: STORE_SCHEMA_VERSION,
			});
			expect(check.query("PRAGMA foreign_key_check").all()).toEqual([]);
			check.close();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

test("unknown unversioned schemas and future versions fail closed", () => {
	const root = repo();
	try {
		fs.mkdirSync(path.dirname(canonicalStorePath(root)), { recursive: true });
		const db = new Database(canonicalStorePath(root), { create: true });
		db.exec("CREATE TABLE unexpected(value TEXT)");
		db.close();
		expect(() => initializeStore(root)).toThrow(/unsupported unversioned/);
		const unchanged = new Database(canonicalStorePath(root));
		expect(unchanged.query("PRAGMA user_version").get()).toEqual({
			user_version: 0,
		});
		unchanged.exec("DROP TABLE unexpected");
		unchanged.close();
		initializeStore(root);
		const future = new Database(canonicalStorePath(root));
		future.exec("PRAGMA user_version=99");
		future.close();
		expect(() => initializeStore(root)).toThrow(
			/unsupported workflow store version: 99/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
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
		const db = new Database(canonicalStorePath(root));
		expect(db.query("PRAGMA user_version").get()).toEqual({
			user_version: STORE_SCHEMA_VERSION,
		});
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failed foreign-key migration preserves its version and recovers on restart", () => {
	const root = repo();
	try {
		initializeStore(root);
		const db = new Database(canonicalStorePath(root));
		db.exec("PRAGMA foreign_keys=OFF");
		db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
			"missing",
			1,
			"test",
			"{}",
			"{}",
			"now",
		);
		db.exec("PRAGMA user_version=3");
		db.close();
		expect(() => initializeStore(root)).toThrow(/foreign-key check failed/);
		const failed = new Database(canonicalStorePath(root));
		expect(failed.query("PRAGMA user_version").get()).toEqual({
			user_version: 3,
		});
		failed.exec("PRAGMA foreign_keys=OFF");
		failed
			.query("DELETE FROM workflow_events WHERE workflow_id=?")
			.run("missing");
		failed.close();
		initializeStore(root);
		const recovered = new Database(canonicalStorePath(root));
		expect(recovered.query("PRAGMA user_version").get()).toEqual({
			user_version: STORE_SCHEMA_VERSION,
		});
		recovered.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("malformed canonical constraints and indexes are rejected", () => {
	const root = repo();
	try {
		initializeStore(root);
		const db = new Database(canonicalStorePath(root));
		db.exec("PRAGMA user_version=0");
		db.exec(
			"ALTER TABLE workflow_instances RENAME TO workflow_instances_valid",
		);
		db.exec(
			"CREATE TABLE workflow_instances(id TEXT PRIMARY KEY, change_id TEXT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0), definition_digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('active')), current_step TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		db.exec("DROP TABLE workflow_instances_valid");
		db.close();
		expect(() => initializeStore(root)).toThrow(
			/unsupported (constraints|table definition)/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("malformed canonical index columns are rejected", () => {
	const root = repo();
	try {
		initializeStore(root);
		const db = new Database(canonicalStorePath(root));
		db.exec("DROP INDEX workflow_runs_workflow_status");
		db.exec(
			"CREATE INDEX workflow_runs_workflow_status ON workflow_runs(status)",
		);
		db.exec("PRAGMA user_version=0");
		db.close();
		expect(() => initializeStore(root)).toThrow(/unsupported index columns/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("symlinked legacy evidence parents are rejected", () => {
	const root = repo();
	const outside = fs.mkdtempSync(
		path.join(os.tmpdir(), "legacy-evidence-outside-"),
	);
	try {
		legacy(root, "parent-link", {
			phase: "apply",
			workflowType: "no-openspec",
			worktree: root,
		});
		fs.mkdirSync(path.join(outside, "parent-link"));
		fs.writeFileSync(
			path.join(outside, "parent-link", "request.md"),
			"external",
		);
		fs.symlinkSync(
			path.join(outside, "parent-link"),
			path.join(root, ".herdr-workflow", "parent-link"),
		);
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "parent-link");
		expect(engine.status(root, "parent-link").health.diagnostic).toContain(
			"unsafe legacy evidence",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("observation reports migration-required without importing legacy state", () => {
	const root = repo();
	try {
		legacy(root, "observed", {
			phase: "apply",
			workflowType: "no-openspec",
			worktree: root,
		});
		const engine = new WorkflowEngine(registerBuiltins());
		const view = engine.status(root, "observed");
		expect(view.definition.id).toBe("migration-required");
		const db = new Database(canonicalStorePath(root));
		expect(
			db
				.query("SELECT 1 FROM sqlite_master WHERE name='workflow_instances'")
				.get(),
		).toBeNull();
		expect(
			db.query("SELECT state FROM workflows WHERE change_id=?").get("observed"),
		).not.toBeNull();
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("recognized legacy phases migrate once into pinned schema and reissue active run", () => {
	const root = repo();
	try {
		legacy(root, "old", {
			changeId: "old",
			phase: "verify",
			repository: root,
			worktree: root,
			branch: "feature/old",
			baseBranch: "main",
			baseCommit: "abc",
			workflowType: "openspec-full",
			verificationRound: 2,
			panes: { worker: "stale" },
		});
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "old");
		const view = engine.status(root, "old");
		expect(view.revision).toBe(1);
		expect(view.definition.id).toBe("openspec-full");
		expect(view.currentStep.id).toBe("core.verification");
		expect(view.runs).toHaveLength(1);
		expect(view.runs[0]?.status).toBe("pending");
		const db = new Database(canonicalStorePath(root));
		expect(
			db
				.query(
					"SELECT type FROM workflow_events WHERE workflow_id=? AND revision=1",
				)
				.get(view.workflowId),
		).toEqual({ type: "legacy.migrated" });
		expect(
			db.query("SELECT state FROM workflows WHERE change_id=?").get("old"),
		).not.toBeNull();
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("every compatible legacy workflow type and phase maps deterministically", () => {
	const matrix: Record<string, string[]> = {
		standard: [
			"explore",
			"proposed",
			"apply",
			"fix",
			"triage",
			"verify",
			"paused",
			"developer-review",
			"archive",
			"committing",
			"completed",
			"closed",
		],
		"openspec-apply": [
			"apply",
			"fix",
			"triage",
			"verify",
			"paused",
			"developer-review",
			"archive",
			"committing",
			"completed",
			"closed",
		],
		"no-openspec": [
			"apply",
			"fix",
			"triage",
			"verify",
			"paused",
			"developer-review",
			"committing",
			"completed",
			"closed",
		],
	};
	for (const [workflowType, phases] of Object.entries(matrix))
		for (const phase of phases) {
			const root = repo();
			try {
				const change = `${workflowType}-${phase}`;
				legacy(root, change, {
					phase,
					workflowType,
					repository: root,
					worktree: root,
					branch: "feature",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				});
				const engine = new WorkflowEngine(registerBuiltins());
				engine.initialize(root, change);
				const view = engine.status(root, change);
				expect(view.definition.id).toBe(
					workflowType === "standard" ? "openspec-full" : workflowType,
				);
				expect(view.health.valid).toBe(true);
				expect(view.status).toBe(
					phase === "paused"
						? "paused"
						: phase === "completed"
							? "completed"
							: phase === "closed"
								? "closed"
								: "active",
				);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
});

test("equivalent legacy mirrors migrate once", () => {
	const root = repo();
	const worktree = path.join(root, "legacy-worktree");
	fs.mkdirSync(path.join(worktree, ".herdr-workflow"), { recursive: true });
	try {
		const state = {
			phase: "apply",
			workflowType: "no-openspec",
			repository: root,
			worktree,
			branch: "one",
			baseBranch: "main",
			baseCommit: "a",
			task: "task",
			panes: { worker: "one" },
		};
		legacy(root, "same", state);
		const mirror = new Database(
			path.join(worktree, ".herdr-workflow", "herdr.db"),
			{ create: true },
		);
		mirror.exec(
			"CREATE TABLE workflows(change_id TEXT PRIMARY KEY,state TEXT NOT NULL)",
		);
		mirror.query("INSERT INTO workflows VALUES (?,?)").run(
			"same",
			JSON.stringify({
				...state,
				panes: { worker: "different transient pane" },
			}),
		);
		mirror.close();
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "same");
		expect(engine.status(root, "same").health.valid).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("conflicting legacy mirrors require repair instead of latest-wins", () => {
	const root = repo();
	const worktree = path.join(root, "legacy-worktree");
	fs.mkdirSync(path.join(worktree, ".herdr-workflow"), { recursive: true });
	try {
		legacy(root, "conflict", {
			phase: "apply",
			workflowType: "openspec-full",
			repository: root,
			worktree,
			branch: "one",
			baseBranch: "main",
			baseCommit: "a",
		});
		const mirror = new Database(
			path.join(worktree, ".herdr-workflow", "herdr.db"),
			{ create: true },
		);
		mirror.exec(
			"CREATE TABLE workflows(change_id TEXT PRIMARY KEY,state TEXT NOT NULL)",
		);
		mirror.query("INSERT INTO workflows VALUES (?,?)").run(
			"conflict",
			JSON.stringify({
				phase: "verify",
				workflowType: "openspec-full",
				repository: root,
				worktree,
				branch: "two",
				baseBranch: "main",
				baseCommit: "b",
			}),
		);
		mirror.close();
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "conflict");
		const view = engine.status(root, "conflict");
		expect(view.health.valid).toBe(false);
		expect(view.health.diagnostic).toContain("conflicting");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("unsafe legacy evidence requires repair", () => {
	const root = repo();
	try {
		const evidence = path.join(root, ".herdr-workflow", "unsafe");
		fs.mkdirSync(evidence, { recursive: true });
		fs.symlinkSync(
			path.join(root, "missing"),
			path.join(evidence, "request.md"),
		);
		legacy(root, "unsafe", {
			phase: "apply",
			workflowType: "no-openspec",
			repository: root,
			worktree: root,
			branch: "one",
			baseBranch: "main",
			baseCommit: "a",
			task: "task",
		});
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "unsafe");
		const view = engine.status(root, "unsafe");
		expect(view.health.valid).toBe(false);
		expect(view.health.diagnostic).toContain("unsafe legacy evidence");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("unknown legacy phase fails closed and preserves source", () => {
	const root = repo();
	try {
		legacy(root, "bad", {
			phase: "invented",
			repository: root,
			worktree: root,
		});
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "bad");
		const view = engine.status(root, "bad");
		expect(view.health.valid).toBe(false);
		expect(view.health.diagnostic).toContain("mapping failed");
		expect(view.availableActions).toEqual([]);
		const db = new Database(canonicalStorePath(root));
		expect(
			db.query("SELECT state FROM workflows WHERE change_id=?").get("bad"),
		).not.toBeNull();
		db.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
