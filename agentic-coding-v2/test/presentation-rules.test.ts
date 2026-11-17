// Pure presentation and configuration rules: no renderer, runtime, gateway or
// engine. These replace the screenshots-and-stack tests that used to prove them.
import { expect, test } from "bun:test";
import { readKubernetes } from "../src/environment/kubernetes-config.ts";
import { bulkFold, foldAll } from "../src/tui/features/sessions/card-folds.ts";
import {
	activeContextTokens,
	promptMeter,
} from "../src/tui/features/sessions/prompt-meter.ts";
import {
	modelLabel,
	turnStats,
} from "../src/tui/features/sessions/turn-stats.ts";
import {
	formatCallDuration,
	formatCost,
	formatTokenCount,
} from "../src/tui/presentation/components/transcriptFormat.ts";

test("token counts and costs render in the compact transcript form", () => {
	expect(formatTokenCount(0)).toBe("0");
	expect(formatTokenCount(999)).toBe("999");
	expect(formatTokenCount(12_340)).toBe("12.3K");
	expect(formatTokenCount(999_999)).toBe("1000.0K");
	expect(formatTokenCount(1_234_567)).toBe("1.2M");
	expect(formatCost(0)).toBe("$0.00");
	expect(formatCost(0.004)).toBe("<$0.01");
	expect(formatCost(0.01)).toBe("$0.01");
	expect(formatCost(1.239)).toBe("$1.24");
	expect(formatCallDuration(950)).toBe("950ms");
	expect(formatCallDuration(4200)).toBe("4.2s");
	expect(formatCallDuration(95_000)).toBe("1m 35s");
});

test("one footer per input sums only recorded usage and names every model", () => {
	const messages = [
		{ identity: 1, role: "user", text: "go" },
		{
			identity: 2,
			role: "assistant",
			provider: "anthropic",
			model: "a",
			usage: { cost: { total: 0.01 }, input: 1000, output: 200 },
		},
		{ identity: 3, role: "toolResult", toolName: "read" },
		{
			identity: 4,
			role: "assistant",
			provider: "anthropic",
			model: "b",
			usage: { cost: { total: 0.02 }, input: 2000, output: 300 },
		},
		{ identity: 5, role: "user", text: "again" },
		{
			identity: 6,
			role: "assistant",
			provider: "openai",
			model: "c",
			usage: { cost: { total: Number.NaN }, input: -1, output: 40 },
		},
	] as never[];
	const stats = turnStats(messages);
	// The footer belongs to the group's last rendered message, not the response.
	expect(stats.get("4")).toMatchObject({
		cost: 0.03,
		input: 3000,
		output: 500,
		responses: 2,
		models: ["anthropic/a", "anthropic/b"],
	});
	expect(stats.has("2")).toBe(false);
	// Non-finite and negative recordings are omitted, never estimated.
	expect(stats.get("6")).toMatchObject({ responses: 1, output: 40 });
	expect(stats.get("6")?.cost).toBeUndefined();
	expect(stats.get("6")?.input).toBeUndefined();
	// The label is a quoted, bounded string so it can never look like two fields.
	expect(modelLabel(["anthropic/a"])).toBe('"anthropic/a"');
	expect(modelLabel([])).toBe("not supplied");
	expect(Array.from(modelLabel(["m".repeat(200)])).length).toBe(101);
});

test("a Kubernetes pod target refuses what the chart or the operator owns", () => {
	const base = {
		cluster: "local",
		namespace: "fixtures",
		image: "fixture:latest",
	};
	expect(readKubernetes(base)).toMatchObject({ namespace: "fixtures" });
	for (const invalid of [
		{ ...base, namespace: "default" },
		{ ...base, namespace: "kube-system" },
		{ ...base, namespace: "Fixtures" },
		{ ...base, cluster: "1local" },
		{ ...base, environment: { A: "b" } },
		{ ...base, secretRefs: { A: "B" } },
		{ ...base, workload: "helm-release-v1", image: undefined },
	])
		expect(() => readKubernetes(invalid)).toThrow(/Kubernetes|Helm release/);
	// A forward must be one loopback port per replica, never a pod picker.
	expect(
		readKubernetes({
			...base,
			portForwards: [{ local: 10_000, remote: 5432 }],
		}),
	).toMatchObject({ portForwards: [{ local: 10_000, replica: 0 }] });
	for (const forwards of [
		[{ local: 0, remote: 5432 }],
		[{ local: 8080, remote: 0 }],
		[
			{ local: 8080, remote: 5432 },
			{ local: 8080, remote: 6379 },
		],
		[{ local: 8080, remote: 5432, replica: 2 }],
	])
		expect(() => readKubernetes({ ...base, portForwards: forwards })).toThrow(
			/Kubernetes|forward/,
		);
});

// The prompt footer reports the active context against the model's own window;
// it never invents either, and the window totals stay visibly separate.
test("the prompt meter reports context, cost and window tokens in that order", () => {
	expect(
		promptMeter({
			contextTokens: 63_900,
			contextWindow: 1_000_000,
			cost: 0.01,
			input: 1200,
			output: 300,
		}),
	).toBe("63.9K (6%) · $0.01 · tok 1.2K→300");
	// No catalogued window: the percentage is omitted, the size is not.
	expect(
		promptMeter({ contextTokens: 8100, contextWindow: null, cost: 0 }),
	).toBe("8.1K · $0.00");
	// Nothing recorded reports nothing rather than a zero.
	expect(promptMeter({})).toBe("");
	expect(promptMeter({ cost: 0.002 })).toBe("<$0.01");
});

test("the active context is the newest generation's prompt, cache included", () => {
	const entries = [
		{ id: 1, model: [{ role: "assistant", usage: { input: 10 } }] },
		{ id: 2, model: [{ role: "user" }] },
		{
			id: 3,
			model: [
				{ role: "assistant", usage: { input: 4000 } },
				{ role: "toolResult" },
				{
					role: "assistant",
					usage: { input: 400, cacheRead: 3600, cacheWrite: 40 },
				},
			],
		},
		// A trailing entry with no usage cannot hide the last recorded one.
		{ id: 4, model: [{ role: "assistant" }] },
	];
	expect(activeContextTokens(entries)).toBe(4040);
	expect(activeContextTokens([{ id: 1, model: [{ role: "user" }] }])).toBe(
		undefined,
	);
	// A zero total is not a context size.
	expect(
		activeContextTokens([
			{ id: 1, model: [{ role: "assistant", usage: { input: 0 } }] },
		]),
	).toBe(undefined);
});

// v1's Ctrl+T / Ctrl+O: one kind of block at a time, and the whole kind moves
// together — closed until one of its members is open, then closed again.
test("a bulk fold closes a half-open kind and keeps every other fold", () => {
	const thoughts = ["a:1", "a:2"];
	expect(bulkFold(thoughts, [])).toEqual({ ids: thoughts, open: true });
	expect(bulkFold(thoughts, ["a:2"])).toEqual({ ids: thoughts, open: false });
	expect(bulkFold(thoughts, ["a:1", "a:2"])).toEqual({
		ids: thoughts,
		open: false,
	});
	// A card's own section fold is not a card: it never decides the kind's state.
	expect(bulkFold(thoughts, ["a:1:output"])).toEqual({
		ids: thoughts,
		open: true,
	});
	expect(foldAll(["a:1", "a:1:output", "b:1"], thoughts, false)).toEqual([
		"a:1:output",
		"b:1",
	]);
	expect(foldAll(["a:1:output", "b:1"], thoughts, true)).toEqual([
		"a:1:output",
		"b:1",
		"a:1",
		"a:2",
	]);
});
