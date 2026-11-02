/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	parseColor,
	type Renderable,
	TextAttributes,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { BreadcrumbRow } from "../../src/tui/shared/navigation/BreadcrumbRow.tsx";
import {
	breadcrumb,
	type Route,
	resourceRoute,
} from "../../src/tui/shared/routes.ts";

const ancestors = () =>
	breadcrumb(
		resourceRoute("applications", "app-1", "jobs", { kind: "applications" }),
	);

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("breadcrumb hover survives focus updates and fresh routes while clicks use current route objects", async () => {
	const [routes, setRoutes] = createSignal(ancestors());
	const [focused, setFocused] = createSignal(routes().length - 1);
	const selected: number[] = [];
	const navigated: Route[] = [];
	const t = await testRender(
		() => (
			<BreadcrumbRow
				ancestors={routes()}
				focusedIndex={focused()}
				width={120}
				onSelectIndex={(index) => selected.push(index)}
				onNavigate={(route) => navigated.push(route)}
			/>
		),
		{ width: 120, height: 3 },
	);
	const span = () =>
		t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("Applications"));
	try {
		await t.flush();
		const x = t.captureCharFrame().split("\n")[0].indexOf("Applications") + 2;
		await t.mockMouse.moveTo(x, 0);
		await t.flush();
		const surface = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!surface) throw new Error("Missing hovered breadcrumb");
		setFocused(2);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect((span()?.attributes ?? 0) & TextAttributes.BOLD).toBe(
			TextAttributes.BOLD,
		);
		expect(Array.from(span()?.bg.buffer ?? [])).toEqual(
			Array.from(parseColor(uiColors.bgHover).buffer),
		);
		setRoutes((current) =>
			current.map((route) => ({
				...route,
				...(route.params ? { params: { ...route.params } } : {}),
			})),
		);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(Array.from(span()?.bg.buffer ?? [])).toEqual(
			Array.from(parseColor(uiColors.bgHover).buffer),
		);
		await t.mockMouse.click(x, 0);
		await t.flush();
		expect(selected.at(-1)).toBe(2);
		expect(navigated.at(-1)).toBe(routes()[2]);
	} finally {
		t.renderer.destroy();
	}
});

test("collapsed breadcrumb hover survives label changes and shared routes survive resizing", async () => {
	const routes = ancestors();
	const [focused, setFocused] = createSignal(routes.length - 1);
	const [width, setWidth] = createSignal(30);
	const selected: number[] = [];
	const navigated: Route[] = [];
	const t = await testRender(
		() => (
			<BreadcrumbRow
				ancestors={routes}
				focusedIndex={focused()}
				width={width()}
				onSelectIndex={(index) => selected.push(index)}
				onNavigate={(route) => navigated.push(route)}
			/>
		),
		{ width: 120, height: 3 },
	);
	try {
		await t.flush();
		await t.mockMouse.moveTo(8, 0);
		await t.flush();
		const collapsed = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!collapsed) throw new Error("Missing collapsed breadcrumb");
		setFocused(2);
		await t.renderOnce();
		expect(collapsed.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Applications");
		const label = t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("Applications"));
		expect(Array.from(label?.bg.buffer ?? [])).toEqual(
			Array.from(parseColor(uiColors.bgHover).buffer),
		);
		await t.mockMouse.click(8, 0);
		await t.flush();
		expect(selected).toEqual([1]);
		expect(navigated).toHaveLength(0);
		await t.mockMouse.moveTo(2, 0);
		await t.flush();
		const home = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!home) throw new Error("Missing Home breadcrumb");
		setWidth(120);
		await t.renderOnce();
		expect(home.isDestroyed).toBe(false);
		expect(collapsed.isDestroyed).toBe(true);
		expect(t.captureCharFrame()).toContain("Environments");
		await t.mockMouse.click(2, 0);
		await t.flush();
		expect(selected.at(-1)).toBe(0);
		expect(navigated.at(-1)).toBe(routes[0]);
	} finally {
		t.renderer.destroy();
	}
});
