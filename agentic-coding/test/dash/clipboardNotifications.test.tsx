/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App.tsx";
import { resetNotifications } from "../../src/tui/dash/notifications.ts";
import { stubClipboardCommand } from "../support/clipboard.ts";

const renderers: Array<{ destroy(): void }> = [];
afterEach(() => {
	for (const renderer of renderers.splice(0).reverse()) renderer.destroy();
});

// The notification signal is module-global; bun runs all files in one
// process, so a toast left by an earlier file would bleed into this one.
beforeEach(() => {
	resetNotifications();
});

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
		agentView(value, ctx) {
			ctx.require("agent.view", String(value));
		},
	});
	onCleanup(() => dispose());
	return <App repo="/demo" workflowId="demo" profile="test" keymap={keymap} />;
}

/** Dismiss the plan-review popup and drag-select some on-screen overview text
 * so `renderer.getSelection()?.getSelectedText()` (what the copy key
 * handlers read) returns non-empty text. */
async function renderWithSelection(t: TestRendererSetup) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
	await t.mockMouse.drag(2, 1, 20, 1);
	await t.renderOnce();
	expect(t.renderer.hasSelection).toBe(true);
}

test("Ctrl+C reports a copy-succeeded notification when the clipboard write succeeds", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	renderers.push(t.renderer);
	await renderWithSelection(t);

	const restoreClipboard = stubClipboardCommand(true);
	try {
		t.mockInput.pressKey("c", { ctrl: true });
		const frame = await t.waitForFrame((f) => f.includes("Selection copied"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreClipboard();
	}
});

test("Ctrl+C reports a copy-failed notification when the clipboard write fails", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	renderers.push(t.renderer);
	await renderWithSelection(t);

	const restoreClipboard = stubClipboardCommand(false);
	try {
		t.mockInput.pressKey("c", { ctrl: true });
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Selection copied");
	} finally {
		restoreClipboard();
	}
});

test("Meta+C reports a copy-succeeded notification when the clipboard write succeeds", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	renderers.push(t.renderer);
	await renderWithSelection(t);

	const restoreClipboard = stubClipboardCommand(true);
	try {
		t.mockInput.pressKey("c", { meta: true });
		const frame = await t.waitForFrame((f) => f.includes("Selection copied"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreClipboard();
	}
});

test("Meta+C reports a copy-failed notification when the clipboard write fails", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	renderers.push(t.renderer);
	await renderWithSelection(t);

	const restoreClipboard = stubClipboardCommand(false);
	try {
		t.mockInput.pressKey("c", { meta: true });
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Selection copied");
	} finally {
		restoreClipboard();
	}
});
