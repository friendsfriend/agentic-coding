import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
