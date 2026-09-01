/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";

/** Force every clipboard command to fail and pretend to be a platform with no
 * OSC 52 fallback (darwin/win32) so `copyToClipboard` deterministically
 * returns `false`, exercising the failure-notification path. */
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

async function renderOtelApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-copy-test-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

/** Drag-select the "AGENTIC CODING" header text so
 * `renderer.getSelection()?.getSelectedText()` (what `copySelection` reads)
 * returns non-empty text, then trigger the Meta+C global copy shortcut. */
async function selectAndCopy(
	t: Awaited<ReturnType<typeof renderOtelApp>>["t"],
) {
	await t.mockMouse.pressDown(2, 1);
	await t.mockMouse.moveTo(10, 1);
	await t.renderOnce();
	expect(t.renderer.hasSelection).toBe(true);
	t.mockInput.pressKey("c", { meta: true });
}

test("otel TUI copySelection reports a copy-succeeded notification when the clipboard write succeeds", async () => {
	const { t, db } = await renderOtelApp();
	const restoreStdout = suppressStdoutWrites();
	try {
		await selectAndCopy(t);
		const frame = await t.waitForFrame((f) => f.includes("Copied selection"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreStdout();
	}
	t.renderer.destroy();
	db.close();
});

test("otel TUI copySelection reports a copy-failed notification when the clipboard write fails", async () => {
	const { t, db } = await renderOtelApp();
	const restoreClipboard = makeClipboardCommandsFail();
	try {
		await selectAndCopy(t);
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Copied selection");
	} finally {
		restoreClipboard();
	}
	t.renderer.destroy();
	db.close();
});
