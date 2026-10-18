// Retention and notification bounds of the live telemetry stores
// (fix-tui-freezes-and-memory).
//
// The receivers push into these stores in the process that also renders the
// TUI, so an unbounded list is a leak the developer sees as growing memory, and
// a notification per pushed batch is a re-derivation per pushed batch. Both
// bounds are asserted here, together with the two properties that must not
// change: a read sees every pushed record, and the trace the view has open is
// never trimmed.
import { describe, expect, it } from "bun:test";
import type {
	LogData,
	MetricData,
	SpanData,
} from "../../src/contracts/telemetry.ts";
import { LogStore, MAX_LOGS } from "../../src/tui/otel/model/logStore.ts";
import {
	MAX_METRICS,
	MetricStore,
} from "../../src/tui/otel/model/metricStore.ts";
import {
	LIVE_NOTIFY_MS,
	MAX_LIVE_SPANS,
	TraceStore,
} from "../../src/tui/otel/model/traceStore.ts";

function span(traceId: string, index: number): SpanData {
	return {
		traceId,
		spanId: `${traceId}-span-${index}`,
		parentSpanId: "",
		name: "workflow.run",
		startTimeUnixNano: `${1_700_000_000_000_000_000n + BigInt(index)}`,
		endTimeUnixNano: `${1_700_000_000_000_000_000n + BigInt(index) + 1n}`,
		status: { code: 0 },
		attributes: [{ key: "herdr.change.id", value: traceId }],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "test", version: "" },
		serviceName: "test",
		kind: 0,
	};
}

function log(body: string): LogData {
	return {
		resource: { attributes: [] },
		scope: { name: "test", version: "" },
		timeUnixNano: `${Date.now().toString()}000000`,
		severity: "INFO",
		body,
		attributes: [],
		serviceName: "test",
	};
}

function metric(name: string): MetricData {
	return {
		resource: { attributes: [] },
		scope: { name: "test", version: "" },
		name,
		description: "",
		unit: "",
		type: "gauge",
		dataPoints: [],
		serviceName: "test",
	};
}

describe("live trace retention", () => {
	it("keeps the newest live spans and drops the oldest past the cap", () => {
		const store = new TraceStore([], { notifyIntervalMs: 0 });
		for (let index = 0; index < MAX_LIVE_SPANS + 500; index++)
			store.pushBatch([span("live", index)]);
		expect(store.spanCount_).toBe(MAX_LIVE_SPANS);
		// The newest span is retained; the first ones are the ones dropped.
		expect(store.getTraceSpans("live").at(-1)?.spanId).toBe(
			`live-span-${MAX_LIVE_SPANS + 499}`,
		);
		expect(store.getTraceSpans("live")[0]?.spanId).toBe("live-span-500");
	});

	it("never trims the trace the view has open", () => {
		const store = new TraceStore([], { notifyIntervalMs: 0 });
		const opened = Array.from({ length: 200 }, (_value, index) =>
			span("opened", index),
		);
		store.setTraceSpans(opened);
		for (let index = 0; index < MAX_LIVE_SPANS + 100; index++)
			store.pushBatch([span("other", index)]);
		expect(store.spanCount_).toBe(200 + MAX_LIVE_SPANS);
		expect(store.getTraceSpans("opened")).toHaveLength(200);
	});

	it("notifies once per window instead of once per batch", async () => {
		const store = new TraceStore([], { notifyIntervalMs: 40 });
		let notified = 0;
		store.onChange(() => {
			notified += 1;
		});
		const batch = [span("live", 1)];
		store.pushBatch(batch);
		store.pushBatch(batch);
		store.pushBatch(batch);
		expect(notified).toBe(0);
		await Bun.sleep(120);
		expect(notified).toBe(1);
	});

	it("notifies synchronously when coalescing is disabled", () => {
		const store = new TraceStore([], { notifyIntervalMs: 0 });
		let notified = 0;
		store.onChange(() => {
			notified += 1;
		});
		store.pushBatch([span("live", 1)]);
		expect(notified).toBe(1);
	});

	it("keeps the default window short enough for a live view", () => {
		expect(LIVE_NOTIFY_MS).toBeLessThanOrEqual(250);
	});
});

describe("live log retention", () => {
	it("keeps the newest logs and drops the oldest past the cap", () => {
		const store = new LogStore([], { flushIntervalMs: 0 });
		for (let index = 0; index < MAX_LOGS + 200; index++)
			store.pushBatch([log(`line ${index}`)]);
		expect(store.logCount_).toBe(MAX_LOGS);
		expect(store.getLogs().at(-1)?.body).toBe(`line ${MAX_LOGS + 199}`);
		expect(store.getLogs()[0]?.body).toBe("line 200");
	});

	it("a read sees what the pushes already delivered", () => {
		const store = new LogStore([], { flushIntervalMs: 10_000 });
		store.pushBatch([log("first")]);
		store.pushBatch([log("second")]);
		expect(store.getLogs().map((entry) => entry.body)).toEqual([
			"first",
			"second",
		]);
	});

	it("applies a burst of batches in one deferred pass", async () => {
		const store = new LogStore([], { flushIntervalMs: 30 });
		for (let index = 0; index < 50; index++)
			store.pushBatch([log(`line ${index}`)]);
		// Nothing is filtered until the window elapses; the burst costs one pass.
		await Bun.sleep(90);
		expect(store.logCount_).toBe(50);
		expect(store.filteredCount_).toBe(50);
	});

	it("exposes the retention cap the production store uses", () => {
		expect(MAX_LOGS).toBeGreaterThan(0);
	});
});

describe("live metric retention", () => {
	it("keeps the newest metrics past the cap", async () => {
		const store = new MetricStore();
		store.pushBatch(
			Array.from({ length: MAX_METRICS + 5 }, (_value, index) =>
				metric(`metric-${index}`),
			),
		);
		await Bun.sleep(700);
		expect(store.getStreams()).toHaveLength(MAX_METRICS);
		expect(
			store
				.getStreams()
				.some((item) => item.name === `metric-${MAX_METRICS + 4}`),
		).toBe(true);
		expect(store.getStreams().some((item) => item.name === "metric-0")).toBe(
			false,
		);
	});
});
