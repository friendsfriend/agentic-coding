/** @jsxImportSource @opentui/solid */
// Modal option-list parity (`tui-mouse-interaction` / task 3.13): a tap selects
// an option, a tap on the selected option runs the dialog's own `Enter`, and the
// key reaches the same state.
import { expect, spyOn, test } from "bun:test";
import { ListViewModal } from "@agentic-coding/ui";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

test("a dialog's option list selects on a tap and activates on a tap of the selected row", async () => {
	const activated = { run: () => {} };
	const activate = spyOn(activated, "run");
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<ListViewModal
				title="Reject plan"
				fieldLabel="Choose a rejection reason"
				items={["reason one", "reason two", "reason three"]}
				selectedIndex={selected()}
				onSelect={setSelected}
				onActivate={(index) => {
					setSelected(index);
					activated.run();
				}}
				renderItem={(item, isSelected) => (
					<text fg={isSelected() ? undefined : undefined}>{item}</text>
				)}
			/>
		),
		{ width: 60, height: 16 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.activate",
				context: "global",
				run: () => {
					activated.run();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.activate" },
			{ key: "return", cmd: "probe.activate" },
		],
	});
	await t.flush();
	// The dialog is centred; the option rows sit inside it. Row 1 is not the
	// cursor, so the first tap only selects it.
	// The dialog is centred: its title row is 6, the field label 7, and the
	// option rows start under them.
	const row = (index: number) => 8 + index;
	await t.mockMouse.click(20, row(1));
	await t.flush();
	expect(selected()).toBe(1);
	expect(activate.mock.calls.length).toBe(0);
	// A tap on the selected row activates, once.
	await t.mockMouse.click(20, row(1));
	await t.flush();
	expect(activate.mock.calls.length).toBe(1);
	// Parity: the key reaches the same command.
	t.mockInput.pressEnter();
	await t.flush();
	expect(activate.mock.calls.length).toBe(2);
	t.renderer.destroy();
});
