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

test("long footers wrap instead of clipping the tail entries", async () => {
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
	// Both ends of the catalog survive; nothing is clipped off a single row.
	expect(frame).toContain("Shift+J/K/H/L");
	expect(frame).toContain("? help");
	const populated = frame.split("\n").filter((line) => line.trim().length > 0);
	expect(populated.length).toBeGreaterThan(1);
	t.renderer.destroy();
});

test("status bar honors a parent inset when wrapping", async () => {
	const catalog: KeybindSection[] = [
		{
			title: "Actions",
			keybinds: [
				{ key: "ab", action: "cde" },
				{ key: "fg", action: "hij" },
				{ key: "kl", action: "mno" },
			],
		},
	];
	setActiveKeybindCatalog(catalog);

	// inset 4 → 14 usable columns: all three entries wrap onto their own row.
	const inset = await testRender(() => <StatusBar inset={4} />, {
		width: 20,
		height: 8,
	});
	await inset.flush();
	const insetRows = inset
		.captureCharFrame()
		.split("\n")
		.filter((line) => line.trim().length > 0);
	expect(insetRows.length).toBe(3);
	inset.renderer.destroy();

	// No inset → 18 usable columns: the first two entries share a row.
	const plain = await testRender(() => <StatusBar />, {
		width: 20,
		height: 8,
	});
	await plain.flush();
	const plainRows = plain
		.captureCharFrame()
		.split("\n")
		.filter((line) => line.trim().length > 0);
	expect(plainRows.length).toBe(2);
	plain.renderer.destroy();
});
