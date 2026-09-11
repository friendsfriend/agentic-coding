import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	adapterTelemetryEnvelope,
	boundedRuntimeAttributes,
	boundedTelemetryPayload,
	childTrace,
	parseTraceparent,
	redactTelemetryText,
	TELEMETRY_ATTRIBUTE_LIMIT,
	TELEMETRY_FLUSH_BUDGET_MS,
	TelemetrySink,
	telemetryEnvelope,
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

test("bounded payload preserves scalars, filters content, and truncates strings", () => {
	expect(
		boundedTelemetryPayload({
			count: 3,
			cost: 0.5,
			flag: true,
			label: "x",
			content: "secret",
			nested: { secret: true },
			missing: undefined,
		}),
	).toEqual({ count: 3, cost: 0.5, flag: true, label: "x" });
	const long = boundedTelemetryPayload({ note: "x".repeat(9000) });
	expect((long.note as string).length).toBe(TELEMETRY_ATTRIBUTE_LIMIT);
	expect(boundedTelemetryPayload({ content: "ok" }, true).content).toBe("ok");
});

test("envelope builders keep identity reserved and payload at the top level", () => {
	const engineEnvelope = telemetryEnvelope({
		layer: "engine",
		event: "agent.handoff",
		at: "2026-01-01T00:00:00.000Z",
		workflowId: "wf",
		runId: "run",
		outcome: "error",
		durationMs: 12,
		payload: { "herdr.run.attempt": 2, ignored: undefined },
	});
	expect(engineEnvelope.layer).toBe("engine");
	expect(engineEnvelope.runId).toBe("run");
	expect(engineEnvelope["herdr.run.attempt"]).toBe(2);
	expect(engineEnvelope.durationMs).toBe(12);
	const adapterEnvelope = adapterTelemetryEnvelope({
		event: "agent.launch",
		at: "2026-01-01T00:00:00.000Z",
		workflowId: "wf",
		runId: "run",
		runtime: "pi",
		payload: { "herdr.run.attempt": 1 },
	});
	expect(adapterEnvelope.layer).toBe("adapter");
	expect(adapterEnvelope.runtime).toBe("pi");
	expect(adapterEnvelope["herdr.run.attempt"]).toBe(1);
});

test("engine-side telemetry text redacts known credential shapes", () => {
	const redacted = redactTelemetryText(
		[
			"https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@example.com/repo.git",
			"token sk-abcdefghijklmnopqrstuvwxyz",
			"-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
		].join(" "),
	);
	expect(redacted).not.toContain("ghp_");
	expect(redacted).not.toContain("sk-abcdef");
	expect(redacted).not.toContain("BEGIN PRIVATE KEY");
	expect(redacted).toContain("[REDACTED]");
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
