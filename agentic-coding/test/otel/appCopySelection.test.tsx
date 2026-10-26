/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { TraceDb } from "../../src/server/telemetry-db";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { stubClipboardCommand } from "../support/clipboard.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function renderOtelApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-copy-test-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const db = new TraceDb(dir);
	cleanups.push(() => db.close());
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
	cleanups.push(() => t.renderer.destroy());
	await t.renderOnce();
	return { t };
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
	const { t } = await renderOtelApp();
	const restoreClipboard = stubClipboardCommand(true);
	try {
		await selectAndCopy(t);
		const frame = await t.waitForFrame((f) => f.includes("Copied selection"));
		expect(frame).not.toContain("Copy failed");
	} finally {
		restoreClipboard();
	}
});

test("otel TUI copySelection reports a copy-failed notification when the clipboard write fails", async () => {
	const { t } = await renderOtelApp();
	const restoreClipboard = stubClipboardCommand(false);
	try {
		await selectAndCopy(t);
		const frame = await t.waitForFrame((f) => f.includes("Copy failed"));
		expect(frame).not.toContain("Copied selection");
	} finally {
		restoreClipboard();
	}
});
