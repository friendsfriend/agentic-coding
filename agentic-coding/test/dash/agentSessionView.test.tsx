/** @jsxImportSource @opentui/solid */
// add-pi-durable-runtime, dashboard-agent-session-view: the live agent
// session page renders the run title and transcript blocks (opencode v2
// styling), and its input drives submit/abort without any competing text keymap
// binding while the view owns the keyboard (see the module comment in
// AgentSessionView.tsx for why).
import { expect, test } from "bun:test";
import { type KeyEvent, parseColor } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { uiColors } from "@ui";
import { createSignal, onCleanup } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "../../src/tui/dash/ui/AgentSessionView.tsx";
import { guardOrchestratorSubmit } from "../../src/tui/orchestrator/submission.ts";

const SAMPLE_BLOCKS: AgentSessionBlock[] = [
	{ id: "b1", kind: "user", text: "fix the parser", tone: "accent" },
	{ id: "b2", kind: "assistant", text: "Reading the parser", tone: "base" },
	{ id: "b3", kind: "tool", text: "read path=a.ts", tone: "muted", icon: "→" },
	{ id: "b4", kind: "result", text: "read: file contents", tone: "success" },
];

function Harness(props: {
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onBack: () => void;
	onCompact?: (instructions?: string) => void;
	history?: readonly string[];
	inputActive?: () => boolean;
}) {
	const [draft, setDraft] = createSignal("");
	const [history, setHistory] = createSignal<readonly string[]>(
		props.history ?? [],
	);
	return (
		<AgentSessionView
			role="worker"
			blocks={SAMPLE_BLOCKS}
			working={false}
			models={["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"]}
			thinkingLevels={["off", "low", "medium", "high"]}
			draft={draft()}
			history={history()}
			onHistoryAppend={(text) =>
				setHistory((items) =>
					items.at(-1) === text ? items : [...items, text],
				)
			}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={props.onAbort}
			onBack={props.onBack}
			onConfigure={() => {}}
			onCompact={props.onCompact ?? (() => {})}
			inputActive={props.inputActive}
		/>
	);
}

test("the page is body content: no title row, and the prompt ends it", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	// Two passes: the transcript's sticky scroll settles on the first one.
	await t.renderOnce();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("fix the parser");
	expect(frame).toContain("Reading the parser");
	expect(frame).toContain("read path=a.ts");
	// The run is named by the prompt's metadata row, not a title row: the host
	// owns the blank lines around its header and footer, so the page adds none
	// of its own above the transcript or below the prompt.
	// `captureCharFrame` ends with a newline: the rows are the trimmed split.
	const lines = frame.trimEnd().split("\n");
	expect(frame).not.toContain("Agent · worker");
	// The user prompt block owns the first row (its own blank line above the
	// text), and the prompt's metadata row is the last.
	expect(lines[0]).not.toContain("fix the parser");
	expect(lines[1]).toContain("fix the parser");
	expect(lines.at(-1)).toContain("Worker");
	t.renderer.destroy();
});

test("a long sent message expands and collapses on click", async () => {
	const prompt = Array.from(
		{ length: 12 },
		(_, index) => `prompt line ${index}`,
	).join("\n");
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{ id: "user:long", kind: "user", text: prompt, tone: "accent" },
				]}
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
			/>
		),
		{ width: 80, height: 24 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("prompt line 0");
		expect(collapsed).not.toContain("prompt line 8");
		const firstLine = collapsed
			.split("\n")
			.findIndex((line) => line.includes("prompt line 0"));
		const firstColumn =
			collapsed.split("\n")[firstLine]?.indexOf("prompt line 0") ?? 0;
		await t.mockMouse.click(firstColumn, firstLine);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("prompt line 11");
		await t.mockMouse.click(firstColumn, firstLine);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("prompt line 8");
	} finally {
		t.renderer.destroy();
	}
});

test("the reader can jump back to the newest transcript output", async () => {
	let scroll:
		| {
				scrollTop: number;
				scrollHeight: number;
				viewport: { height: number };
		  }
		| undefined;
	const blocks: AgentSessionBlock[] = Array.from(
		{ length: 40 },
		(_, index) => ({
			id: `row-${index}`,
			kind: "result",
			text: `transcript row ${index}`,
			tone: "success",
		}),
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
				onScrollBoxReady={(box) => {
					scroll = box as unknown as typeof scroll;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		if (scroll) scroll.scrollTop = 0;
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const lines = frame.split("\n");
		const actionLine = lines.findIndex((line) =>
			line.includes("Jump to latest"),
		);
		expect(actionLine).toBeGreaterThanOrEqual(0);
		const actionColumn = lines[actionLine]?.indexOf("Jump to latest") ?? 0;
		await t.mockMouse.click(actionColumn, actionLine);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("transcript row 39");
		expect(t.captureCharFrame()).not.toContain("Jump to latest");
		expect(scroll?.scrollTop).toBeGreaterThanOrEqual(
			Math.max(
				0,
				(scroll?.scrollHeight ?? 0) - (scroll?.viewport.height ?? 0) - 1,
			),
		);
	} finally {
		t.renderer.destroy();
	}
});

test("renders a provider error block", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b5",
						kind: "error",
						text: "400: MissingSessionID",
						tone: "error",
					},
				]}
				working={false}
				error="400: MissingSessionID"
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Error: 400: MissingSessionID");
	const errorSpan = t
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) => span.text.includes("Error: 400: MissingSessionID"));
	const actual = (
		errorSpan?.fg as { buffer?: Record<number, number> } | undefined
	)?.buffer;
	const expectedColor = parseColor(uiColors.error) as unknown as {
		r: number;
		g: number;
		b: number;
	};
	if (!actual) throw new Error("error row has no foreground color");
	expect(
		[actual[0] ?? -1, actual[1] ?? -1, actual[2] ?? -1].map(Math.round),
	).toEqual(
		[expectedColor.r, expectedColor.g, expectedColor.b].map((part) =>
			Math.round(part * 255),
		),
	);
	t.renderer.destroy();
});

test("status rows stay on the page background instead of tinted boxes", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "notice",
						kind: "notice",
						text: "Queued follow-up",
						tone: "warning",
					},
					{ id: "result", kind: "result", text: "done", tone: "success" },
					{ id: "error", kind: "error", text: "failed", tone: "error" },
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 24 },
	);
	try {
		await t.flush();
		const spans = t.captureSpans().lines.flatMap((line) => line.spans);
		const background = (text: string) => {
			const span = spans.find((item) => item.text.includes(text));
			const buffer = (
				span?.bg as { buffer?: Record<number, number> } | undefined
			)?.buffer;
			if (!buffer) return undefined;
			return [buffer[0] ?? -1, buffer[1] ?? -1, buffer[2] ?? -1].map(
				Math.round,
			);
		};
		const base = parseColor(uiColors.bgBase) as unknown as {
			r: number;
			g: number;
			b: number;
		};
		const expected = [base.r, base.g, base.b].map((part) =>
			Math.round(part * 255),
		);
		// The raised fill is reserved for prompts, user messages and tool calls;
		// notices, results and errors are drawn on the page background, with the
		// status color living in the marker and text.
		expect(background("Queued follow-up")).toEqual(expected);
		expect(background("done")).toEqual(expected);
		expect(background("failed")).toEqual(expected);
	} finally {
		t.renderer.destroy();
	}
});

