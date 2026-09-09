import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import {
	engineLayer,
	WorkflowStore,
} from "../src/workflow/runtime/services.ts";
import { canonicalStorePath } from "../src/workflow/runtime.ts";

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

describe("workflow store service", () => {
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
