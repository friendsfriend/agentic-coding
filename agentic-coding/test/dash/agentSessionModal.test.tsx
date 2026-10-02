/** @jsxImportSource @opentui/solid */
// add-pi-durable-runtime, dashboard-agent-session-view: the live agent
// session modal renders its title/status, and the always-focused input
// drives submit/abort/close without any competing keymap layer (see the
// module comment in AgentSessionModal.tsx for why).
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentSessionModal } from "../../src/tui/dash/ui/AgentSessionModal.tsx";

function Harness(props: {
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = createSignal("");
	return (
		<AgentSessionModal
			role="worker"
			statusLines={["**Status:** working", "**Transcript entries:** 3"]}
			draft={draft()}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={props.onAbort}
			onClose={props.onClose}
		/>
	);
}

test("renders the agent title and live status lines", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onClose={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Agent");
	expect(frame).toContain("worker");
	expect(frame).toContain("Status:");
	expect(frame).toContain("working");
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

test("typing /close and pressing Enter closes the view without submitting or aborting", async () => {
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
	for (const character of "/close") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(closed).toBe(true);
	expect(aborted).toBe(false);
	expect(submitted).toBeUndefined();
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
