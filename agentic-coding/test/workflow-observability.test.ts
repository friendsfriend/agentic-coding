import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	boundedRuntimeAttributes,
	childTrace,
	parseTraceparent,
	TELEMETRY_FLUSH_BUDGET_MS,
	TelemetrySink,
	traceparent,
} from "../src/workflow/observability.ts";

test("W3C trace context propagates with new child identity", () => {
	const parent = parseTraceparent(
		"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	);
	if (!parent) throw new Error("expected traceparent to parse");
	const child = childTrace(parent);
	expect(child.traceId).toBe(parent.traceId);
	expect(child.spanId).not.toBe(parent.spanId);
	expect(parseTraceparent(traceparent(child))).toEqual(child);
	expect(parseTraceparent("broken")).toBeUndefined();
});
test("runtime fields are bounded and content is local opt-in", () => {
	expect(
		boundedRuntimeAttributes({ content: "secret", model: "x", tokens: 2 }),
	).toEqual({ model: "x", tokens: 2 });
	expect(
		boundedRuntimeAttributes({ content: "x".repeat(9000) }, true).content,
	).toHaveLength(8192);
});

test("the telemetry flush budget is fixed and small (no accidental liveness owner)", () => {
	expect(TELEMETRY_FLUSH_BUDGET_MS).toBeGreaterThan(0);
	expect(TELEMETRY_FLUSH_BUDGET_MS).toBeLessThanOrEqual(2_000);
});

test("TelemetrySink appends the JSONL envelope and a failing export is observational", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-sink-"));
	try {
		const sink = new TelemetrySink(
			directory,
			"http://127.0.0.1:1/v1/traces", // closed port: export must never raise
		);
		const envelope = {
			schemaVersion: 1 as const,
			at: "2026-01-02T00:00:00.000Z",
			layer: "engine" as const,
			event: "workflow.started",
			workflowId: `wf-${randomUUID()}`,
			traceparent: `00-${"0".repeat(32)}-${"1".repeat(16)}-01`,
		};
		expect(() => sink.emit(envelope)).not.toThrow();
		const written = fs.readFileSync(
			path.join(directory, "telemetry.jsonl"),
			"utf8",
		);
		expect(written).toContain(`"workflowId":"${envelope.workflowId}"`);
		expect(written).toContain(envelope.traceparent);
	} finally {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
