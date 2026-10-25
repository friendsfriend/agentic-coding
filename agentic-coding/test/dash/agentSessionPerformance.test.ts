import { describe, expect, test } from "bun:test";
import { applyWatchPatch } from "../../src/agent-host/view-ops.ts";
import {
	AGENT_SESSION_BLOCK_LIMIT,
	buildAgentSessionView,
	createAgentSessionProjection,
	readAgentSessionMetadata,
} from "../../src/tui/dash/agent-session.ts";

const assistant = (id: string, input: number, error?: string) => ({
	id,
	kind: "pi.assistant",
	model: [
		{
			stopReason: error ? "error" : "stop",
			...(error ? { errorMessage: error } : {}),
			usage: { input, output: 10 },
			content: [{ type: "text", text: `answer ${id}` }],
		},
	],
});

/** Count actual history accesses, not elapsed time on a shared test machine. */
function countedEntries(entries: unknown[], onRead: (index: number) => void) {
	return new Proxy(entries, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) onRead(Number(key));
			return Reflect.get(target, key, receiver);
		},
	});
}

function livePatch(value: unknown, sequence: number): unknown {
	return applyWatchPatch(value, {
		ops: [["s", ["docs", "pi.live", "generation"], { sequence }]],
	});
}

describe("bounded session projection measurements", () => {
	test("never reads compactions that cannot enter the projected window", () => {
		const hidden = 12_000;
		let hiddenReads = 0;
		const entries = countedEntries(
			[
				...Array.from({ length: hidden }, (_, index) => ({
					id: `old-${index}`,
					kind: "pi.compaction",
					data: { reason: "threshold" },
				})),
				...Array.from({ length: 600 }, (_, index) =>
					assistant(`tail-${index}`, 30_000),
				),
			],
			(index) => {
				if (index < hidden) hiddenReads++;
			},
		);
		const projection = createAgentSessionProjection({ entries });
		expect(projection.blocks.at(-1)?.id).toBe("tail-599:summary");
		while (!projection.step(0)) {
			// Fixed chunks exercise the production progressive early-stop path.
		}
		expect(projection.blocks).toHaveLength(AGENT_SESSION_BLOCK_LIMIT);
		expect(projection.blocks.some((block) => block.kind === "compaction")).toBe(
			false,
		);
		expect(hiddenReads).toBe(0);
	});

	test("adjacent visible compactions share long token-free gaps and live frames reuse labels", () => {
		const gap = 8_000;
		let gapReads = 0;
		const entries = countedEntries(
			[
				assistant("before", 120_000),
				...Array.from({ length: gap }, () => ({ kind: "unknown" })),
				...Array.from({ length: 40 }, (_, index) => ({
					id: `compact-${index}`,
					kind: "pi.compaction",
					data: { reason: "manual" },
				})),
				...Array.from({ length: 20 }, (_, index) =>
					assistant(`after-${index}`, 30_000),
				),
			],
			(index) => {
				if (index > 0 && index <= gap) gapReads++;
			},
		);
		let frame: unknown = { entries, docs: { "pi.live": {} } };
		const labels = createAgentSessionProjection(frame).blocks.filter(
			(block) => block.kind === "compaction",
		);
		expect(labels).toHaveLength(40);
		for (const block of labels)
			expect(block.text).toBe("Compaction (manual) · 120.0K → 30.0K tokens");
		// One gap search, not H times the number of visible compactions.
		expect(gapReads).toBe(gap);
		for (let sequence = 0; sequence < 32; sequence++) {
			frame = livePatch(frame, sequence);
			expect(
				createAgentSessionProjection(frame).blocks.filter(
					(block) => block.kind === "compaction",
				),
			).toEqual(labels);
		}
		expect(gapReads).toBe(gap);
	});

	test("a new source refreshes a compaction whose after-measurement was absent", () => {
		const entries = [
			assistant("before", 120_000),
			{ id: "compact", kind: "pi.compaction", data: { reason: "manual" } },
		];
		const label = (source: unknown[]) =>
			buildAgentSessionView({ entries: source }).find(
				(block) => block.kind === "compaction",
			)?.text;
		expect(label(entries)).toBe("Compaction (manual)");
		expect(label([...entries, assistant("after", 30_000)])).toBe(
			"Compaction (manual) · 120.0K → 30.0K tokens",
		);
		// Same length and IDs, changed measurement: identity, not length, owns it.
		expect(label([assistant("before", 90_000), entries[1]])).toBe(
			"Compaction (manual)",
		);
		expect(
			label([
				assistant("before", 90_000),
				entries[1],
				assistant("after", 20_000),
			]),
		).toBe("Compaction (manual) · 90.0K → 20.0K tokens");
	});

	test("shared gap ranges preserve nearest measurements across multiple token boundaries", () => {
		const compaction = (id: string) => ({
			id,
			kind: "pi.compaction",
			data: { reason: "threshold" },
		});
		const entries = [
			compaction("no-before"),
			assistant("one", 120_000),
			compaction("first"),
			compaction("second"),
			{ kind: "unknown" },
			assistant("two", 30_000),
			compaction("third"),
			assistant("three", 10_000),
			compaction("no-after"),
		];
		expect(
			buildAgentSessionView({ entries })
				.filter((block) => block.kind === "compaction")
				.map((block) => block.text),
		).toEqual([
			"Compaction (automatic, threshold) · 120.0K tokens after",
			"Compaction (automatic, threshold) · 120.0K → 30.0K tokens",
			"Compaction (automatic, threshold) · 120.0K → 30.0K tokens",
			"Compaction (automatic, threshold) · 30.0K → 10.0K tokens",
			"Compaction (automatic, threshold)",
		]);
	});
});

