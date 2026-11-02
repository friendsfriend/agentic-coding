/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { DebugRequestView } from "../../src/contracts/environment.ts";
import { DebugRequestsModal } from "../../src/tui/dash/ui/DebugRequestsModal.tsx";

const request = (id: string): DebugRequestView => ({
	id,
	goal: `probe-${id}`,
	status: "queued",
	callerRole: "worker",
	callerRunId: "run-1",
	createdAt: "2026-01-01T00:00:00Z",
	baseline: "usable",
	changedFiles: [],
	evidence: [],
	delivered: false,
});

function renderTree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(renderTree)];
}

test("debug request rows retain hover across refreshes and activate the current request after reorder", async () => {
	const [requests, setRequests] = createSignal([request("a"), request("b")]);
	const [selected, setSelected] = createSignal(-1);
	const opened: string[] = [];
	const t = await testRender(
		() => (
			<DebugRequestsModal
				requests={requests()}
				state="ready"
				selectedIndex={selected()}
				offset={12}
				onSelectIndex={setSelected}
			/>
		),
		{ width: 180, height: 45 },
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		commands: [
			{
				name: "test.open-report",
				context: "global",
				run: () => {
					opened.push(requests()[selected()]?.reportPath ?? "missing");
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "test.open-report" },
			{ key: "return", cmd: "test.open-report" },
		],
	});
	const rowY = (label: string) =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes(label));
	const background = (label: string) => {
		const span = t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes(label));
		if (!span) throw new Error(`Missing request row: ${label}`);
		return Array.from(span.bg.buffer);
	};
	try {
		await t.flush();
		await t.mockMouse.moveTo(20, rowY("probe-a"));
		await t.flush();
		const surface = renderTree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.height === 1 &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!surface) throw new Error("Missing hovered debug request");
		const hoverColor = Array.from(parseColor(uiColors.bgHover).buffer);
		expect(background("probe-a")).toEqual(hoverColor);
		for (const status of ["running", "done"] as const) {
			setRequests((current) =>
				current.map((item) => ({
					...item,
					...(item.id === "a"
						? {
								goal: "probe-updated",
								status,
								durationSeconds: 4,
								report: "Updated investigation report",
								reportPath: "/reports/latest.md",
							}
						: {}),
				})),
			);
			await t.renderOnce();
			expect(surface.isDestroyed).toBe(false);
			expect(background("probe-updated")).toEqual(hoverColor);
			expect(t.captureCharFrame().split("\n")[rowY("probe-updated")]).toContain(
				status,
			);
		}
		setRequests((current) => [...current].reverse());
		await t.flush();
		expect(surface.isDestroyed).toBe(false);
		await t.mockMouse.click(20, rowY("probe-updated"));
		await t.flush();
		expect(selected()).toBe(1);
		expect(opened).toHaveLength(0);
		expect(t.captureCharFrame()).toContain("Updated investigation report");
		await t.mockMouse.click(20, rowY("probe-updated"));
		await t.flush();
		expect(opened).toEqual(["/reports/latest.md"]);
	} finally {
		t.renderer.destroy();
	}
});
