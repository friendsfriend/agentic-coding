/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";

// Renders the demo dashboard (profile="test") so the Agents panel exercises
// populated, partial, and metric-less agent rows from testDashboard fixtures.
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

test("agents panel renders compact bounded metric lines per agent", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await t.waitForFrame((frame) => frame.includes("Agents"));
	const frame = t.captureCharFrame();
	// Full metric line for a populated agent (cost · tokens in→out · cache hit
	// rate · duration · tok/s), derived from runtime.usage demo telemetry.
	expect(frame).toContain(
		"$0.07 · tok 4.1k→900 · 80% cached · 1m 7s · 20 tok/s",
	);
	// Bounded rendering: an over-long line is truncated inside the panel
	// instead of overflowing into adjacent panels.
	expect(frame).toContain("7.7 tok");
	expect(frame).not.toContain("7.7 tok/s");
	t.renderer.destroy();
});
