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
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Error: 400: MissingSessionID");
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

test("/model opens the picker and selecting applies the model override", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				history={[]}
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
				}}
				onPickerKeyReady={(value) => {
					handler = value as unknown as (event: { name: string }) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/model") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Select model");
	handler?.({ name: "j" });
	handler?.({ name: "enter" });
	expect(configured).toEqual({ model: "openai-codex/gpt-5.6-luna" });
	t.renderer.destroy();
});

/** The route's `agent-session-picker` layer, built from the modal's own key
 * list: while a picker is open the prompt input is unfocused, so the picker's
 * keys (including the terminal's Enter spelling) reach the modal through the
 * keymap rather than through the input. */
function PickerRoute(props: {
	onSubmit: (text: string) => void;
	onConfigure: (change: { model?: string; thinking?: string }) => void;
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
			blocks={[]}
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
			onPickerKeyReady={(value) => {
				handler = value;
			}}
		/>
	);
}

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
		expect(collapsed).toContain("▸ → src/a.ts");
		expect(collapsed).toContain("40-120 of 512");
		expect(collapsed).toContain("▸ ← src/a.ts");
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

		// Expanded: one line per call, then the script and its output, as parts
		// with their own headers.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("✱ glob *.ts (ok)");
		expect(expanded).toContain("→ read src/a.ts (error)");
		expect(expanded).toContain("▾ script (2 lines)");
		expect(expanded).toContain(
			'const hits = await tools.glob({ pattern: "*.ts" });',
		);
		expect(expanded).toContain("▾ output (3 lines)");
		expect(expanded).toContain("Script completed");

		// Folding a part keeps its header, so the call list stays in view.
		const scriptRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("script (2 lines)"));
		await t.mockMouse.click(10, scriptRow);
		await t.renderOnce();
		const folded = t.captureCharFrame();
		expect(folded).toContain("▸ script (2 lines)");
		expect(folded).not.toContain("tools.glob");
		expect(folded).toContain("Script completed");
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
