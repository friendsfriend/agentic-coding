import { describe, expect, test } from "bun:test";
import type { HerdrPort } from "../src/workflow/adapters.ts";
import type { WorkflowEngine } from "../src/workflow/runtime.ts";
import { syncAgentTabLabels } from "../src/workflow/tab-sync.ts";

function fakeEngine(input: {
	workspace?: string;
	runs: Array<{ status: string; tabId?: string }>;
}): WorkflowEngine {
	return {
		status: () => ({
			workflowId: "wf",
			...(input.workspace ? { workspace: input.workspace } : {}),
			runs: input.runs.map((run, index) => ({
				id: `run-${index}`,
				stepId: "core.implementation",
				role: "worker",
				attempt: 1,
				status: run.status,
				runtime: "pi",
				profile: "test",
				...(run.tabId ? { tabId: run.tabId } : {}),
			})),
		}),
	} as unknown as WorkflowEngine;
}

function fakeHerdr(tabs: Array<{ tab_id: string; label: string }>) {
	const calls: string[][] = [];
	const herdr: HerdrPort = {
		call(...args: string[]) {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "list")
				return { tabs: tabs.map((tab) => ({ ...tab })) };
			if (args[0] === "tab" && args[1] === "rename") {
				const target = tabs.find((tab) => tab.tab_id === args[2]);
				if (target) target.label = args[3] ?? target.label;
				return {};
			}
			return {};
		},
	};
	return { herdr, calls, tabs };
}

describe("syncAgentTabLabels", () => {
	test("renames a role tab to the glyph for its run status", async () => {
		const { herdr, calls } = fakeHerdr([
			{ tab_id: "t1", label: "worker" },
			{ tab_id: "t2", label: "dashboard" },
		]);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({
				workspace: "w1",
				runs: [{ status: "working", tabId: "t1" }],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "t1", "● worker"]);
		// The dashboard tab has no run and is never touched.
		expect(calls.some((args) => args[0] === "tab" && args[2] === "t2")).toBe(
			false,
		);
	});

	test("is idempotent when the label already matches", async () => {
		const { herdr, calls } = fakeHerdr([{ tab_id: "t1", label: "● worker" }]);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({
				workspace: "w1",
				runs: [{ status: "working", tabId: "t1" }],
			}),
			"/repo",
			"wf",
		);
		expect(
			calls.some((args) => args[0] === "tab" && args[1] === "rename"),
		).toBe(false);
	});

	test("updates a previously open tab once the run completes", async () => {
		const { herdr, calls } = fakeHerdr([{ tab_id: "t1", label: "○ worker" }]);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({
				workspace: "w1",
				runs: [{ status: "completed", tabId: "t1" }],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "t1", "✓ worker"]);
	});

	test("aggregates grouped verification runs sharing one tab", async () => {
		const { herdr, calls } = fakeHerdr([
			{ tab_id: "tv", label: "○ verification" },
		]);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({
				workspace: "w1",
				runs: [
					{ status: "completed", tabId: "tv" },
					{ status: "working", tabId: "tv" },
				],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "tv", "● verification"]);
	});

	test("ignores missing workspace, runs without tabs, and closed tabs", async () => {
		const { herdr, calls } = fakeHerdr([{ tab_id: "t1", label: "worker" }]);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({ runs: [{ status: "working", tabId: "t1" }] }),
			"/repo",
			"wf",
		);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({ workspace: "w1", runs: [{ status: "working" }] }),
			"/repo",
			"wf",
		);
		await syncAgentTabLabels(
			herdr,
			fakeEngine({
				workspace: "w1",
				runs: [{ status: "working", tabId: "gone" }],
			}),
			"/repo",
			"wf",
		);
		expect(
			calls.some((args) => args[0] === "tab" && args[1] === "rename"),
		).toBe(false);
	});

	test("never throws when Herdr fails", async () => {
		const herdr: HerdrPort = {
			call() {
				throw new Error("herdr unavailable");
			},
		};
		await expect(
			syncAgentTabLabels(
				herdr,
				fakeEngine({
					workspace: "w1",
					runs: [{ status: "working", tabId: "t1" }],
				}),
				"/repo",
				"wf",
			),
		).resolves.toBeUndefined();
	});
});
