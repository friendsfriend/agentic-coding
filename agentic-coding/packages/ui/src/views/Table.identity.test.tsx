/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import type { TableRow } from "../types.ts";
import { RepositoryTable } from "./Table.tsx";

const app = (ident: string, displayName: string): TableRow => ({
	ident,
	displayName,
	rowKind: "app",
	appType: "APP",
	localDirectoryPath: `/repos/${ident}`,
	repositoryPath: `/repos/${ident}`,
	branch: "main",
	containerBaseName: ident,
	sourceType: "github",
	provider: "github",
	gitStatus: "✓",
	runtimeStatus: { state: "starting" },
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("work-item table cards survive refreshed app payloads and keep current click indices after reorder", async () => {
	const [apps, setApps] = createSignal([
		app("first", "First app"),
		app("second", "Second app"),
	]);
	const selected: number[] = [];
	const t = await testRender(
		() => (
			<RepositoryTable
				apps={apps()}
				columns={[]}
				selectedIndex={-1}
				onSelect={(index) => selected.push(index)}
				availableLines={18}
				showBorder={false}
			/>
		),
		{ width: 120, height: 24 },
	);
	const rowY = (label: string) =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes(label));
	try {
		// Starting rows intentionally animate continuously; paint explicit frames
		// rather than waiting for visual idle.
		await t.renderOnce();
		await t.renderOnce();
		await t.mockMouse.moveTo(10, rowY("First app"));
		await t.renderOnce();
		await t.renderOnce();
		// Both the list wrapper and card own hover. The deepest surface is the
		// WorkItemCard whose status/animation state must not be reconstructed.
		const card = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 2 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		if (!(card instanceof BoxRenderable))
			throw new Error("Missing hovered work-item card");
		setApps((current) => current.map((item) => ({ ...item })));
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		setApps((current) =>
			current.map((item) => ({
				...item,
				...(item.ident === "first"
					? {
							displayName: "Updated first",
							runtimeStatus: { state: "running" as const },
						}
					: {}),
			})),
		);
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(t.captureCharFrame()).toContain("Updated first");
		expect(t.captureCharFrame()).toContain("1/2 running");
		setApps((current) => [...current].reverse().map((item) => ({ ...item })));
		await t.renderOnce();
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		await t.mockMouse.click(10, rowY("Updated first"));
		await t.renderOnce();
		expect(selected).toEqual([1]);
	} finally {
		t.renderer.destroy();
	}
});

test("table tabs retain hover while counts and labels refresh and use current IDs after reorder", async () => {
	const [tabs, setTabs] = createSignal([
		{ id: "apps", label: "Apps", count: 2 },
		{ id: "libs", label: "Libraries", count: 1 },
	]);
	const clicked: string[] = [];
	const t = await testRender(
		() => (
			<RepositoryTable
				apps={[]}
				columns={[]}
				selectedIndex={-1}
				tabs={tabs()}
				activeTab="apps"
				onTabChange={(id) => clicked.push(id)}
				availableLines={18}
				showBorder={false}
			/>
		),
		{ width: 120, height: 24 },
	);
	const location = (label: string) => {
		const lines = t.captureCharFrame().split("\n");
		const y = lines.findIndex((line) => line.includes(label));
		return { x: (lines[y] ?? "").indexOf(label) + 1, y };
	};
	try {
		await t.flush();
		let point = location("Apps (2)");
		await t.mockMouse.moveTo(point.x, point.y);
		await t.flush();
		const tab = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.height === 3 &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!(tab instanceof BoxRenderable))
			throw new Error("Missing hovered table tab");
		setTabs((current) =>
			current.map((item) => ({
				...item,
				...(item.id === "apps" ? { label: "Repositories", count: 3 } : {}),
			})),
		);
		await t.renderOnce();
		expect(tab.isDestroyed).toBe(false);
		expect(tab.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(t.captureCharFrame()).toContain("Repositories (3)");
		setTabs((current) => [...current].reverse());
		await t.flush();
		expect(tab.isDestroyed).toBe(false);
		point = location("Repositories (3)");
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(clicked).toEqual(["apps"]);
	} finally {
		t.renderer.destroy();
	}
});
