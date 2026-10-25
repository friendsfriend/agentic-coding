/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	type BoxRenderable,
	CodeRenderable,
	DiffRenderable,
	type Renderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";
import {
	ToolSurfaceHoverContext,
	TranscriptFile,
} from "../../src/tui/dash/ui/TranscriptFile.tsx";
import { createTranscriptViewport } from "../../src/tui/dash/ui/transcript-viewport.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}
function Session(props: {
	blocks: readonly AgentSessionBlock[];
	ready?: (box: ScrollBoxRenderable) => void;
}) {
	return (
		<AgentSessionView
			role="worker"
			blocks={props.blocks}
			working={false}
			draft=""
			history={[]}
			models={[]}
			thinkingLevels={[]}
			onHistoryAppend={() => {}}
			onDraftChange={() => {}}
			onSubmit={() => {}}
			onAbort={() => {}}
			onBack={() => {}}
			onConfigure={() => {}}
			onCompact={() => {}}
			onScrollBoxReady={props.ready}
		/>
	);
}
function read(index: number, count = 3): AgentSessionBlock {
	const lines = Array.from(
		{ length: count },
		(_, row) => `export const file${index}_value${row} = ${row};`,
	);
	return {
		id: `read:${index}`,
		kind: "tool",
		text: "read",
		tool: "read",
		tone: "success",
		detail: lines,
		toolCall: {
			name: "read",
			args: { path: `file${index}.ts` },
			result: { lines, notes: [], isError: false },
		},
	};
}
async function settle(t: Awaited<ReturnType<typeof testRender>>) {
	for (let index = 0; index < 6; index++) await t.renderOnce();
}

test("appending completed reads retains existing native code views", async () => {
	const initial = [read(0), read(1)];
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(initial);
	const t = await testRender(() => <Session blocks={blocks()} />, {
		width: 140,
		height: 45,
	});
	try {
		await settle(t);
		const codes = tree(t.renderer.root).filter(
			(node) => node instanceof CodeRenderable,
		);
		expect(codes).toHaveLength(2);
		setBlocks([...initial, read(2)]);
		await settle(t);
		const after = tree(t.renderer.root);
		for (const code of codes) expect(after.includes(code)).toBe(true);
		expect(t.captureCharFrame()).toContain("3 reads");
	} finally {
		t.renderer.destroy();
	}
});

test("codemode keeps its script and completed children when one running child prints", async () => {
	const [output, setOutput] = createSignal("first output");
	const blocks = () => [
		{
			id: "cm",
			kind: "tool" as const,
			text: "codemode",
			tone: "warning" as const,
			pending: true,
			toolCall: {
				name: "codemode",
				args: { code: "await tools.bash({ command: 'build' });" },
				progress: {
					calls: [
						{
							name: "read",
							status: "ok",
							args: { path: "a.ts" },
							output: "const answer = 42;",
						},
						{
							name: "bash",
							status: "running",
							args: { command: "build" },
							output: output(),
						},
					],
				},
			},
		},
	];
	const t = await testRender(() => <Session blocks={blocks()} />, {
		width: 140,
		height: 45,
	});
	try {
		await settle(t);
		const codes = tree(t.renderer.root).filter(
			(node) => node instanceof CodeRenderable,
		);
		expect(codes).toHaveLength(2);
		setOutput("second output");
		await settle(t);
		const after = tree(t.renderer.root);
		for (const code of codes) expect(after.includes(code)).toBe(true);
		expect(t.captureCharFrame()).toContain("second output");
	} finally {
		t.renderer.destroy();
	}
});

test("long read groups mount only nearby code while preserving the entire scroll range", async () => {
	let box: ScrollBoxRenderable | undefined;
	const blocks = Array.from({ length: 120 }, (_, index) => read(index, 100));
	const t = await testRender(
		() => (
			<Session
				blocks={blocks}
				ready={(value) => {
					box = value;
				}}
			/>
		),
		{ width: 140, height: 45 },
	);
	try {
		await settle(t);
		if (!box) throw new Error("Missing transcript");
		expect(box.scrollHeight).toBeGreaterThan(12_000);
		expect(
			tree(t.renderer.root).filter((node) => node instanceof CodeRenderable)
				.length,
		).toBeLessThanOrEqual(4);
		expect(t.captureCharFrame()).toContain("file119_value99");
		box.scrollTop = 0;
		await settle(t);
		expect(t.captureCharFrame()).toContain("120 reads");
		expect(t.captureCharFrame()).toContain("file0_value0");
		const code = tree(t.renderer.root).find(
			(node) => node instanceof CodeRenderable,
		);
		if (!(code instanceof CodeRenderable))
			throw new Error("Missing visible code");
		await t.mockMouse.scroll(20, 20, "down");
		await settle(t);
		expect(box.scrollTop).toBeGreaterThan(0);
		expect(code.scrollY).toBe(0);
		box.scrollTo(box.scrollHeight);
		await settle(t);
		expect(t.captureCharFrame()).toContain("file119_value99");
	} finally {
		t.renderer.destroy();
	}
});

