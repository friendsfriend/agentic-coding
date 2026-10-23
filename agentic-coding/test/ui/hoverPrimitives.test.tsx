/** @jsxImportSource @opentui/solid */
// Shared hover feedback: list rows, work-item cards and footer chips all use
// the same pointer surface step, so the primitive a surface is built from does
// not change how it answers the pointer.
import { expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	HelpText,
	ModalTabs,
	Panel,
	ScrollableList,
	SelectableList,
	uiColors,
	WorkItemCard,
} from "@ui";

function rgb(hex: string): string {
	const parsed = parseColor(hex) as unknown as {
		r: number;
		g: number;
		b: number;
	};
	return [parsed.r, parsed.g, parsed.b]
		.map((part) => Math.round(part * 255))
		.join(",");
}

function backgroundOf(
	t: Awaited<ReturnType<typeof testRender>>,
	text: string,
): string | undefined {
	for (const line of t.captureSpans().lines) {
		for (const span of line.spans) {
			if (!span.text.includes(text)) continue;
			return span.bg.buffer
				.slice(0, 3)
				.map((part) => Math.round(part))
				.join(",");
		}
	}
	return undefined;
}

function rowOf(
	t: Awaited<ReturnType<typeof testRender>>,
	text: string,
): number {
	return t
		.captureCharFrame()
		.split("\n")
		.findIndex((line) => line.includes(text));
}

test("SelectableList lifts every row under the pointer, including the selected row", async () => {
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<SelectableList
					items={["alpha row", "beta row"]}
					selectedIndex={0}
					availableLines={4}
					itemHeight={1}
					onSelect={() => {}}
					renderItem={(item) => <text>{item}</text>}
				/>
			</box>
		),
		{ width: 50, height: 8 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const selected = rgb(uiColors.bgSurface0);
		const resting = rgb(uiColors.bgMantle);
		const lifted = rgb(uiColors.bgHover);
		expect(backgroundOf(t, "alpha row")).toBe(selected);
		expect(backgroundOf(t, "beta row")).toBe(resting);

		const betaRow = rowOf(t, "beta row");
		expect(betaRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, betaRow);
		await t.renderOnce();
		expect(backgroundOf(t, "beta row")).toBe(lifted);
		expect(backgroundOf(t, "alpha row")).toBe(selected);

		const alphaRow = rowOf(t, "alpha row");
		expect(alphaRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, alphaRow);
		await t.renderOnce();
		// The selected row keeps its marker but gains the pointer surface.
		expect(backgroundOf(t, "alpha row")).toBe(lifted);

		await t.mockMouse.moveTo(45, 7);
		await t.renderOnce();
		expect(backgroundOf(t, "alpha row")).toBe(selected);
		expect(backgroundOf(t, "beta row")).toBe(resting);
	} finally {
		t.renderer.destroy();
	}
});

test("WorkItemCard lifts both unselected and selected cards on hover", async () => {
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<WorkItemCard
					marker="A"
					title="api"
					statusText="running"
					metadata="docker"
					selected={false}
					index={0}
					onMouseUp={() => {}}
				/>
				<WorkItemCard
					marker="B"
					title="web"
					statusText="idle"
					metadata="docker"
					selected={true}
					index={1}
					onMouseUp={() => {}}
				/>
			</box>
		),
		{ width: 60, height: 8 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const resting = rgb(uiColors.bgMantle);
		const lifted = rgb(uiColors.bgHover);
		const selected = rgb(uiColors.bgSurface0);
		expect(backgroundOf(t, "api")).toBe(resting);
		expect(backgroundOf(t, "web")).toBe(selected);

		const apiRow = rowOf(t, "api");
		expect(apiRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, apiRow);
		await t.renderOnce();
		expect(backgroundOf(t, "api")).toBe(lifted);
		expect(backgroundOf(t, "web")).toBe(selected);

		const webRow = rowOf(t, "web");
		expect(webRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, webRow);
		await t.renderOnce();
		expect(backgroundOf(t, "api")).toBe(resting);
		expect(backgroundOf(t, "web")).toBe(lifted);

		await t.mockMouse.moveTo(50, 7);
		await t.renderOnce();
		expect(backgroundOf(t, "web")).toBe(selected);
	} finally {
		t.renderer.destroy();
	}
});

