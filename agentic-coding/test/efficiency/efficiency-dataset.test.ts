import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { writeDataset } from "../../scripts/efficiency/lib/dataset.ts";
import { extractTables } from "../../scripts/efficiency/lib/extract.ts";
import { queryByName } from "../../scripts/efficiency/lib/queries.ts";
import {
	type FixtureEvidence,
	makeFixtureEvidence,
	makeTempDir,
} from "./fixture.ts";

let fixture: FixtureEvidence;
let out: { path: string; cleanup(): void };
let datasetPath = "";

function query<T>(sql: string): T[] {
	const db = new Database(datasetPath, { readonly: true });
	try {
		return db.query<T, []>(sql).all();
	} finally {
		db.close();
	}
}

beforeAll(() => {
	fixture = makeFixtureEvidence();
	out = makeTempDir("efficiency-dataset-");
	const tables = extractTables({ evidenceDir: fixture.root }).tables;
	const written = writeDataset({
		outDir: out.path,
		tables,
		meta: { builtAt: "test", evidenceDir: fixture.root },
	});
	datasetPath = written.path;
});

afterAll(() => {
	fixture.cleanup();
	out.cleanup();
});

describe("dataset schema", () => {
	test("writes the dataset and its README into the output directory", () => {
		expect(fs.existsSync(datasetPath)).toBe(true);
		const tables = query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		).map((row) => row.name);
		for (const table of [
			"meta",
			"sources",
			"source_files",
			"workflows",
			"runs",
			"turns",
			"tool_calls",
			"events",
		])
			expect(tables).toContain(table);
		const views = query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
		).map((row) => row.name);
		for (const view of [
			"v_runs",
			"v_turns",
			"v_tool_calls",
			"v_events",
			"v_run_summary",
			"v_workflow_summary",
			"v_workflow_coverage",
		])
			expect(views).toContain(view);
	});

	test("records every source with its rank", () => {
		const sources = query<{ source: string; rank: number }>(
			"SELECT source, rank FROM sources ORDER BY rank DESC",
		);
		expect(sources.length).toBeGreaterThanOrEqual(11);
		expect(sources[0]?.rank).toBe(190);
	});

	test("counts the unparseable fixture lines instead of failing", () => {
		const row = query<{ records: number; parsed: number; skipped: number }>(
			"SELECT records, parsed, skipped FROM source_files WHERE path LIKE '%corrupt-wf.jsonl'",
		)[0];
		expect(row?.records).toBe(5);
		expect(row?.parsed).toBe(1);
		expect(row?.skipped).toBe(4);
	});
});

