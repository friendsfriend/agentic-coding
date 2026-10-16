/** @jsxImportSource @opentui/solid */
// Settings pointer parity (`centralized-application-settings`): a tap selects a
// section row and a tap on the selected row runs the row's own action, which
// the shell expresses as the dialog's `Enter`.
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { SettingsItem } from "../../src/tui/settings/items.ts";
import { SettingsSectionView } from "../../src/tui/settings/SettingsSectionView.tsx";

const items: SettingsItem[] = [
	{
		id: "theme",
		label: "Theme",
		detail: "The shell's colour scheme",
		value: "nord",
		editable: true,
		scope: "user",
		section: "appearance",
	} as unknown as SettingsItem,
	{
		id: "compaction",
		label: "Compaction",
		detail: "Tokens kept when a session is compacted",
		value: "180000",
		editable: true,
		scope: "user",
		section: "appearance",
	} as unknown as SettingsItem,
];

test("a settings row selects on a tap and activates on a tap of the selected row", async () => {
	const activated = { run: () => {} };
	const activate = spyOn(activated, "run");
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<SettingsSectionView
				items={items}
				selectedIndex={selected()}
				onSelectIndex={setSelected}
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
				name: "probe.activateSetting",
				context: "global",
				run: () => {
					activated.run();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.activateSetting" },
			{ key: "return", cmd: "probe.activateSetting" },
		],
	});
	await t.flush();
	// The first pointer gesture on a fresh renderer also starts a text
	// selection; consume it on an inert cell before the measured taps.
	await t.mockMouse.click(78, 11);
	await t.flush();
	// Rows are three lines tall: the second row starts at y 3.
	await t.mockMouse.click(3, 4);
	await t.flush();
	expect(selected()).toBe(1);
	expect(activate.mock.calls.length).toBe(0);
	// A tap on the selected row is the row's own `Enter`.
	await t.mockMouse.click(3, 4);
	await t.flush();
	expect(activate.mock.calls.length).toBe(1);
	// Parity: the key reaches the same command.
	t.mockInput.pressEnter();
	await t.flush();
	expect(activate.mock.calls.length).toBe(2);
	t.renderer.destroy();
});
