/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, test } from "bun:test";
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
import {
	activeErrorModal,
	resetErrorModal,
	showErrorModal,
} from "../../src/tui/shared/errorModal";

beforeEach(() => resetErrorModal());

/** Home-mode shell so the dashboard keymap (and the global error overlay) is
 * wired exactly as in production. */
async function renderHomeApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-error-modal-"));
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
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

test("dismissing the error modal on another tab never reaches that tab", async () => {
	const { t } = await renderHomeApp();

	// Move to a non-workflow shell tab; this is where a leaked dismissal key
	// would drive the observability view logic.
	t.mockInput.pressKey("3");
	await t.flush();

	showErrorModal("Observation failed", "background refresh failed");
	await t.flush();
	expect(t.captureCharFrame()).toContain("background refresh failed");

	t.mockInput.pressEscape();
	await Bun.sleep(80);
	await t.flush();

	expect(t.captureCharFrame()).not.toContain("background refresh failed");
	expect(activeErrorModal()).toBeUndefined();

	t.renderer.destroy();
});
