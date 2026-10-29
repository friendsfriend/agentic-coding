// Deterministic temporary stores only. No adapters, hosts or models are run.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedProfile } from "../src/contracts/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import { createRepoFixture, repoPreset } from "./support/git-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
const profile: ResolvedProfile = {
	name: "test",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt"],
	digest: "test-profile",
};
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-isolation-"));
	roots.push(root);
	const repo = createRepoFixture(
		path.join(root, "repo"),
		repoPreset.specDriven,
	);
	fs.appendFileSync(
		path.join(repo, ".git/info/exclude"),
		"\n.herdr-workflow/\n",
	);
	const time = new Date("2026-01-02T09:00:00Z");
	const engine = new WorkflowEngine(registerBuiltins(), () => time);
	const start = (workflowId: string) =>
		engine.start({
			repo,
			workflowId,
			definitionId: "solo",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "HEAD",
				task: "test only",
			},
			routing: {
				defaultProfile: "test",
				routes: [{ stepId: "core.implementation", profile }],
			},
		});
	return { repo, engine, start, time };
}
function ownerState(db: Database, workflowId: string) {
	return {
		instance: db
			.query("SELECT * FROM workflow_instances WHERE id=?")
			.get(workflowId),
		runs: db
			.query("SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY rowid")
			.all(workflowId),
		effects: db
			.query("SELECT * FROM workflow_outbox WHERE workflow_id=? ORDER BY rowid")
			.all(workflowId),
		events: db
			.query("SELECT * FROM workflow_events WHERE workflow_id=? ORDER BY rowid")
			.all(workflowId),
	};
}

describe("repository-wide effect claim fault isolation", () => {
	for (const stalePosition of ["first", "last", "live-current"] as const) {
		test(`an expired-attempt launch (${stalePosition}) cannot block healthy workflows or claim its owner's other work`, () => {
			const f = fixture();
			const broken = f.start("broken");
			const oldRun = broken.view.runs[0];
			if (!oldRun) throw new Error("fixture must start an implementation run");
			const db = new Database(canonicalStorePath(f.repo));
			try {
				// Reproduce historical corruption after manual step re-entry. Repair
				// now retires the failed launch, so explicitly revive that old row
				// only in this isolated fixture to retain dispatcher containment coverage.
				db.query(
					"UPDATE workflow_outbox SET status='failed' WHERE workflow_id=? AND kind='agent.launch'",
				).run("broken");
				f.engine.dispatch(f.repo, {
					type: "operator.repair",
					workflowId: "broken",
					revision: broken.view.revision,
					targetStep: "core.implementation",
					reason: "fixture re-entry",
				});
				db.query(
					"UPDATE workflow_outbox SET status='retry' WHERE workflow_id=? AND status='expired' AND kind='agent.launch' AND json_extract(payload_json,'$.runId')=?",
				).run("broken", oldRun.id);
				expect(f.engine.getRun(f.repo, oldRun.id).status).toBe("expired");
				if (stalePosition === "last") {
					// A healthy-looking row can precede the invalid launch. Preflight
					// must finish before claiming any work for this owner.
					db.query(
						"INSERT INTO workflow_outbox SELECT id || '-late',workflow_id,revision,kind,idempotency_key || '-late',payload_json,status,attempts,max_attempts,next_attempt_at,lease,lease_expires_at,last_error FROM workflow_outbox WHERE workflow_id=? AND status='retry'",
					).run("broken");
					db.query(
						"DELETE FROM workflow_outbox WHERE workflow_id=? AND status='retry' AND id NOT LIKE '%-late'",
					).run("broken");
				}
				if (stalePosition === "live-current") {
					// Match the production failure: an old expired-attempt retry
					// alongside a claimed launch for the current pending run.
					db.query(
						"UPDATE workflow_outbox SET status='running',attempts=1,lease='current-owner',lease_expires_at=? WHERE workflow_id=? AND status='pending' AND kind='agent.launch'",
					).run("2999-01-01T00:00:00Z", "broken");
				}
				f.start("healthy-one");
				f.start("healthy-two");
				const before = ownerState(db, "broken");
				const claimed = f.engine.claimEffects(f.repo, 100);
				expect(new Set(claimed.map((effect) => effect.workflowId))).toEqual(
					new Set(["healthy-one", "healthy-two"]),
				);
				expect(ownerState(db, "broken")).toEqual(before);
				expect(f.engine.claimEffects(f.repo, 100)).toEqual([]);
				expect(ownerState(db, "broken")).toEqual(before);
				// Restarting the engine and using the production serial claim limit
				// still admits another workflow without touching the invalid owner.
				f.start("healthy-three");
				const restarted = new WorkflowEngine(registerBuiltins(), () => f.time);
				expect(restarted.claimEffects(f.repo, 1)[0]?.workflowId).toBe(
					"healthy-three",
				);
				expect(ownerState(db, "broken")).toEqual(before);
			} finally {
				db.close();
			}
		});
	}

	test("an invalid snapshot and a live owner-held launch do not block healthy siblings or lose their lease", () => {
		const f = fixture();
		const broken = f.start("broken-snapshot");
		const db = new Database(canonicalStorePath(f.repo));
		try {
			const run = broken.view.runs[0];
			if (!run) throw new Error("missing fixture run");
			// Deliberate structural damage, confined to this temporary fixture.
			db.query("UPDATE workflow_runs SET status='expired' WHERE id=?").run(
				run.id,
			);
			db.query(
				"UPDATE workflow_outbox SET status='running',attempts=1,lease='live-owner',lease_expires_at=? WHERE workflow_id=? AND kind='agent.launch'",
			).run("2999-01-01T00:00:00Z", "broken-snapshot");
			f.start("healthy");
			const before = ownerState(db, "broken-snapshot");
			const claimed = f.engine.claimEffects(f.repo, 100);
			expect(claimed.length).toBeGreaterThan(0);
			expect(claimed.every((effect) => effect.workflowId === "healthy")).toBe(
				true,
			);
			expect(ownerState(db, "broken-snapshot")).toEqual(before);
		} finally {
			db.close();
		}
	});
});
