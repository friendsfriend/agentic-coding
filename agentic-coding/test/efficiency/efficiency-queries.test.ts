import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeDataset } from "../../scripts/efficiency/lib/dataset.ts";
import { extractTables } from "../../scripts/efficiency/lib/extract.ts";
import { TOOL_FAILURE_KINDS } from "../../scripts/efficiency/lib/normalize.ts";
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

	test("archive-attempts flags the archive runs past the item's call ceiling", () => {
		const query = queryByName("archive-attempts");
		expect(query).toBeDefined();
		const copy = makeTempDir("efficiency-archive-attempts-");
		const file = path.join(copy.path, "dataset.sqlite");
		fs.copyFileSync(datasetPath, file);
		const db = new Database(file);
		try {
			const insertRun = db.query(
				`INSERT INTO runs (run_id, run_label, workflow_id, step_id, role, status, handoff_outcome, source, source_rank, sources, confidence, preferred)
				 VALUES (?, ?, 'wf-archive', 'core.archive', 'archive', 'completed', ?, 'test', 1, 'test', 'exact', 1)`,
			);
			insertRun.run("run-noisy", "noisy", "blocked");
			insertRun.run("run-clean", "clean", "complete");
			const insertCall = db.query(
				`INSERT INTO tool_calls (run_id, run_label, workflow_id, source, source_rank, call_id, dedupe_key, tool, ok, recording, confidence, preferred)
				 VALUES (?, ?, 'wf-archive', 'test', 1, ?, ?, 'read', 1, 'exact', 'exact', 1)`,
			);
			// 14 calls is past the archive budget's 12-call ceiling; 2 is not.
			for (let index = 0; index < 14; index += 1)
				insertCall.run("run-noisy", "noisy", `c${index}`, `noisy-${index}`);
			for (let index = 0; index < 2; index += 1)
				insertCall.run("run-clean", "clean", `d${index}`, `clean-${index}`);

			const rows = db
				.query<
					{
						run_id: string;
						calls: number;
						over_budget: number;
						handoff_outcome: string;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.map((row) => row.run_id)).toEqual(["run-noisy", "run-clean"]);
			expect(rows[0]).toMatchObject({
				calls: 14,
				over_budget: 1,
				handoff_outcome: "blocked",
			});
			expect(rows[1]).toMatchObject({
				calls: 2,
				over_budget: 0,
				handoff_outcome: "complete",
			});
		} finally {
			db.close();
			copy.cleanup();
		}
	});

	test("source-recording marks a failure-only generation instead of reporting a failure rate", () => {
		const query = queryByName("source-recording");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						source: string;
						month: string;
						recording: string;
						calls: number;
						ok: number;
						failed: number;
						unknown: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			// The fixture's legacy file carries one `tool_error` and no successful
			// call: the source+month+recording row must show it as a failure-only
			// record. The recording is part of the key, so the same source and month
			// in the span generation is a separate row rather than a tie.
			const legacy = rows.find(
				(row) =>
					row.source === "telemetry.main-store" &&
					row.month === "2026-01" &&
					row.recording === "legacy",
			);
			expect(legacy).toBeDefined();
			expect(legacy?.calls).toBeGreaterThan(0);
			expect(legacy?.ok).toBe(0);
			expect(legacy?.failed).toBe(legacy?.calls);
			// A modern source in the same dataset does record successes.
			const modern = rows.find((row) => row.source === "harness.worktree");
			expect(modern?.ok).toBeGreaterThan(0);
			expect(modern?.recording).toBe("harness");
		} finally {
			db.close();
		}
	});

	test("source-recording reports the per-generation share of the recorded fields", () => {
		const query = queryByName("source-recording");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						source: string;
						recording: string;
						calls: number;
						with_args: number;
						with_result_size: number;
						with_duration: number;
						args_pct: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			// The harness generation records every field of every call.
			const harness = rows.find((row) => row.recording === "harness");
			expect(harness).toBeDefined();
			expect(harness?.with_args).toBe(harness?.calls);
			expect(harness?.with_duration).toBe(harness?.calls);
			expect(harness?.args_pct).toBe(100);
			// The fixture's legacy generation records neither arguments nor sizes:
			// the share is the honest 0, not an assumed 100.
			const legacy = rows.find((row) => row.recording === "legacy");
			expect(legacy?.with_args).toBe(0);
			expect(legacy?.args_pct).toBe(0);
		} finally {
			db.close();
		}
	});

	test("failure-kinds reports failures per 100 calls for the kinds it can name", () => {
		const query = queryByName("failure-kinds");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						role: string;
						tool: string;
						failure_kind: string;
						calls: number;
						failed: number;
						failures_per_100_calls: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			for (const row of rows) {
				expect(row.failures_per_100_calls).toBeGreaterThan(0);
				expect(row.failures_per_100_calls).toBeLessThanOrEqual(100);
				expect(row.failed).toBeLessThanOrEqual(row.calls);
				// Only the documented vocabulary ever reaches the column.
				expect(TOOL_FAILURE_KINDS.has(row.failure_kind)).toBe(true);
			}
		} finally {
			db.close();
		}
	});

	test("compactions reports the kinds of compaction and the peak context per run", () => {
		const query = queryByName("compactions");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db.query(`${query?.sql}`).all() as Array<{
				workflow_id: string;
				run_id: string;
				role: string;
				auto_ceiling: number;
				auto_overflow: number;
				manual: number;
				peak_context_tokens: number;
				cost: number;
			}>;
			const run = rows.find((row) => row.run_id === "run-ceil-a");
			expect(run).toBeDefined();
			expect(run?.auto_ceiling).toBe(1);
			expect(run?.auto_overflow).toBe(1);
			expect(run?.manual).toBe(1);
			// The peak context is the measured request: input plus the cache read it
			// carried, which is what the ceiling is compared against.
			expect(run?.peak_context_tokens).toBe(190000);
			// A run whose only compaction was the ceiling still reports it, so
			// "automatic compactions > 0" is answerable per run.
			const second = rows.find((row) => row.run_id === "run-ceil-b");
			expect(second?.auto_ceiling).toBe(1);
			expect(second?.auto_overflow).toBe(0);
			expect(second?.manual).toBe(0);
		} finally {
			db.close();
		}
	});

	test("repeats-per-run counts the extra calls of an exact repeat", () => {
		const query = queryByName("repeats-per-run");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						run_id: string;
						with_args: number;
						repeat_groups: number;
						repeated_calls: number;
						repeated_calls_per_100: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.repeated_calls).toBeGreaterThan(0);
				expect(row.repeated_calls).toBeLessThan(row.with_args);
				expect(row.repeated_calls_per_100).toBeGreaterThan(0);
				expect(row.repeated_calls_per_100).toBeLessThan(100);
			}
			// The twice-read path of the fixture is one repeat group.
			const twice = rows.find((row) => row.repeated_calls === 1);
			expect(twice).toBeDefined();
		} finally {
			db.close();
		}
	});

	test("triage-economics separates the triage cost from the verification it gates", () => {
		const query = queryByName("triage-economics");
		expect(query).toBeDefined();
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<
					{
						month: string;
						role_group: string;
						runs: number;
						turns: number;
						cost: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.length).toBeGreaterThan(0);
			const groups = new Set(rows.map((row) => row.role_group));
			expect(groups.has("worker")).toBe(true);
			// Every row is one month and one role group, never a double count.
			const total = rows.reduce((sum, row) => sum + row.runs, 0);
			const all = db
				.query<{ runs: number }, []>("SELECT COUNT(*) AS runs FROM v_runs")
				.get();
			expect(total).toBe(all?.runs ?? -1);
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
						runs_with_artifact: number;
						turns_before: number;
						cost_before: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
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
						role: string | null;
						runs: number;
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
				`INSERT INTO tool_calls (run_id, run_label, workflow_id, source, source_rank, turn_index, dedupe_key, tool, ok, recording, confidence, preferred)
				 VALUES ('run-span-a', null, null, 'herdr.main-store', 190, 1, 'synthetic-write', 'write', 1, 'harness', 'exact', 1)`,
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

	test("verification-rounds-recorded separates recorded rounds from reconstructed ones", () => {
		const query = queryByName("verification-rounds-recorded");
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE v_events (workflow_id TEXT, source TEXT, event TEXT);
				CREATE TABLE v_runs (run_id TEXT, workflow_id TEXT, source TEXT, role TEXT, started_at TEXT);
				-- wf-recorded: two rounds, both recorded.
				INSERT INTO v_runs VALUES
					('a1', 'wf-recorded', 'herdr', 'quality-verifier', '2026-01-01T10:00:00.000Z'),
					('a2', 'wf-recorded', 'herdr', 'test-verifier', '2026-01-01T10:00:30.000Z'),
					('a3', 'wf-recorded', 'herdr', 'quality-verifier', '2026-01-01T10:40:00.000Z');
				INSERT INTO v_events VALUES
					('wf-recorded', 'herdr', 'verification_round'),
					('wf-recorded', 'herdr', 'verification_round'),
					('wf-recorded', 'herdr', 'agent.handoff');
				-- wf-silent: one round, no event at all.
				INSERT INTO v_runs VALUES
					('b1', 'wf-silent', 'herdr', 'security-verifier', '2026-01-02T10:00:00.000Z');
			`);
			const rows = db
				.query<
					{
						source: string;
						workflows: number;
						rounds_recorded: number;
						rounds_reconstructed: number;
						rounds_unrecorded: number;
						recorded_pct: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows).toHaveLength(1);
			// The gap between the two same-round verifiers is 30 seconds and the gap
			// to the next round is 40 minutes: two rounds for the first workflow,
			// and the second workflow contributes the one run that is its round.
			expect(rows[0]).toMatchObject({
				source: "herdr",
				workflows: 2,
				rounds_recorded: 2,
				rounds_reconstructed: 3,
				rounds_unrecorded: 1,
				recorded_pct: 66.7,
			});
		} finally {
			db.close();
		}
	});

	test("gate-decisions splits recorded evaluations into run and skip", () => {
		const query = queryByName("gate-decisions");
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE v_events (workflow_id TEXT, source TEXT, event TEXT, step_id TEXT, outcome TEXT);
				INSERT INTO v_events VALUES
					('wf-a', 'herdr', 'gate.decision', 'core.triage-route', 'run'),
					('wf-a', 'herdr', 'gate.decision', 'core.triage-route', 'skip'),
					('wf-b', 'herdr', 'gate.decision', 'core.triage-route', 'run'),
					('wf-a', 'herdr', 'gate.decision', 'core.wiki-gate', 'skip'),
					('wf-b', 'herdr', 'gate.decision', 'core.wiki-gate', 'skip'),
					('wf-a', 'herdr', 'gate.skip', 'core.wiki-gate', NULL);
			`);
			const rows = db
				.query<
					{
						source: string;
						step_id: string;
						decisions: number;
						run_count: number;
						skip_count: number;
						undecided: number;
						workflows: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			// Only `gate.decision` rows count: the `gate.skip` boundary event is not
			// an evaluation.
			expect(rows).toHaveLength(2);
			const triage = rows.find((row) => row.step_id === "core.triage-route");
			expect(triage).toMatchObject({
				source: "herdr",
				decisions: 3,
				run_count: 2,
				skip_count: 1,
				undecided: 0,
				workflows: 2,
			});
			const wiki = rows.find((row) => row.step_id === "core.wiki-gate");
			expect(wiki).toMatchObject({
				decisions: 2,
				run_count: 0,
				skip_count: 2,
			});
		} finally {
			db.close();
		}
	});

	test("operator-repairs-recorded reports what each recorded repair carried", () => {
		const query = queryByName("operator-repairs-recorded");
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE v_events (workflow_id TEXT, source TEXT, event TEXT, detail TEXT, repair_effects INTEGER, repair_runs INTEGER, repair_count INTEGER);
				INSERT INTO v_events VALUES
					('wf-a', 'telemetry.main-store', 'operator.repair', 'verification failed twice', 2, 1, 1),
					('wf-a', 'telemetry.main-store', 'operator.repair', NULL, NULL, NULL, NULL),
					('wf-b', 'telemetry.main-store', 'operator.repair', '', NULL, NULL, NULL),
					('wf-a', 'herdr.main-store', 'operator.repair', 'stalled run', NULL, NULL, NULL),
					('wf-a', 'telemetry.main-store', 'agent.handoff', NULL, NULL, NULL, NULL);
			`);
			const rows = db
				.query<
					{
						source: string;
						workflows: number;
						repairs: number;
						repairs_with_reason: number;
						repairs_with_effects: number;
						repairs_with_runs: number;
						repairs_with_count: number;
						max_expired_effects: number | null;
						reason_pct: number | null;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows).toHaveLength(2);
			// The telemetry source recorded three repairs, one of them with a reason
			// and effects; an empty reason is a missing one, and a non-repair event is
			// not a repair at all.
			expect(
				rows.find((row) => row.source === "telemetry.main-store"),
			).toMatchObject({
				workflows: 2,
				repairs: 3,
				repairs_with_reason: 1,
				repairs_with_effects: 1,
				repairs_with_runs: 1,
				repairs_with_count: 1,
				max_expired_effects: 2,
				reason_pct: 33.3,
			});
			// A repair recorded by a store that keeps the reason but neither count is
			// measurable only for its reason.
			expect(
				rows.find((row) => row.source === "herdr.main-store"),
			).toMatchObject({
				workflows: 1,
				repairs: 1,
				repairs_with_reason: 1,
				repairs_with_effects: 0,
				reason_pct: 100,
			});
		} finally {
			db.close();
		}
	});

	test("developer-waits pairs recorded waits and falls back to the dialogue's question waits", () => {
		const query = queryByName("developer-waits");
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE workflows (id TEXT);
				CREATE TABLE v_runs (workflow_id TEXT, started_at TEXT, completed_at TEXT);
				CREATE TABLE v_events (id INTEGER PRIMARY KEY, workflow_id TEXT, source TEXT, event TEXT, at TEXT, outcome TEXT, wait_kind TEXT, detail TEXT);
				INSERT INTO workflows VALUES ('wf-dialogue'), ('wf-recorded');
				-- wf-dialogue recorded no wait event: its wait is the dialogue's own
				-- asked-to-answered / asked-to-expired distance.
				INSERT INTO v_events (workflow_id, source, event, at, outcome, wait_kind, detail) VALUES
					('wf-dialogue', 'telemetry.main-store', 'developer.question.created', '2026-01-01T10:00:00.000Z', NULL, NULL, NULL),
					('wf-dialogue', 'telemetry.main-store', 'developer.question.created', '2026-01-01T10:05:00.000Z', NULL, NULL, NULL),
					('wf-dialogue', 'telemetry.main-store', 'developer.question.answered', '2026-01-01T10:10:00.000Z', NULL, NULL, NULL),
					('wf-dialogue', 'telemetry.main-store', 'developer.question.expired', '2026-01-01T10:20:00.000Z', NULL, NULL, NULL),
					('wf-dialogue', 'telemetry.main-store', 'developer.question.created', '2026-01-01T10:30:00.000Z', NULL, NULL, NULL);
				INSERT INTO v_runs VALUES
					('wf-dialogue', '2026-01-01T09:00:00.000Z', '2026-01-01T09:30:00.000Z'),
					('wf-dialogue', '2026-01-01T09:00:00.000Z', NULL);
				-- wf-recorded recorded one closed wait and one still open, and one
				-- blocked handoff; its question wait must not be added on top.
				INSERT INTO v_events (workflow_id, source, event, at, outcome, wait_kind, detail) VALUES
					('wf-recorded', 'herdr.main-store', 'workflow.waiting', '2026-01-01T11:00:00.000Z', NULL, 'question', 'q1'),
					('wf-recorded', 'herdr.main-store', 'workflow.waiting.ended', '2026-01-01T11:01:00.000Z', NULL, 'question', 'q1'),
					('wf-recorded', 'herdr.main-store', 'workflow.waiting', '2026-01-01T11:05:00.000Z', NULL, 'handoff', 'run-1'),
					('wf-recorded', 'herdr.main-store', 'agent.handoff', '2026-01-01T11:05:00.000Z', 'blocked', NULL, NULL),
					('wf-recorded', 'telemetry.main-store', 'developer.question.created', '2026-01-01T11:00:00.000Z', NULL, NULL, NULL),
					('wf-recorded', 'telemetry.main-store', 'developer.question.answered', '2026-01-01T11:05:00.000Z', NULL, NULL, NULL);
			`);
			const rows = db
				.query<
					{
						workflow_id: string;
						questions: number;
						blocked_handoffs: number;
						waits_recorded: number;
						waits_ended: number;
						waits_open: number;
						question_waits: number;
						question_wait_seconds: number;
						recorded_wait_seconds: number;
						human_wait_seconds: number;
						agent_seconds: number;
						human_share_pct: number | null;
					},
					[]
				>(`${query?.sql}`)
				.all();
			expect(rows.map((row) => row.workflow_id)).toEqual([
				"wf-dialogue",
				"wf-recorded",
			]);
			// Two answered questions (10 and 15 minutes) and one still open at the
			// dataset's edge: the open one opens a wait with no end and so counts
			// nothing. The run without a completion adds no agent time.
			expect(rows[0]).toMatchObject({
				questions: 3,
				waits_recorded: 0,
				question_waits: 2,
				question_wait_seconds: 1500,
				recorded_wait_seconds: 0,
				human_wait_seconds: 1500,
				agent_seconds: 1800,
				human_share_pct: 45.5,
			});
			// The recorded minute wins over the five-minute question wait the dialogue
			// would have measured: one wait is reported once, and the open handoff wait
			// is what `waits_open` counts.
			expect(rows[1]).toMatchObject({
				questions: 1,
				blocked_handoffs: 1,
				waits_recorded: 2,
				waits_ended: 1,
				waits_open: 1,
				question_waits: 1,
				question_wait_seconds: 300,
				recorded_wait_seconds: 60,
				human_wait_seconds: 60,
				agent_seconds: 0,
				human_share_pct: 100,
			});
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
		}
	});

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
		}
	});

	test("run-window-drift reports a session that outlived its run window", () => {
		const query = queryByName("run-window-drift");
		expect(query).toBeDefined();
		const out = makeTempDir("efficiency-window-drift-");
		const copy = path.join(out.path, "dataset.sqlite");
		fs.copyFileSync(datasetPath, copy);
		const db = new Database(copy, { readwrite: true });
		try {
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

	test("kpi-baseline reports every metric the measurement plan tracks", () => {
		const query = queryByName("kpi-baseline");
		const db = new Database(datasetPath, { readonly: true });
		try {
			const rows = db
				.query<{ kpi: string; value: number | null }, []>(`${query?.sql}`)
				.all();
			const byKpi = new Map(rows.map((row) => [row.kpi, row.value]));
			expect(byKpi.has("cost_total_preferred")).toBe(true);
			expect(byKpi.has("turns_total")).toBe(true);
			expect(byKpi.has("single_call_turn_share")).toBe(true);
			expect(byKpi.has("verifier_cost_share")).toBe(true);
			expect(byKpi.has("empty_settles")).toBe(true);
			const share = byKpi.get("single_call_turn_share");
			if (share !== null && share !== undefined) {
				expect(share).toBeGreaterThanOrEqual(0);
				expect(share).toBeLessThanOrEqual(1);
			}
		} finally {
			db.close();
		}
	});

	test("zero-success-runs counts recorded outcomes per era and role", () => {
		const query = queryByName("zero-success-runs");
		expect(query).toBeDefined();
		// A copy of the fixture dataset, so the synthetic runs below never change
		// what the other tests read.
		const copy = path.join(out.path, "zero-success.sqlite");
		fs.copyFileSync(datasetPath, copy);
		const db = new Database(copy);
		try {
			const run = db.query(
				`INSERT INTO runs (run_id, workflow_id, role, status, started_at, source, source_rank, sources, confidence, preferred)
				 VALUES (?, 'wf-zero', ?, 'completed', ?, 'telemetry.main-store', 0, 'telemetry.main-store', 'exact', 1)`,
			);
			const call = db.query(
				`INSERT INTO tool_calls (run_id, workflow_id, source, source_rank, turn_index, dedupe_key, tool, ok, failure_kind, recording, confidence, preferred)
				 VALUES (?, 'wf-zero', 'telemetry.main-store', 0, ?, ?, 'bash', ?, ?, 'harness', 'exact', 1)`,
			);
			/** One run of `role` whose every call carries a recorded outcome. */
			const addRun = (
				runId: string,
				role: string,
				startedAt: string,
				calls: ReadonlyArray<{ ok: 0 | 1 | null; kind: string | null }>,
			) => {
				run.run(runId, role, startedAt);
				for (const [index, entry] of calls.entries())
					call.run(runId, index, `${runId}-${index}`, entry.ok, entry.kind);
			};
			// Post-era: one dead verifier run beside one healthy verifier run, and
			// one run whose calls carry no outcome at all (the recording artefact)
			// which must not be counted.
			addRun("synth-zero", "quality-verifier", "2026-10-01T00:00:00.000Z", [
				{ ok: 0, kind: "host-error" },
				{ ok: 0, kind: "host-error" },
				{ ok: 0, kind: "host-error" },
				{ ok: 0, kind: "host-error" },
			]);
			addRun("synth-healthy", "quality-verifier", "2026-10-02T00:00:00.000Z", [
				{ ok: 1, kind: null },
				{ ok: 1, kind: null },
				{ ok: 1, kind: null },
			]);
			addRun("synth-unrecorded", "worker", "2026-10-03T00:00:00.000Z", [
				{ ok: null, kind: null },
				{ ok: null, kind: null },
				{ ok: null, kind: null },
				{ ok: null, kind: null },
			]);
			// Pre-era: the same shape, so the era split is what the numbers show.
			addRun("synth-legacy", "worker", "2026-01-05T00:00:00.000Z", [
				{ ok: 0, kind: "host-error" },
				{ ok: 0, kind: "host-error" },
				{ ok: 0, kind: "host-error" },
			]);
			const rows = db
				.query<
					{
						era: string;
						role: string;
						runs: number;
						zero_success_runs: number;
						per_1000: number;
						zero_success_calls: number;
						zero_success_failures_with_kind: number;
					},
					[]
				>(`${query?.sql}`)
				.all();
			const verifier = rows.find(
				(row) =>
					row.era === "post-2026-09-01" && row.role === "quality-verifier",
			);
			expect(verifier?.runs).toBe(2);
			expect(verifier?.zero_success_runs).toBe(1);
			expect(verifier?.per_1000).toBe(500);
			expect(verifier?.zero_success_calls).toBe(4);
			expect(verifier?.zero_success_failures_with_kind).toBe(4);
			// The unrecorded-outcome run is invisible, so a failures-only recording
			// cannot inflate the modern era.
			const modernAll = rows.find(
				(row) => row.era === "post-2026-09-01" && row.role === "(all roles)",
			);
			expect(modernAll?.runs).toBe(2);
			expect(modernAll?.zero_success_runs).toBe(1);
			const legacy = rows.find(
				(row) =>
					row.era === "pre-2026-09-01" &&
					row.role === "worker" &&
					row.runs >= 1,
			);
			expect(legacy?.zero_success_runs).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
	});
});
