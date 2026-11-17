// Pure presentation and configuration rules: no renderer, runtime, gateway or
// engine. These replace the screenshots-and-stack tests that used to prove them.
import { expect, test } from "bun:test";
import { readKubernetes } from "../src/environment/kubernetes-config.ts";
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
