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
	test("cache-expiry buckets every measurable gap and never loses a turn", () => {
		const query = QUERIES.find((entry) => entry.name === "cache-expiry");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						role: string | null;
						runs: number;
						runs_with_artifact: number;
						turns_before: number;
						cost_before: number;
						idle_bucket: string;
						turns: number;
						avg_gap_seconds: number;
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
			const start = rows.find((row) => row.run_id === "run-span-a");
			expect(start?.first_edit_call).toBeNull();
			expect(start?.pre_edit_calls).toBe(start?.calls);
			expect(start?.pre_edit_call_pct).toBe(100);
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
		} finally {
			db.close();
		}
	});
});
