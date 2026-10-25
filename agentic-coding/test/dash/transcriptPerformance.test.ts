import { expect, test } from "bun:test";
import {
	type AgentSessionBlock,
	AgentSessionProjectionCache,
	buildAgentSessionView,
	createAgentSessionProjection,
	reuseAgentSessionBlocks,
} from "../../src/tui/dash/agent-session.ts";

test("projection cache evicts least-recent entries without caching empty history", () => {
	const cache = new AgentSessionProjectionCache();
	const entries = Array.from({ length: 513 }, () => ({}));
	let builds = 0;
	const project = (entry: object) =>
		cache.project(entry, "entry", undefined, undefined, () => {
			builds++;
			return [{ id: "entry", kind: "notice", tone: "muted", text: "cached" }];
		});
	const first = entries[0];
	const second = entries[1];
	if (!first || !second) throw new Error("Missing cache fixtures");
	for (const entry of entries.slice(0, 512)) project(entry);
	project(first);
	for (let index = 0; index < 1000; index++)
		cache.project({}, "empty", undefined, undefined, () => []);
	expect(builds).toBe(512);
	const last = entries[512];
	if (!last) throw new Error("Missing eviction fixture");
	project(last);
	project(first);
	expect(builds).toBe(513);
	project(second);
	expect(builds).toBe(514);
});

test("cached immutable entries retain projections and timing changes invalidate them", () => {
	const entry = {
		id: "a",
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "thought" },
					{ type: "text", text: "answer" },
				],
			},
		],
	};
	const entries = [entry];
	const cache = new AgentSessionProjectionCache();
	const first = buildAgentSessionView(
		{ entries, timings: { a: { generationMs: 100, thinkingMs: 20 } } },
		{ cache },
	);
	const second = buildAgentSessionView(
		{
			entries,
			timings: { a: { generationMs: 100, thinkingMs: 20 } },
			docs: { "pi.live": {} },
		},
		{ cache },
	);
	expect(second[0]).toBe(first[0]);
	const changed = buildAgentSessionView(
		{ entries, timings: { a: { generationMs: 200, thinkingMs: 40 } } },
		{ cache },
	);
	expect(changed[0]).not.toBe(first[0]);
	expect(changed.find((block) => block.kind === "reasoning")?.durationMs).toBe(
		40,
	);
});

test("progressive projection stops parsing history once the retained window is full", () => {
	const visited = new Set<number>();
	const entries = Array.from({ length: 10_000 }, (_, index) => ({
		id: String(index),
		kind: "pi.assistant",
		get model() {
			visited.add(index);
			return [
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			];
		},
	}));
	const projection = createAgentSessionProjection(
		{ entries },
		{ cache: new AgentSessionProjectionCache() },
	);
	while (!projection.complete) projection.step();
	expect(projection.blocks).toHaveLength(240);
	expect(visited.size).toBeLessThanOrEqual(480);
});

test("block reuse compares exact live arguments and structured results without serialization", () => {
	const first: AgentSessionBlock = {
		id: "tool",
		kind: "tool",
		tone: "warning",
		text: "write",
		live: true,
		toolCall: {
			name: "write",
			args: { path: "a.ts", content: "same" },
			progress: { calls: [{ output: "first" }] },
		},
	};
	const clone = {
		...first,
		toolCall: {
			name: "write",
			args: { path: "a.ts", content: "same" },
			progress: { calls: [{ output: "first" }] },
		},
	};
	expect(reuseAgentSessionBlocks([first], [clone])[0]).toBe(first);
	const rewritten = {
		...clone,
		toolCall: { ...clone.toolCall, args: { path: "a.ts", content: "else" } },
	};
	expect(reuseAgentSessionBlocks([first], [rewritten])[0]).toBe(rewritten);
	const output = {
		...clone,
		toolCall: { ...clone.toolCall, progress: { calls: [{ output: "other" }] } },
	};
	expect(reuseAgentSessionBlocks([first], [output])[0]).toBe(output);
});