test("renders a blocked Orchestrator message with a red model-selection error", async () => {
	let blocks: readonly AgentSessionBlock[] = [];
	guardOrchestratorSubmit(
		"please fix this",
		{},
		"local:orchestrator-model-gate:test",
		{
			onSubmit: () => {},
			onBlocked: (next) => {
				blocks = next;
			},
		},
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="orchestrator"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("please fix this");
	expect(frame).toContain("Error: No model and no thinking level are selected");
	expect(frame).toContain("/thinking, then send your message again.");
	const errorSpan = t
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) =>
			span.text.includes("Error: No model and no thinking level are selected"),
		);
	const actual = (
		errorSpan?.fg as { buffer?: Record<number, number> } | undefined
	)?.buffer;
	const expectedColor = parseColor(uiColors.error) as unknown as {
		r: number;
		g: number;
		b: number;
	};
	if (!actual) throw new Error("gate error row has no foreground color");
	expect(
		[actual[0] ?? -1, actual[1] ?? -1, actual[2] ?? -1].map(Math.round),
	).toEqual(
		[expectedColor.r, expectedColor.g, expectedColor.b].map((part) =>
			Math.round(part * 255),
		),
	);
	t.renderer.destroy();
});

test("typing a message and pressing Enter submits it, not /abort", async () => {
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "use approach B") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(submitted).toBe("use approach B");
	expect(aborted).toBe(false);
	t.renderer.destroy();
});

test("typing /abort and pressing Enter aborts instead of sending a message", async () => {
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/abort") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(aborted).toBe(true);
	expect(submitted).toBeUndefined();
	t.renderer.destroy();
});

test("typing /hide and pressing Enter hides the view without submitting or aborting", async () => {
	let closed = false;
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {
					closed = true;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/hide") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(closed).toBe(true);
	expect(aborted).toBe(false);
	expect(submitted).toBeUndefined();
	t.renderer.destroy();
});

test("thinking blocks collapse to 'Thinking…' and Ctrl+T expands them", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b6",
						kind: "reasoning",
						text: "the hidden chain of thought",
						tone: "muted",
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const collapsed = t.captureCharFrame();
	expect(collapsed).toContain("Thinking…");
	expect(collapsed).not.toContain("the hidden chain of thought");
	t.mockInput.pressKey("t", { ctrl: true });
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("the hidden chain of thought");
	t.renderer.destroy();
});

test("a live thinking block collapses, expands, and keeps streaming into it", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{
			id: "live:reasoning",
			kind: "reasoning",
			text: "weighing options",
			tone: "muted",
			live: true,
		},
	]);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={blocks()}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Collapsed by default, exactly like a committed one.
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("Thinking…");
		// A live thinking block carries the same animated marker as a running
		// tool; a committed thought does not.
		expect(collapsed).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Thinking…/);
		expect(collapsed).not.toContain("weighing options");
		t.mockInput.pressKey("t", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("weighing options");
		// The fold keeps its state as the partial grows: later watch frames carry
		// more text into the same open block.
		setBlocks(() => [
			{
				id: "live:reasoning",
				kind: "reasoning",
				text: "weighing options and the parser",
				tone: "muted",
				live: true,
			},
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("and the parser");
	} finally {
		t.renderer.destroy();
	}
});

test("a thinking block with a measured duration renders 'Thought: 1.6s'", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b7",
						kind: "reasoning",
						text: "weighing options",
						tone: "muted",
						durationMs: 1600,
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	expect(t.captureCharFrame()).toContain("Thought: 1.6s");
	t.renderer.destroy();
});

test("assistant text renders as markdown without a status box", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b8",
						kind: "assistant",
						text: "- first item\n- second item",
						tone: "base",
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = await t.waitForFrame((value) => value.includes("second item"));
	expect(frame).toContain("first item");
	expect(frame).toContain("second item");
	t.renderer.destroy();
});

test("renders the assistant footer and the context/cost meter", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b9",
						kind: "summary",
						text: "opencode-go/deepseek · 4.1K out",
						tone: "muted",
					},
				]}
				working={false}
				contextTokens={63900}
				contextWindow={1000000}
				cost={0.012}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Worker · opencode-go/deepseek · 4.1K out");
	expect(frame).toContain("63.9K (6%) · $0.01");
	t.renderer.destroy();
});

test("typing / opens the command autocomplete and Tab completes the command", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressKey("/");
	await t.renderOnce();
	const open = t.captureCharFrame();
	expect(open).toContain("/model");
	expect(open).toContain("/timeline");
	expect(open).toContain("/latest");
	expect(open).toContain("Change the model for this run");
	expect(open).toContain("Change the thinking level");
	// Tab completes the highlighted command into the draft.
	t.mockInput.pressArrow("down");
	t.mockInput.pressTab();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("/thinking");
	t.renderer.destroy();
});

test("the autocomplete's highlighted command runs on Enter", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressKey("/");
	await t.renderOnce();
	// Second entry is /thinking, which opens the thinking picker.
	t.mockInput.pressArrow("down");
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Select thinking level");
	t.renderer.destroy();
});

test("/model opens the picker and the prompt follows the selected model", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	// The host's watch carries the new model back as metadata; the prompt reads
	// it through a reactive prop, so the footer must not stay on the old one.
	const [model, setModel] = createSignal<string | undefined>(
		"opencode-go/deepseek-v4.1-flash",
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				history={[]}
				model={model()}
				onHistoryAppend={() => {}}
				models={[
					"opencode-go/deepseek-v4.1-flash",
					"openai-codex/gpt-5.6-luna",
				]}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => {
					configured = change;
					if (change.model) setModel(change.model);
				}}
				onCompact={() => {}}
				onPickerKeyReady={(value) => {
					handler = value as unknown as (event: { name: string }) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		expect(t.captureCharFrame()).toContain(
			"Worker · opencode-go/deepseek-v4.1-flash",
		);
		for (const character of "/model") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		handler?.({ name: "j" });
		handler?.({ name: "enter" });
		expect(configured).toEqual({ model: "openai-codex/gpt-5.6-luna" });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(
			"Worker · openai-codex/gpt-5.6-luna",
		);
		// opencode spells the command `/models`, and reopening the picker starts
		// on the model the prompt now shows: Enter accepts it instead of silently
		// selecting the first catalog entry again.
		configured = undefined;
		for (const character of "/models") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		handler?.({ name: "enter" });
		expect(configured as { model?: string } | undefined).toEqual({
			model: "openai-codex/gpt-5.6-luna",
		});
	} finally {
		t.renderer.destroy();
	}
});