describe("immutable-source session metadata summaries", () => {
	test("32 actual live-only patches do not revisit entry history or timing records", () => {
		let entryReads = 0;
		let timingReads = 0;
		const history = 10_000;
		const entries = countedEntries(
			[
				assistant("failed", 500, "provider unavailable"),
				...Array.from({ length: history }, () => ({ kind: "unknown" })),
			],
			() => entryReads++,
		);
		const timings = Object.fromEntries(
			Array.from({ length: history }, (_, index) => [
				`timing-${index}`,
				{
					get generationMs() {
						timingReads++;
						return 1;
					},
				},
			]),
		);
		let frame: unknown = {
			entries,
			timings,
			docs: {
				"pi.live": {},
				"pi.usage": { models: { test: { input: 500, output: 1_000 } } },
			},
		};
		const first = readAgentSessionMetadata(frame);
		expect(first.error).toBe("provider unavailable");
		expect(first.contextTokens).toBe(500);
		expect(first.tokensPerSecond).toBe(100);
		expect(entryReads).toBeGreaterThan(history);
		expect(timingReads).toBe(history);
		const initialEntryReads = entryReads;
		for (let sequence = 0; sequence < 32; sequence++) {
			frame = livePatch(frame, sequence);
			expect(readAgentSessionMetadata(frame)).toEqual({
				...first,
				working: true,
			});
		}
		expect(entryReads).toBe(initialEntryReads);
		expect(timingReads).toBe(history);
	});

	test("append, same-length edit and root replacement refresh error and context summaries", () => {
		const first = {
			entries: [assistant("one", 500, "boom")],
			docs: { "pi.live": {} },
		};
		expect(readAgentSessionMetadata(first).error).toBe("boom");
		const edited = applyWatchPatch(first, {
			ops: [["s", ["entries", 0, "model", 0, "usage", "input"], 700]],
		});
		expect(readAgentSessionMetadata(edited)).toMatchObject({
			error: "boom",
			contextTokens: 700,
		});
		const appended = {
			...first,
			entries: [...first.entries, assistant("two", 900)],
		};
		expect(readAgentSessionMetadata(appended).error).toBeUndefined();
		expect(readAgentSessionMetadata(appended).contextTokens).toBe(900);
		const replaced = applyWatchPatch(appended, {
			ops: [["r", { entries: [assistant("one", 1_200, "new error")] }]],
		});
		expect(readAgentSessionMetadata(replaced)).toMatchObject({
			error: "new error",
			contextTokens: 1_200,
		});
		// Neither update mutated the source of the earlier cached summary.
		expect(readAgentSessionMetadata(first)).toMatchObject({
			error: "boom",
			contextTokens: 500,
		});
	});

	test("timings-only patches invalidate totals, including cached absent totals", () => {
		let reads = 0;
		const first = {
			entries: [],
			timings: {
				empty: {
					get generationMs() {
						reads++;
						return 0;
					},
				},
				malformed: { generationMs: Number.NaN },
			},
			docs: { "pi.usage": { models: { test: { output: 100 } } } },
		};
		expect(readAgentSessionMetadata(first).tokensPerSecond).toBeUndefined();
		expect(readAgentSessionMetadata(first).tokensPerSecond).toBeUndefined();
		expect(reads).toBe(1);
		const next = applyWatchPatch(first, {
			ops: [],
			timings: { measured: { generationMs: 2_500 } },
		});
		expect(readAgentSessionMetadata(next).tokensPerSecond).toBe(40);
		const corrected = applyWatchPatch(next, {
			ops: [],
			timings: { measured: { generationMs: 5_000 } },
		});
		expect(readAgentSessionMetadata(corrected).tokensPerSecond).toBe(20);
	});

	test("a malformed assistant does not clear an error but a later valid success does", () => {
		const entries = [
			assistant("failed", 500, "boom"),
			{ kind: "pi.assistant", model: [null] },
			{ kind: "pi.tool-result", model: [] },
		];
		expect(readAgentSessionMetadata({ entries }).error).toBe("boom");
		expect(
			readAgentSessionMetadata({
				entries: [...entries, { kind: "pi.assistant", model: [{}] }],
			}).error,
		).toBeUndefined();
	});
});
