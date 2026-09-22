// Trace-list span-type filtering and span-name search: the store keeps the
// distinct span (event) names per workflow so the filter modal can narrow the
// list by "tool calls", "LLM messages", and the rest without loading every span.
import { describe, expect, test } from "bun:test";
import type { SpanData } from "../../src/contracts/telemetry.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";

function span(options: {
	changeId: string;
	name: string;
	role?: string;
}): SpanData {
	return {
		traceId: options.changeId,
		spanId: `${options.changeId}-${options.name}`.padEnd(16, "0"),
		parentSpanId: "",
		name: options.name,
		startTimeUnixNano: "1000000000",
		endTimeUnixNano: "2000000000",
		status: { code: 0 },
		attributes: [
			{ key: "herdr.change.id", value: options.changeId },
			...(options.role ? [{ key: "herdr.role", value: options.role }] : []),
		],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

function store(): TraceStore {
	return new TraceStore([
		span({ changeId: "wf-tools", name: "runtime.tool", role: "worker" }),
		span({ changeId: "wf-tools", name: "runtime.message", role: "worker" }),
		span({ changeId: "wf-engine", name: "effect.result" }),
	]);
}

const ids = (value: TraceStore): string[] =>
	value.getTraceSummaries().map((summary) => summary.traceId);

describe("trace-list span-type filter", () => {
	test("lists the distinct span types across the loaded summaries", () => {
		expect(store().spanTypes_).toEqual([
			"effect.result",
			"runtime.message",
			"runtime.tool",
		]);
	});

	test("keeps only the workflows containing the selected span type", () => {
		const value = store();
		value.setSpanTypeFilter("runtime.tool");
		expect(ids(value)).toEqual(["wf-tools"]);
		expect(value.filteredCount_).toBe(1);
		expect(value.spanTypeFilter_).toBe("runtime.tool");

		// Clearing restores every workflow.
		value.setSpanTypeFilter("all");
		expect(ids(value).sort()).toEqual(["wf-engine", "wf-tools"]);
	});

	test("search matches a span name on any span of the workflow", () => {
		const value = store();
		value.applyFilter("runtime.tool");
		expect(ids(value)).toEqual(["wf-tools"]);

		value.applyFilter("effect.result");
		expect(ids(value)).toEqual(["wf-engine"]);
	});
});