test("the command autocomplete filters live as the command is typed", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressKey("/");
		await t.renderOnce();
		const open = t.captureCharFrame();
		expect(open).toContain("/model");
		expect(open).toContain("/thinking");
		expect(open).toContain("/compact");

		for (const character of "mo") t.mockInput.pressKey(character);
		await t.renderOnce();
		const filtered = t.captureCharFrame();
		expect(filtered).toContain("/model");
		expect(filtered).not.toContain("/thinking");
		expect(filtered).not.toContain("/compact");

		// A query with no command closes the list, and deleting the character
		// that stopped matching brings it back.
		t.mockInput.pressKey("x");
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("/model");
		t.mockInput.pressBackspace();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("/model");
	} finally {
		t.renderer.destroy();
	}
});

test("/compact is offered, forwards its instructions and never sends a prompt", async () => {
	const compacted: Array<string | undefined> = [];
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
				onCompact={(instructions) => compacted.push(instructions)}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		// `/com` autocompletes to the command, description included.
		for (const character of "/com") t.mockInput.pressKey(character);
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("/compact");
		expect(frame).toContain("Summarize the context");
		// The bare command runs the compaction and asks for no instructions.
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(compacted).toEqual([undefined]);
		expect(submitted).toEqual([]);

		// Free text after the command is the summarizer's guidance; the prompt is
		// cleared instead of being sent as a message.
		for (const character of "/compact focus on the open findings")
			t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(compacted).toEqual([undefined, "focus on the open findings"]);
		expect(submitted).toEqual([]);
	} finally {
		t.renderer.destroy();
	}
});

/** The route's `agent-session-picker` layer, built from the modal's own key
 * list: while a picker is open the prompt input is unfocused, so the picker's
 * keys (including the terminal's Enter spelling) reach the modal through the
 * keymap rather than through the input. */
function PickerRoute(props: {
	onSubmit: (text: string) => void;
	onConfigure: (change: { model?: string; thinking?: string }) => void;
	blocks?: readonly AgentSessionBlock[];
}) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const [draft, setDraft] = createSignal("");
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const dispose = keymap.registerLayer({
		priority: 1100,
		commands: [
			{
				name: "agent-session-picker.handle",
				run: ({ event }) => (handler ? handler(event) : false),
			},
		],
		bindings: SESSION_PICKER_KEYS.map((key) => ({
			key,
			cmd: "agent-session-picker.handle",
		})),
	});
	onCleanup(dispose);
	return (
		<AgentSessionView
			role="worker"
			blocks={props.blocks ?? []}
			working={false}
			models={["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"]}
			thinkingLevels={["off", "low"]}
			draft={draft()}
			history={[]}
			onHistoryAppend={() => {}}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={() => {}}
			onBack={() => {}}
			onConfigure={props.onConfigure}
			onCompact={() => {}}
			onPickerKeyReady={(value) => {
				handler = value;
			}}
		/>
	);
}

test("/timeline lists prompts and jumps to older messages outside the live window", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "user:early",
			kind: "user",
			text: "Earlier request: inspect the parser",
			tone: "accent",
			startedAt: 1_700_000_000_000,
		},
		...Array.from({ length: 80 }, (_, index) => ({
			id: `output:${index}`,
			kind: "result" as const,
			text: `output row ${index}`,
			tone: "success" as const,
		})),
		{
			id: "user:latest",
			kind: "user",
			text: "Latest follow-up",
			tone: "accent",
		},
		{
			id: "assistant:latest",
			kind: "assistant",
			text: "The parser is fixed",
			tone: "base",
		},
	];
	const t = await testRender(
		() => (
			<PickerRoute blocks={blocks} onSubmit={() => {}} onConfigure={() => {}} />
		),
		{ width: 100, height: 24 },
	);
	try {
		await t.flush();
		for (const character of "/timeline") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		const picker = t.captureCharFrame();
		expect(picker).toContain("Jump to message");
		expect(picker).toContain("Latest follow-up");
		expect(picker).toContain("Earlier request: inspect the parser");
		// Newest prompt is first; one `j` selects the older prompt.
		t.mockInput.pressKey("j");
		t.mockInput.pressEnter();
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(
			"Earlier request: inspect the parser",
		);
		expect(t.captureCharFrame()).not.toContain("Jump to message");
	} finally {
		t.renderer.destroy();
	}
});

test("the picker layer selects on the terminal's Enter spelling", async () => {
	const configured: Array<{ model?: string; thinking?: string }> = [];
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<PickerRoute
				onConfigure={(change) => configured.push(change)}
				onSubmit={(text) => submitted.push(text)}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const character of "/model") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(configured).toEqual([{ model: "openai-codex/gpt-5.6-luna" }]);
		expect(submitted).toEqual([]);
		// The prompt accepts ordinary keys again once the picker is closed.
		for (const character of "carry on") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toEqual(["carry on"]);
	} finally {
		t.renderer.destroy();
	}
});

test("model and thinking slash commands remain available while prompts are gated", async () => {
	const configured: Array<{ model?: string; thinking?: string }> = [];
	const blocked: AgentSessionBlock[][] = [];
	let pickerHandler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="orchestrator"
				blocks={[]}
				working={false}
				history={[]}
				onHistoryAppend={() => {}}
				models={["provider/model"]}
				thinkingLevels={["off", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={(text) =>
					guardOrchestratorSubmit(text, {}, "gate-test", {
						onSubmit: () => {},
						onBlocked: (blocks) => blocked.push([...blocks]),
					})
				}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => configured.push(change)}
				onCompact={() => {}}
				onPickerKeyReady={(handler) => {
					pickerHandler = handler as unknown as (event: {
						name: string;
					}) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const command of ["/model", "/thinking"]) {
			for (const character of command) t.mockInput.pressKey(character);
			t.mockInput.pressEnter();
			await t.renderOnce();
			expect(t.captureCharFrame()).toContain(
				command === "/model" ? "Select model" : "Select thinking level",
			);
			pickerHandler?.({ name: "enter" });
			await t.renderOnce();
		}
		expect(configured).toEqual([
			{ model: "provider/model" },
			{ thinking: "off" },
		]);
		expect(blocked).toEqual([]);
		for (const character of "plain prompt") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(blocked[0]?.[0]?.text).toBe("plain prompt");
	} finally {
		t.renderer.destroy();
	}
});

test("/thinking opens the picker and selecting applies the thinking override", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				history={[]}
				onHistoryAppend={() => {}}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => {
					configured = change;
				}}
				onCompact={() => {}}
				onPickerKeyReady={(value) => {
					handler = value as unknown as (event: { name: string }) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/thinking") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Select thinking level");
	handler?.({ name: "j" });
	handler?.({ name: "j" });
	handler?.({ name: "enter" });
	expect(configured).toEqual({ thinking: "medium" });
	t.renderer.destroy();
});

