/** @jsxImportSource @opentui/solid */
// Theme picker rows (`tui-mouse-interaction`): a tap selects a theme and a tap
// on the selected row applies it, exactly as the keys do.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemePickerModal, ThemePickerView } from "@ui";
import { createSignal } from "solid-js";

test("a theme row selects on a tap and applies on a tap of the selected row", async () => {
	const picked: number[] = [];
	const [index, setIndex] = createSignal(0);
	const t = await testRender(
		() => (
			<ThemePickerModal
				selected={index}
				active="nord"
				themes={["nord", "dracula", "solarized"]}
				query=""
				filtering={false}
				onSelect={(next) => {
					picked.push(next);
					setIndex(next);
				}}
			/>
		),
		{ width: 60, height: 16 },
	);
	await t.flush();
	const lines = t.captureCharFrame().split("\n");
	const draculaY = lines.findIndex((line) => line.includes("Dracula"));
	expect(draculaY).toBeGreaterThan(0);
	// The row is not the cursor: the tap selects it.
	await t.mockMouse.click(20, draculaY);
	await t.flush();
	expect(picked.at(-1)).toBe(1);
	expect(index()).toBe(1);
	// A drag and a right click change nothing.
	await t.mockMouse.drag(20, draculaY, 22, draculaY + 1);
	await t.mockMouse.click(20, draculaY, 2);
	await t.flush();
	expect(picked.length).toBe(1);
	// A left tap on the selected row is the picker's `Enter`.
	await t.mockMouse.click(20, draculaY);
	await t.flush();
	expect(picked.length).toBe(2);
	t.renderer.destroy();
});

test("the environment theme adapter forwards its selection callback", async () => {
	const picked: number[] = [];
	const t = await testRender(
		() => (
			<ThemePickerView
				selectedIndex={0}
				activeTheme="nord"
				filterQuery=""
				filterActive={false}
				themes={["nord", "dracula"]}
				onSelectIndex={(index) => picked.push(index)}
			/>
		),
		{ width: 60, height: 16 },
	);
	await t.flush();
	const lines = t.captureCharFrame().split("\n");
	const draculaY = lines.findIndex((line) => line.includes("Dracula"));
	expect(draculaY).toBeGreaterThan(0);
	await t.mockMouse.click(20, draculaY);
	await t.flush();
	expect(picked.at(-1)).toBe(1);
	t.renderer.destroy();
});