describe("workflows and runs", () => {
	test("finds every workflow in every source", () => {
		const ids = query<{ id: string }>(
			"SELECT id FROM workflows ORDER BY id",
		).map((row) => row.id);
		expect(ids).toContain("legacy-wf");
		expect(ids).toContain("span-wf");
		expect(ids).toContain("corrupt-wf");
		expect(ids).toContain("env-setup-demo");
		expect(ids).toContain("traces-only-wf");
	});

	test("prefers the durable store for a workflow's identity and status", () => {
		const row = query<{
			repo: string;
			type: string;
			branch: string;
			definition_id: string;
			status: string;
			source: string;
			confidence: string;
		}>(
			"SELECT repo, type, branch, definition_id, status, source, confidence FROM workflows WHERE id = 'span-wf'",
		)[0];
		expect(row?.repo).toBe("/repo/agentic-coding");
		expect(row?.type).toBe("solo");
		expect(row?.branch).toBe("feature/span-wf");
		expect(row?.definition_id).toBe("solo");
		expect(row?.status).toBe("attention-required");
		expect(row?.source).toBe("herdr.main-store");
		expect(row?.confidence).toBe("exact");
	});

	test("marks a workflow that only ever appeared in spans as heuristic", () => {
		const row = query<{ confidence: string; sources: string }>(
			"SELECT confidence, sources FROM workflows WHERE id = 'traces-only-wf'",
		)[0];
		expect(row?.confidence).toBe("heuristic");
		expect(row?.sources).toBe("traces.otel-tui");
	});

	test("merges one run seen in four sources and keeps the sources explicit", () => {
		const row = query<{
			sources: string;
			confidence: string;
			source: string;
			handoff_outcome: string;
			step_id: string;
			attempt: number;
			profile: string;
		}>(
			"SELECT sources, confidence, source, handoff_outcome, step_id, attempt, profile FROM runs WHERE run_id = 'run-span-a'",
		)[0];
		expect(row?.sources.split(",").sort()).toEqual([
			"harness.worktree",
			"herdr.main-store",
			"telemetry.main-store",
			"telemetry.worktree",
		]);
		expect(row?.source).toBe("herdr.main-store");
		expect(row?.confidence).toBe("exact");
		expect(row?.step_id).toBe("core.implementation");
		expect(row?.handoff_outcome).toBe("complete");
		expect(row?.attempt).toBe(1);
		expect(row?.profile).toBe("pi-opencode-go-deepseek-flash");
	});

	test("keeps a blocked handoff's outcome and the store's status", () => {
		const row = query<{
			status: string;
			handoff_outcome: string;
			handoff_reason: string;
		}>(
			"SELECT status, handoff_outcome, handoff_reason FROM runs WHERE run_id = 'run-span-b'",
		)[0];
		expect(row?.handoff_outcome).toBe("blocked");
		expect(row?.status).toBe("blocked");
	});

	test("keeps run-less legacy records as a synthetic, heuristic run", () => {
		const rows = query<{
			run_id: string;
			workflow_id: string;
			role: string;
			confidence: string;
		}>(
			"SELECT run_id, workflow_id, role, confidence FROM runs WHERE workflow_id = 'legacy-wf' AND run_id LIKE 'telemetry.main-store#%'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("planner");
		expect(rows[0]?.confidence).toBe("heuristic");
	});

	test("attributes a labelled conversation exactly and an unlabelled one only heuristically", () => {
		const exact = query<{ run_id: string; confidence: string }>(
			"SELECT run_id, confidence FROM runs WHERE run_label = 'worker-aaaa'",
		)[0];
		expect(exact?.run_id).toBe("run-span-a");
		expect(exact?.confidence).toBe("exact");

		const isolated = query<{
			run_id: string;
			workflow_id: string;
			confidence: string;
		}>(
			"SELECT run_id, workflow_id, confidence FROM runs WHERE source = 'harness.worktree' AND run_label IS NULL",
		)[0];
		expect(isolated?.workflow_id).toBe("span-wf");
		expect(isolated?.confidence).toBe("unknown");
	});
});

describe("turns and tool calls", () => {
	test("counts a harness turn exactly like the telemetry that saw it", () => {
		const rows = query<{ source: string; turns: number }>(
			`SELECT source, COUNT(*) AS turns FROM turns WHERE run_id = 'run-span-a'
			 GROUP BY source ORDER BY source`,
		);
		expect(rows).toEqual([
			{ source: "harness.worktree", turns: 2 },
			{ source: "telemetry.main-store", turns: 2 },
			{ source: "telemetry.worktree", turns: 2 },
		]);
	});

	test("reports the run whose sources disagree instead of hiding it", () => {
		const rows = query<{ source: string; turns: number; tool_calls: number }>(
			`SELECT t.source AS source, COUNT(*) AS turns,
				(SELECT COUNT(*) FROM tool_calls c WHERE c.run_id = t.run_id AND c.source = t.source) AS tool_calls
			 FROM turns t WHERE t.run_id = 'run-span-b' GROUP BY t.source ORDER BY t.source`,
		);
		expect(rows).toEqual([
			{ source: "harness.worktree", turns: 1, tool_calls: 1 },
			{ source: "telemetry.main-store", turns: 2, tool_calls: 1 },
			{ source: "telemetry.worktree", turns: 1, tool_calls: 1 },
		]);
	});

	test("marks exactly one preferred source per run", () => {
		const rows = query<{ run_id: string; preferred_sources: number }>(
			`SELECT run_id, COUNT(DISTINCT source) AS preferred_sources FROM turns
			 WHERE preferred = 1 GROUP BY run_id HAVING COUNT(DISTINCT source) > 1`,
		);
		expect(rows).toEqual([]);
		const preferred = query<{ source: string }>(
			"SELECT DISTINCT source FROM turns WHERE run_id = 'run-span-a' AND preferred = 1",
		);
		expect(preferred).toEqual([{ source: "harness.worktree" }]);
	});

	test("carries the transcript's stop reason, thinking tokens and result size", () => {
		const turn = query<{
			stop_reason: string;
			thinking_tokens: number;
			input_tokens: number;
		}>(
			"SELECT stop_reason, thinking_tokens, input_tokens FROM turns WHERE run_id = 'run-span-a' AND preferred = 1 ORDER BY turn_index LIMIT 1",
		)[0];
		expect(turn?.stop_reason).toBe("toolUse");
		expect(turn?.thinking_tokens).toBe(40);
		expect(turn?.input_tokens).toBe(1000);

		const call = query<{
			tool: string;
			args_digest: string;
			result_bytes: number;
			result_truncated: number;
			ok: number;
			duration_ms: number;
		}>(
			"SELECT tool, args_digest, result_bytes, result_truncated, ok, duration_ms FROM tool_calls WHERE run_id = 'run-span-a' AND call_id = 'call-a2' AND preferred = 1",
		)[0];
		expect(call?.tool).toBe("read");
		expect(call?.args_digest).toBe("read src/a.ts");
		expect(call?.result_truncated).toBe(1);
		expect(call?.ok).toBe(1);
		expect(call?.duration_ms).toBeGreaterThan(0);
	});

	test("keeps the call outcome unknown when no source reported one", () => {
		const rows = query<{ ok: number | null; result_bytes: number }>(
			"SELECT ok, result_bytes FROM tool_calls WHERE run_id = 'run-span-b' AND source = 'telemetry.main-store'",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.result_bytes).toBeNull();
	});

	test("groups the repeated read of one path inside a run", () => {
		const repeated = queryByName("repeated-calls");
		const rows = query<{
			tool: string;
			calls: number;
			digest: string;
			wasted_result_bytes: number;
		}>(`${repeated?.sql ?? ""}`);
		const hit = rows.find((row) => row.digest === "read src/dup.ts");
		expect(hit?.calls).toBe(2);
		expect(hit?.wasted_result_bytes).toBeGreaterThan(0);
	});
});

describe("events and redaction", () => {
	test("classifies handoffs, effects and routing decisions", () => {
		const rows = query<{ event: string; event_class: string; outcome: string }>(
			"SELECT DISTINCT event, event_class, outcome FROM v_events WHERE workflow_id = 'span-wf'",
		);
		const classOf = (event: string) => [
			...new Set(
				rows.filter((row) => row.event === event).map((row) => row.event_class),
			),
		];
		const outcomesOf = (event: string) =>
			rows
				.filter((row) => row.event === event)
				.map((row) => row.outcome)
				.sort();
		expect(classOf("agent.handoff")).toEqual(["handoff"]);
		expect(classOf("effect.result")).toEqual(["effect"]);
		expect(classOf("routing.classified")).toEqual(["routing"]);
		expect(outcomesOf("agent.handoff")).toEqual(["blocked", "complete"]);
	});

	test("keeps an effect failure's bounded error class", () => {
		const row = query<{ outcome: string; error_class: string; detail: string }>(
			"SELECT outcome, error_class, detail FROM v_events WHERE event = 'effect.result'",
		)[0];
		expect(row?.outcome).toBe("failed");
		expect(row?.error_class).toContain("workspace identity");
		expect(row?.detail).toBe(row?.error_class);
	});

	test("stores a verifier finding's severity but only a digest of its body", () => {
		const row = query<{
			severity: string;
			detail: string | null;
			detail_bytes: number | null;
		}>(
			"SELECT severity, detail, detail_bytes FROM v_events WHERE event = 'verification_finding' AND severity IS NOT NULL",
		)[0];
		expect(row?.severity).toBe("warning");
		expect(row?.detail).toBeNull();
		expect(row?.detail_bytes).toBeGreaterThan(0);
	});

	test("no text column in the dataset contains a secret or a transcript body", () => {
		const forbidden = [
			"sk-live",
			"hunter2",
			"ghp_0123456789",
			"api_key=",
			"Bearer sk-",
			"synthetic assignment body",
			"a finding body",
			"export const dup",
			"line one\nline two",
		];
		const tables = query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		);
		for (const { name } of tables) {
			const columns = query<{ name: string; type: string }>(
				`PRAGMA table_info(${name})`,
			).filter((column) => column.type === "TEXT");
			if (columns.length === 0) continue;
			const list = columns.map((column) => column.name).join(", ");
			for (const row of query<Record<string, unknown>>(
				`SELECT ${list} FROM ${name}`,
			))
				for (const value of Object.values(row)) {
					if (typeof value !== "string") continue;
					for (const needle of forbidden) expect(value).not.toContain(needle);
				}
		}
	});

	test("reduces a credentialed command to its program and hashes the arguments", () => {
		const row = query<{ args_digest: string; args_hash: string }>(
			"SELECT args_digest, args_hash FROM tool_calls WHERE call_id = 'call-c1'",
		)[0];
		expect(row?.args_digest).toBe("bash curl");
		expect(row?.args_hash).toHaveLength(16);
	});
});
