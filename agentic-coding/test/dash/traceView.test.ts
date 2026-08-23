import { expect, test } from "bun:test";
import { parseJsonl } from "../../src/tui/otel/model/parser.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";

// Confirms the dashboard's trace tab (data.ts + ui/TraceBrowser.tsx) can read the
// exact traces.jsonl shape the workflow engine writes (telemetry.ts SpanRecord:
// Record<string, unknown> attributes, string status) through the shared otel-tui
// parser/store — the module now consumed by both agent-dash and the otel-tui binary.
test("parses workflow-engine traces.jsonl lines and groups them by change", () => {
	const line = (id: string, parentSpanId: string | null, status?: string) =>
		JSON.stringify({
			traceId: "a".repeat(32),
			spanId: id.repeat(16),
			parentSpanId,
			name: `op-${id}`,
			startTimeUnixNano: "1000000",
			endTimeUnixNano: "2000000",
			status,
			attributes: { "service.name": "test", "herdr.change.id": "my-change" },
		});
	const jsonl = [line("1", null), line("2", "1".repeat(16), "ERROR")].join(
		"\n",
	);
	const spans = parseJsonl(jsonl);
	expect(spans).toHaveLength(2);

	const flatten = (
		nodes: ReturnType<TraceStore["getSpanTree"]>,
	): ReturnType<TraceStore["getSpanTree"]> =>
		nodes.flatMap((node) => [node, ...flatten(node.children)]);
	const tree = new TraceStore(spans).getSpanTree("my-change");
	expect(tree).toHaveLength(1);
	expect(
		flatten(tree).some(
			(node) => node.span.name === "op-2" && node.span.status.code === 2,
		),
	).toBe(true);
});