test("a raw ScrollableList row takes the hover surface including the selected row", async () => {
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<ScrollableList
					items={["first row", "second row"]}
					selectedIndex={0}
					availableLines={4}
					estimatedItemHeight={1}
					onSelect={() => {}}
					renderItem={(item) => <text>{item}</text>}
				/>
			</box>
		),
		{ width: 50, height: 8 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const resting = backgroundOf(t, "second row");
		const lifted = rgb(uiColors.bgHover);

		const secondRow = rowOf(t, "second row");
		expect(secondRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, secondRow);
		await t.renderOnce();
		expect(backgroundOf(t, "second row")).toBe(lifted);

		const firstRow = rowOf(t, "first row");
		expect(firstRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, firstRow);
		await t.renderOnce();
		expect(backgroundOf(t, "first row")).toBe(lifted);
		expect(backgroundOf(t, "second row")).toBe(resting);

		await t.mockMouse.moveTo(45, 7);
		await t.renderOnce();
		expect(backgroundOf(t, "first row")).not.toBe(lifted);
		expect(backgroundOf(t, "second row")).toBe(resting);
	} finally {
		t.renderer.destroy();
	}
});

test("dialog tabs take the hover surface, including the active tab", async () => {
	const t = await testRender(
		() => (
			<box width="100%" height="100%" flexDirection="column">
				<ModalTabs
					tabs={[
						{ id: "overview", label: "Overview" },
						{ id: "details", label: "Details" },
					]}
					activeId="overview"
					onChange={() => {}}
				/>
			</box>
		),
		{ width: 60, height: 6 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const resting = backgroundOf(t, "Details");
		const lifted = rgb(uiColors.bgHover);
		const activeResting = backgroundOf(t, "Overview");
		const column = (t.captureCharFrame().split("\n")[0] ?? "").indexOf(
			"Details",
		);
		expect(column).toBeGreaterThanOrEqual(0);

		await t.mockMouse.moveTo(column + 1, 0);
		await t.renderOnce();
		expect(backgroundOf(t, "Details")).toBe(lifted);
		expect(backgroundOf(t, "Overview")).toBe(activeResting);

		const activeColumn = (t.captureCharFrame().split("\n")[0] ?? "").indexOf(
			"Overview",
		);
		expect(activeColumn).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(activeColumn + 1, 0);
		await t.renderOnce();
		expect(backgroundOf(t, "Overview")).toBe(lifted);
		expect(backgroundOf(t, "Details")).toBe(resting);

		await t.mockMouse.moveTo(50, 5);
		await t.renderOnce();
		expect(backgroundOf(t, "Details")).toBe(resting);
		expect(backgroundOf(t, "Overview")).toBe(activeResting);
	} finally {
		t.renderer.destroy();
	}
});

test("panels lift on hover, including the active panel", async () => {
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<Panel
					title="Idle panel"
					onFocusRequest={() => {}}
					style={{ height: 4, flexShrink: 0 }}
				>
					<text>idle body</text>
				</Panel>
				<Panel
					title="Active panel"
					active
					onFocusRequest={() => {}}
					style={{ height: 4, flexShrink: 0 }}
				>
					<text>active body</text>
				</Panel>
			</box>
		),
		{ width: 50, height: 10 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const resting = rgb(uiColors.bgMantle);
		const lifted = rgb(uiColors.bgHover);
		expect(backgroundOf(t, "Idle panel")).toBe(resting);
		expect(backgroundOf(t, "Active panel")).toBe(resting);

		const idleRow = rowOf(t, "Idle panel");
		expect(idleRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, idleRow);
		await t.renderOnce();
		expect(backgroundOf(t, "Idle panel")).toBe(lifted);
		expect(backgroundOf(t, "Active panel")).toBe(resting);

		const activeRow = rowOf(t, "Active panel");
		expect(activeRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(5, activeRow);
		await t.renderOnce();
		expect(backgroundOf(t, "Idle panel")).toBe(resting);
		expect(backgroundOf(t, "Active panel")).toBe(lifted);

		await t.mockMouse.moveTo(45, 9);
		await t.renderOnce();
		expect(backgroundOf(t, "Idle panel")).toBe(resting);
		expect(backgroundOf(t, "Active panel")).toBe(resting);
	} finally {
		t.renderer.destroy();
	}
});

test("HelpText chips take the shared hover surface", async () => {
	const t = await testRender(
		() => (
			<box width="100%" height="100%" flexDirection="column">
				<HelpText
					entries={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Open" },
					]}
					onActivate={() => {}}
				/>
			</box>
		),
		{ width: 60, height: 6 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const resting = backgroundOf(t, "j/k");
		const lifted = rgb(uiColors.bgHover);

		await t.mockMouse.moveTo(2, 0);
		await t.renderOnce();
		expect(backgroundOf(t, "j/k")).toBe(lifted);

		await t.mockMouse.moveTo(50, 5);
		await t.renderOnce();
		expect(backgroundOf(t, "j/k")).toBe(resting);
	} finally {
		t.renderer.destroy();
	}
});
