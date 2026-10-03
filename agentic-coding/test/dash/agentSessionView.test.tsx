/** @jsxImportSource @opentui/solid */
// add-pi-durable-runtime, dashboard-agent-session-view: the live agent
// session page renders the run title and transcript blocks (opencode v2
// styling), and the always-focused input drives submit/abort without any
// competing text keymap binding (see the module comment in
// AgentSessionView.tsx for why).
import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "../../src/tui/dash/ui/AgentSessionView.tsx";

const SAMPLE_BLOCKS: AgentSessionBlock[] = [
	{ kind: "user", text: "fix the parser", tone: "accent" },
	{ kind: "assistant", text: "Reading the parser", tone: "base" },
	{ kind: "tool", text: "read path=a.ts", tone: "muted", icon: "→" },
	{ kind: "result", text: "read: file contents", tone: "success" },
];

function Harness(props: {
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onBack: () => void;
	history?: readonly string[];
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
					{ kind: "error", text: "400: MissingSessionID", tone: "error" },
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

test("the newest output is separated by a dashed divider, until the next output", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{ kind: "user", text: "fix the parser", tone: "accent" },
		{ kind: "assistant", text: "Reading the parser now.", tone: "base" },
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
	const dividerRow = () => rows().findIndex((line) => line.includes("╎"));
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Opening a page adds no output, so nothing is separated.
		expect(dividerRow()).toBe(-1);

		// New output: the divider sits between it and the transcript before it.
		setBlocks((current) => [
			...current,
			{ kind: "result", text: "read: file contents", tone: "success" },
		]);
		await t.renderOnce();
		const first = dividerRow();
		expect(first).toBeGreaterThan(rowOf("Reading the parser"));
		expect(first).toBeLessThan(rowOf("read: file contents"));

		// A frame that adds nothing leaves the divider where it is.
		setBlocks((current) => current.map((block) => ({ ...block })));
		await t.renderOnce();
		expect(dividerRow()).toBe(first);

		// The next output moves the divider down: everything above it is old.
		setBlocks((current) => [
			...current,
			{ kind: "assistant", text: "Applied the fix.", tone: "base" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeGreaterThan(rowOf("read: file contents"));
		expect(dividerRow()).toBeLessThan(rowOf("Applied the fix"));
	} finally {
		t.renderer.destroy();
	}
});

test("a watch frame never blanks the transcript's markdown", async () => {
	const committed: AgentSessionBlock[] = [
		{ kind: "user", text: "fix the parser", tone: "accent" },
		{
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
				{ kind: "assistant", text: `streaming ${index}`, tone: "base" },
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
			{ kind: "assistant", text: "streaming 3", tone: "base" },
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("streaming 3");
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
