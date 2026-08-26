/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App, agentMetricLine } from "../../src/tui/dash/App";

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
	// Populated-agent metrics (cost · tokens in→out · cache hit rate · duration
	// · tok/s), derived from runtime.usage demo telemetry.
	expect(frame).toContain("$0.07 · tok 4.1k→900 · 75.0% · 1m 7s · 20 tok/s");
	expect(frame.split("$0.07").length - 1).toBe(1);
	expect(frame).not.toContain("PASS · 1m 7s · $0.07");
	// The compact line keeps the tokens/s unit visible at the panel width.
	expect(frame).toContain("7.7 tok/s");
	t.renderer.destroy();
});

test("agent metric line includes cache writes and preserves incomplete precision", () => {
	expect(
		agentMetricLine({
			inputTokens: 100,
			cacheReadTokens: 300,
			cacheWriteTokens: 100,
		}),
	).toContain("60.0%");
	expect(
		agentMetricLine({
			inputTokens: 1,
			cacheReadTokens: 999,
			cacheWriteTokens: 0,
		}),
	).toContain("99.9%");
	expect(
		agentMetricLine({
			inputTokens: 0,
			cacheReadTokens: 100,
			cacheWriteTokens: 0,
		}),
	).toContain("100.0%");
});

test("agent metric line omits incomplete or zero-denominator cache rates", () => {
	expect(
		agentMetricLine({
			inputTokens: 100,
			cacheReadTokens: 0,
		}),
	).not.toContain("%");
	expect(
		agentMetricLine({
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		}),
	).not.toContain("%");
});
