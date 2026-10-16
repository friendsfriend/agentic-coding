import { describe, expect, test } from "bun:test";
import {
	nanosToIso,
	normalizeRecord,
	toIso,
} from "../../scripts/efficiency/lib/normalize.ts";
import { readTelemetryJsonl } from "../../scripts/efficiency/lib/telemetry.ts";
import { makeFixtureEvidence } from "./fixture.ts";

const LEGACY = {
	at: "2026-01-01T10:00:05.000Z",
	event: "model_usage",
	role: "planner",
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 10,
	cacheWriteTokens: 5,
	totalTokens: 165,
	cost: 0.01,
};

const SPAN = {
	schemaVersion: 1,
	layer: "runtime",
	runtime: "pi-durable",
	event: "runtime.tool",
	at: "2026-01-02T09:00:04.700Z",
	workflowId: "span-wf",
	runId: "run-span-a",
	stepId: "core.implementation",
	role: "worker",
	profile: "pi-x",
	outcome: "error",
	"pi.tool.name": "bash",
	"pi.tool.call_id": "call-a1",
	"pi.tool.outcome": "error",
	"pi.tool.duration_ms": 12,
	"pi.tool.argument_bytes": 40,
	"pi.tool.result_bytes": 2048,
	"pi.error.class": "exit status 1",
};

describe("normalizeRecord", () => {
	test("recognizes both telemetry generations", () => {
		expect(normalizeRecord(LEGACY)?.format).toBe("legacy");
		expect(normalizeRecord(SPAN)?.format).toBe("span");
		// A span is a record with a spanId and no schemaVersion.
		expect(
			normalizeRecord({ spanId: "x", name: "effect.result", at: "t" })?.format,
		).toBe("span");
	});

	test("refuses a record without an event name", () => {
		expect(normalizeRecord({ role: "worker" })).toBeUndefined();
		expect(normalizeRecord({})).toBeUndefined();
	});

	test("reads the legacy envelope without inventing a workflow or run id", () => {
		const event = normalizeRecord(LEGACY);
		expect(event?.workflowId).toBeUndefined();
		expect(event?.runId).toBeUndefined();
		expect(event?.inputTokens).toBe(100);
		expect(event?.cost).toBe(0.01);
		// The file name is the fallback identity.
		expect(
			normalizeRecord(LEGACY, { workflowId: "legacy-wf" })?.workflowId,
		).toBe("legacy-wf");
	});

	test("reads the span envelope's tool metrics and keeps the raw input out", () => {
		const event = normalizeRecord(SPAN);
		expect(event?.workflowId).toBe("span-wf");
		expect(event?.runId).toBe("run-span-a");
		expect(event?.toolName).toBe("bash");
		expect(event?.callId).toBe("call-a1");
		expect(event?.toolDurationMs).toBe(12);
		expect(event?.toolResultBytes).toBe(2048);
		expect(event?.errorClass).toBe("exit status 1");

		const captured = normalizeRecord({
			...SPAN,
			"herdr.content.tool_input":
				'{"command":"curl -H Bearer sk-live-abcdefghijklmnop https://x"}',
		});
		expect(captured?.toolInput?.digest).toBe("bash curl");
		expect(JSON.stringify(captured)).not.toContain("sk-live");
		expect(JSON.stringify(captured)).not.toContain("curl -H");
	});

	test("a non-tool event's status is not an error class", () => {
		const finding = normalizeRecord({
			name: "verification_finding",
			severity: "warning",
			status: "new",
			description: "a finding body that must not be stored",
		});
		expect(finding?.toolOutcome).toBeUndefined();
		expect(finding?.errorClass).toBeUndefined();
		expect(finding?.severity).toBe("warning");
		// The body is reduced to a hash and a byte count.
		expect(finding?.detail?.bytes).toBe(38);
		expect(JSON.stringify(finding)).not.toContain("finding body");
	});

	test("a handoff reason is only the engine's, never free prose", () => {
		const handoff = normalizeRecord({
			event: "agent.handoff",
			outcome: "blocked",
			"herdr.handoff.outcome": "blocked",
			"herdr.handoff.reason": "verification_failed",
		});
		expect(handoff?.handoffOutcome).toBe("blocked");
		expect(handoff?.handoffReason).toBe("verification_failed");

		const phase = normalizeRecord({
			event: "phase_changed",
			reason: "Quality review needed for new persistence layer and tests",
		});
		expect(phase?.reasonCode).toBeUndefined();
		expect(phase?.detail).toBeUndefined();
		expect(
			normalizeRecord({
				event: "phase_changed",
				reason: "verification_requested",
			})?.reasonCode,
		).toBe("verification_requested");
	});

	test("lets a span attribute identify its workflow when the column is not enough", () => {
		const event = normalizeRecord(
			{ name: "runtime.usage", change: "traces-only-wf", inputTokens: 300 },
			{ workflowId: "", at: "2026-01-01T00:00:00.000Z" },
		);
		expect(event?.workflowId).toBe("traces-only-wf");
	});

	test("converts timestamps from every shape a source uses", () => {
		expect(toIso(1767261600000)).toBe("2026-01-01T10:00:00.000Z");
		expect(toIso("2026-01-01T10:00:00.000Z")).toBe("2026-01-01T10:00:00.000Z");
		expect(nanosToIso(1767261600000000000)).toBe("2026-01-01T10:00:00.000Z");
		expect(nanosToIso(0)).toBeUndefined();
	});
});

describe("readTelemetryJsonl", () => {
	test("tolerates a truncated line, a non-JSON line, an array and a nameless record", () => {
		const fixture = makeFixtureEvidence();
		try {
			const result = readTelemetryJsonl(
				`${fixture.root}/main-store/telemetry/corrupt-wf.jsonl`,
				"corrupt-wf",
			);
			expect(result.stats.records).toBe(5);
			expect(result.stats.parsed).toBe(1);
			expect(result.stats.skipped).toBe(4);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.event).toBe("workflow.started");
			expect(result.events[0]?.workflowId).toBe("corrupt-wf");
		} finally {
			fixture.cleanup();
		}
	});

	test("reports an unreadable file as a note instead of throwing", () => {
		const result = readTelemetryJsonl("/definitely/not/here.jsonl", "x");
		expect(result.events).toHaveLength(0);
		expect(result.stats.records).toBe(0);
		expect(result.stats.notes.length).toBe(1);
	});
});
