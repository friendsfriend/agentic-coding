/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	type KeyEvent,
	parseColor,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import {
	type PresetChoice,
	PresetSwitcherModal,
} from "../../src/tui/dash/ui/PresetSwitcherModal.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}
const key = (name: string) => ({ name }) as KeyEvent;

test("preset rows retain hover and cursor identity across catalog refresh and reorder", async () => {
	const [choices, setChoices] = createSignal<PresetChoice[]>([
		{ label: "Defaults" },
		{ label: "Fast", value: "fast" },
		{ label: "Safe", value: "safe" },
	]);
	const chosen: (string | undefined)[] = [];
	let handler: ((key: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<PresetSwitcherModal
				choices={choices()}
				selected="safe"
				onSelect={(value) => chosen.push(value)}
				onCancel={() => {}}
				onKeyReady={(ready) => {
					handler = ready;
				}}
			/>
		),
		{ width: 120, height: 30 },
	);
	const rowY = () =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Fast"));
	const rowX = () =>
		(t.captureCharFrame().split("\n")[rowY()] ?? "").indexOf("Fast") + 2;
	try {
		await t.flush();
		if (!handler) throw new Error("Missing picker key handler");
		await t.mockMouse.moveTo(rowX(), rowY());
		await t.flush();
		const surface = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.height === 1 &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		const label = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText.includes("Fast"),
		);
		if (
			!(surface instanceof BoxRenderable) ||
			!(label instanceof TextRenderable)
		)
			throw new Error("Missing hovered preset row");
		setChoices((current) =>
			[...current].reverse().map((choice) => ({
				...choice,
				...(choice.value === "fast" ? { label: "Fast updated" } : {}),
			})),
		);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(label.isDestroyed).toBe(false);
		expect(label.plainText).toContain("Fast updated");
		expect(surface.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		handler(key("enter"));
		expect(chosen).toEqual(["safe"]);
		await t.mockMouse.click(rowX(), rowY());
		await t.flush();
		expect(chosen).toEqual(["safe"]);
		setChoices((current) => current.map((choice) => ({ ...choice })));
		await t.renderOnce();
		await t.mockMouse.click(rowX(), rowY());
		await t.flush();
		expect(chosen).toEqual(["safe", "fast"]);
	} finally {
		t.renderer.destroy();
	}
});

test("default configuration has its own identity and cursor clamps when a preset disappears", async () => {
	const [choices, setChoices] = createSignal<PresetChoice[]>([
		{ label: "Defaults" },
		{ label: "Named preset", value: "config-defaults" },
	]);
	const chosen: (string | undefined)[] = [];
	let handler: ((key: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<PresetSwitcherModal
				choices={choices()}
				onSelect={(value) => chosen.push(value)}
				onCancel={() => {}}
				onKeyReady={(ready) => {
					handler = ready;
				}}
			/>
		),
		{ width: 120, height: 30 },
	);
	try {
		await t.flush();
		if (!handler) throw new Error("Missing picker key handler");
		setChoices((current) => [...current].reverse());
		await t.renderOnce();
		handler(key("enter"));
		expect(chosen).toEqual([undefined]);
		setChoices([{ label: "Named preset", value: "config-defaults" }]);
		await t.renderOnce();
		handler(key("enter"));
		expect(chosen).toEqual([undefined, "config-defaults"]);
		setChoices([]);
		await t.renderOnce();
		handler(key("enter"));
		expect(chosen).toHaveLength(2);
		expect(t.captureCharFrame()).toContain("No agent presets configured");
		setChoices([{ label: "New preset", value: "new" }]);
		await t.renderOnce();
		handler(key("enter"));
		expect(chosen).toEqual([undefined, "config-defaults", "new"]);
	} finally {
		t.renderer.destroy();
	}
});
