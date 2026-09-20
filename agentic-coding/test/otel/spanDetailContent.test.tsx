/** @jsxImportSource @opentui/solid */
// Captured session content in the span detail: prompt text, tool arguments and
// tool results are long, so they render wrapped (and JSON is indented) instead
// of one clipped metadata row.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { SpanData, TreeNode } from "../../src/contracts/telemetry.ts";
import {
	prettyContent,
	SpanDetailView,
} from "../../src/tui/otel/views/SpanDetailView.tsx";

const span: SpanData = {
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "0000000000000001",
	parentSpanId: "",
	name: "runtime.tool",
	startTimeUnixNano: "1000000",
	endTimeUnixNano: "2000000",
	status: { code: 0 },
	attributes: [
		{ key: "pi.tool.name", value: "bash" },
		{
			key: "herdr.content.tool_input",
			value: JSON.stringify({ command: "bun test" }),
		},
		{
			key: "herdr.content.tool_output",
			value: `${"x".repeat(70)} tail-marker`,
		},
	],
	resource: { attributes: [], droppedAttributesCount: 0 },
	scope: { name: "pi", version: "" },
	serviceName: "pi",
	kind: 0,
};

const node: TreeNode = { span, depth: 0, expanded: true, children: [] };

test("captured content renders wrapped and pretty-printed", async () => {
	const t = await testRender(() => <SpanDetailView node={() => node} />, {
		width: 80,
		height: 24,
	});
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Tool input");
	// JSON payloads are indented for reading, not shown as one escaped line.
	expect(frame).toContain('"command": "bun test"');
	expect(frame).toContain("Tool output");
	// The long output wraps: its tail only fits on the row after the first chunk.
	const lines = frame.split("\n");
	const firstChunk = lines.findIndex((line) => line.includes("xxxx"));
	expect(firstChunk).toBeGreaterThanOrEqual(0);
	expect(lines[firstChunk + 1]?.trim().startsWith("marker")).toBe(true);
	// Metadata attributes keep their compact one-line row.
	expect(frame).toContain("pi.tool.name");
	expect(frame).toContain("bash");
	t.renderer.destroy();
});

test("prettyContent indents JSON and keeps plain text as captured", () => {
	expect(prettyContent('{"command":"bun test"}')).toBe(
		'{\n  "command": "bun test"\n}',
	);
	expect(prettyContent("[1,2]")).toBe("[\n  1,\n  2\n]");
	expect(prettyContent("plain output")).toBe("plain output");
	expect(prettyContent("{not json")).toBe("{not json");
});