test("an empty submission does nothing", async () => {
	let calls = 0;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={() => {
					calls++;
				}}
				onAbort={() => {
					calls++;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(calls).toBe(0);
	t.renderer.destroy();
});

test("empty prompt recalls submitted input; arrows browse history without overwriting edits", async () => {
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const text of ["first input", "second input"]) {
			for (const character of text) t.mockInput.pressKey(character);
			t.mockInput.pressEnter();
			await t.renderOnce();
		}
		expect(submitted).toEqual(["first input", "second input"]);
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("second input");
		t.mockInput.pressArrow("up");
		t.mockInput.pressArrow("up"); // Clamp at oldest.
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("first input");
		t.mockInput.pressArrow("down");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("second input");
		t.mockInput.pressArrow("down");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Ask anything…");
		for (const character of "new draft") t.mockInput.pressKey(character);
		t.mockInput.pressArrow("up");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted.at(-1)).toBe("new draft");
		t.mockInput.pressArrow("up");
		t.mockInput.pressKey("!");
		t.mockInput.pressArrow("up");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted.at(-1)).toBe("new draft!");
	} finally {
		t.renderer.destroy();
	}
});

test("restored history recalls slash commands without interfering with typed autocomplete", async () => {
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				history={["saved message", "/abort"]}
				onSubmit={() => {}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("/abort");
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("saved message");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(aborted).toBe(true);
		t.mockInput.pressKey("/");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select thinking level");
	} finally {
		t.renderer.destroy();
	}
});

test("a frame that arrives while scrolled up leaves the viewport alone", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 20 }, (_, index) => ({
			id: "b10",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box: { scrollBy: (delta: number) => void; scrollTop: number } | undefined;
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
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// The keymap scrolls with `scrollBy`, which the box's sticky logic does
		// not read as "the reader left the bottom".
		box?.scrollBy(-12);
		await t.renderOnce();
		// The top row of the viewport, so the assertion is about position rather
		// than about how far one scroll happened to move.
		const topLine = (frame: string) =>
			Number(/line (\d+)/.exec(frame)?.[1] ?? -1);
		const scrolled = t.captureCharFrame();
		expect(topLine(scrolled)).toBeGreaterThan(0);
		expect(scrolled).not.toContain("line 19");

		// New output arrives: the viewport stays where the reader left it.
		setBlocks((current) => [
			...current,
			{ id: "b11", kind: "assistant", text: "a new answer", tone: "base" },
		]);
		await t.renderOnce();
		const after = t.captureCharFrame();
		expect(topLine(after)).toBe(topLine(scrolled));
		expect(after).not.toContain("a new answer");
	} finally {
		t.renderer.destroy();
	}
});

