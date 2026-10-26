/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSidebarRow } from "../../src/tui/otel/app/agent-sidebar-model.ts";
import { AgentSidebar } from "../../src/tui/otel/components/AgentSidebar.tsx";

const row = (runId: string, role: string): AgentSidebarRow => ({
	key: JSON.stringify(["/repo", "flow-123", runId]),
	target: "/repo",
	workflowId: "flow-123",
	runId,
	role,
	status: runId === "run-1" ? "working" : "completed",
	runtime: "pi",
	model: "model-a",
	workflowStep: "Apply change",
	hostSocket: "/tmp/agent.sock",
	conversationId: "conversation-1",
});

const baseProps = {
	active: true,
	mode: "permanent" as const,
	widthLimit: 34,
	sourceState: "fresh" as const,
	onToggleMode: () => {},
	onSelectIndex: () => {},
	onOpen: () => {},
	onFocus: () => {},
};

test("renders recorded run identity and activates only a second tap on a selected row", async () => {
	const opened: string[] = [];
	const selected: number[] = [];
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const rows = [row("run-1", "implementer"), row("run-2", "reviewer")];
	const t = await testRender(
		() => (
			<AgentSidebar
				{...baseProps}
				rows={rows}
				selectedIndex={selectedIndex()}
				onSelectIndex={(index) => {
					selected.push(index);
					setSelectedIndex(index);
				}}
				onOpen={(agent) => opened.push(agent.runId)}
			/>
		),
		{ width: 100, height: 20 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Agents");
	expect(frame).toContain("implementer");
	expect(frame).toContain("flow-123");
	expect(frame).toContain("working");
	expect(frame).toContain("model-a");
	const rowY = frame.split("\n").findIndex((line) => line.includes("reviewer"));
	expect(rowY).toBeGreaterThanOrEqual(0);
	await t.mockMouse.click(12, rowY);
	await t.flush();
	expect(selected.at(-1)).toBe(1);
	expect(opened).toEqual([]);
	await t.mockMouse.click(12, rowY);
	await t.flush();
	expect(opened).toEqual(["run-2"]);
	t.renderer.destroy();
});

test("wheel scrolling changes only the window and keyboard selection reveals the selected row", async () => {
	const selected: number[] = [];
	const opened: string[] = [];
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const rows = Array.from({ length: 8 }, (_, index) =>
		row(`run-${index}`, `role-${index}`),
	);
	const t = await testRender(
		() => (
			<AgentSidebar
				{...baseProps}
				rows={rows}
				selectedIndex={selectedIndex()}
				onSelectIndex={(index) => selected.push(index)}
				onOpen={(agent) => opened.push(agent.runId)}
			/>
		),
		{ width: 100, height: 18 },
	);
	try {
		await t.flush();
		expect(t.captureCharFrame()).toContain("role-0");
		await t.mockMouse.scroll(10, 3, "down");
		await t.flush();
		expect(t.captureCharFrame()).not.toContain("role-0");
		expect(t.captureCharFrame()).toContain("role-3");
		expect(selected).toEqual([]);
		expect(opened).toEqual([]);
		setSelectedIndex(7);
		await t.flush();
		expect(t.captureCharFrame()).toContain("role-7");
	} finally {
		t.renderer.destroy();
	}
});

test("stale observations keep their known rows and narrow allocations use compact chrome", async () => {
	const t = await testRender(
		() => (
			<AgentSidebar
				{...baseProps}
				rows={[row("run-1", "implementer")]}
				selectedIndex={0}
				sourceState="stale"
			/>
		),
		{ width: 80, height: 18 },
	);
	try {
		await t.flush();
		expect(t.captureCharFrame()).toContain("stale");
		expect(t.captureCharFrame()).toContain("implementer");
	} finally {
		t.renderer.destroy();
	}
	const compact = await testRender(
		() => (
			<AgentSidebar
				{...baseProps}
				widthLimit={10}
				rows={[row("run-1", "implementer")]}
				selectedIndex={0}
			/>
		),
		{ width: 30, height: 18 },
	);
	try {
		await compact.flush();
		expect(compact.captureCharFrame()).not.toContain("implementer");
		expect(compact.captureCharFrame()).toContain("im…");
		expect(compact.captureCharFrame()).toContain("1");
	} finally {
		compact.renderer.destroy();
	}
});

test("empty sidebars show neither filters nor empty-state messages", async () => {
	for (const [active, widthLimit] of [
		[false, 34],
		[true, 10],
		[true, 34],
	] as const) {
		const t = await testRender(
			() => (
				<AgentSidebar
					{...baseProps}
					mode="expanding"
					active={active}
					widthLimit={widthLimit}
					rows={[]}
					selectedIndex={-1}
				/>
			),
			{ width: 40, height: 14 },
		);
		try {
			await t.flush();
			const frame = t.captureCharFrame();
			expect(frame).not.toContain("Act");
			expect(frame).not.toContain("All");
			expect(frame).not.toContain("No");
			expect(frame).not.toContain("active");
		} finally {
			t.renderer.destroy();
		}
	}
});

test("compact source cues distinguish loading and stale data with or without cached rows", async () => {
	for (const sourceState of ["loading", "fresh", "stale"] as const) {
		for (const rows of [[], [row("run-1", "implementer")]]) {
			for (const widthLimit of [6, 10]) {
				const t = await testRender(
					() => (
						<AgentSidebar
							{...baseProps}
							widthLimit={widthLimit}
							rows={rows}
							selectedIndex={rows.length ? 0 : -1}
							sourceState={sourceState}
						/>
					),
					{ width: 30, height: 18 },
				);
				try {
					await t.flush();
					const frame = t.captureCharFrame();
					expect(frame.includes("Stale")).toBe(sourceState === "stale");
					expect(frame.includes("Load…")).toBe(sourceState === "loading");
					expect(frame).not.toContain("Off");
					if (rows.length) expect(frame).toContain("im…");
					else expect(frame).not.toContain("No");
				} finally {
					t.renderer.destroy();
				}
			}
		}
	}
});

test("distinguishes an empty observation from an unavailable workflow source", async () => {
	for (const [sourceState, expected] of [
		["loading", "Reading agents…"],
		["fresh", ""],
		["stale", "Workflow source unavailable"],
	] as const) {
		const t = await testRender(
			() => (
				<AgentSidebar
					{...baseProps}
					rows={[]}
					selectedIndex={-1}
					sourceState={sourceState}
				/>
			),
			{ width: 100, height: 14 },
		);
		await t.flush();
		expect(t.captureCharFrame()).toContain(expected);
		t.renderer.destroy();
	}
});
