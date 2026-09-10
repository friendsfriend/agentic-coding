/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";

type Test = Awaited<ReturnType<typeof renderOtelApp>>["t"];

const stores = () => ({
	traceStore: new TraceStore(),
	metricStore: new MetricStore(),
	logStore: new LogStore(),
	topologyStore: new TopologyStore(),
});

async function renderOtelApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-shell-help-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => <App repos={["/demo"]} db={db} {...stores()} />,
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

/** Home mode (dashboard prop) so the wiki tab exists. */
async function renderHomeApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-shell-help-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return (
				<App
					repos={["/demo"]}
					db={db}
					{...stores()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

/** A lone ESC byte is only flushed by the input parser after a short delay. */
async function pressEscape(t: Test) {
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
}

test("`?` opens the catalog help modal on the traces tab", async () => {
	const { t, db } = await renderOtelApp();
	t.mockInput.pressKey("?");
	const frame = await t.waitForFrame((value) => value.includes("Keybindings"));
	// The modal renders the whole catalog, standard keys included.
	expect(frame).toContain("select trace");
	expect(frame).toContain("search");
	expect(frame).toContain("help");
	await pressEscape(t);
	await t.waitForFrame((value) => !value.includes("Keybindings"));
	t.renderer.destroy();
	db.close();
});

test("`?` opens the catalog help modal on metrics/logs/topology tabs", async () => {
	const { t, db } = await renderOtelApp();
	// traces → metrics (tab 2).
	t.mockInput.pressKey("2");
	await t.renderOnce();
	t.mockInput.pressKey("?");
	const frame = await t.waitForFrame((value) => value.includes("Keybindings"));
	expect(frame).toContain("select metric");
	expect(frame).toContain("help");
	await pressEscape(t);
	await t.waitForFrame((value) => !value.includes("Keybindings"));
	t.renderer.destroy();
	db.close();
});

test("`?` does not replace an open traces filter modal", async () => {
	const { t, db } = await renderOtelApp();
	t.mockInput.pressKey("f", { shift: true });
	await t.waitForFrame((value) => value.includes("Filter"));
	t.mockInput.pressKey("?");
	await t.renderOnce();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Filter");
	expect(frame).not.toContain("Keybindings");
	t.renderer.destroy();
	db.close();
});

test("`?` opens the catalog help modal on the wiki tab", async () => {
	const { t, db } = await renderHomeApp();
	// workflow → wiki (tab 2).
	t.mockInput.pressKey("2");
	await t.renderOnce();
	await t.renderOnce();
	t.mockInput.pressKey("?");
	const frame = await t.waitForFrame((value) => value.includes("Keybindings"));
	expect(frame).toContain("visual line selection");
	expect(frame).toContain("next/previous note");
	await pressEscape(t);
	await t.waitForFrame((value) => !value.includes("Keybindings"));
	t.renderer.destroy();
	db.close();
});
