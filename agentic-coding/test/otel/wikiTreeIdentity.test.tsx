/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	parseColor,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { WikiView } from "../../src/tui/otel/views/WikiView.tsx";

const previous = process.env.HERDR_WIKI_DIR;
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "wiki-tree-identity-"));
	process.env.HERDR_WIKI_DIR = root;
});
afterEach(() => {
	if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
	else process.env.HERDR_WIKI_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});

function concept(id: string) {
	const file = join(root, `${id}.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		"---\ntype: concept\ntitle: Demo\ndescription: test concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
}
function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

function Fixture(props: { onOpen: (id: string) => void }) {
	const keymap = createDefaultOpenTuiKeymap(useRenderer());
	const dispose = keymap.registerLayerFields({
		name: () => undefined,
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	keymap.setData("app.view", "home");
	keymap.setData("modal.active", "none");
	onCleanup(dispose);
	return (
		<WikiView
			keymap={keymap}
			comments={[]}
			submitting={false}
			onSubmittingChange={() => {}}
			onAddComment={() => {}}
			onFinish={async () => ""}
			onClearComments={() => {}}
			onOpenNote={props.onOpen}
			onCloseNote={() => {}}
		/>
	);
}

test("wiki tree rows survive directory folds and synchronous refresh while clicks use current indices", async () => {
	concept("group/one");
	concept("group/two");
	concept("zeta");
	const opened: string[] = [];
	const t = await testRender(
		() => <Fixture onOpen={(id) => opened.push(id)} />,
		{ width: 120, height: 30 },
	);
	const location = () => {
		const lines = t.captureCharFrame().split("\n");
		const y = lines.findIndex((line) => line.includes("zeta.md"));
		return { x: (lines[y] ?? "").indexOf("zeta.md") + 2, y };
	};
	try {
		await t.flush();
		let point = location();
		await t.mockMouse.moveTo(point.x, point.y);
		await t.flush();
		const surface = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 1 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		const label = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText.includes("zeta.md"),
		);
		if (!(surface instanceof BoxRenderable) || !label)
			throw new Error("Missing wiki concept row");
		t.mockInput.pressEnter(); // The initial keyboard cursor is on group.
		await t.flush();
		expect(t.captureCharFrame()).toContain("▸ group");
		expect(t.captureCharFrame()).not.toContain("one.md");
		expect(surface.isDestroyed).toBe(false);
		expect(label.isDestroyed).toBe(false);
		point = location();
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(opened).toHaveLength(0);
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(opened).toEqual(["zeta"]);
		concept("zz-extra");
		t.mockInput.pressKey("r");
		await t.flush();
		expect(t.captureCharFrame()).toContain("zz-extra.md");
		expect(t.captureCharFrame()).toContain("▾ group");
		expect(surface.isDestroyed).toBe(false);
		expect(label.isDestroyed).toBe(false);
		point = location();
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(opened).toHaveLength(1);
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(opened).toEqual(["zeta", "zeta"]);
	} finally {
		t.renderer.destroy();
	}
});
