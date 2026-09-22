// Phase/category telemetry grouping in the trace tree: each lifecycle phase
// (`herdr.step.id`) is one parent node, each phase groups its events by
// category (agent, workflow, git operation, …), and the agent category groups
// by role. Roles come from the agent events themselves, so the grouping works
// for real engine, adapter, and runtime telemetry.
import { describe, expect, test } from "bun:test";
import type { SpanData, TreeNode } from "../../src/contracts/telemetry.ts";
import {
	TraceStore,
	telemetryCategory,
} from "../../src/tui/otel/model/traceStore.ts";

function span(options: {
	name: string;
	startMs: number;
	stepId?: string;
	role?: string;
	changeId?: string;
}): SpanData {
	const changeId = options.changeId ?? "wf-1";
	const start = (BigInt(options.startMs) * 1_000_000n).toString();
	const end = (BigInt(options.startMs + 5) * 1_000_000n).toString();
	return {
		traceId: "a".repeat(32),
		spanId: `${options.name}-${options.startMs}`.padEnd(16, "0").slice(0, 16),
		parentSpanId: "",
		name: options.name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		status: { code: 0 },
		attributes: [
			{ key: "herdr.change.id", value: changeId },
			...(options.stepId
				? [{ key: "herdr.step.id", value: options.stepId }]
				: []),
			...(options.role ? [{ key: "herdr.role", value: options.role }] : []),
		],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

const names = (nodes: readonly TreeNode[]): string[] =>
	nodes.map((node) => node.span.name);

describe("telemetryCategory", () => {
	test("maps event families to viewer categories", () => {
		expect(telemetryCategory("runtime.tool")).toBe("agent");
		expect(telemetryCategory("agent.handoff")).toBe("agent");
		expect(telemetryCategory("effect.result")).toBe("workflow");
		expect(telemetryCategory("workflow.started")).toBe("workflow");
		expect(telemetryCategory("git.status")).toBe("git operation");
		expect(telemetryCategory("developer.question.created")).toBe("developer");
		// Unknown families keep their own name rather than being dropped.
		expect(telemetryCategory("custom.event")).toBe("custom");
	});
});

describe("phase/category span tree", () => {
	test("groups by phase, then category, then role", () => {
		const store = new TraceStore([
			span({
				name: "runtime.turn",
				startMs: 10,
				stepId: "core.implementation",
				role: "worker",
			}),
			span({
				name: "runtime.tool",
				startMs: 20,
				stepId: "core.implementation",
				role: "worker",
			}),
			span({
				name: "agent.handoff",
				startMs: 30,
				stepId: "core.implementation",
				role: "worker",
			}),
			span({
				name: "effect.result",
				startMs: 40,
				stepId: "core.implementation",
			}),
			span({
				name: "runtime.turn",
				startMs: 50,
				stepId: "core.verification",
				role: "verifier",
			}),
			span({ name: "effect.result", startMs: 60, stepId: "core.verification" }),
		]);
		const root = store.getSpanTree("wf-1")[0];
		expect(root?.span.name).toBe("workflow: wf-1");
		const phases = root?.children ?? [];
		expect(names(phases)).toEqual(["core.implementation", "core.verification"]);

		const implementation = phases[0];
		const categories = implementation?.children ?? [];
		expect(names(categories)).toEqual(["agent", "workflow"]);
		const agent = categories[0];
		expect(names(agent?.children ?? [])).toEqual(["worker"]);
		expect(names(agent?.children[0]?.children ?? [])).toEqual([
			"runtime.turn",
			"runtime.tool",
			"agent.handoff",
		]);
		const workflow = categories[1];
		expect(names(workflow?.children ?? [])).toEqual(["effect.result"]);

		const verification = phases[1];
		expect(names(verification?.children ?? [])).toEqual(["agent", "workflow"]);
		expect(names(verification?.children[0]?.children ?? [])).toEqual([
			"verifier",
		]);
	});

	test("keeps unphased events under the root beside the phases", () => {
		const store = new TraceStore([
			span({ name: "workflow.started", startMs: 5 }),
			span({ name: "effect.result", startMs: 10, stepId: "core.plan" }),
		]);
		const root = store.getSpanTree("wf-1")[0];
		expect(names(root?.children ?? [])).toEqual(["workflow", "core.plan"]);
		expect(names(root?.children[0]?.children ?? [])).toEqual([
			"workflow.started",
		]);
	});

	test("keeps same-named groups in different phases distinct", () => {
		const store = new TraceStore([
			span({
				name: "runtime.turn",
				startMs: 10,
				stepId: "core.plan",
				role: "worker",
			}),
			span({
				name: "runtime.turn",
				startMs: 20,
				stepId: "core.implementation",
				role: "worker",
			}),
		]);
		const phases = store.getSpanTree("wf-1")[0]?.children ?? [];
		// Both phases contain an `agent` category with a `worker` group, so the
		// virtual span ids must still be unique for the timeline offsets map.
		const spanIds = phases.flatMap((phase) =>
			(phase.children ?? []).flatMap((node) => [
				node.span.spanId,
				...(node.children ?? []).map((child) => child.span.spanId),
			]),
		);
		expect(spanIds).toHaveLength(4);
		expect(new Set(spanIds).size).toBe(4);
	});

	test("keeps the legacy role-group shape for traces without phases", () => {
		const store = new TraceStore([
			span({ name: "agent.operation", startMs: 10, role: "worker" }),
			span({ name: "runtime.tool", startMs: 20, role: "worker" }),
			span({ name: "effect.result", startMs: 30 }),
		]);
		const root = store.getSpanTree("wf-1")[0];
		expect(names(root?.children ?? [])).toEqual([
			"worker agent",
			"effect.result",
		]);
		expect(names(root?.children[0]?.children ?? [])).toEqual([
			"agent.operation",
			"runtime.tool",
		]);
	});
});
