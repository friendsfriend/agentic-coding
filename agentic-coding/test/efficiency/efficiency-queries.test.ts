import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeDataset } from "../../scripts/efficiency/lib/dataset.ts";
import { extractTables } from "../../scripts/efficiency/lib/extract.ts";
import { QUERIES, queryByName } from "../../scripts/efficiency/lib/queries.ts";
import {
	type FixtureEvidence,
	makeFixtureEvidence,
	makeTempDir,
} from "./fixture.ts";

let fixture: FixtureEvidence;
let out: { path: string; cleanup(): void };
let datasetPath = "";

beforeAll(() => {
	fixture = makeFixtureEvidence();
	out = makeTempDir("efficiency-queries-");
	datasetPath = writeDataset({
		outDir: out.path,
		tables: extractTables({ evidenceDir: fixture.root }).tables,
		meta: { builtAt: "test" },
	}).path;
});

afterAll(() => {
	fixture.cleanup();
	out.cleanup();
});

describe("ready-made queries", () => {
	test("every documented query runs against the dataset", () => {
		const db = new Database(datasetPath, { readonly: true });
		try {
			for (const query of QUERIES) {
				const sql = query.limitable ? `${query.sql}\nLIMIT 25` : query.sql;
				const rows = db.query<Record<string, unknown>, []>(sql).all();
				expect(Array.isArray(rows)).toBe(true);
				for (const column of query.columns)
					if (rows.length > 0) expect(rows[0]).toHaveProperty(column);
			}
		} finally {
			db.close();
		}
	});

	test("repeated-reads finds the twice-read path in the fixture", () => {
		const query = QUERIES.find((entry) => entry.name === "repeated-reads");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<{ path_digest: string; reads: number }, []>(`${query?.sql}`)
				.all();
			const hit = rows.find((row) => row.path_digest === "read src/dup.ts");
			expect(hit?.reads).toBe(2);
		} finally {
			db.close();
		}
	});

	test("turn-gaps only reports a gap it can measure", () => {
		const query = QUERIES.find((entry) => entry.name === "turn-gaps");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<{ gap_seconds: number | null }, []>(`${query?.sql}`)
				.all();
			for (const row of rows) expect(row.gap_seconds).not.toBeNull();
		} finally {
			db.close();
		}
	});

	test("orientation-cost counts a run without an artifact as no orientation, not all of it", () => {
		const query = QUERIES.find((entry) => entry.name === "orientation-cost");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						runs_with_artifact: number;
						turns_before: number;
						cost_before: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			// No fixture run writes an artifact, so every run contributes nothing to
			// the orientation half rather than being counted as all orientation.
			for (const row of rows) {
				expect(row.runs_with_artifact).toBe(0);
				expect(row.turns_before).toBe(0);
				expect(row.cost_before).toBe(0);
			}
		} finally {
			db.close();
		}
	});

	test("cache-expiry buckets every measurable gap and never loses a turn", () => {
		const query = QUERIES.find((entry) => entry.name === "cache-expiry");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						idle_bucket: string;
						turns: number;
						avg_gap_seconds: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			// Buckets are disjoint and ordered by their lower bound.
			expect(rows.map((row) => row.idle_bucket)).toEqual([
				...new Set(rows.map((row) => row.idle_bucket)),
			]);
			expect(rows.length).toBeGreaterThan(0);
			// Every bucketed turn carries a real gap.
			for (const row of rows) expect(row.avg_gap_seconds).toBeGreaterThan(0);
			// The same turns the `turn-gaps` query measures, counted once.
			const gaps = db
				.query<{ gap_seconds: number }, []>(
					`${QUERIES.find((entry) => entry.name === "turn-gaps")?.sql}`,
				)
				.all();
			expect(rows.reduce((total, row) => total + row.turns, 0)).toBe(
				gaps.filter((gap) => gap.gap_seconds > 0).length,
			);
		} finally {
			db.close();
		}
	});

	test("orientation-cost splits a run that writes an artifact after some turns", () => {
		const query = QUERIES.find((entry) => entry.name === "orientation-cost");
		const out = makeTempDir("efficiency-orientation-");
		const copy = path.join(out.path, "dataset.sqlite");
		fs.copyFileSync(datasetPath, copy);
		const db = new Database(copy, { readwrite: true });
		try {
			// run-span-a has two turns; a write at turn 1 makes turn 0 the orientation.
			db.run(
				`INSERT INTO tool_calls (run_id, run_label, workflow_id, source, source_rank, turn_index, dedupe_key, tool, ok, confidence, preferred)
				 VALUES ('run-span-a', null, null, 'herdr.main-store', 190, 1, 'synthetic-write', 'write', 1, 'exact', 1)`,
			);
			const row = db
				.query<
					{
						role: string | null;
						runs_with_artifact: number;
						turns_before: number;
						cost_before: number;
						cost_share_before: number;
					},
					[]
				>(`${query?.sql}`)
				.all()
				.find((entry) => entry.role === "worker");
			expect(row).toBeDefined();
			expect(row?.runs_with_artifact).toBe(1);
			expect(row?.turns_before).toBe(1);
			expect(row?.cost_before).toBeGreaterThan(0);
			expect(row?.cost_share_before).toBeGreaterThan(0);
			expect(row?.cost_share_before).toBeLessThan(1);
		} finally {
			db.close();
			out.cleanup();
		}
	});

	test("reconciliation treats a differing turn count as a difference, not an error", () => {
		const query = QUERIES.find((entry) => entry.name === "reconciliation");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<{ run_id: string; source: string; turns: number }, []>(
					`${query?.sql}`,
				)
				.all();
			const isB = rows.filter((row) => row.run_id === "run-span-b");
			expect(isB.map((row) => row.turns).sort()).toEqual([1, 1, 2]);
			const isA = rows.filter((row) => row.run_id === "run-span-a");
			expect(new Set(isA.map((row) => row.turns)).size).toBe(1);
		} finally {
			db.close();
		}
	});

	test("edit-latency treats a run without an edit as all orientation", () => {
		const query = queryByName("edit-latency");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						run_id: string;
						calls: number;
						first_edit_call: number | null;
						pre_edit_calls: number;
						pre_edit_call_pct: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			const start = rows.find((row) => row.run_id === "run-span-a");
			expect(start?.first_edit_call).toBeNull();
			expect(start?.pre_edit_calls).toBe(start?.calls);
			expect(start?.pre_edit_call_pct).toBe(100);
		} finally {
			db.close();
		}
	});

	test("verifier-rounds groups verifiers dispatched together into one round", () => {
		const query = QUERIES.find((entry) => entry.name === "verifier-rounds");
		expect(query).toBeDefined();
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE v_runs (run_id TEXT, workflow_id TEXT, role TEXT, started_at TEXT);
				CREATE TABLE v_turns (run_id TEXT, cost REAL);
				CREATE TABLE v_tool_calls (run_id TEXT);
				INSERT INTO v_runs VALUES
					('r1', 'wf-a', 'quality-verifier', '2026-01-01T10:00:00.000Z'),
					('r2', 'wf-a', 'security-verifier', '2026-01-01T10:00:03.000Z'),
					('r3', 'wf-a', 'quality-verifier', '2026-01-01T10:40:00.000Z'),
					('r4', 'wf-a', 'worker', '2026-01-01T11:00:00.000Z');
				INSERT INTO v_turns VALUES ('r1', 0.5), ('r1', 0.5), ('r2', 1.0), ('r3', 0.25);
				INSERT INTO v_tool_calls VALUES ('r1'), ('r2'), ('r2'), ('r3');
			`);
			const rows = db
				.query<
					{
						workflow_id: string;
						round_index: number;
						roles: number;
						runs: number;
						turns: number;
						tool_calls: number;
						cost: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.round_index)).toEqual([1, 2]);
			expect(rows[0]).toMatchObject({
			const rounds = rows.filter((row) => row.workflow_id === "wf-a");
			expect(rounds.map((row) => row.round_index)).toEqual([1, 2]);
			expect(rounds[0]).toMatchObject({
			expect(rows.length).toBeGreaterThan(0);
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.round_index)).toEqual([1, 2]);
			expect(rows[0]).toMatchObject({
				workflow_id: "wf-a",
				roles: 2,
				runs: 2,
				turns: 3,
				tool_calls: 3,
				cost: 2,
			});
			expect(rows[1]).toMatchObject({ roles: 1, runs: 1, cost: 0.25 });
			expect(rounds[1]).toMatchObject({ roles: 1, runs: 1, cost: 0.25 });
		} finally {
			db.close();
		}
	});

	test("bash-vs-tools counts only arguments that survived into a digest", () => {
		const query = queryByName("bash-vs-tools");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						run_id: string;
						bash_calls: number;
						shell_for_a_tool: number;
						shell_share_pct: number;
						read_tool: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			const hit = rows.find((row) => row.run_id === "run-span-a");
			expect(hit?.bash_calls).toBe(1);
			expect(hit?.shell_for_a_tool).toBe(1);
			expect(hit?.shell_share_pct).toBe(100);
			expect(hit?.read_tool).toBe(1);
		} finally {
			db.close();
		}
	});

	test("stalled-runs reports only runs at or below two turns", () => {
		const query = queryByName("stalled-runs");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<{ run_id: string; turns: number; calls: number }, []>(
					`${query?.sql}`,
				)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.turns).toBeLessThanOrEqual(2);
			expect(rows.some((row) => row.run_id === "run-span-b")).toBe(true);
		} finally {
			db.close();
		}
	});

	test("source-gaps reports a file that parsed nothing and stays quiet about the rest", () => {
		const query = queryByName("source-gaps");
		expect(query).toBeDefined();
		const out = makeTempDir("efficiency-source-gaps-");
	test("run-window-drift reports a session that outlived its run window", () => {
		const query = queryByName("run-window-drift");
		expect(query).toBeDefined();
		const out = makeTempDir("efficiency-window-drift-");
		const copy = path.join(out.path, "dataset.sqlite");
		fs.copyFileSync(datasetPath, copy);
		const db = new Database(copy, { readwrite: true });
		try {
			// The fixture parses every file it ships, so the query is empty until a
			// source goes missing the way a read-only open of a WAL snapshot does.
			expect(
				db.query<{ path: string }, []>(`${query?.sql}`).all(),
			).toHaveLength(0);
			db.run(
				`INSERT INTO source_files (source, path, kind, records, parsed, skipped, note)
				 VALUES ('harness.wiki', 'wiki-workflows/harness.sqlite', 'harness', 0, 0, 0, 'unreadable: unable to open database file')`,
			);
			const rows = db
				.query<{ source: string; path: string; note: string | null }, []>(
					`${query?.sql}`,
				)
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.source).toBe("harness.wiki");
			expect(rows[0]?.note).toContain("unreadable");
		} finally {
			db.close();
			out.cleanup();
	test("delivery-timeline measures the latencies it has and leaves the rest null", () => {
		const query = queryByName("delivery-timeline");
		const copy = makeTempDir("efficiency-delivery-");
		const file = path.join(copy.path, "dataset.sqlite");
		fs.copyFileSync(datasetPath, file);
		const db = new Database(file);
		try {
			const insert = db.query(
				`INSERT INTO events (workflow_id, source, source_rank, at, event, event_class, step_id, confidence, preferred)
				 VALUES (?, 'test', 1, ?, ?, ?, ?, 'exact', 1)`,
			);
			const rows: readonly [string, string, string, string, string][] = [
				[
					"wf-delivery",
					"2026-08-01T09:30:00.000Z",
					"agent.handoff",
					"handoff",
					"core.wiki-approval",
				],
				[
					"wf-delivery",
					"2026-08-01T10:00:00.000Z",
					"archive_started",
					"delivery",
					"",
				],
				[
					"wf-delivery",
					"2026-08-01T10:00:20.000Z",
					"archive_completed",
					"delivery",
					"",
				],
				[
					"wf-delivery",
					"2026-08-01T10:00:20.100Z",
					"git_operations_started",
					"delivery",
					"",
				],
				[
					"wf-delivery",
					"2026-08-01T10:00:23.100Z",
					"git_operations_pushed",
					"delivery",
					"",
				],
				[
					"wf-delivery",
					"2026-08-01T10:10:23.100Z",
					"workflow_closed",
					"delivery",
					"",
				],
				[
					"wf-delivery",
					"2026-08-01T10:30:00.000Z",
					"developer.action",
					"gate",
					"core.archive",
				],
				[
					"wf-delivery",
					"2026-08-01T10:00:21.000Z",
					"effect.result",
					"effect",
					"",
				],
				[
					"wf-failed",
					"2026-08-02T09:00:00.000Z",
					"git_operations_started",
					"delivery",
					"",
				],
				[
					"wf-failed",
					"2026-08-02T09:00:01.000Z",
					"git_operations_failed",
					"delivery",
					"",
				],
				[
					"wf-failed",
					"2026-08-02T09:00:12.000Z",
					"git_operations_started",
					"delivery",
					"",
				],
				[
					"wf-failed",
					"2026-08-02T09:00:13.000Z",
					"git_operations_failed",
					"delivery",
					"",
				],
			];
			for (const [workflow, at, event, eventClass, stepId] of rows)
				insert.run(workflow, at, event, eventClass, stepId);
			const measured = db
				.query<
					{
						workflow_id: string;
						archive_seconds: number | null;
						push_seconds: number | null;
						pushed_to_closed_minutes: number | null;
						wiki_approval_to_archive_minutes: number | null;
						effect_results: number;
						git_failures: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			const ok = measured.find((row) => row.workflow_id === "wf-delivery");
			expect(ok?.archive_seconds).toBe(20);
			expect(ok?.push_seconds).toBe(3);
			expect(ok?.pushed_to_closed_minutes).toBe(10);
			expect(ok?.wiki_approval_to_archive_minutes).toBe(60);
			expect(ok?.effect_results).toBe(1);
			expect(ok?.git_failures).toBe(0);
			const failed = measured.find((row) => row.workflow_id === "wf-failed");
			expect(failed?.archive_seconds).toBeNull();
			expect(failed?.push_seconds).toBeNull();
			expect(failed?.wiki_approval_to_archive_minutes).toBeNull();
			expect(failed?.git_failures).toBe(2);
		} finally {
			db.close();
			copy.cleanup();
			const target = db
				.query<{ run_id: string }, []>(
					`SELECT t.run_id AS run_id
					FROM v_turns t JOIN v_runs r ON r.run_id = t.run_id
					WHERE t.started_at IS NOT NULL AND r.completed_at IS NOT NULL
					GROUP BY t.run_id
					HAVING COUNT(*) > 1
					LIMIT 1`,
				)
				.get();
			if (!target) throw new Error("fixture has no run with turns");
			const clean = db
				.query<{ run_id: string; tail_seconds: number }, []>(`${query?.sql}`)
				.all();
			expect(clean.some((row) => row.run_id === target.run_id)).toBe(false);
			// A run whose recorded completion precedes its own last turn is a session
			// that outlived the run identity the telemetry kept attributing to it.
			db.run("UPDATE runs SET completed_at = ? WHERE run_id = ?", [
				"2000-01-01T00:00:00.000Z",
				target.run_id,
			]);
			const rows = db
				.query<{ run_id: string; tail_seconds: number }, []>(`${query?.sql}`)
				.all();
			const hit = rows.find((row) => row.run_id === target.run_id);
			expect(hit).toBeDefined();
			expect(hit?.tail_seconds).toBeGreaterThan(0);
		} finally {
			db.close();
			out.cleanup();
		}
	});
});
