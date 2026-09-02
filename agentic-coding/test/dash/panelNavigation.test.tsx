/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";

type Test = Awaited<ReturnType<typeof testRender>>;

function TestDashboard() {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	// Mirror the production detail keymap (src/tui/index.tsx → setupKeymap):
	// shift+letter events resolve to their uppercase binding ("J" ↔ Shift+J).
	const disposeKeymap = keymap.appendEventMatchResolver((event, ctx) => {
		if (
			!event.shift ||
			event.ctrl ||
			event.meta ||
			event.super ||
			event.name.length !== 1
		)
			return undefined;
		const upper = event.name.toUpperCase();
		return upper !== event.name
			? [
					ctx.resolveKey({
						name: upper,
						ctrl: false,
						shift: false,
						meta: false,
						super: false,
					}),
				]
			: undefined;
	});
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(() => {
		disposeKeymap();
		dispose();
	});
	return <App repo="/demo" workflowId="demo" profile="test" keymap={keymap} />;
}

// Dismiss the auto-opened plan review popup; focus starts on the Change panel.
async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Enter on the focused panel; the opened modal identifies the panel:
// Change → plan review popup, Current task → tasks verdict. Agents is probed
// separately with `v` because Enter there dispatches a pane focus action.
async function openFocusedPanelModal(t: Test) {
	t.mockInput.pressEnter();
	await t.renderOnce();
	return t.captureCharFrame();
}

async function expectCurrentTask(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("Tasks ·");
	expect(frame).not.toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Tasks ·"));
}

async function expectChange(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Agents panel probe: move selection to the security-verifier (planner →
// worker → security-verifier) and open its result.
async function expectAgents(t: Test) {
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressKey("v");
	const frame = await t.waitForFrame((value) =>
		value.includes("VERDICT: PASS"),
	);
	expect(frame).toContain("security-verifier · demo");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("VERDICT"));
}

test("Shift+J/K move focus vertically with wrap at both edges", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change → (Shift+J) → Current task.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectCurrentTask(t);

	// Current task → (Shift+J, bottom wraps to top) → Change.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+K, top wraps to bottom) → Current task.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectCurrentTask(t);

	// Current task → (Shift+K) → Change.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	t.renderer.destroy();
});

test("Shift+H/L move focus horizontally with wrap at both edges", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change → (Shift+L) → Agents (selection starts at the top).
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);

	// Agents → (Shift+H) → Change.
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+H, left edge wraps to the right) → Agents, then
	// Shift+L returns to Change — reaching Change again proves the wrap
	// landed on the only other panel of the row.
	t.mockInput.pressKey("h", { shift: true });
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+L) → Agents, then Shift+H (right edge wraps to the
	// left) returns to Change.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	t.renderer.destroy();
});

test("Shift+J/K on the spanning Agents column move to Current task", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);

	// Agents → (Shift+J) → Current task.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectCurrentTask(t);

	// Current task → (Shift+K) → Change.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+L) → Agents; Shift+K wraps up to Current task.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectCurrentTask(t);

	t.renderer.destroy();
});

test("Shift+H/L on the full-width Current task row are a no-op", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change → (Shift+J) → Current task.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectCurrentTask(t);

	// Shift+H on Current task stays on Current task.
	t.mockInput.pressKey("h", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Tasks ·");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Tasks ·"));

	// Shift+L on Current task stays on Current task.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Tasks ·");

	t.renderer.destroy();
});

test("unshifted j scrolls without switching panels; Tab never moves panel focus", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Unshifted j stays on Change (no focus change) — Enter still opens the
	// plan review instead of the Current task verdict.
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Tab is unbound for panel navigation (reserved for the shell tab bar):
	// focus stays on Change, so Enter still opens the plan review.
	t.mockInput.pressTab();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Shift+Tab similarly leaves focus on Change.
	t.mockInput.pressKey("\t", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// From another panel Tab still does not move focus: Shift+J to Current
	// task, Tab, then Enter opens the Current task verdict.
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressTab();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Tasks ·");

	t.renderer.destroy();
});

test("help documents directional panel navigation", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	t.mockInput.pressKey("?");
	const helpFrame = await t.waitForFrame((frame) =>
		frame.includes("Shift+J/K/H/L"),
	);
	expect(helpFrame).toContain("Move between panels");
	// In-panel scrolling stays documented alongside the new bindings.
	expect(helpFrame).toContain("Scroll focused panel");
	t.renderer.destroy();
});
