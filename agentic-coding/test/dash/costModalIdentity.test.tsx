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
import {
	type CostBreakdownRow,
	CostModal,
} from "../../src/tui/dash/ui/CostModal.tsx";

const row = (role: string, cost: number): CostBreakdownRow => ({
	role,
	cost,
	inputTokens: 10,
	outputTokens: 2,
	totalTokens: 12,
	messages: [
		{
			at: "12:00:00",
			cost: 0.25,
			inputTokens: 10,
			outputTokens: 2,
			totalTokens: 12,
		},
	],
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("cost rows keep hover and native values across refresh and use current indices after reorder", async () => {
	const [rows, setRows] = createSignal([row("worker", 1), row("reviewer", 2)]);
	const chosen: number[] = [];
	const t = await testRender(
		() => (
			<CostModal
				rows={rows()}
				selected={-1}
				agent={null}
				offset={0}
				onSelectIndex={(index) => chosen.push(index)}
			/>
		),
		{ width: 160, height: 30 },
	);
	const rowY = () =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("worker"));
	try {
		await t.flush();
		await t.mockMouse.moveTo(40, rowY());
		await t.flush();
		const surface = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.height === 1 &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		const cost = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "$1.00",
		);
		if (
			!(surface instanceof BoxRenderable) ||
			!(cost instanceof TextRenderable)
		)
			throw new Error("Missing cost row");
		setRows((current) =>
			current.map((item) => ({
				...item,
				...(item.role === "worker" ? { cost: 3, inputTokens: 30 } : {}),
			})),
		);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(cost.isDestroyed).toBe(false);
		expect(surface.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(cost.plainText).toBe("$3.00");
		expect(t.captureCharFrame()).toContain("30/2");
		expect(
			tree(t.renderer.root).some(
				(node) =>
					node instanceof TextRenderable && node.plainText === "Total $5.00",
			),
		).toBe(true);
		setRows((current) => [...current].reverse());
		await t.flush();
		expect(surface.isDestroyed).toBe(false);
		await t.mockMouse.click(40, rowY());
		await t.flush();
		expect(chosen).toEqual([1]);
	} finally {
		t.renderer.destroy();
	}
});

test("message details stay attached to their agent when cost rows reorder and duplicate timestamps remain separate", async () => {
	const worker = row("worker", 1);
	worker.messages.push({
		...worker.messages[0],
		at: "12:00:00",
		cost: 0.5,
		inputTokens: 20,
		outputTokens: 4,
		totalTokens: 24,
	});
	const reviewer = row("reviewer", 2);
	reviewer.messages = [
		{
			...reviewer.messages[0],
			at: "review-only",
			cost: 2,
			inputTokens: 5,
			outputTokens: 1,
			totalTokens: 6,
		},
	];
	const [rows, setRows] = createSignal([worker, reviewer]);
	const t = await testRender(
		() => <CostModal rows={rows()} selected={0} agent="worker" offset={0} />,
		{ width: 160, height: 30 },
	);
	try {
		await t.flush();
		const cost = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "$0.2500",
		);
		if (!(cost instanceof TextRenderable))
			throw new Error("Missing message cost");
		setRows((current) =>
			[...current].reverse().map((item) => ({
				...item,
				messages: item.messages.map((message, index) => ({
					...message,
					...(item.role === "worker" && index === 0
						? { cost: 0.75, inputTokens: 30 }
						: {}),
				})),
			})),
		);
		await t.renderOnce();
		expect(cost.isDestroyed).toBe(false);
		expect(cost.plainText).toBe("$0.7500");
		expect(t.captureCharFrame()).toContain("in 30 · out 2");
		expect(t.captureCharFrame()).not.toContain("review-only");
		expect(
			tree(t.renderer.root).filter(
				(node) =>
					node instanceof TextRenderable && node.plainText === "12:00:00",
			),
		).toHaveLength(2);
	} finally {
		t.renderer.destroy();
	}
});
