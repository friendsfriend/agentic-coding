/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { catalogKeybinds } from "@ui";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import {
	environmentsKeybindCatalog,
	observabilityKeybindCatalog,
} from "../../src/tui/otel/app/keybinds";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import { destinationPageKeybindCatalog } from "../../src/tui/shared/navigation/keybinds";
import { pressEscapeAndSettle } from "./support/terminal";

// Page-local input (replace-nested-tabs-with-page-navigation, task 3.1): Tab
// traverses focus regions instead of destinations, Ctrl+P opens the one
// location picker, Escape opens the structural parent, and no numeric or `t`
// cycling remains.

type Test = Awaited<ReturnType<typeof renderShell>>["t"];

const pressEscape = pressEscapeAndSettle;

async function renderShell(options: { home?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "page-navigation-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			if (!options.home) {
				return (
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
				);
			}
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

const crumb = (t: Test) =>
	t
		.captureCharFrame()
		.split("\n")
		.find((line) => line.includes("›"))
		?.trim() ?? "";

test("number and `t` keys no longer switch destinations", async () => {
	const { t, db } = await renderShell();
	expect(crumb(t)).toContain("Home › Environments");
	for (const key of ["1", "2", "3", "t"]) {
		t.mockInput.pressKey(key);
		await t.renderOnce();
	}
	const frame = t.captureCharFrame();
	expect(crumb(t)).toContain("Home › Environments");
	// The numbers neither switched the destination nor opened the environment body.
	expect(frame).not.toContain("ENV-BODY");
	t.renderer.destroy();
	db.close();
});

test("Ctrl+P jumps straight to a destination and Back returns", async () => {
	const { t, db } = await renderShell();
	t.mockInput.pressKey("p", { ctrl: true });
	await t.renderOnce();
	for (const character of "libraries") {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	expect(crumb(t)).toContain("Home › Environments › Libraries");

	await pressEscape(t, (frame) => frame.includes("Home › Environments"));
	expect(crumb(t)).toContain("Home › Environments");
	t.renderer.destroy();
	db.close();
});

test("Parent and picker are advertised on the page surfaces", async () => {
	// The parent operation itself is covered by the route tests; here the
	// binding must be declared once per surface so the footer and `?` help agree.
	const actionsFor = (
		catalog: ReturnType<typeof destinationPageKeybindCatalog>,
	) => catalogKeybinds(catalog).map((keybind) => keybind.action);
	expect(actionsFor(destinationPageKeybindCatalog())).toContain("parent page");
	expect(
		actionsFor(
			observabilityKeybindCatalog({ tab: "metrics", view: "selection" }),
		),
	).toContain("parent page");
	expect(actionsFor(environmentsKeybindCatalog())).toContain("parent page");
	expect(actionsFor(destinationPageKeybindCatalog())).toContain("locations");

	// The rendered `?` help lists them on a destination page.
	const { t, db } = await renderShell();
	t.mockInput.pressKey("?");
	const frame = await t.waitForFrame((value) => value.includes("Keybindings"));
	expect(frame).toContain("parent page");
	expect(frame).toContain("locations");
	expect(frame).not.toContain("feature tabs");
	t.renderer.destroy();
	db.close();
});

test("the retired Alt+Up alias opens no parent and is advertised nowhere", async () => {
	// Escape is the only structural up-step: `Alt+Up` was dropped from the
	// catalogs, so no footer, `?` help or keymap layer may offer it again.
	for (const catalog of [
		destinationPageKeybindCatalog(),
		observabilityKeybindCatalog({ tab: "metrics", view: "selection" }),
		environmentsKeybindCatalog(),
	]) {
		for (const keybind of catalogKeybinds(catalog)) {
			expect(keybind.key.toLowerCase()).not.toContain("alt+up");
		}
	}

	const { t, db } = await renderShell({ home: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	// Home mode mounts no environment backend, so Observability is the first
	// destination; any body page proves the same point.
	expect(crumb(t)).toContain("Home › Observability");

	t.mockInput.pressKey("up", { meta: true });
	await t.renderOnce();
	await t.renderOnce();
	expect(crumb(t)).toContain("Home › Observability");

	await pressEscape(
		t,
		(frame) => !frame.split("\n").some((line) => line.includes("›")),
	);
	expect(crumb(t)).toBe("");
	t.renderer.destroy();
	db.close();
});

test("Tab traverses page-local focus regions instead of destinations", async () => {
	const { t, db } = await renderShell();
	// Tab moves focus from the destination list to the breadcrumb row, where k
	// walks the ancestors: Enter then opens the ancestor, not a destination.
	t.mockInput.pressTab();
	await t.renderOnce();
	t.mockInput.pressKey("k");
	await t.renderOnce();
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	// Home renders without a separator (it has no ancestor) and shows its list,
	// which carries no title, description or hint row of its own.
	const frame = t.captureCharFrame();
	expect(frame).toContain("Environments");
	expect(frame).not.toContain("Choose a destination");
	expect(frame).not.toContain("ENV-BODY");
	t.renderer.destroy();
	db.close();
});

test("the environment body owns Tab on its own page", async () => {
	const dir = mkdtempSync(join(tmpdir(), "page-navigation-tab-"));
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
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	// The embedded body's own keymap layer sees Tab; the shell does not use it to
	// switch pages (the breadcrumb stays on the opened category).
	t.mockInput.pressTab();
	await t.renderOnce();
	expect(crumb(t)).toContain("Home › Environments › Applications");
	t.renderer.destroy();
	db.close();
});
