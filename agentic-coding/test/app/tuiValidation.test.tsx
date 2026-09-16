/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../../src/tui/otel/app/App";
import { resetNotifications } from "../../src/tui/otel/app/notifications";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import {
	activeKeybindCatalog,
	activeKeybindContext,
	catalogKeybinds,
	footerKeybinds,
} from "../../src/tui/shared/keybinds";
import { renderUntil } from "./support/terminal";

// Terminal-size and input-surface validation for the page shell
// (replace-nested-tabs-with-page-navigation, task 4.2). The interactive TUI
// check is substituted by rendered frames at narrow and wide sizes, a real mouse
// click on the breadcrumb, and assertions on the footer and `?` help catalogs.

type Test = Awaited<ReturnType<typeof renderShell>>["t"];

async function renderShell(width: number, height = 30) {
	const dir = mkdtempSync(join(tmpdir(), "tui-validation-"));
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
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => <text>ENV-BODY</text>}
			/>
		),
		{ width, height },
	);
	await t.renderOnce();
	return { t, db };
}

const crumbLines = (t: Test) =>
	t
		.captureCharFrame()
		.split("\n")
		.filter((line) => line.includes("›"));

test("the breadcrumb row stays bounded at narrow and wide widths", async () => {
	const narrow = await renderShell(48);
	// The category page opens one row; it never wraps or overflows.
	narrow.t.mockInput.pressEnter();
	await renderUntil(narrow.t, (frame) => frame.includes("›"));
	const narrowLines = crumbLines(narrow.t);
	expect(narrowLines).toHaveLength(1);
	expect(narrowLines[0].trimEnd().length).toBeLessThanOrEqual(48);
	expect(narrowLines[0]).toContain("Applications");
	narrow.t.renderer.destroy();
	narrow.db.close();

	const wide = await renderShell(200, 50);
	wide.t.mockInput.pressEnter();
	await renderUntil(wide.t, (frame) => frame.includes("›"));
	const wideLines = crumbLines(wide.t);
	expect(wideLines).toHaveLength(1);
	// A wide terminal shows every ancestor without collapsing.
	expect(wideLines[0]).toContain("Home");
	expect(wideLines[0]).toContain("Environments");
	expect(wideLines[0]).toContain("Applications");
	expect(wideLines[0]).not.toContain("…");
	wide.t.renderer.destroy();
	wide.db.close();
});

test("clicking a breadcrumb ancestor navigates to it", async () => {
	const { t, db } = await renderShell(120);
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => frame.includes("Applications"));
	const line = crumbLines(t)[0];
	expect(line).toContain("Home › Environments › Applications");

	// Click "Environments" (the middle ancestor) on the breadcrumb row.
	const row = t
		.captureCharFrame()
		.split("\n")
		.findIndex((value) => value.includes("›"));
	const column = line.indexOf("Environments");
	await t.mockMouse.click(column + 2, row);
	await renderUntil(t, (frame) => frame.includes("Home › Environments"));
	const after = crumbLines(t)[0];
	expect(after).toContain("Home › Environments");
	expect(after).not.toContain("Applications");
	t.renderer.destroy();
	db.close();
});

test("every migrated destination renders its own page", async () => {
	const { t, db } = await renderShell(140, 40);
	// Environments category: the five category destinations are pages.
	const category = t.captureCharFrame();
	for (const label of [
		"Applications",
		"Libraries",
		"Infrastructure",
		"Scripts",
		"Kubernetes",
	]) {
		expect(category).toContain(label);
	}
	// Each one opens the feature body at that destination.
	for (const label of ["Applications", "Libraries", "Scripts"]) {
		t.mockInput.pressKey("p", { ctrl: true });
		await t.renderOnce();
		for (const character of label.toLowerCase()) {
			t.mockInput.pressKey(character);
			await t.renderOnce();
		}
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => frame.includes(label));
		expect(crumbLines(t)[0]).toContain(label);
	}
	t.renderer.destroy();
	db.close();
});

test("the footer advertises special keys and the help lists the whole catalog", async () => {
	const { t, db } = await renderShell(140, 40);
	await t.renderOnce();
	// A toast from an earlier test would displace the right-anchored `?` help
	// entry; the footer contract is asserted without it.
	resetNotifications();
	await t.renderOnce();
	const lines = t.captureCharFrame().split("\n");
	const footer =
		lines.find((line) => line.includes("Ctrl+P")) ?? lines.at(-2) ?? "";
	// Special keys only: navigation keys stay out of the footer.
	expect(footer).toContain("Ctrl+P");
	expect(footer).toContain("?");
	const footerActions = footerKeybinds(
		activeKeybindCatalog(),
		activeKeybindContext(),
	).map((keybind) => keybind.action);
	expect(footerActions).toContain("locations");
	expect(footerActions).not.toContain("select destination");
	// Parent, Back and Forward are navigation, so the footer leaves them to the
	// `?` help modal.
	expect(footerActions).not.toContain("parent page");
	expect(footerActions).not.toContain("back");
	expect(footerActions).not.toContain("forward");

	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((value) => value.includes("Keybindings"));
	// The help modal lists the complete catalog, standard keys included.
	expect(help).toContain("select destination");
	expect(help).toContain("open destination");
	expect(help).toContain("locations");
	expect(help).toContain("parent page");
	expect(help).toContain("back");
	expect(help).toContain("forward");
	const catalog = catalogKeybinds(activeKeybindCatalog()).map(
		(keybind) => keybind.action,
	);
	expect(catalog).toContain("select destination");
	expect(catalog).toContain("open destination");
	t.renderer.destroy();
	db.close();
});
