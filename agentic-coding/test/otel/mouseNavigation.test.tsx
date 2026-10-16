/** @jsxImportSource @opentui/solid */
// Pointer parity for the observability trace list (`home-orchestrator`-adjacent
// shell surface): a tap selects a trace, a tap on the selected trace opens it
// through the shell's own `Enter`, and the key reaches the same command.
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { TraceSummary } from "../../src/contracts/telemetry.ts";
import { TraceListView } from "../../src/tui/otel/views/TraceListView.tsx";

const summary = (id: string): TraceSummary => ({
	traceId: id,
	rootSpans: [],
	startTime: 0n,
	endTime: 1_000_000n,
	durationMs: 1,
	errorCount: 0,
	spanCount: 1,
	agents: ["planner"],
	spanNames: ["step"],
});

test("a trace row selects on a tap and opens on a tap of the selected row", async () => {
	const opened = { open: () => {} };
	const open = spyOn(opened, "open");
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<TraceListView
				summaries={() => [summary("a"), summary("b"), summary("c")]}
				selectedIndex={selected}
				onSelect={setSelected}
				searchMode={() => false}
				searchQuery={() => ""}
				resultCount={() => 3}
				page={() => 1}
				totalPages={() => 1}
				loading={() => false}
			/>
		),
		{ width: 80, height: 12 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.openTrace",
				context: "global",
				run: () => {
					opened.open();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.openTrace" },
			{ key: "return", cmd: "probe.openTrace" },
		],
	});
	await t.flush();
	// The first pointer gesture on a fresh renderer also starts a text
	// selection; consume it on an inert cell before the measured taps.
	await t.mockMouse.click(78, 11);
	await t.flush();
	// The view's search header owns the first row, then two-line rows: the
	// second trace row sits at y 3..4.
	await t.mockMouse.click(3, 3);
	await t.flush();
	expect(selected()).toBe(1);
	expect(open.mock.calls.length).toBe(0);
	// A tap on the selected row is the view's `Enter`.
	await t.mockMouse.click(3, 3);
	await t.flush();
	expect(open.mock.calls.length).toBe(1);
	// Parity: the key reaches the same command.
	t.mockInput.pressEnter();
	await t.flush();
	expect(open.mock.calls.length).toBe(2);
	t.renderer.destroy();
});
