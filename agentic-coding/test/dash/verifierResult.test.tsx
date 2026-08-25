/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";

function TestDashboard() {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(dispose);
	return <App repo="/demo" change="demo" profile="test" keymap={keymap} />;
}

// Dismiss the auto-opened plan review popup and move focus to the Agents
// panel (Tab order [0, 6, 1, 2, 4]: Change → OpenSpec → Agents).
async function focusAgentsPanel(t: Awaited<ReturnType<typeof testRender>>) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
	t.mockInput.pressTab();
	t.mockInput.pressTab();
	await t.renderOnce();
}

test("v on a verification agent opens its result directly", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await focusAgentsPanel(t);

	// Move the selection from planner → worker → security-verifier.
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();

	t.mockInput.pressKey("v");
	const verdictFrame = await t.waitForFrame((frame) =>
		frame.includes("VERDICT: PASS"),
	);
	expect(verdictFrame).toContain("security-verifier · demo");
	expect(verdictFrame).toContain("Demo verifier report.");

	t.renderer.destroy();
});

test("v on a non-verification agent does nothing", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await focusAgentsPanel(t);

	// Selection stays on planner (not a verifier role).
	t.mockInput.pressKey("v");
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("VERDICT");
	expect(frame).not.toContain("Select a verifier agent");

	t.renderer.destroy();
});
