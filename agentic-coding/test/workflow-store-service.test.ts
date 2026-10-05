import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { deleteWorkflow } from "../src/workflow/operations.ts";
import {
	engineLayer,
	WorkflowStore,
} from "../src/workflow/runtime/services.ts";
import { deleteWorkflowRows } from "../src/workflow/runtime/store.ts";
import {
	canonicalStorePath,
	WorkflowEngine,
	wikiWorkflowDataRoot,
} from "../src/workflow/runtime.ts";

// Real temporary SQLite store behind the live store layer: the same
// application program must run without consulting hidden production deps.
const layer = engineLayer(() => new Date("2026-01-01T00:00:00Z"));

function run<A>(
	effect: Effect.Effect<A, WorkflowRuntimeError, WorkflowStore>,
): A {
	const exit = Effect.runSyncExit(effect.pipe(Effect.provide(layer)));
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.failureOption(exit.cause);
	if (Option.isSome(failure)) throw failure.value;
	throw new WorkflowRuntimeError("unavailable", Cause.pretty(exit.cause));
}

function repository(root: string): string {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	fs.writeFileSync(path.join(root, "README.md"), "test\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}

function auditCount(db: Database): number {
	return (
		db.query("SELECT COUNT(*) AS count FROM workflow_security_audit").get() as {
			count: number;
		}
	).count;
}

function rowCount(db: Database, table: string): number {
	return (
		db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
			count: number;
		}
	).count;
}

/** One workflow with a row in every table that references it, so a delete has
 * something to remove in each child table. */
function seedWorkflow(db: Database, repo: string, workflowId: string): void {
	const at = "2026-01-01T00:00:00.000Z";
	db.query(
		"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		workflowId,
		null,
		repo,
		repo,
		"core",
		1,
		"digest",
		0,
		"active",
		"core.plan",
		"{}",
		at,
		at,
	);
	db.query(
		"INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		`${workflowId}-run`,
		workflowId,
		"core.plan",
		"planner",
		1,
		1,
		"pending",
		"{}",
		0,
		"[]",
		"hash",
		at,
		"/tmp/assignment",
		null,
		null,
		null,
		null,
		null,
		at,
		null,
	);
	db.query("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(
		workflowId,
		0,
		"workflow.started",
		"{}",
		"{}",
		at,
	);
	db.query(
		"INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		`${workflowId}-effect`,
		workflowId,
		0,
		"workspace.setup",
		`key-${workflowId}`,
		"{}",
		"pending",
		0,
		3,
		null,
		null,
		null,
		null,
	);
	db.query("INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)").run(
		`${workflowId}-audit`,
		workflowId,
		"test",
		"subject",
		"diagnostic",
		at,
	);
}

/** Journal-mode byte pair at the SQLite header offset: `0x02 0x02` is WAL, the
 * mode the retired runtime left behind on every store it wrote. */
function journalMode(file: string): string {
	return fs.readFileSync(file).subarray(18, 20).toString("hex");
}

describe("workflow store service", () => {
	test("a store left in WAL mode by the retired runtime opens and leaves WAL", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-wal-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
				}),
			);
			const file = canonicalStorePath(repo);
			// SQLite derives `-wal`/`-shm` from the filename it is given, so a WAL
			// store cannot be reached through a file descriptor path at all: every
			// open failed with `unable to open database file` until it left WAL.
			const legacy = new Database(file);
			legacy.exec("PRAGMA journal_mode=WAL");
			legacy.close();
			expect(journalMode(file)).toBe("0202");

			// Observation cannot convert a store, so it diagnoses instead of passing
			// SQLite's message through; the next write open leaves WAL.
			const observed = Effect.runSyncExit(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					return yield* store.observed(repo);
				}).pipe(Effect.provide(layer)),
			);
			expect(Exit.isFailure(observed)).toBe(true);
			if (Exit.isFailure(observed)) {
				const failure = Cause.failureOption(observed.cause);
				expect(Option.isSome(failure) && failure.value.code).toBe(
					"migration-required",
				);
			}

			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
					expect((yield* store.observed(repo))?.version).toBeGreaterThan(0);
				}),
			);
			expect(journalMode(file)).toBe("0101");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("transaction commits writes and releases the handle", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-commit-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
				}),
			);
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.transaction(repo, (db) => {
						db.query(
							"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
						).run(randomUUID(), null, "test", "subject", "diagnostic", "now");
					});
				}),
			);
			const db = new Database(canonicalStorePath(repo));
			try {
				expect(auditCount(db)).toBe(1);
			} finally {
				db.close();
			}
			// The handle was released: a follow-up transaction works without a lock.
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.transaction(repo, (db) => {
						db.query(
							"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
						).run(randomUUID(), null, "test", "subject", "diagnostic", "now");
					});
				}),
			);
			expect(fs.existsSync(canonicalStorePath(repo))).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("deleting a workflow removes every row it owns and leaves the others", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-delete-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
					yield* store.transaction(repo, (db) => {
						seedWorkflow(db, repo, "wf-1");
						seedWorkflow(db, repo, "wf-2");
					});
					const removed = yield* store.transaction(repo, (db) =>
						deleteWorkflowRows(db, "wf-1"),
					);
					expect(removed).toBe(1);
					const remaining = yield* store.transaction(repo, (db) => ({
						instances: rowCount(db, "workflow_instances"),
						runs: rowCount(db, "workflow_runs"),
						events: rowCount(db, "workflow_events"),
						outbox: rowCount(db, "workflow_outbox"),
						audit: rowCount(db, "workflow_security_audit"),
					}));
					expect(remaining).toEqual({
						instances: 1,
						runs: 1,
						events: 1,
						outbox: 1,
						audit: 1,
					});
					// A workflow that is already gone reports 0, so the caller can
					// surface not-found instead of a silent success.
					expect(
						yield* store.transaction(repo, (db) =>
							deleteWorkflowRows(db, "wf-1"),
						),
					).toBe(0);
				}),
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("deleting a workflow never removes the shared wiki/research data root", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-shared-root-"));
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const repo = repository(path.join(tmp, "repo"));
			const shared = wikiWorkflowDataRoot();
			fs.mkdirSync(shared, { recursive: true });
			const marker = path.join(shared, "herdr.db");
			fs.writeFileSync(marker, "every workflow's rows live here");
			const profile = {
				name: "test",
				runtime: "pi-durable" as const,
				executable: "sh",
				tools: [],
				extensions: [],
				readOnly: false,
				capabilities: ["prompt", "run-environment", "observe"] as const,
				digest: "profile",
			};
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				workflowId: "shared-root",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: {
					defaultProfile: "test",
					routes: [{ stepId: "core.implementation", role: "worker", profile }],
					diversity: [],
				},
			});
			// A repository-independent row that predates the shared store keeps the
			// shared root in its worktree column while its rows live in a
			// repository: removing that path would take every other wiki/research
			// workflow's state with it, so the delete must leave it alone.
			const db = new Database(canonicalStorePath(repo));
			db.query("UPDATE workflow_instances SET worktree=? WHERE id=?").run(
				shared,
				started.view.workflowId,
			);
			db.close();

			const deletion = await deleteWorkflow(repo, started.view.workflowId);

			expect(deletion).toEqual({ worktreeRemoved: false });
			expect(fs.readFileSync(marker, "utf8")).toBe(
				"every workflow's rows live here",
			);
			expect(() => engine.status(repo, started.view.workflowId)).toThrow(
				WorkflowRuntimeError,
			);
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("transaction failure rolls back every write and surfaces the typed failure", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-rollback-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
				}),
			);
			expect(() =>
				run(
					Effect.gen(function* () {
						const store = yield* WorkflowStore;
						yield* store.transaction(repo, (db) => {
							db.query(
								"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
							).run(randomUUID(), null, "test", "subject", "diagnostic", "now");
							throw new WorkflowRuntimeError("invalid-input", "boom");
						});
					}),
				),
			).toThrow(WorkflowRuntimeError);
			const db = new Database(canonicalStorePath(repo));
			try {
				expect(auditCount(db)).toBe(0);
			} finally {
				db.close();
			}
			// Rollback released the handle: the next mutation commits cleanly.
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.transaction(repo, (db) => {
						db.query(
							"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
						).run(randomUUID(), null, "test", "subject", "diagnostic", "now");
					});
				}),
			);
			const after = new Database(canonicalStorePath(repo));
			try {
				expect(auditCount(after)).toBe(1);
			} finally {
				after.close();
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("absent store fails closed and is never created by a read/transaction", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-absent-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			// Observation metadata on an absent store returns undefined, no init.
			const observed = run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					return yield* store.observed(repo);
				}),
			);
			expect(observed).toBeUndefined();
			expect(() =>
				run(
					Effect.gen(function* () {
						const store = yield* WorkflowStore;
						yield* store.transaction(repo, (db) => {
							db.query(
								"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
							).run(randomUUID(), null, "test", "subject", "diagnostic", "now");
						});
					}),
				),
			).toThrow(/absent/);
			expect(fs.existsSync(canonicalStorePath(repo))).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("interruption is observed at transaction boundaries, never between writes", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-interrupt-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			run(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					yield* store.initialize(repo);
				}),
			);
			let rows = 0;
			const exit = Effect.runSyncExit(
				Effect.interrupt
					.pipe(
						Effect.flatMap(() =>
							Effect.gen(function* () {
								const store = yield* WorkflowStore;
								yield* store.transaction(repo, (db) => {
									rows += 1;
									db.query(
										"INSERT INTO workflow_security_audit VALUES (?,?,?,?,?,?)",
									).run(
										randomUUID(),
										null,
										"test",
										"subject",
										"diagnostic",
										"now",
									);
								});
							}),
						),
					)
					.pipe(Effect.provide(layer)),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(rows).toBe(0);
			const db = new Database(canonicalStorePath(repo));
			try {
				expect(auditCount(db)).toBe(0);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