test("large tables keep a bounded render tree and every retained row remains reachable", async () => {
	let box: ScrollBoxRenderable | undefined;
	const blocks: AgentSessionBlock[] = Array.from({ length: 10 }, (_, table) => {
		const value = {
			columns: Array.from({ length: 6 }, (_, column) => `column${column}`),
			rows: Array.from({ length: 200 }, (_, row) =>
				Array.from({ length: 6 }, (_, column) => `T${table}R${row}C${column}`),
			),
		};
		return {
			id: `table:${table}`,
			kind: "tool",
			text: "query",
			tone: "success",
			toolCall: {
				name: "db_query",
				args: { infra: "postgres", sql: "select * from records" },
				result: {
					lines: [],
					notes: [],
					isError: false,
					details: { view: value },
				},
			},
		};
	});
	const t = await testRender(
		() => (
			<Session
				blocks={blocks}
				ready={(value) => {
					box = value;
				}}
			/>
		),
		{ width: 140, height: 45 },
	);
	try {
		await settle(t);
		if (!box) throw new Error("Missing transcript");
		expect(tree(t.renderer.root).length).toBeLessThan(3000);
		expect(t.captureCharFrame()).toContain("T9R199C5");
		box.scrollTop = 0;
		await settle(t);
		expect(t.captureCharFrame()).toContain("T0R0C0");
		t.resize(60, 45);
		await settle(t);
		box.scrollTo(box.scrollHeight);
		await settle(t);
		expect(t.captureCharFrame()).toContain("T9R199C5");
		expect(tree(t.renderer.root).length).toBeLessThan(3000);
	} finally {
		t.renderer.destroy();
	}
});

test("refining offscreen heights anchors content without overriding explicit scrolling", () => {
	const viewport = createTranscriptViewport();
	const node = { screenY: 10, height: 20, isDestroyed: false };
	const box = {
		scrollTop: 100,
		scrollHeight: 1000,
		viewport: { screenY: 0, height: 40, width: 80 },
	};
	viewport.box = box as unknown as ScrollBoxRenderable;
	viewport.observe(
		() => {},
		() => node as unknown as BoxRenderable,
	);
	viewport.sample();
	node.screenY = 18;
	viewport.sample();
	expect(box.scrollTop).toBe(108);
	node.screenY = 10;
	viewport.sample();
	expect(box.scrollTop).toBe(108);
	box.scrollTop = 120;
	node.screenY = -2;
	viewport.sample();
	expect(box.scrollTop).toBe(120);
});

for (const width of [100, 160])
	test(`hover colors cause only one native diff rebuild at width ${width}`, async () => {
		const [hovered, setHovered] = createSignal(false);
		const t = await testRender(
			() => (
				<ToolSurfaceHoverContext.Provider value={hovered}>
					<TranscriptFile
						file={{
							kind: "diff",
							path: "plain.txt",
							content: "@@ -1 +1 @@\n-before\n+after\n",
						}}
					/>
				</ToolSurfaceHoverContext.Provider>
			),
			{ width, height: 12 },
		);
		try {
			await settle(t);
			const diff = tree(t.renderer.root).find(
				(node) => node instanceof DiffRenderable,
			);
			if (!diff) throw new Error("Missing diff");
			// Instrument the pinned native wrapper to guard the checked-in coalescing patch.
			const native = diff as unknown as { buildView: () => void };
			const original = native.buildView.bind(diff);
			let builds = 0;
			native.buildView = () => {
				builds++;
				original();
			};
			setHovered(true);
			await settle(t);
			expect(builds).toBe(1);
		} finally {
			t.renderer.destroy();
		}
	});
