import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MultiplexerPort } from "../src/multiplexer/port.ts";
import type { WorkflowEngine } from "../src/workflow/runtime.ts";
import { syncAgentTabLabels } from "../src/workflow/tab-sync.ts";

function fakeEngine(input: {
	workspace?: string;
	runs: Array<{ status: string; tabId?: string; role?: string }>;
}): WorkflowEngine {
	return {
		status: () => ({
			workflowId: "wf",
			...(input.workspace ? { workspace: input.workspace } : {}),
			runs: input.runs.map((run, index) => ({
				id: `run-${index}`,
				stepId: "core.implementation",
				role: run.role ?? "worker",
				attempt: 1,
				status: run.status,
				runtime: "pi",
				profile: "test",
				...(run.tabId ? { tabId: run.tabId } : {}),
			})),
		}),
	} as unknown as WorkflowEngine;
}

/** Fake port recording the equivalent tab argv so the assertions stay about
 * behavior, not transport. */
function fakePort(tabs: Array<{ tab_id: string; label: string }>): {
	port: MultiplexerPort;
	calls: string[][];
	tabs: Array<{ tab_id: string; label: string }>;
} {
	const calls: string[][] = [];
	const port = {
		tabList: (workspaceId: string) => {
			calls.push(["tab", "list", workspaceId]);
			return Effect.succeed(
				tabs.map((tab) => ({ tabId: tab.tab_id, label: tab.label })),
			);
		},
		tabRename: (tabId: string, label: string) => {
			calls.push(["tab", "rename", tabId, label]);
			const target = tabs.find((tab) => tab.tab_id === tabId);
			if (target) target.label = label;
			return Effect.void;
		},
	} as unknown as MultiplexerPort;
	return { port, calls, tabs };
}

describe("syncAgentTabLabels", () => {
	test("renames a role tab to the glyph for its run status", async () => {
		const { port, calls } = fakePort([
			{ tab_id: "t1", label: "worker" },
			{ tab_id: "t2", label: "dashboard" },
		]);
		await syncAgentTabLabels(
			port,
			fakeEngine({
				workspace: "w1",
				runs: [{ status: "working", tabId: "t1" }],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "list", "w1"]);
		expect(calls).toContainEqual(["tab", "rename", "t1", "● worker"]);
		// The dashboard tab has no run and is never touched.
		expect(calls.some((args) => args[0] === "tab" && args[2] === "t2")).toBe(
			false,
		);
	});

	test("is idempotent when the label already matches", async () => {
		const { port, calls } = fakePort([{ tab_id: "t1", label: "● worker" }]);
		await syncAgentTabLabels(
			port,
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
		const { port, calls } = fakePort([{ tab_id: "t1", label: "○ worker" }]);
		await syncAgentTabLabels(
			port,
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
		const { port, calls } = fakePort([
			{ tab_id: "tv", label: "○ verification" },
		]);
		await syncAgentTabLabels(
			port,
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

	test("a superseded failed run no longer pins the completed tab", async () => {
		const { port, calls } = fakePort([{ tab_id: "t1", label: "✗ worker" }]);
		await syncAgentTabLabels(
			port,
			fakeEngine({
				workspace: "w1",
				runs: [
					{ status: "failed", tabId: "t1" },
					{ status: "completed", tabId: "t1" },
				],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "t1", "✓ worker"]);
	});

	test("a superseded blocked run no longer pins the completed tab", async () => {
		const { port, calls } = fakePort([{ tab_id: "t1", label: "■ worker" }]);
		await syncAgentTabLabels(
			port,
			fakeEngine({
				workspace: "w1",
				runs: [
					{ status: "blocked", tabId: "t1" },
					{ status: "completed", tabId: "t1" },
				],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "t1", "✓ worker"]);
	});

	test("a latest working run reactivates the tab after a completed run", async () => {
		const { port, calls } = fakePort([{ tab_id: "t1", label: "✓ worker" }]);
		await syncAgentTabLabels(
			port,
			fakeEngine({
				workspace: "w1",
				runs: [
					{ status: "completed", tabId: "t1" },
					{ status: "working", tabId: "t1" },
				],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "t1", "● worker"]);
	});

	test("aggregates the latest run of each role on a grouped tab", async () => {
		const { port, calls } = fakePort([
			{ tab_id: "tv", label: "○ verification" },
		]);
		await syncAgentTabLabels(
			port,
			fakeEngine({
				workspace: "w1",
				runs: [
					{ role: "worker", status: "completed", tabId: "tv" },
					{ role: "quality-verifier", status: "working", tabId: "tv" },
				],
			}),
			"/repo",
			"wf",
		);
		expect(calls).toContainEqual(["tab", "rename", "tv", "● verification"]);
	});

	test("ignores missing workspace, runs without tabs, and closed tabs", async () => {
		const { port, calls } = fakePort([{ tab_id: "t1", label: "worker" }]);
		await syncAgentTabLabels(
			port,
			fakeEngine({ runs: [{ status: "working", tabId: "t1" }] }),
			"/repo",
			"wf",
		);
		await syncAgentTabLabels(
			port,
			fakeEngine({ workspace: "w1", runs: [{ status: "working" }] }),
			"/repo",
			"wf",
		);
		await syncAgentTabLabels(
			port,
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

	test("never throws when the multiplexer fails", async () => {
		const port = {
			tabList: () => Effect.fail(new Error("runtime unavailable")),
		} as unknown as MultiplexerPort;
		await expect(
			syncAgentTabLabels(
				port,
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
