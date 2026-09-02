/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";
import { resetNotifications } from "../../src/tui/dash/notifications";

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

/** Force every clipboard command to fail and disable the OSC 52 last-resort
 * fallback (by pretending to be a platform with no such fallback) so
 * `copyToClipboard` deterministically returns `false`. */
function makeClipboardCommandsFail() {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { value: "darwin" });
	const spy = spyOn(childProcess, "execFileSync").mockImplementation(() => {
		throw new Error("pbcopy: command not found");
	});
	return () => {
		spy.mockRestore();
		Object.defineProperty(process, "platform", { value: originalPlatform });
	};
}

/** Stub stdout so a real OSC 52 fallback write can't leak escape sequences
 * into the captured test frame. */
function suppressStdoutWrites() {
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	return () => {
		process.stdout.write = original;
	};
}

test("Ctrl+C reports a copy-succeeded notification when the clipboard write succeeds", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await renderWithSelection(t);

	const restoreStdout = suppressStdoutWrites();
	try {
		t.mockInput.pressKey("c", { ctrl: true });
		const frame = await t.waitForFrame((f) => f.includes("Selection copied"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreStdout();
	}
	t.renderer.destroy();
});

test("Ctrl+C reports a copy-failed notification when the clipboard write fails", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await renderWithSelection(t);

	const restoreClipboard = makeClipboardCommandsFail();
	try {
		t.mockInput.pressKey("c", { ctrl: true });
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Selection copied");
	} finally {
		restoreClipboard();
	}
	t.renderer.destroy();
});

test("Meta+C reports a copy-succeeded notification when the clipboard write succeeds", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await renderWithSelection(t);

	const restoreStdout = suppressStdoutWrites();
	try {
		t.mockInput.pressKey("c", { meta: true });
		const frame = await t.waitForFrame((f) => f.includes("Selection copied"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreStdout();
	}
	t.renderer.destroy();
});

test("Meta+C reports a copy-failed notification when the clipboard write fails", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await renderWithSelection(t);

	const restoreClipboard = makeClipboardCommandsFail();
	try {
		t.mockInput.pressKey("c", { meta: true });
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Selection copied");
	} finally {
		restoreClipboard();
	}
	t.renderer.destroy();
});
