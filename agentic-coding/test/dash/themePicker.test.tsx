/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ThemePicker } from "../../src/tui/shared/ThemePicker";

const THEMES = ["catppuccin", "nord", "tokyonight", "dracula"];

test("theme picker aligns the active and inactive name columns", async () => {
	const t = await testRender(
		() => (
			<ThemePicker
				selected={0}
				active="nord"
				themes={THEMES}
				searchMode="display"
			/>
		),
		{ width: 80, height: 20 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	const lines = frame.split("\n");
	const activeLine = lines.find((line) => line.includes("Nord"));
	const inactiveLine = lines.find((line) => line.includes("Catppuccin"));
	expect(activeLine).toBeDefined();
	expect(inactiveLine).toBeDefined();
	// Both name columns start at the same cell (the checkmark is a 2-cell
	// prefix, matching the inactive placeholder).
	const activeColumn = activeLine?.indexOf("Nord") ?? -1;
	const inactiveColumn = inactiveLine?.indexOf("Catppuccin") ?? -1;
	expect(activeColumn).toBe(inactiveColumn);
	t.renderer.destroy();
});

test("theme picker keeps its swatches on a narrow dialog", async () => {
	const t = await testRender(
		() => (
			<ThemePicker
				selected={0}
				active="nord"
				themes={THEMES}
				searchMode="display"
			/>
		),
		{ width: 60, height: 20 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	const line = frame.split("\n").find((row) => row.includes("Nord")) ?? "";
	// The full swatch strip is present: one leading swatch group after the
	// name plus five more.
	expect(line).toContain("▬▬▬");
	expect((line.match(/▬▬▬/g) ?? []).length).toBeGreaterThanOrEqual(3);
	t.renderer.destroy();
});
