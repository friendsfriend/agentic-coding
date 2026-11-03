/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	parseColor,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { SettingsItem } from "../../src/tui/settings/items.ts";
import { SettingsSectionView } from "../../src/tui/settings/SettingsSectionView.tsx";
import { DestinationPage } from "../../src/tui/shared/navigation/DestinationPage.tsx";
import type { DestinationEntry } from "../../src/tui/shared/navigation/destinations.ts";
import { LocationPicker } from "../../src/tui/shared/navigation/LocationPicker.tsx";
import type { Route } from "../../src/tui/shared/routes.ts";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

for (const picker of [false, true]) {
	test(`${picker ? "location picker" : "destination page"} retains cards across catalog refresh and opens the current entry after reorder`, async () => {
		const [entries, setEntries] = createSignal<DestinationEntry[]>([
			{
				id: "first",
				label: "First destination",
				description: "Original detail",
				group: "Pages",
				route: { page: "wiki" },
			},
			{
				id: "second",
				label: "Second destination",
				description: "Second detail",
				group: "Pages",
				route: { page: "schedules" },
			},
		]);
		const [selected, setSelected] = createSignal(-1);
		const opened: (DestinationEntry | Route)[] = [];
		const t = await testRender(
			() =>
				picker ? (
					<LocationPicker
						entries={entries()}
						selectedIndex={selected()}
						onSelectIndex={setSelected}
						onAccept={(route) => opened.push(route)}
						query=""
						onQueryChange={() => {}}
						onClose={() => {}}
					/>
				) : (
					<DestinationPage
						entries={entries()}
						selectedIndex={selected()}
						onSelectIndex={setSelected}
						onOpen={(entry) => opened.push(entry)}
					/>
				),
			{ width: 120, height: 30 },
		);
		const point = (label: string) => {
			const lines = t.captureCharFrame().split("\n");
			const y = lines.findIndex((line) => line.includes(label));
			return { x: (lines[y] ?? "").indexOf(label) + 2, y };
		};
		try {
			await t.flush();
			let location = point("First destination");
			await t.mockMouse.moveTo(location.x, location.y);
			await t.flush();
			const card = tree(t.renderer.root)
				.filter(
					(node) =>
						node instanceof BoxRenderable &&
						node.height === 2 &&
						node.backgroundColor.equals(parseColor(uiColors.bgHover)),
				)
				.at(-1);
			const description = tree(t.renderer.root).find(
				(node) =>
					node instanceof TextRenderable &&
					node.plainText.includes("Original detail"),
			);
			if (
				!(card instanceof BoxRenderable) ||
				!(description instanceof TextRenderable)
			)
				throw new Error("Missing destination card");
			setEntries((current) =>
				current.map((entry) => ({
					...entry,
					...(entry.id === "first"
						? {
								label: "Updated first",
								description: "Updated detail",
								route: { page: "observability.logs" as const },
							}
						: {}),
				})),
			);
			await t.renderOnce();
			expect(card.isDestroyed).toBe(false);
			expect(description.isDestroyed).toBe(false);
			expect(description.plainText).toContain("Updated detail");
			expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
			setEntries((current) => [...current].reverse());
			await t.flush();
			expect(card.isDestroyed).toBe(false);
			location = point("Updated first");
			await t.mockMouse.click(location.x, location.y);
			await t.flush();
			expect(selected()).toBe(1);
			if (!picker) {
				expect(opened).toHaveLength(0);
				await t.mockMouse.click(location.x, location.y);
				await t.flush();
			}
			expect(opened).toHaveLength(1);
			const expected = picker ? entries()[1]?.route : entries()[1];
			if (!expected) throw new Error("Missing expected destination target");
			expect(opened[0]).toBe(expected);
		} finally {
			t.renderer.destroy();
		}
	});
}

test("settings cards retain hover and fields while effective value, editability and order update", async () => {
	const [items, setItems] = createSignal<SettingsItem[]>([
		{
			id: "theme",
			label: "Theme",
			value: "nord",
			detail: "Original detail",
			editable: true,
			action: { kind: "theme-picker" },
		},
		{
			id: "other",
			label: "Other",
			value: "on",
			detail: "Other detail",
			editable: false,
			action: { kind: "none" },
		},
	]);
	const [selected, setSelected] = createSignal(-1);
	const t = await testRender(
		() => (
			<SettingsSectionView
				items={items()}
				selectedIndex={selected()}
				onSelectIndex={setSelected}
			/>
		),
		{ width: 120, height: 24 },
	);
	const yOf = () =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Theme"));
	try {
		await t.flush();
		await t.mockMouse.moveTo(6, yOf());
		await t.flush();
		const card = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 3 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		const title = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText.includes("Theme"),
		);
		const detail = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText === "Original detail",
		);
		if (
			!(card instanceof BoxRenderable) ||
			!(title instanceof TextRenderable) ||
			!(detail instanceof TextRenderable)
		)
			throw new Error("Missing setting card");
		setItems((current) =>
			current.map((item) => ({
				...item,
				...(item.id === "theme"
					? {
							value: "dracula",
							detail: "Updated detail",
							editable: false,
							action: { kind: "none" as const },
						}
					: {}),
			})),
		);
		await t.renderOnce();
		for (const node of [card, title, detail])
			expect(node.isDestroyed).toBe(false);
		expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(title.plainText).toContain("read-only — dracula");
		expect(detail.plainText).toBe("Updated detail");
		setItems((current) => [...current].reverse());
		await t.flush();
		expect(card.isDestroyed).toBe(false);
		await t.mockMouse.click(6, yOf());
		await t.flush();
		expect(selected()).toBe(1);
	} finally {
		t.renderer.destroy();
	}
});
