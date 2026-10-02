/** @jsxImportSource @opentui/solid */
// add-pi-durable-runtime, dashboard-agent-session-view: the live agent
// session modal renders its title and transcript blocks (opencode v2 styling),
// and the always-focused input drives submit/abort/close without any
// competing text keymap binding (see the module comment in
// AgentSessionModal.tsx for why).
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { AgentSessionModal } from "../../src/tui/dash/ui/AgentSessionModal.tsx";

const SAMPLE_BLOCKS: AgentSessionBlock[] = [
	{ kind: "user", text: "fix the parser", tone: "accent" },
	{ kind: "assistant", text: "Reading the parser", tone: "base" },
	{ kind: "tool", text: "read path=a.ts", tone: "muted", icon: "→" },
	{ kind: "result", text: "read: file contents", tone: "success" },
];

function Harness(props: {
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = createSignal("");
	return (
		<AgentSessionModal
			role="worker"
			blocks={SAMPLE_BLOCKS}
			working={false}
			models={["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"]}
			thinkingLevels={["off", "low", "medium", "high"]}
			draft={draft()}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={props.onAbort}
			onClose={props.onClose}
			onConfigure={() => {}}
		/>
	);
}

test("renders the agent title and the transcript blocks", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onClose={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Agent");
	expect(frame).toContain("worker");
	expect(frame).toContain("fix the parser");
	expect(frame).toContain("Reading the parser");
	expect(frame).toContain("read path=a.ts");
	t.renderer.destroy();
});

test("renders a provider error block", async () => {
	const t = await testRender(
		() => (
			<AgentSessionModal
				role="worker"
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
				onClose={() => {}}
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
				onClose={() => {}}
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
				onClose={() => {}}
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
				onClose={() => {
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
			<AgentSessionModal
				role="worker"
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
				onClose={() => {}}
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
			<AgentSessionModal
				role="worker"
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
				onClose={() => {}}
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
			<AgentSessionModal
				role="worker"
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
				onClose={() => {}}
				onConfigure={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("first item");
	expect(frame).toContain("second item");
	t.renderer.destroy();
});

test("renders the assistant footer and the context/cost meter", async () => {
	const t = await testRender(
		() => (
			<AgentSessionModal
				role="worker"
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
				onClose={() => {}}
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
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onClose={() => {}} />,
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
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onClose={() => {}} />,
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
			<AgentSessionModal
				role="worker"
				blocks={[]}
				working={false}
				models={[
					"opencode-go/deepseek-v4.1-flash",
					"openai-codex/gpt-5.6-luna",
				]}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onClose={() => {}}
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

test("/thinking opens the picker and selecting applies the thinking override", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionModal
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onClose={() => {}}
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
				onClose={() => {}}
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
