// Named application composition roots (complete-workflow-effect-cutover,
// task 1): one production application layer composed at the CLI/dashboard
// root, one reusable dashboard application runtime, bounded disposal, and
// repository execution through child scopes. Mirrors the store/clock/config
// service seams used across the workflow runtime tests.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
	runCliProgram,
	WorkflowApplication,
} from "../src/workflow/application.ts";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	WorkflowClock,
	WorkflowConfig,
	WorkflowStore,
} from "../src/workflow/runtime/services.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

const FIXED_NOW = "2026-01-02T00:00:00.000Z";

function repository(root: string): void {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	fs.writeFileSync(path.join(root, "README.md"), "test\n");
	fs.mkdirSync(path.join(root, "openspec"));
	fs.writeFileSync(
		path.join(root, "openspec", "config.yaml"),
		"schema: spec-driven\n",
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
}

describe("workflow application composition roots (complete-workflow-effect-cutover)", () => {
	test("applicationLayer composes store, clock, and config services", () => {
		const program = Effect.gen(function* () {
			const store = yield* WorkflowStore;
			const clock = yield* WorkflowClock;
			const config = yield* WorkflowConfig;
			return {
				store: typeof store.transaction === "function",
				clock: clock.now().toISOString(),
				config: typeof config.load === "function",
			};
		});
		const result = runCliProgram(program, () => new Date(FIXED_NOW));
		expect(result).toEqual({
			store: true,
			clock: FIXED_NOW,
			config: true,
		});
	});

	test("one dashboard application runtime is reused and survives bounded disposal", () => {
		const app = new WorkflowApplication(() => new Date(FIXED_NOW));
		const read = Effect.gen(function* () {
			const clock = yield* WorkflowClock;
			return clock.now().toISOString();
		});
		const first = app.runSync(read);
		expect(first).toBe(FIXED_NOW);
		// Bounded disposal releases the runtime; a later operation re-acquires
		// the same production layer rather than failing.
		app.dispose();
		const second = app.runSync(read);
		expect(second).toBe(FIXED_NOW);
		app.dispose();
	});

	test("repository execution runs through a child scope and surfaces typed failures", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-app-"));
		repository(tmp);
		const app = new WorkflowApplication(() => new Date(FIXED_NOW));
		try {
			const program = Effect.gen(function* () {
				const store = yield* WorkflowStore;
				yield* store.initialize(tmp);
				const id = `wf-${randomUUID()}`;
				return yield* store.write(tmp, (db) => {
					db.query(
						"CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)",
					).run();
					db.query("INSERT INTO seen VALUES (?)").run(id);
					return id;
				});
			});
			const written = app.runSync(program);
			const observed = app.runSync(
				Effect.gen(function* () {
					const store = yield* WorkflowStore;
					return yield* store.write(tmp, (db) =>
						(
							db.query("SELECT id FROM seen").all() as Array<{ id: string }>
						).map((row) => row.id),
					);
				}),
			);
			expect(observed).toEqual([written]);
		} finally {
			app.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("the engine's Effect programs run at the application root (cutover seam)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-app-seam-"));
		repository(tmp);
		const app = new WorkflowApplication(() => new Date(FIXED_NOW));
		const engine = new WorkflowEngine(
			registerBuiltins(),
			app.clock,
			undefined,
			app.layerOf(),
		);
		try {
			// Read programs run at the root layer instead of a facade-owned
			// nested runtime; both surfaces must converge on the same views
			// (legacy/imported rows included), proving the seam shares one layer
			// and clock with the facade.
			const viaRoot = app.runSync(engine.listEffect(tmp));
			expect(engine.list(tmp)).toEqual(viaRoot);
			// Status for an unknown workflow is a soft diagnostic view, not a
			// throw — the same read both surfaces agree on.
			const status = app.runSync(engine.statusEffect(tmp, "wf-missing"));
			expect(status.health.valid).toBe(false);
			expect(status.health.diagnostic).toContain("store is absent");
		} finally {
			app.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("a typed WorkflowRuntimeError surfaces as the original error at the root", () => {
		const app = new WorkflowApplication(() => new Date(FIXED_NOW));
		expect(() =>
			app.runSync(
				Effect.fail(
					new WorkflowRuntimeError("invalid-input", "rejected at root"),
				),
			),
		).toThrow("rejected at root");
		app.dispose();
	});
});
