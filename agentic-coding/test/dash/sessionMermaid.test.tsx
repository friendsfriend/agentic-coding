/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { MarkdownViewer } from "@agentic-coding/ui";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";

const diagram = "```mermaid\nflowchart LR\nStart --> Done\n```";

async function session(text: string, live = false) {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{ id: "diagram", kind: "assistant", tone: "base", text, live },
	]);
	const setup = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={live}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 90, height: 40 },
	);
	return { ...setup, setBlocks };
}

async function settle(t: { renderOnce: () => Promise<void> }) {
	for (let i = 0; i < 10; i++) {
		await Bun.sleep(10);
		await t.renderOnce();
	}
}

test("pi-durable renders Mermaid between prose and ordinary code", async () => {
	const t = await session(
		`Before.\n\n${diagram}\n\nAfter.\n\n\`\`\`ts\nconst kept = 1;\n\`\`\``,
	);
	try {
		await settle(t);
		const frame = t.captureCharFrame();
		expect(frame).toContain("Before.");
		expect(frame).toContain("Start");
		expect(frame).toContain("Done");
		expect(frame).toContain("After.");
		expect(frame).not.toContain("flowchart LR");
		expect(frame).toContain("▶");
	} finally {
		t.renderer.destroy();
	}
});

test("live diagram survives incomplete growth and completion", async () => {
	const t = await session("```mermaid\nflowchart LR\nStart --> Done\n\n", true);
	try {
		await settle(t);
		expect(t.captureCharFrame()).toContain("▶");
		t.setBlocks([
			{
				id: "diagram",
				kind: "assistant",
				tone: "base",
				live: true,
				text: "```mermaid\nflowchart LR\nStart --> Done\nDone --> Next[\n\n",
			},
		]);
		await settle(t);
		expect(t.captureCharFrame()).toContain("Done");
		expect(t.captureCharFrame()).not.toContain("flowchart LR");
		t.setBlocks([
			{ id: "diagram", kind: "assistant", tone: "base", text: diagram },
		]);
		await settle(t);
		expect(t.captureCharFrame()).toContain("▶");
	} finally {
		t.renderer.destroy();
	}
});

for (const source of [
	'pie\n title Unsupported\n "A": 1',
	"flowchart LR\nunsupported structural statement\nA --> B",
	`flowchart LR\n${"%".repeat(33_000)}`,
]) {
	test(`unsupported or oversized Mermaid remains source (${source.length})`, async () => {
		const t = await session(`\`\`\`mermaid\n${source}\n\`\`\``);
		try {
			await settle(t);
			expect(t.captureCharFrame()).not.toContain("▶");
			expect(t.captureCharFrame()).toContain(
				source.length > 32_768 ? "%%%%" : source.split("\n")[0],
			);
		} finally {
			t.renderer.destroy();
		}
	});
}

test("shared MarkdownViewer does not opt ordinary surfaces into diagrams", async () => {
	const t = await testRender(
		() => <MarkdownViewer content={diagram} streaming />,
		{ width: 90, height: 15 },
	);
	try {
		await settle(t);
		expect(t.captureCharFrame()).toContain("flowchart LR");
		expect(t.captureCharFrame()).not.toContain("▶");
	} finally {
		t.renderer.destroy();
	}
});
