import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceDb } from "../../src/server/telemetry-db";
import {
	parseLine,
	parseTelemetryJsonl,
	parseTelemetryLine,
} from "../../src/server/telemetry-parser";
import { workflowTraceId } from "../../src/workflow/observability.ts";
import { autoRemoveTempDirs, trackTempDir } from "../support/temp-dirs.ts";

// Every workspace fixture below is a directory the watcher reads and writes; the
// file-scoped sweep removes them when this file ends (test/support/temp-dirs.ts).
autoRemoveTempDirs();

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

	test("session content keys reach the span as custom attributes", () => {
		const line = JSON.stringify({
			schemaVersion: 1,
			at: "2026-09-11T10:00:05.000Z",
			layer: "runtime",
			runtime: "pi-durable",
			event: "runtime.tool",
			workflowId: "wf-9",
			role: "worker",
			"pi.tool.name": "bash",
			"herdr.content.tool_input": JSON.stringify({ command: "bun test" }),
			"herdr.content.tool_output": "all green",
		});
		const span = parseTelemetryLine(line, 1);
		expect(span?.attributes.find((a) => a.key === "pi.tool.name")?.value).toBe(
			"bash",
		);
		expect(
			span?.attributes.find((a) => a.key === "herdr.content.tool_input")?.value,
		).toBe(JSON.stringify({ command: "bun test" }));
		expect(
			span?.attributes.find((a) => a.key === "herdr.content.tool_output")
				?.value,
		).toBe("all green");
	});

	test("skips malformed lines and non-envelopes", () => {
		const spans = parseTelemetryJsonl(`${TELEMETRY}\nnot json\n{}`);
		expect(spans).toHaveLength(2);
		expect(spans[1]?.serviceName).toBe("pi");
	});
});

describe("enriched telemetry payload ingest", () => {
	const MIXED = [
		// New engine event: reserved identity plus `herdr.*` numeric payload.
		'{"schemaVersion":1,"at":"2026-09-11T10:00:00.000Z","layer":"engine","event":"agent.handoff","workflowId":"wf-9","runId":"run-9","role":"worker","profile":"pi","runtime":"pi","sessionId":"session-9","effectId":"effect-9","outcome":"ok","durationMs":12,"herdr.run.attempt":3,"herdr.evidence.count":0,"attributes":{"herdr.effect.kind":"agent.launch"}}',
		// pi bridge event: top-level tokens and a numeric runtime attribute.
		'{"schemaVersion":1,"at":"2026-09-11T10:00:01.000Z","layer":"runtime","runtime":"pi","event":"runtime.usage","workflowId":"wf-9","inputTokens":100,"outputTokens":20,"cost":0.5,"pi.tool.duration_ms":7.5,"pi.compaction.automatic":true}',
		// Unknown event name must stay readable.
		'{"schemaVersion":1,"at":"2026-09-11T10:00:02.000Z","layer":"engine","event":"workflow.rollup","workflowId":"wf-9","herdr.revision.count":4}',
		// Legacy record without a layer.
		'{"schemaVersion":1,"at":"2026-09-11T10:00:03.000Z","event":"legacy.event","workflowId":"wf-9"}',
	].join("\n");

	test("preserves scalar types, maps top-level fields, and keeps unknown names", () => {
		const spans = parseTelemetryJsonl(MIXED);
		expect(spans).toHaveLength(4);
		const handoff = spans[0];
		const usage = spans[1];
		const rollup = spans[2];
		const legacy = spans[3];
		if (!handoff || !usage || !rollup || !legacy)
			throw new Error("missing spans");
		expect(
			handoff.attributes.find((a) => a.key === "herdr.run.attempt")?.value,
		).toBe(3);
		expect(
			handoff.attributes.find((a) => a.key === "herdr.session.id")?.value,
		).toBe("session-9");
		expect(
			handoff.attributes.find((a) => a.key === "herdr.effect.kind")?.value,
		).toBe("agent.launch");
		expect(
			typeof usage.attributes.find((a) => a.key === "inputTokens")?.value,
		).toBe("number");
		expect(
			typeof usage.attributes.find((a) => a.key === "pi.tool.duration_ms")
				?.value,
		).toBe("number");
		expect(
			usage.attributes.find((a) => a.key === "pi.compaction.automatic")?.value,
		).toBe(true);
		expect(rollup.name).toBe("workflow.rollup");
		expect(legacy.serviceName).toBe("herdr-workflow");
	});

	test("decodes numeric OTLP strings for int and double", () => {
		const line = JSON.stringify({
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			name: "metric.span",
			startTimeUnixNano: "1000000",
			endTimeUnixNano: "2000000",
			status: { code: 0 },
			attributes: [
				{ key: "int.attr", value: { intValue: "12" } },
				{ key: "double.attr", value: { doubleValue: "1.5" } },
				{ key: "bool.attr", value: { boolValue: true } },
				{ key: "string.attr", value: { stringValue: "x" } },
			],
		});
		const span = parseLine(line);
		if (!span) throw new Error("expected a span");
		expect(span.attributes.find((a) => a.key === "int.attr")?.value).toBe(12);
		expect(span.attributes.find((a) => a.key === "double.attr")?.value).toBe(
			1.5,
		);
		expect(span.attributes.find((a) => a.key === "bool.attr")?.value).toBe(
			true,
		);
		expect(span.attributes.find((a) => a.key === "string.attr")?.value).toBe(
			"x",
		);
	});

	test("workflow traceparent keeps every layer in one workflow trace", () => {
		const traceId = workflowTraceId("wf-group");
		const traceparent = `00-${traceId}-${"a".repeat(16)}-01`;
		const row = (fields: Record<string, unknown>) =>
			JSON.stringify({
				schemaVersion: 1,
				at: "2026-09-11T10:00:00.000Z",
				workflowId: "wf-group",
				...fields,
			});
		const spans = parseTelemetryJsonl(
			[
				row({ layer: "engine", event: "effect.result", traceparent }),
				row({ layer: "adapter", event: "agent.launch", traceparent }),
				row({
					layer: "runtime",
					runtime: "pi-durable",
					event: "runtime.usage",
					traceparent,
					inputTokens: 7,
				}),
				// A record the emitter never stamped falls back to the same
				// workflow-id digest, so it joins the workflow trace too.
				row({ event: "legacy.event" }),
			].join("\n"),
		);
		expect(spans).toHaveLength(4);
		// The per-span trace id, not the viewer's workflow grouping, is what this
		// test guards: every layer must carry the one workflow trace id (TELEM-001).
		expect(new Set(spans.map((span) => span.traceId))).toEqual(
			new Set([traceId]),
		);
	});
});

