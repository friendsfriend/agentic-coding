/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { StatusBar } from "../../src/tui/otel/components/StatusBar";
import {
	type KeybindSection,
	setActiveKeybindCatalog,
} from "../../src/tui/shared/keybinds";

// The shell footer reads the reactive keybind store the active surface
// publishes; it must show special keys only and follow store updates.
const catalog = (panelAction: string, context: string): KeybindSection[] => [
	{
		title: "Navigation",
		keybinds: [
			{ key: "j/k", action: "scroll", standard: true },
			{ key: "Shift+J/K", action: "switch panel" },
		],
	},
	{
		title: "Panel",
		keybinds: [{ key: "Enter", action: panelAction, context }],
	},
];

test("status bar renders only special keybinds from the active catalog", async () => {
	setActiveKeybindCatalog(catalog("open artifact", "openspec"), "openspec");
	const t = await testRender(() => <StatusBar />, { width: 80, height: 3 });
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Shift+J/K switch panel");
	expect(frame).toContain("Enter open artifact");
	expect(frame).not.toContain("j/k scroll");
	t.renderer.destroy();
});

test("status bar follows the store when the active context changes", async () => {
	setActiveKeybindCatalog(catalog("open artifact", "openspec"), "openspec");
	const t = await testRender(() => <StatusBar />, { width: 80, height: 3 });
	await t.flush();
	expect(t.captureCharFrame()).toContain("Enter open artifact");

	setActiveKeybindCatalog(catalog("focus agent", "agents"), "agents");
	const frame = await t.waitForFrame((value) =>
		value.includes("Enter focus agent"),
	);
	expect(frame).not.toContain("Enter open artifact");
	t.renderer.destroy();
});

test("explicit keybinds override the active catalog", async () => {
	setActiveKeybindCatalog(catalog("open artifact", "openspec"), "openspec");
	const t = await testRender(
		() => <StatusBar keybinds={[{ key: "x", action: "custom" }]} />,
		{ width: 80, height: 3 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("x custom");
	expect(frame).not.toContain("Enter open artifact");
	t.renderer.destroy();
});

test("long footers stay one row and pin `?` help to the right", async () => {
	setActiveKeybindCatalog([
		{
			title: "Actions",
			keybinds: [
				{ key: "Shift+J/K/H/L", action: "move between panels" },
				{ key: "Shift+O", action: "repair guidance" },
				{ key: "c", action: "cost breakdown" },
				{ key: "Shift+T", action: "theme picker" },
				{ key: "r", action: "refresh dashboard" },
				{ key: "?", action: "help" },
			],
		},
	]);
	const t = await testRender(() => <StatusBar />, { width: 32, height: 8 });
	await t.flush();
	const frame = t.captureCharFrame();
	const populated = frame.split("\n").filter((line) => line.trim().length > 0);
	// A single row: overflow clips instead of growing the footer.
	expect(populated).toHaveLength(1);
	// `?` help is anchored to the right edge and survives the overflow.
	expect(populated[0]?.trimEnd().endsWith("? help")).toBe(true);
	// Entries pushed past the clipped left column are not rendered.
	expect(frame).not.toContain("Shift+O");
	t.renderer.destroy();
});

test("status bar advertises `?` help even when the catalog omits it", async () => {
	setActiveKeybindCatalog([
		{ title: "Actions", keybinds: [{ key: "x", action: "custom" }] },
	]);
	const t = await testRender(() => <StatusBar />, { width: 40, height: 3 });
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("x custom");
	expect(frame.trimEnd().endsWith("? help")).toBe(true);
	t.renderer.destroy();
});
