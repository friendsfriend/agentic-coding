import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";

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
			workflowType: "standard",
			verificationRound: 2,
			panes: { worker: "stale" },
		});
		const engine = new WorkflowEngine(registerBuiltins());
		const view = engine.status(root, "old");
		expect(view.revision).toBe(1);
		expect(view.definition.id).toBe("standard");
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
		"direct-apply": [
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
				const view = new WorkflowEngine(registerBuiltins()).status(
					root,
					change,
				);
				expect(view.definition.id).toBe(workflowType);
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
		expect(
			new WorkflowEngine(registerBuiltins()).status(root, "same").health.valid,
		).toBe(true);
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
			workflowType: "standard",
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
				workflowType: "standard",
				repository: root,
				worktree,
				branch: "two",
				baseBranch: "main",
				baseCommit: "b",
			}),
		);
		mirror.close();
		const view = new WorkflowEngine(registerBuiltins()).status(
			root,
			"conflict",
		);
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
		const view = new WorkflowEngine(registerBuiltins()).status(root, "unsafe");
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
		const view = new WorkflowEngine(registerBuiltins()).status(root, "bad");
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