test("output arriving while scrolled up does not slide the transcript", async () => {
	// More rows than the window renders, so the window would slide (and drag the
	// viewport toward the bottom with it) if it were not anchored.
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 100 }, (_, index) => ({
			id: "b12",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box: { scrollBy: (delta: number) => void; scrollTop: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
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
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	/** The line at the top of the viewport. */
	const topLine = () => Number(/line (\d+)/.exec(t.captureCharFrame())?.[1]);
	try {
		await t.renderOnce();
		await t.renderOnce();
		box?.scrollBy(-20);
		await t.renderOnce();
		const scrolled = box?.scrollTop ?? 0;
		const top = topLine();
		expect(top).toBeGreaterThan(0);

		for (let index = 0; index < 4; index++) {
			setBlocks((current) => [
				...current,
				{
					id: "b13",
					kind: "assistant",
					text: `streaming ${index}`,
					tone: "base",
				},
			]);
			await t.renderOnce();
		}
		expect(box?.scrollTop).toBe(scrolled);
		expect(topLine()).toBe(top);
	} finally {
		t.renderer.destroy();
	}
});

test("reaching the top loads the older rows the window left out", async () => {
	const [blocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 80 }, (_, index) => ({
			id: "b14",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box:
		| {
				scrollTop: number;
				scrollHeight: number;
		  }
		| undefined;
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
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const opened = box?.scrollHeight ?? 0;
		expect(t.captureCharFrame()).not.toContain("line 0");

		// Reaching the top renders the older rows the window left out.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		await t.renderOnce();
		expect(box?.scrollHeight ?? 0).toBeGreaterThan(opened);

		// The loaded rows are above the viewport, so scrolling on reaches them.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("line 0");
	} finally {
		t.renderer.destroy();
	}
});

test("the divider opens the newest run of the model's output", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{ id: "u1", kind: "user", text: "first question", tone: "accent" },
		{ id: "a1", kind: "assistant", text: "first answer", tone: "base" },
		{ id: "s1", kind: "summary", text: "600 out", tone: "muted" },
	]);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
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
		{ width: 80, height: 20 },
	);
	const rows = () => t.captureCharFrame().trimEnd().split("\n");
	const rowOf = (text: string) =>
		rows().findIndex((line) => line.includes(text));
	const dividerRow = () =>
		rows().findIndex((line) => line.includes("new ↓") && line.includes("─"));
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Opening a page adds no output, so nothing is separated.
		expect(dividerRow()).toBe(-1);

		// The model answers the first question: the divider opens that answer,
		// below the user's message.
		setBlocks((current) => [
			...current,
			{ id: "u2", kind: "user", text: "second question", tone: "accent" },
			{ id: "a2", kind: "assistant", text: "second answer", tone: "base" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeGreaterThan(rowOf("second question"));
		expect(dividerRow()).toBeLessThan(rowOf("second answer"));

		// The turn's own steps join the same run: the divider stays put.
		setBlocks((current) => [
			...current,
			{ id: "s2", kind: "summary", text: "4 out", tone: "muted" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeLessThan(rowOf("4 out"));
		expect(dividerRow()).toBeGreaterThan(rowOf("second question"));

		// A new user message does not move it: the divider marks output, and
		// keeps the position it had until the model answers.
		setBlocks((current) => [
			...current,
			{ id: "u3", kind: "user", text: "third question", tone: "accent" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeLessThan(rowOf("third question"));

		// The next answer starts the next run.
		setBlocks((current) => [
			...current,
			{ id: "a3", kind: "assistant", text: "third answer", tone: "base" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeGreaterThan(rowOf("third question"));
		expect(dividerRow()).toBeLessThan(rowOf("third answer"));
	} finally {
		t.renderer.destroy();
	}
});

test("an expanded block stays expanded when the window loads older rows", async () => {
	const [blocks] = createSignal<readonly AgentSessionBlock[]>([
		...Array.from({ length: 70 }, (_, index) => ({
			id: `r${index}`,
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
			detail: [`detail ${index}`],
		})),
		{ id: "think", kind: "reasoning", text: "weighing options", tone: "muted" },
	]);
	let box: { scrollTop: number; scrollHeight: number } | undefined;
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
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Ctrl+T expands the thinking block.
		t.mockInput.pressKey("t", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("weighing options");

		// Loading older rows shifts every rendered row's position: the expansion
		// follows the block, not the position.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		await t.renderOnce();
		if (box) box.scrollTop = box.scrollHeight;
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("weighing options");
		expect(frame).not.toContain("detail 59");
	} finally {
		t.renderer.destroy();
	}
});

test("tool rows get a view from their call and result, and a generic default", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "r1",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts", offset: 40, limit: 80 },
				callId: "c1",
				result: {
					lines: ["const a = 1;"],
					isError: false,
					notes: ["Showing lines 40-120 of 512. Use offset=121 to continue."],
				},
			},
		},
		{
			id: "e1",
			kind: "tool",
			text: "edit path=src/a.ts",
			tone: "success",
			icon: "←",
			tool: "edit",
			toolCall: {
				name: "edit",
				args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
				callId: "c2",
				result: {
					lines: ["Successfully replaced 1 block(s) in src/a.ts."],
					isError: false,
					details: { diff: "-const a = 1;\n+const b = 2;" },
					notes: [],
				},
			},
		},
		{
			id: "j1",
			kind: "tool",
			text: "ask_jev",
			tone: "success",
			icon: "◆",
			tool: "ask_jev",
			toolCall: {
				name: "ask_jev",
				args: { questions: { leak: { type: "noul" } }, paths: ["src/a.ts"] },
				callId: "c3",
				result: {
					lines: [
						"## Jev",
						"state s1 · judged files (1), 12.3k tokens",
						"",
						"leak (noul): 0.12 confidence 0.93",
					],
					isError: false,
					details: { answers: { leak: { noul: 0.12, confidence: 0.93 } } },
					notes: [],
				},
			},
		},
		{
			id: "p1",
			kind: "tool",
			text: "agent_ask role=planner",
			tone: "success",
			icon: "•",
			tool: "agent_ask",
			toolCall: { name: "agent_ask", args: { role: "planner" } },
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
			/>
		),
		{ width: 80, height: 18 },
	);
	/** The painted foreground of the first cell holding `text`. */
	const foreground = (text: string) => {
		for (const line of t.captureSpans().lines) {
			for (const span of line.spans) {
				if (span.text.includes(text)) return span.fg;
			}
		}
		return undefined;
	};
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		// Each view names its own subject: the file, the range, the command.
		expect(collapsed).toContain("▸ → Read src/a.ts");
		expect(collapsed).toContain("40-120 of 512");
		expect(collapsed).toContain("▸ ← Edit src/a.ts");
		expect(collapsed).toContain("1 edit · +1 −1");
		// The judgment view names the verdict; a tool without a view keeps the
		// generic row.
		expect(collapsed).toContain("◆ leak → 0.12");
		expect(collapsed).toContain("agent_ask role=planner");

		// Ctrl+O expands every tool row: the diff and the text appear.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("-const a = 1;");
		expect(expanded).toContain("+const b = 2;");
		expect(expanded).toContain("const a = 1;");
		// Additions and removals carry their own tone.
		const rgb = (color: unknown) => {
			const buffer = (color as { buffer: Record<string, number> }).buffer;
			return [buffer[0], buffer[1], buffer[2]].map(Math.round).join(",");
		};
		const theme = (hex: string) => {
			const parsed = parseColor(hex) as unknown as {
				r: number;
				g: number;
				b: number;
			};
			// RGBA carries normalized components; the spans carry bytes.
			return [parsed.r, parsed.g, parsed.b]
				.map((part) => Math.round(part * 255))
				.join(",");
		};
		expect(rgb(foreground("+const b = 2;"))).toBe(theme(uiColors.success));
		expect(rgb(foreground("-const a = 1;"))).toBe(theme(uiColors.error));
	} finally {
		t.renderer.destroy();
	}
});

test("every tool row uses the raised block surface", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "r1",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts" },
				result: { lines: ["a"], isError: false, notes: [] },
			},
		},
		{
			id: "s1",
			kind: "tool",
			text: "search query=needle",
			tone: "success",
			icon: "•",
			tool: "search",
			toolCall: {
				name: "search",
				args: { query: "needle" },
				result: { lines: ["src/a.ts"], isError: false, notes: [] },
			},
			detail: ["src/a.ts"],
		},
		{
			id: "b1",
			kind: "tool",
			text: "bash command=bun test",
			tone: "success",
			icon: "$",
			tool: "bash",
			toolCall: {
				name: "bash",
				args: { command: "bun test" },
				result: { lines: ["ok"], isError: false, notes: [] },
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
			/>
		),
		{ width: 80, height: 14 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const row = (needle: string) =>
			frame.split("\n").find((line) => line.includes(needle)) ?? "";
		// A specialized view and the generic fallback share the same raised block:
		// the heavy left rule is the first cell of every tool row.
		expect(row("Read src/a.ts")).toContain("▸ → Read src/a.ts");
		expect(row("Read src/a.ts").trimStart().startsWith("┃")).toBe(true);
		expect(row("search query=needle")).toContain("▸ • search query=needle");
		expect(row("search query=needle").trimStart().startsWith("┃")).toBe(true);
		expect(row("bun test")).toContain("▸ $ bun test");
		expect(row("bun test").trimStart().startsWith("┃")).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});

test("consecutive successful reads group without adding or replacing tools", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "read-a",
			kind: "tool",
			text: "read: alpha contents",
			tone: "success",
			icon: "✓",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/alpha.ts" },
				callId: "call-a",
				result: { lines: ["alpha contents"], isError: false, notes: [] },
			},
			detail: ["alpha contents"],
		},
		{
			id: "read-b",
			kind: "tool",
			text: "read: beta contents",
			tone: "success",
			icon: "✓",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/beta.ts" },
				callId: "call-b",
				result: { lines: ["beta contents"], isError: false, notes: [] },
			},
			detail: ["beta contents"],
		},
		{
			id: "read-pending",
			kind: "tool",
			text: "read path=src/gamma.ts",
			tone: "warning",
			icon: "→",
			tool: "read",
			pending: true,
			live: true,
			toolCall: {
				name: "read",
				args: { path: "src/gamma.ts" },
				callId: "call-gamma",
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
			/>
		),
		{ width: 80, height: 18 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("2 reads");
		expect(collapsed).not.toContain("src/alpha.ts");
		expect(collapsed).toContain("src/gamma.ts");
		const groupLine = collapsed
			.split("\n")
			.findIndex((line) => line.includes("2 reads"));
		// A grouped read summary is still a tool row and keeps the raised block.
		expect(collapsed.split("\n")[groupLine]?.trimStart().startsWith("┃")).toBe(
			true,
		);
		await t.mockMouse.click(8, groupLine);
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("src/alpha.ts");
		expect(expanded).toContain("src/beta.ts");
	} finally {
		t.renderer.destroy();
	}
});

test("a running tool shows an in-progress row that its result replaces in place", async () => {
	const running: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash command=npm test",
			tone: "warning",
			icon: "$",
			tool: "bash",
			pending: true,
			live: true,
			toolCall: { name: "bash", args: { command: "npm test" }, callId: "c1" },
			detail: ["compiling…"],
		},
	];
	const finished: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash: all good",
			tone: "success",
			icon: "✓",
			tool: "bash",
			pending: false,
			toolCall: {
				name: "bash",
				args: { command: "npm test" },
				callId: "c1",
				result: { lines: ["all good"], isError: false, notes: [] },
			},
			detail: ["all good"],
		},
	];
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(running);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
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
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const pending = t.captureCharFrame();
		// The call's subject appears as soon as it starts, with opencode's
		// animated spinner in the icon gutter.
		expect(pending).toContain("npm test");
		expect(pending).not.toContain("running…");
		expect(pending).not.toContain("$ npm test");
		expect(pending).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm test/);
		// No result section yet: the answer is not on screen while the call runs.
		expect(pending).not.toContain("all good");
		expect(pending.match(/npm test/g)).toHaveLength(1);

		// The output produced so far is there when the row is expanded, like a
		// finished result's own rows.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("compiling…");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();

		// The result lands at the same position: one row, now the finished view.
		setBlocks(finished);
		await t.renderOnce();
		await t.renderOnce();
		const done = t.captureCharFrame();
		expect(done).not.toContain("running…");
		expect(done).toContain("▸ $ npm test");
		expect(done).toContain("1 lines");
		expect(done.match(/npm test/g)).toHaveLength(1);
	} finally {
		t.renderer.destroy();
	}
});

