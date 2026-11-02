/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { SidebarPin } from "../../src/tui/otel/app/sidebar-model.ts";
import { WorkspaceSidebar } from "../../src/tui/otel/components/WorkspaceSidebar.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

for (const active of [false, true]) {
	test(`${active ? "expanded" : "collapsed"} workspace pins retain hover across poll snapshots and open current sessions after reorder`, async () => {
		const [pins, setPins] = createSignal<SidebarPin[]>([
			{
				glyph: "D",
				label: "Daily",
				meta: "idle",
				page: "pi-durable",
				sessionId: "daily",
			},
			{
				glyph: "W",
				label: "Weekly",
				meta: "idle",
				page: "pi-durable",
				sessionId: "weekly",
			},
		]);
		const [selected, setSelected] = createSignal(-1);
		const opened: SidebarPin[] = [];
		const t = await testRender(
			() => (
				<WorkspaceSidebar
					active={active}
					mode="expanding"
					side="left"
					overviews={[]}
					pins={pins()}
					filter="all"
					selectedIndex={selected()}
					loading={false}
					onToggleMode={() => {}}
					onSelectIndex={setSelected}
					onOpenPin={(pin) => opened.push(pin)}
					onOpen={() => {}}
					onFilterChange={() => {}}
					onFocus={() => {}}
				/>
			),
			{ width: 80, height: 24 },
		);
		const yOf = (glyph: string) =>
			t
				.captureCharFrame()
				.split("\n")
				.findIndex((line) =>
					active ? line.includes("Daily") : line.trim() === glyph,
				);
		try {
			await t.flush();
			await t.mockMouse.moveTo(active ? 5 : 2, yOf("D"));
			await t.flush();
			const surface = tree(t.renderer.root).find(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === (active ? 2 : 1) &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			);
			if (!(surface instanceof BoxRenderable))
				throw new Error("Missing hovered pin");
			setPins((current) =>
				current.map((pin) => ({
					...pin,
					...(pin.sessionId === "daily"
						? { glyph: "E", label: "Daily updated", meta: "running now" }
						: {}),
				})),
			);
			await t.renderOnce();
			expect(surface.isDestroyed).toBe(false);
			expect(surface.backgroundColor).toEqual(parseColor(uiColors.bgHover));
			expect(t.captureCharFrame()).toContain("E");
			if (active) {
				expect(t.captureCharFrame()).toContain("Daily updated");
				expect(t.captureCharFrame()).toContain("running now");
			}
			setPins((current) => [...current].reverse());
			await t.flush();
			expect(surface.isDestroyed).toBe(false);
			await t.mockMouse.click(active ? 5 : 2, yOf("E"));
			await t.flush();
			expect(selected()).toBe(1);
			expect(opened).toHaveLength(1);
			expect(opened[0]).toBe(pins()[1]);
			expect(opened[0]?.sessionId).toBe("daily");
			expect(opened[0]?.meta).toBe("running now");
			setPins((current) =>
				current.map((pin) =>
					pin.sessionId === "daily"
						? { ...pin, sessionId: "replacement-session" }
						: pin,
				),
			);
			await t.renderOnce();
			expect(surface.isDestroyed).toBe(true);
		} finally {
			t.renderer.destroy();
		}
	});
}