describe("TraceDb telemetry ingest", () => {
	const envelope = (event: string, at: string, workflowId = "wf-1") =>
		JSON.stringify({
			schemaVersion: 1,
			at,
			layer: "engine",
			event,
			workflowId,
		});
	/** One envelope per second from a fixed origin, so a synthetic file is easy to
	 * grow a line at a time. */
	const envelopeAt = (index: number, workflowId = "wf-1") =>
		envelope(
			`event.${index}`,
			new Date(Date.UTC(2026, 8, 11, 9, 0, index)).toISOString(),
			workflowId,
		);

	test("parses only the appended tail of a growing workspace file", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-tail-")),
		);
		const path = join(dir, "telemetry.jsonl");
		writeFileSync(path, `${envelopeAt(0)}\n${envelopeAt(1)}\n`);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-tail")).toBe(2);
			writeFileSync(path, `${envelopeAt(2)}\n`, { flag: "a" });
			// One appended line: a tick must parse what was appended, not the file it
			// already ingested.
			expect(db.ingestWorkspace(dir, "wf-tail")).toBe(1);
			const spans = db.loadSpans("wf-tail");
			expect(spans.map((span) => span.name)).toEqual([
				"event.0",
				"event.1",
				"event.2",
			]);
			// The tail keeps the line numbering of a full parse, so span identity is
			// identical to what a whole-file ingest produces.
			const full = parseTelemetryJsonl(readFileSync(path, "utf8"));
			expect(spans.map((span) => span.spanId)).toEqual(
				full.map((span) => span.spanId),
			);
			// An unchanged file (same size, same mtime) is not read again.
			expect(db.ingestWorkspace(dir, "wf-tail")).toBe(0);
		} finally {
			db.close();
		}
	});

	test("waits for the newline of a half-written line", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-partial-")),
		);
		const path = join(dir, "telemetry.jsonl");
		const second = envelopeAt(1);
		// The writer is mid-line: only the complete first record is ingested, and the
		// fragment waits instead of being consumed as a truncated record.
		writeFileSync(path, `${envelopeAt(0)}\n${second.slice(0, 24)}`);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-partial")).toBe(1);
			expect(db.loadSpans("wf-partial").map((span) => span.name)).toEqual([
				"event.0",
			]);
			writeFileSync(path, `${second.slice(24)}\n`, { flag: "a" });
			expect(db.ingestWorkspace(dir, "wf-partial")).toBe(1);
			expect(db.loadSpans("wf-partial").map((span) => span.name)).toEqual([
				"event.0",
				"event.1",
			]);
		} finally {
			db.close();
		}
	});

	test("re-ingests from the start when the file is truncated or rotated", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-rotate-")),
		);
		const path = join(dir, "telemetry.jsonl");
		writeFileSync(path, `${envelopeAt(0)}\n${envelopeAt(1)}\n`);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-rotate")).toBe(2);
			// A rotated (shorter) file: the watermark's prefix is gone, so the rows it
			// described are dropped rather than left behind as stale spans.
			writeFileSync(path, `${envelopeAt(9)}\n`);
			expect(db.ingestWorkspace(dir, "wf-rotate")).toBe(1);
			expect(db.loadSpans("wf-rotate").map((span) => span.name)).toEqual([
				"event.9",
			]);
		} finally {
			db.close();
		}
	});

	test("an appended line costs the tail, not the whole file", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-cost-")),
		);
		const path = join(dir, "telemetry.jsonl");
		const lines = Array.from({ length: 12_000 }, (_, index) =>
			envelopeAt(index % 60, `wf-${index}`),
		);
		writeFileSync(path, `${lines.join("\n")}\n`);
		const db = new TraceDb(join(dir, "db"));
		try {
			const firstIngest = performance.now();
			expect(db.ingestWorkspace(dir, "wf-cost")).toBe(12_000);
			const firstIngestMs = performance.now() - firstIngest;
			// Two appended ticks, keeping the cheaper measurement: what this asserts is
			// the work an append does, and a busy machine can only add time to it.
			const appendedMs = Math.min(
				...[0, 1].map((index) => {
					writeFileSync(path, `${envelopeAt(index, "wf-appended")}\n`, {
						flag: "a",
					});
					const started = performance.now();
					expect(db.ingestWorkspace(dir, "wf-cost")).toBe(1);
					return performance.now() - started;
				}),
			);
			// The watermark is the whole point: a tick that appends one line must not
			// pay for the 12000 lines it already ingested (measured ~60 ms against
			// ~3 ms; before this change the two were the same work).
			expect(appendedMs).toBeLessThan(firstIngestMs / 3);
			expect(db.loadSpans("wf-cost")).toHaveLength(12_002);
		} finally {
			db.close();
		}
	});

	test("keeps the per-workflow span cap once a growing file passes it", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-cap-")),
		);
		const path = join(dir, "telemetry.jsonl");
		const lines = Array.from({ length: 50_000 }, (_, index) =>
			envelopeAt(index % 60, "wf-cap"),
		);
		writeFileSync(path, `${lines.join("\n")}\n`);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-cap")).toBe(50_000);
			// Append-only ingest never drops a row by itself, so the cap has to be
			// enforced: the rows past it are the oldest ones, never the new arrival.
			writeFileSync(path, `${envelopeAt(0, "wf-cap")}\n`, { flag: "a" });
			expect(db.ingestWorkspace(dir, "wf-cap")).toBe(1);
			writeFileSync(path, `${envelopeAt(1, "wf-cap")}\n`, { flag: "a" });
			expect(db.ingestWorkspace(dir, "wf-cap")).toBe(1);
			expect(
				db.listTraceSummaries({ changeId: "wf-cap" }).items[0]?.spanCount,
			).toBe(50_000);
		} finally {
			db.close();
		}
	});

	test("ingests a workspace that only has telemetry.jsonl", () => {
		const dir = trackTempDir(mkdtempSync(join(tmpdir(), "otel-telemetry-db-")));
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

	test("a telemetry database from an earlier schema is refused by name", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-old-schema-")),
		);
		// The shape an earlier release wrote: the trace table without its
		// materialized columns. It is refused with an actionable message instead of
		// dying on the first statement with `no such column`.
		const raw = new Database(join(dir, "traces.sqlite"));
		raw.run(
			"CREATE TABLE traces (id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, span TEXT NOT NULL, ingested_at TEXT NOT NULL DEFAULT (datetime('now')))",
		);
		raw.close();
		expect(() => new TraceDb(dir)).toThrow(/predates the current trace schema/);
	});

	test("reads the current telemetry source and ignores an obsolete trace file", () => {
		const dir = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-both-")),
		);
		const obsolete = {
			traceId: "0af7651916cd43dd8448eb211c80319c",
			spanId: "b7ad6b7169203331",
			name: "obsolete.span",
			startTimeUnixNano: "1000000",
			endTimeUnixNano: "2000000",
			status: { code: 0 },
			attributes: { "service.name": "herdr-agent" },
		};
		const obsoletePath = join(dir, "traces.jsonl");
		const telemetryPath = join(dir, "telemetry.jsonl");
		writeFileSync(obsoletePath, `${JSON.stringify(obsolete)}\n`);
		writeFileSync(telemetryPath, TELEMETRY);
		// The obsolete file is the fresher one and is still not read.
		const now = new Date();
		utimesSync(obsoletePath, now, now);
		utimesSync(
			telemetryPath,
			new Date(Date.now() - 60_000),
			new Date(Date.now() - 60_000),
		);
		const db = new TraceDb(join(dir, "db"));
		try {
			expect(db.ingestWorkspace(dir, "wf-2")).toBe(2);
			expect(db.loadSpans("wf-2").map((span) => span.name)).toEqual([
				"effect.result",
				"runtime.usage",
			]);
		} finally {
			db.close();
		}
	});
	test("the watcher reads only the appended tail of a large workspace file", async () => {
		const root = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-watch-tail-")),
		);
		const workflowDir = join(root, ".herdr-workflow", "wf-big");
		mkdirSync(workflowDir, { recursive: true });
		const path = join(workflowDir, "telemetry.jsonl");
		// ~370 KiB already ingested: the watcher's next tick must read the appended
		// bytes at that offset, not the file the watermark covers.
		writeFileSync(
			path,
			`${Array.from({ length: 3000 }, (_, index) => envelopeAt(index % 60, "wf-big")).join("\n")}\n`,
		);
		const db = new TraceDb(join(root, "db"));
		expect(db.ingestWorkspace(workflowDir, "wf-big")).toBe(3000);
		const seen: string[] = [];
		const stop = db.watchWorkspaces(root, (changeId, spans) => {
			seen.push(`${changeId}:${spans.length}`);
		});
		try {
			writeFileSync(path, `${envelopeAt(1, "wf-big")}\n`, { flag: "a" });
			const deadline = Date.now() + 12_000;
			while (!seen.includes("wf-big:1") && Date.now() < deadline)
				await Bun.sleep(50);
			expect(seen).toContain("wf-big:1");
			expect(
				db.listTraceSummaries({ changeId: "wf-big" }).items[0]?.spanCount,
			).toBe(3001);
		} finally {
			stop();
			db.close();
		}
	});

	test("watcher picks up a new telemetry workspace and reports its spans", async () => {
		const root = trackTempDir(
			mkdtempSync(join(tmpdir(), "otel-telemetry-watch-")),
		);
		const workflowDir = join(root, ".herdr-workflow", "wf-3");
		mkdirSync(workflowDir, { recursive: true });
		const path = join(workflowDir, "telemetry.jsonl");
		writeFileSync(path, TELEMETRY);
		const db = new TraceDb(join(root, "db"));
		const seen: string[] = [];
		const stop = db.watchWorkspaces(root, (changeId, spans) => {
			seen.push(`${changeId}:${spans.length}`);
		});
		const waitFor = async (entry: string): Promise<void> => {
			const deadline = Date.now() + 12_000;
			while (!seen.includes(entry) && Date.now() < deadline)
				await Bun.sleep(50);
		};
		try {
			await waitFor("wf-3:2");
			expect(seen).toContain("wf-3:2");
			expect(db.loadSpans("wf-3")).toHaveLength(2);
			// An append is reported as the appended line alone, not as another
			// whole-file re-ingest.
			writeFileSync(
				path,
				`\n${JSON.stringify({ schemaVersion: 1, at: "2026-09-11T09:14:17.000Z", layer: "engine", event: "effect.result", workflowId: "wf-3" })}`,
				{ flag: "a" },
			);
			await waitFor("wf-3:1");
			expect(seen).toContain("wf-3:1");
			expect(db.loadSpans("wf-3")).toHaveLength(3);
		} finally {
			stop();
			db.close();
		}
	});
});