test("a streaming write stays one compact line instead of its content", async () => {
	const content = Array.from(
		{ length: 400 },
		(_, index) => `line ${index}`,
	).join("\n");
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{
						id: "w1",
						kind: "tool",
						text: "write path=src/a.ts",
						tone: "warning",
						icon: "←",
						tool: "write",
						pending: true,
						live: true,
						toolCall: {
							name: "write",
							args: { path: "src/a.ts", content },
							callId: "c1",
						},
					},
				]}
				working={true}
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
		{ width: 100, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// The icon gutter carries the spinner while the content streams; the
		// path names the file and the hint measures what has arrived.
		expect(frame).not.toContain("writing…");
		expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Writing src\/a\.ts/);
		expect(frame).toContain("400 lines");
		// The content itself is measured, never laid out: only its size is shown.
		expect(frame).not.toContain("line 399");
	} finally {
		t.renderer.destroy();
	}
});

test("a collapsed tool row wraps its whole summary instead of cutting it with an ellipsis", async () => {
	const command =
		"cd /Users/dev/project && bun run test --filter alpha-suite --reporter verbose && echo the-very-last-word";
	const path =
		"src/some/deeply/nested/directory/with/a/long/path/to/the/module-under-edit.ts";
	const blocks: AgentSessionBlock[] = [
		{
			id: "t3",
			kind: "tool",
			text: "custom_tool query=src/some/deeply/nested/directory/with/a/long/value/that/reachesTheLastWord",
			tone: "muted",
			icon: "•",
			tool: "custom_tool",
			toolCall: {
				name: "custom_tool",
				args: { query: "src/a.ts" },
				callId: "c3",
			},
		},
		{
			id: "t1",
			kind: "tool",
			text: "bash command",
			tone: "warning",
			icon: "$",
			tool: "bash",
			pending: true,
			live: true,
			toolCall: { name: "bash", args: { command }, callId: "c1" },
		},
		{
			id: "t2",
			kind: "tool",
			text: "read path",
			tone: "warning",
			icon: "→",
			tool: "read",
			pending: true,
			live: true,
			toolCall: { name: "read", args: { path }, callId: "c2" },
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={true}
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
		{ width: 50, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// Nothing is cut: the tail of the command and of the path reach the
		// screen, wrapped over further rows (a hyphen is a break point).
		expect(frame).toContain("very-last-word");
		expect(frame).toContain("reporter verbose");
		expect(frame).toContain("module-under-edit.");
		// The raised block's left rule is repeated on every wrapped row.
		expect(frame).toMatch(/module-under-edit\. *\n┃ +ts/);
		// A tool without a specialized view wraps its own summary too.
		expect(frame).toContain("reachesTheLastWord");
		// The spinner in the icon gutter is the running marker; the row's own
		// text adds no ellipsis.
		expect(frame).not.toContain("running…");
		expect(frame).not.toContain("reading…");
	} finally {
		t.renderer.destroy();
	}
});

test("a generic tool view wraps its request and output instead of truncating them", async () => {
	const block: AgentSessionBlock = {
		id: "g1",
		kind: "tool",
		text: "custom_tool query=src/some/deeply/nested/value/that/reachesTheLastWord",
		tone: "muted",
		icon: "•",
		tool: "custom_tool",
		toolCall: {
			name: "custom_tool",
			args: { query: "src/a.ts" },
			callId: "c1",
		},
		request: "custom_tool query=aRequestThatReachesItsOwnLastWord",
		detail: ["anOutputLineThatReachesItsOwnLastWord"],
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
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
			/>
		),
		{ width: 50, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("reachesTheLastWord");
		expect(collapsed).not.toContain("...");
		expect(collapsed).not.toContain("ItsOwnLastWord");

		// Ctrl+O opens the fold: the request line and the output rows are read
		// whole too, not cut in the middle.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("aRequestThatReachesItsOwnLastWord");
		expect(expanded).toContain("anOutputLineThatReachesItsOwnLastWord");
		expect(expanded).not.toContain("...");
	} finally {
		t.renderer.destroy();
	}
});

test("an expanded specialized tool wraps its output rows instead of truncating them", async () => {
	const line = `${"prefix ".repeat(12)}theLastOutputWord`;
	const block: AgentSessionBlock = {
		id: "r1",
		kind: "tool",
		text: "read path=src/a.ts",
		tone: "success",
		icon: "→",
		tool: "read",
		toolCall: {
			name: "read",
			args: { path: "src/a.ts" },
			callId: "c1",
			result: { lines: [line], isError: false, notes: [] },
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
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
			/>
		),
		{ width: 50, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("theLastOutputWord");
		expect(frame).not.toContain("...");
	} finally {
		t.renderer.destroy();
	}
});

test("rows show their start time, and a tool call its duration, at the right edge", async () => {
	const at = (h: number, m: number, sec: number) =>
		new Date(2026, 9, 19, h, m, sec).getTime();
	const blocks: AgentSessionBlock[] = [
		{
			id: "u1",
			kind: "user",
			text: "run the tests",
			tone: "accent",
			startedAt: at(14, 3, 20),
		},
		{
			id: "r1",
			kind: "reasoning",
			text: "plan the run",
			tone: "muted",
			durationMs: 1600,
			startedAt: at(14, 3, 21),
		},
		{
			id: "t1",
			kind: "tool",
			text: "bash: ok",
			tone: "success",
			icon: "✓",
			tool: "bash",
			startedAt: at(14, 3, 23),
			durationMs: 42_000,
			toolCall: {
				name: "bash",
				args: { command: "bun test" },
				callId: "c1",
				result: { lines: ["ok"], isError: false, notes: [] },
			},
		},
		{
			id: "t2",
			kind: "tool",
			text: "read: a",
			tone: "success",
			icon: "✓",
			tool: "read",
			startedAt: at(14, 4, 5),
			durationMs: 340,
			toolCall: {
				name: "read",
				args: { path: "a.ts" },
				callId: "c2",
				result: { lines: ["a"], isError: false, notes: [] },
			},
		},
		{
			id: "s1",
			kind: "summary",
			text: "opencode-go/deepseek · 2.0s",
			tone: "muted",
			startedAt: at(14, 4, 6),
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
			/>
		),
		{ width: 80, height: 26 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const line = (needle: string) =>
			frame.split("\n").find((row) => row.includes(needle)) ?? "";
		expect(line("14:03:20").trimEnd().endsWith("14:03:20")).toBe(true);
		expect(line("Thought: 1.6s").trimEnd().endsWith("14:03:21")).toBe(true);
		// A tool row: its duration, then its start time, at the right edge.
		expect(line("bun test").trimEnd()).toMatch(/42\.0s +14:03:23$/);
		expect(line("a.ts").trimEnd()).toMatch(/340ms +14:04:05$/);
		expect(line("Worker").trimEnd().endsWith("14:04:06")).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});

test("a tool call aborted before it ran is marked aborted", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{
						id: "t1",
						kind: "tool",
						text: "read path=src/a.ts",
						tone: "warning",
						icon: "→",
						tool: "read",
						aborted: true,
						toolCall: {
							name: "read",
							args: { path: "src/a.ts" },
							callId: "c1",
						},
					},
				]}
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
			/>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("→ Read src/a.ts");
		expect(frame).toContain("aborted");
	} finally {
		t.renderer.destroy();
	}
});

test("a codemode row lists its calls, and its script and output fold away", async () => {
	const block: AgentSessionBlock = {
		id: "c1",
		kind: "tool",
		text: "codemode",
		tone: "success",
		icon: "λ",
		tool: "codemode",
		toolCall: {
			name: "codemode",
			args: {
				code: 'const hits = await tools.glob({ pattern: "*.ts" });\nreturn hits.length;',
			},
			callId: "k1",
			result: {
				lines: [
					"Script completed",
					'return: ["a.ts","b.ts"]',
					"calls: glob (ok), read (error)",
				],
				isError: false,
				details: {
					calls: [
						{ name: "glob", status: "ok", args: { pattern: "*.ts" } },
						{ name: "read", status: "error", args: { path: "src/a.ts" } },
					],
				},
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
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
			/>
		),
		{ width: 70, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Collapsed: only the call's own metadata line. The calls a script made
		// belong to the expanded body, so a run's transcript stays a list of
		// one-line summaries.
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("▸ λ 2 calls · 1 failed");
		expect(collapsed).not.toContain("glob *.ts");
		expect(collapsed).not.toContain("tools.glob");

		// Expanded: one line per call, with the script and its output kept as
		// compact parts that open on demand.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("✱ glob *.ts (ok)");
		expect(expanded).toContain("→ read src/a.ts (error)");
		expect(expanded).toContain("▸ script (2 lines)");
		expect(expanded).toContain("▸ output (3 lines)");
		expect(expanded).not.toContain("tools.glob");
		expect(expanded).not.toContain("Script completed");

		// Opening a part shows its rows and keeps its header, so the call list
		// stays in view beside it.
		const scriptRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("script (2 lines)"));
		await t.mockMouse.click(10, scriptRow);
		await t.renderOnce();
		const opened = t.captureCharFrame();
		expect(opened).toContain("▾ script (2 lines)");
		expect(opened).toContain(
			'const hits = await tools.glob({ pattern: "*.ts" });',
		);
		expect(opened).toContain("▸ output (3 lines)");
	} finally {
		t.renderer.destroy();
	}
});

test("a script's call rows fold into their own tool view", async () => {
	const block: AgentSessionBlock = {
		id: "c2",
		kind: "tool",
		text: "codemode",
		tone: "success",
		icon: "λ",
		tool: "codemode",
		toolCall: {
			name: "codemode",
			args: { code: "return 1;" },
			callId: "k2",
			result: {
				lines: ["Script completed"],
				isError: false,
				details: {
					calls: [
						{
							name: "edit",
							status: "ok",
							args: {
								path: "src/b.ts",
								edits: [{ oldText: "a", newText: "b" }],
							},
							// The nested edit's diff, captured from the tool's own
							// `result.details`.
							details: { diff: "@@ -1 +1 @@\n-a\n+b" },
						},
						{
							name: "read",
							status: "ok",
							args: { path: "src/c.ts" },
							output: "line one\nline two",
							isError: false,
						},
					],
				},
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
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
			/>
		),
		{ width: 80, height: 24 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		// Each call is its own fold, so one edit can be read without the rest.
		expect(expanded).toContain("edit src/b.ts");
		expect(expanded).not.toContain("+b");
		const editRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("edit src/b.ts"));
		await t.mockMouse.click(5, editRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("+b");

		// The read call folds into the text it read.
		const readRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("read src/c.ts"));
		await t.mockMouse.click(5, readRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("line one");
	} finally {
		t.renderer.destroy();
	}
});

test("a developer question shows its context, options, and chosen answer", async () => {
	const options = [
		{
			title: "SQLite in-process",
			value: "sqlite",
			recommended: true,
			description: "No service to run.",
		},
		{ title: "Postgres via compose", value: "postgres" },
	];
	const block: AgentSessionBlock = {
		id: "d1",
		kind: "tool",
		text: "developer_question",
		tone: "success",
		icon: "?",
		tool: "developer_question",
		toolCall: {
			name: "developer_question",
			args: {
				description: "Which backend should the wiki use?",
				context: "The migration script must pick one.",
				options,
			},
			callId: "d1",
			result: {
				lines: [
					JSON.stringify({
						id: "q1",
						role: "planner",
						status: "answered",
						description: "Which backend should the wiki use?",
						context: "The migration script must pick one.",
						options,
						answer: { kind: "option", value: "sqlite" },
					}),
				],
				isError: false,
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
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
			/>
		),
		{ width: 100, height: 24 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Collapsed: the question and what came back are the row's own line.
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("? Which backend should the wiki use?");
		expect(collapsed).toContain("answered · developer");
		expect(collapsed).not.toContain("SQLite in-process");

		// Expanded: the context and the question are folds of their own.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("▸ context");
		expect(expanded).toContain("→ SQLite in-process");
		expect(expanded).not.toContain("No service to run.");

		// The context folds open into the markdown it is.
		const contextRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("▸ context"));
		await t.mockMouse.click(10, contextRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(
			"The migration script must pick one.",
		);

		// The question folds into every option it offered, the chosen one marked.
		const questionRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("→ SQLite in-process"));
		await t.mockMouse.click(10, questionRow);
		await t.renderOnce();
		const opened = t.captureCharFrame();
		expect(opened).toContain("● ★ SQLite in-process");
		expect(opened).toContain("○   Postgres via compose");

		// An option folds into the description the agent attached to it.
		const optionRow = opened
			.split("\n")
			.findIndex((line) => line.includes("● ★ SQLite in-process"));
		await t.mockMouse.click(10, optionRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("No service to run.");
	} finally {
		t.renderer.destroy();
	}
});

test("expanding a block keeps the reader's place", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash npm test",
			tone: "muted",
			icon: "$",
			tool: "bash",
			detail: Array.from({ length: 20 }, (_, index) => `output ${index}`),
		},
		...Array.from({ length: 30 }, (_, index) => ({
			id: `r${index}`,
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	];
	let box: { scrollTop: number; scrollHeight: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
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
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	/** The result line at the top of the viewport. */
	const topLine = () => Number(/line (\d+)/.exec(t.captureCharFrame())?.[1]);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Scroll into the transcript: the tool block is now above the viewport.
		if (box) box.scrollTop = 12;
		await t.renderOnce();
		const before = topLine();
		const height = box?.scrollHeight ?? 0;
		expect(before).toBeGreaterThan(0);

		// Ctrl+O expands the tool block above: its rows land above the reader,
		// and the viewport follows the line it was resting on.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		await t.renderOnce();
		expect(box?.scrollHeight ?? 0).toBeGreaterThan(height);
		expect(topLine()).toBe(before);
	} finally {
		t.renderer.destroy();
	}
});

test("a streaming message holds its fenced code instead of re-drawing it", async () => {
	const text = "Here is the fix:\n\n```ts\nconst a = 1;\n```\n";
	const frameOf = async (block: AgentSessionBlock) => {
		const t = await testRender(
			() => (
				<AgentSessionView
					role="worker"
					blocks={[block]}
					working={true}
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
			{ width: 60, height: 14 },
		);
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		t.renderer.destroy();
		return frame;
	};

	// A committed message draws its fence immediately (the raw text first, the
	// highlight concealing the markers a moment later).
	const committed = await frameOf({
		id: "e1:0",
		kind: "assistant",
		text,
		tone: "base",
	});
	expect(committed).toContain("Here is the fix:");
	expect(committed).toContain("const a = 1;");

	// A live one keeps the text it already laid out rather than re-laying the
	// chunk: re-drawing shows the fence markers again, which changes the block's
	// height by a line on every frame — the jump the reader sees as unreadable
	// output. The prose still draws through its streaming preview.
	const live = await frameOf({
		id: "live:generation",
		kind: "assistant",
		text,
		tone: "base",
		live: true,
	});
	expect(live).toContain("Here is the fix:");
	expect(live).not.toContain("const a = 1;");
});

test("a watch frame never blanks the transcript's markdown", async () => {
	const committed: AgentSessionBlock[] = [
		{ id: "b19", kind: "user", text: "fix the parser", tone: "accent" },
		{
			id: "b20",
			kind: "assistant",
			text: "Reading the parser now.\n\n```ts\nconst a = 1;\n```\n",
			tone: "base",
		},
	];
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(committed);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
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
		{ width: 100, height: 30 },
	);
	try {
		await t.waitForFrame((frame) => frame.includes("Reading the parser"));
		// Every frame rebuilds the block objects and grows the in-flight one.
		for (let index = 0; index < 4; index++) {
			setBlocks(() => [
				...committed.map((block) => ({ ...block })),
				{
					id: "b21",
					kind: "assistant",
					text: `streaming ${index}`,
					tone: "base",
				},
			]);
			await t.renderOnce();
			const frame = t.captureCharFrame();
			expect(frame).toContain("Reading the parser");
			// The code fence draws in the same frame, before its syntax pass.
			expect(frame).toContain("const a = 1;");
			expect(frame).toContain(`streaming ${index}`);
		}
		// The in-flight block commits: the message keeps drawing as it settles.
		setBlocks(() => [
			...committed,
			{ id: "b22", kind: "assistant", text: "streaming 3", tone: "base" },
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("streaming 3");
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt reads keys only while the view owns the keyboard", async () => {
	const [active, setActive] = createSignal(false);
	let submitted: string | undefined;
	const t = await testRender(
		() => (
			<Harness
				inputActive={active}
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		// A keymap-only surface (the workspace sidebar, a modal) owns the
		// keyboard: the unfocused prompt must not swallow what is typed at it.
		for (const character of "sidebar") t.mockInput.pressKey(character);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("sidebar");
		// Handing the keyboard back focuses the prompt again, so the same input
		// accepts text and submits.
		setActive(true);
		await t.renderOnce();
		for (const character of "hello") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toBe("hello");
	} finally {
		t.renderer.destroy();
	}
});

test("`?` on an empty prompt opens the shared help, and a typed `?` stays literal", async () => {
	let help = 0;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				thinkingLevels={["off", "low"]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onHelp={() => {
					help++;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressKey("?");
		await t.renderOnce();
		expect(help).toBe(1);
		// A message may start with `?`: once anything is typed the key is text.
		t.mockInput.pressKey("w");
		t.mockInput.pressKey("?");
		await t.renderOnce();
		expect(help).toBe(1);
		expect(t.captureCharFrame()).toContain("w?");
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt's metadata row shows context, cost, tokens and tok/s", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				thinkingLevels={["off"]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				contextTokens={12_500}
				contextWindow={100_000}
				cost={0.42}
				inputTokens={2500}
				outputTokens={800}
				tokensPerSecond={40}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		const frame = t.captureCharFrame();
		expect(frame).toContain("12.5K (13%)");
		expect(frame).toContain("$0.42");
		expect(frame).toContain("tok 2.5K→800");
		expect(frame).toContain("40 tok/s");
	} finally {
		t.renderer.destroy();
	}
});

test("Shift+Enter starts a new prompt line and Enter sends the whole message", async () => {
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		// A terminal in the kitty keyboard protocol (the renderer's own mode):
		// only then is Shift+Enter distinguishable from Enter.
		{ width: 100, height: 30, kittyKeyboard: true },
	);
	try {
		await t.flush();
		for (const character of "first line") t.mockInput.pressKey(character);
		t.mockInput.pressEnter({ shift: true });
		for (const character of "second line") t.mockInput.pressKey(character);
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// Both lines are on screen at once, not one line with a lost separator.
		expect(frame).toContain("first line");
		expect(frame).toContain("second line");
		expect(submitted).toEqual([]);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toEqual(["first line\nsecond line"]);
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt grows with the message and scrolls once it is eight lines tall", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30, kittyKeyboard: true },
	);
	try {
		await t.flush();
		for (const line of ["alpha", "beta", "gamma"]) {
			for (const character of line) t.mockInput.pressKey(character);
			t.mockInput.pressEnter({ shift: true });
		}
		await t.renderOnce();
		const grown = t.captureCharFrame();
		// The transcript above the prompt keeps its rows: the prompt grew into
		// the space it needs instead of covering the conversation.
		expect(grown).toContain("fix the parser");
		expect(grown).toContain("alpha");
		expect(grown).toContain("beta");
		expect(grown).toContain("gamma");
		// Past the cap the editor scrolls instead of eating the transcript.
		const numbered = Array.from(
			{ length: 12 },
			(_, index) => `line${String(index).padStart(2, "0")}`,
		);
		for (const line of numbered) {
			for (const character of line) t.mockInput.pressKey(character);
			t.mockInput.pressEnter({ shift: true });
		}
		await t.renderOnce();
		const capped = t.captureCharFrame();
		expect(capped).toContain("fix the parser");
		expect(capped).toContain(numbered.at(-1) ?? "");
		const visible = numbered.filter((line) => capped.includes(line));
		expect(visible.length).toBeGreaterThan(0);
		expect(visible.length).toBeLessThanOrEqual(8);
	} finally {
		t.renderer.destroy();
	}
});
