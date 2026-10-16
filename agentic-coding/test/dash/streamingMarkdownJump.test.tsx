/** @jsxImportSource @opentui/solid */
// fix-markdown-live-jump: an assistant message that is still streaming must not
// lose a transcript row from one frame to the next.
//
// A live message re-renders on every host frame from the text that has arrived,
// and its markdown is drawn from that text verbatim. An unfinished trailing
// line — a document-ending newline, a bare list marker (`- `), a partly typed
// closing code fence — draws as a row of its own for as long as it is unfinished
// and disappears on the frame the next character lands, so the bottom-anchored
// transcript gained a line and immediately took it back: the live output
// flickered one line up and down.
//
// These tests stream one character per frame and read the transcript's laid-out
// height, the viewport row of a settled line and the committed render of the
// same message. A frame that takes a row back fails the height, a frame that
// moves the settled line down fails the position.
import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";

/** A message that exercises every construct the renderer lays out: a wrapped
 * paragraph, a list, a fenced block and a closing paragraph. */
const STREAM_DOC =
	"Here is a paragraph that is long enough to wrap around the transcript width.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\nAnd a closing line.\n";

/** Every shape that lost a row while streaming. */
const DOCS: Record<string, string> = {
	paragraphAndList: STREAM_DOC,
	nestedLists:
		"Intro line.\n\n1. first\n   - nested a\n   - nested b\n2. second\n\n> quoted\n\n# Heading\n\nDone.\n",
	blankLines: "para one\n\n\n\npara two\n",
	table:
		"Results:\n\n| name | value |\n|------|-------|\n| alpha | 1 |\n| beta | 2 |\n\nDone.\n",
	codeFence: "Test:\n\n```\nabc\n```\n\nAfter.\n",
	headingAndRule: "One\n\n---\n\n## Two\n\nThree\n",
};

const VIEWPORT = { width: 70, height: 20 } as const;

/** Rows above the live message, so the transcript outgrows the viewport and
 * follows its newest output the way a busy session does. */
const LEADING_ROWS: readonly AgentSessionBlock[] = Array.from(
	{ length: 12 },
	(_, index) => ({
		id: `r${index}`,
		kind: "result" as const,
		text: `settled line ${index}`,
		tone: "success" as const,
	}),
);

interface StreamFrame {
	/** The transcript's laid-out height. */
	readonly height: number;
	/** The viewport's rows, trailing blank rows trimmed. */
	readonly rows: readonly string[];
}

/** The transcript's laid-out height: the scroll box's content column. */
function transcriptHeight(box: ScrollBoxRenderable | undefined): number {
	return box?.content.getChildren()[0]?.height ?? -1;
}

async function renderSession(blocks: () => readonly AgentSessionBlock[]) {
	let box: ScrollBoxRenderable | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={false}
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
				onScrollBoxReady={(value) => {
					box = value;
				}}
			/>
		),
		VIEWPORT,
	);
	// The transcript's sticky scroll settles on the first pass.
	await t.renderOnce();
	return { setup: t, box: () => box };
}

/** Render one live assistant message whose text grows a character per frame,
 * reporting the transcript's height and rows after every frame. */
async function streamFrames(doc: string): Promise<StreamFrame[]> {
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(LEADING_ROWS);
	const t = await renderSession(blocks);
	const frames: StreamFrame[] = [];
	try {
		for (let length = 1; length <= doc.length; length++) {
			setBlocks([
				...LEADING_ROWS,
				{
					id: "live:generation",
					kind: "assistant",
					text: doc.slice(0, length),
					tone: "base",
					live: true,
				},
			]);
			await t.setup.renderOnce();
			await t.setup.renderOnce();
			frames.push({
				height: transcriptHeight(t.box()),
				rows: t.setup.captureCharFrame().replace(/\n+$/, "").split("\n"),
			});
		}
	} finally {
		t.setup.renderer.destroy();
	}
	return frames;
}

/** The committed message of the same text: the render the live frames settle
 * into once the run stops streaming. */
async function committedFrame(doc: string): Promise<StreamFrame> {
	const t = await renderSession(() => [
		...LEADING_ROWS,
		{ id: "live:generation", kind: "assistant", text: doc, tone: "base" },
	]);
	try {
		await t.setup.renderOnce();
		return {
			height: transcriptHeight(t.box()),
			rows: t.setup.captureCharFrame().replace(/\n+$/, "").split("\n"),
		};
	} finally {
		t.setup.renderer.destroy();
	}
}

/** The frames that lost a row, with the text that was streaming in then. */
function lostRows(doc: string, frames: readonly StreamFrame[]): string[] {
	const lost: string[] = [];
	for (let index = 1; index < frames.length; index++) {
		const before = frames[index - 1];
		const after = frames[index];
		if (!before || !after) continue;
		if (after.height < before.height)
			lost.push(
				`${JSON.stringify(doc.slice(Math.max(0, index - 6), index + 1))}: ${before.height} -> ${after.height}`,
			);
	}
	return lost;
}

/** The viewport row of the first row carrying `needle`. */
function rowOf(frame: StreamFrame, needle: string): number | undefined {
	const index = frame.rows.findIndex((row) => row.includes(needle));
	return index < 0 ? undefined : index;
}

test("a live assistant message never loses a transcript row while it streams", async () => {
	const failures: string[] = [];
	for (const [name, doc] of Object.entries(DOCS)) {
		const lost = lostRows(doc, await streamFrames(doc));
		if (lost.length > 0) failures.push(`${name}: ${lost.join("; ")}`);
	}
	expect(failures).toEqual([]);
});

test("the lines a live message already settled never move back down", async () => {
	// The transcript follows its newest output, so a line it already settled
	// travels up the viewport as the message grows — and never down again. A
	// frame that took a row back would move it down for that frame.
	const frames = await streamFrames(STREAM_DOC);
	const positions = frames
		.map((frame) => rowOf(frame, "Here is a paragraph"))
		.filter((row): row is number => row !== undefined);
	// The line has to be watched for most of the message, not from one frame.
	expect(positions.length).toBeGreaterThan(STREAM_DOC.length / 2);
	const movedDown: string[] = [];
	for (let index = 1; index < positions.length; index++) {
		const before = positions[index - 1];
		const after = positions[index];
		if (before === undefined || after === undefined) continue;
		if (after > before)
			movedDown.push(`frame ${index + 1}: ${before} -> ${after}`);
	}
	expect(movedDown).toEqual([]);
});

test("the last streaming frame is the committed render", async () => {
	for (const [name, doc] of Object.entries(DOCS)) {
		const frames = await streamFrames(doc);
		const committed = await committedFrame(doc);
		expect([name, frames.at(-1)?.height]).toEqual([name, committed.height]);
	}
});

test("the committed render still draws the whole message", async () => {
	// The held-back trailing line is layout, not content: everything the model
	// wrote is on screen once the message is no longer live.
	const committed = await committedFrame(STREAM_DOC);
	const text = committed.rows.join("\n");
	for (const line of [
		"Here is a paragraph",
		"- one",
		"- two",
		"const x = 1;",
		"And a closing line.",
	])
		expect(text).toContain(line);
});
