import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceDb } from "../../src/tui/otel/model/db";
import {
	parseTelemetryJsonl,
	parseTelemetryLine,
} from "../../src/tui/otel/model/parser";

const TELEMETRY = [
	'{"schemaVersion":1,"at":"2026-09-11T09:14:15.921Z","layer":"engine","event":"effect.result","workflowId":"wf-1","stepId":"core.implementation","role":"worker","outcome":"error","durationMs":250,"traceparent":"00-a3bc231c2fb909c7dc3fdf4a55f6aa7e-dd7779c4a8490e79-01"}',
	'{"schemaVersion":1,"at":"2026-09-11T09:14:16.247Z","layer":"runtime","runtime":"pi","event":"runtime.usage","workflowId":"wf-1","role":"worker","inputTokens":100,"outputTokens":20}',
].join("\n");

describe("telemetry envelope parsing", () => {
	test("maps an envelope to a span with trace identity and safe attributes", () => {
		const first = TELEMETRY.split("\n")[0];
		expect(first).toBeDefined();
		if (!first) return;
		const span = parseTelemetryLine(first, 1);
		expect(span).toBeDefined();
		if (!span) return;
		expect(span.name).toBe("effect.result");
		// Grouped by workflow, not by the per-event traceparent id.
		expect(
			span.attributes.find((a) => a.key === "herdr.change.id")?.value,
		).toBe("wf-1");
		expect(span.attributes.find((a) => a.key === "herdr.role")?.value).toBe(
			"worker",
		);
		expect(span.traceId).toBe("a3bc231c2fb909c7dc3fdf4a55f6aa7e");
		expect(span.status.code).toBe(2);
		expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(
			250_000_000n,
		);
		// Events in one run share the run's traceparent span id, so the emitted
		// span id must be derived from the envelope to stay unique per event.
		expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(span.spanId).not.toBe("dd7779c4a8490e79");
	});

	test("skips malformed lines and non-envelopes", () => {
		const spans = parseTelemetryJsonl(`${TELEMETRY}\nnot json\n{}`);
		expect(spans).toHaveLength(2);
		expect(spans[1]?.serviceName).toBe("pi");
	});
});

describe("TraceDb telemetry ingest", () => {
	test("ingests a workspace that only has telemetry.jsonl", () => {
		const dir = mkdtempSync(join(tmpdir(), "otel-telemetry-db-"));
		writeFileSync(join(dir, "telemetry.jsonl"), TELEMETRY);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-1")).toBe(2);
			expect(db.loadSpans("wf-1")).toHaveLength(2);
			expect(
				db.getWorkspaces().find((w) => w.changeId === "wf-1")?.spanCount,
			).toBe(2);
		} finally {
			db.close();
		}
	});

	test("picks the fresher source and never lets a stale legacy file mask new telemetry", () => {
		const dir = mkdtempSync(join(tmpdir(), "otel-telemetry-both-"));
		const legacy = {
			traceId: "0af7651916cd43dd8448eb211c80319c",
			spanId: "b7ad6b7169203331",
			name: "legacy.span",
			startTimeUnixNano: "1000000",
			endTimeUnixNano: "2000000",
			status: { code: 0 },
			attributes: { "service.name": "herdr-agent" },
		};
		const legacyPath = join(dir, "traces.jsonl");
		const telemetryPath = join(dir, "telemetry.jsonl");
		writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`);
		writeFileSync(telemetryPath, TELEMETRY);
		const ago = (ms: number) => new Date(Date.now() - ms);
		utimesSync(legacyPath, ago(120_000), ago(120_000));
		utimesSync(telemetryPath, ago(60_000), ago(60_000));
		const db = new TraceDb(join(dir, "db"));
		try {
			// Fresh telemetry beats the hour-old legacy snapshot.
			expect(db.ingestWorkspace(dir, "wf-2")).toBe(2);
			expect(db.loadSpans("wf-2").map((span) => span.name)).toEqual([
				"effect.result",
				"runtime.usage",
			]);
			// A source switch re-ingests when the other file becomes the fresher one.
			utimesSync(legacyPath, ago(0), ago(0));
			expect(db.ingestWorkspace(dir, "wf-2")).toBe(1);
			expect(db.loadSpans("wf-2")[0]?.name).toBe("legacy.span");
		} finally {
			db.close();
		}
	});

	test("watcher picks up a new telemetry workspace and reports its spans", async () => {
		const root = mkdtempSync(join(tmpdir(), "otel-telemetry-watch-"));
		const workflowDir = join(root, ".herdr-workflow", "wf-3");
		mkdirSync(workflowDir, { recursive: true });
		writeFileSync(join(workflowDir, "telemetry.jsonl"), TELEMETRY);
		const db = new TraceDb(join(root, "db"));
		const seen: string[] = [];
		const stop = db.watchWorkspaces(root, (changeId, spans) => {
			seen.push(`${changeId}:${spans.length}`);
		});
		try {
			const deadline = Date.now() + 6000;
			while (!seen.includes("wf-3:2") && Date.now() < deadline)
				await Bun.sleep(50);
			expect(seen).toContain("wf-3:2");
			expect(db.loadSpans("wf-3")).toHaveLength(2);
		} finally {
			stop();
			db.close();
		}
	});
});
