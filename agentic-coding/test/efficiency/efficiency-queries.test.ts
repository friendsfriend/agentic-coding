import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeDataset } from "../../scripts/efficiency/lib/dataset.ts";
import { extractTables } from "../../scripts/efficiency/lib/extract.ts";
import { QUERIES } from "../../scripts/efficiency/lib/queries.ts";
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
						role: string | null;
						runs: number;
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
});
