/** @jsxImportSource @opentui/solid */
// Dashboard pointer parity (`dashboard-panel-navigation`): the Agents panel is
// the witness for the panel wiring — a tap selects a row, a tap on the selected
// row runs the same command `Enter` runs, tapping the panel focuses it, and the
// layer behind the agent-session page takes no tap.
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Panel, useKeyDispatch } from "@ui";
import { createSignal } from "solid-js";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { AgentsPanel } from "../../src/tui/dash/panels/AgentsPanel.tsx";

/** The dashboard's own wiring: select the resolved row, then dispatch `Enter`. */
function PanelProbe(props: { onFocused: () => void }) {
	const dispatch = useKeyDispatch();
	const [selected, setSelected] = createSignal(1);
	return (
		<box width="100%" height="100%" flexDirection="column">
			<AgentsPanel
				data={testDashboard()}
				active
				selectedIndex={selected()}
				narrow={false}
				onSelectIndex={setSelected}
				onActivateRow={(index) => {
					setSelected(index);
					dispatch("Enter");
				}}
				onFocusRequest={props.onFocused}
			/>
			{/* A hidden twin, mounted the way the grid stays mounted behind the
			    agent-session page. */}
			<box visible={false} height={6}>
				<Panel title="Hidden" onFocusRequest={props.onFocused}>
					<text>hidden body</text>
				</Panel>
			</box>
		</box>
	);
}

test("the agents panel selects on a tap, opens on a tap of the selected row, and matches Enter", async () => {
	const opened = { open: () => {} };
	const open = spyOn(opened, "open");
	const focused = { focus: () => {} };
	const focus = spyOn(focused, "focus");
	const t = await testRender(() => <PanelProbe onFocused={focused.focus} />, {
		width: 120,
		height: 40,
	});
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.openSession",
				context: "global",
				run: () => {
					opened.open();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.openSession" },
			{ key: "return", cmd: "probe.openSession" },
		],
	});
	// The Agents panel animates its status badge, so wait for a frame rather than
	// for visual idle; the pointer must have been placed once for the renderer's
	// hit map to be primed before the measured taps.
	await t.waitForFrame(() => true);
	await t.mockMouse.moveTo(1, 1);
	await t.renderOnce();
	// Prime with a click outside any row (the panel title): the very first pointer
	// gesture on a fresh renderer also starts a text selection and is not the
	// gesture under test.
	await t.mockMouse.click(3, 0);
	await t.waitForFrame(() => true);
	const openBefore = open.mock.calls.length;
	// The panel title owns the first row, so the first agent row starts under it.
	// The cursor starts on the second row: the first tap only selects.
	await t.mockMouse.click(3, 1);
	await t.waitForFrame(() => true);
	expect(open.mock.calls.length).toBe(openBefore);
	// Tapping a panel requests focus for it, as `J/K/H/L` would.
	expect(focus.mock.calls.length).toBeGreaterThan(0);
	// A tap on the already-selected row opens the session, once.
	await t.mockMouse.click(3, 1);
	await t.waitForFrame(() => true);
	expect(open.mock.calls.length).toBe(openBefore + 1);
	// Parity: the key reaches the same command.
	t.mockInput.pressEnter();
	await t.waitForFrame(() => true);
	expect(open.mock.calls.length).toBe(openBefore + 2);
	t.renderer.destroy();
});
