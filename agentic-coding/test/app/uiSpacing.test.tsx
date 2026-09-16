/** @jsxImportSource @opentui/solid */
// One spacing rule for every page of the unified shell: exactly one blank row
// between the header (logo bar + breadcrumb) and the page content, exactly one
// between the content and the footer, and no page-level inset on either side —
// a page's own rows may indent their own content, the page itself must not.
//
// The rule lives in the shell chrome (`otel/app/App.tsx`), and a hosted body
// that renders its own framing stands its outer gutters down for it
// (`shared/hostChrome.ts` + `shared/ContentStack.tsx`), so a check on a
// destination list and on a full-height list covers both owners.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { createDemoDb } from "../../src/tui/otel/model/demoDb";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import { advance, jumpTo, renderUntil } from "./support/terminal";

type Test = Awaited<ReturnType<typeof renderShell>>["t"];

/** Row `index` (0-based) of the frame, clipped so a scrollbar column cannot
 * count as page content. */
const row = (t: Test, index: number) =>
	(t.captureCharFrame().split("\n")[index] ?? "").slice(0, 90);

/** Chrome rows: 1 logo, 2 breadcrumb, 3 blank, content, blank, footer. */
function expectChromeSpacing(t: Test, label: string): void {
	const rows = t.captureCharFrame().split("\n");
	const footer = rows.reduce(
		(acc, line, index) => (line.slice(0, 90).trim() ? index : acc),
		0,
	);
	expect(`${label} row3=${JSON.stringify(row(t, 2).trim())}`).toBe(
		`${label} row3=""`,
	);
	expect(
		`${label} gapBeforeFooter=${JSON.stringify(row(t, footer - 1).trim())}`,
	).toBe(`${label} gapBeforeFooter=""`);
}

async function renderShell() {
	const db = new TraceDb(mkdtempSync(join(tmpdir(), "ui-spacing-")));
	const demo = await createDemoDb();
	const traceStore = new TraceStore();
	traceStore.loadFile(demo.spans);
	const metricStore = new MetricStore();
	metricStore.load(demo.metrics);
	const logStore = new LogStore();
	logStore.load(demo.logs);
	const topologyStore = new TopologyStore();
	topologyStore.load(demo.spans);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(() => {});
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={traceStore}
					metricStore={metricStore}
					logStore={logStore}
					topologyStore={topologyStore}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 100, height: 24 },
	);
	await t.renderOnce();
	await advance(t, 10);
	return { t, db };
}

test("every page keeps one blank row above and below its content", async () => {
	const { t, db } = await renderShell();
	try {
		// A destination list (the menu the rule was reported from).
		expectChromeSpacing(t, "menu");
		expect(row(t, 3)).toContain("Observability");
		// No page-level inset: the row itself may indent its own content, but the
		// page never pushes it in by more than the selection indicator column.
		const menuRow = row(t, 3);
		expect(menuRow.length - menuRow.trimStart().length).toBeLessThanOrEqual(1);

		// A full-height list: the last log line stays inside the content area.
		await jumpTo(t, "logs");
		expect(await renderUntil(t, "(50)")).toBe(true);
		await advance(t, 8);
		expectChromeSpacing(t, "logs");

		// A detail page.
		t.mockInput.pressEnter();
		await advance(t, 8);
		expectChromeSpacing(t, "log detail");

		// Settings: the list and a section editor.
		await jumpTo(t, "settings");
		await advance(t, 8);
		expectChromeSpacing(t, "settings list");
		expect(row(t, 3)).toContain("Appearance");
		t.mockInput.pressEnter();
		await advance(t, 8);
		expectChromeSpacing(t, "settings section");
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 40_000);
