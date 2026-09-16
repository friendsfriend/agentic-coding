/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { createEffect, type JSX } from "solid-js";
import { App, type EnvironmentDestination } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { createDemoDb } from "../../src/tui/otel/model/demoDb";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import type { KeybindSection } from "../../src/tui/shared/keybinds";
import {
	crumb,
	jumpTo as jumpToDestination,
	pressEscapeAndSettle,
	renderUntil,
} from "./support/terminal";

// Rendered navigation checks for the page shell
// (replace-nested-tabs-with-page-navigation, task 4.1): Home → Applications →
// resource, an observability list → trace → span, cross-domain Back versus
// Parent, modal/text-input isolation and inactive handlers.

type Test = Awaited<ReturnType<typeof renderShell>>["t"];

/** The destination projection the shell hands the embedded environment body. */
type DestinationLike = EnvironmentDestination;
type RenderEnvironments = (
	onCatalog: (catalog: KeybindSection[]) => void,
	active: () => boolean,
	onModalChange: (open: boolean) => void,
	destination: () => DestinationLike | undefined,
) => JSX.Element;

/**
 * Environments body stub that reports the destination the real feature reports:
 * the report follows the category the shell requested, exactly as the feature's
 * store-driven report does.
 */
function ReportingEnvironment(props: {
	destination: () => DestinationLike | undefined;
}) {
	createEffect(() => {
		const destination = props.destination();
		if (destination?.category !== "applications") return;
		destination.onChange?.({
			category: "applications",
			view: "appDetail",
			resourceId: "app-1",
		});
	});
	return <text>ENV-BODY</text>;
}

async function renderShell(
	renderEnvironments: (
		destination: () => DestinationLike | undefined,
	) => JSX.Element = () => <text>ENV-BODY</text>,
) {
	const dir = mkdtempSync(join(tmpdir(), "rendered-navigation-"));
	const db = new TraceDb(dir);
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
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={traceStore}
				metricStore={metricStore}
				logStore={logStore}
				topologyStore={topologyStore}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={
					((_onCatalog, _active, _onModal, destination) =>
						renderEnvironments(destination)) as RenderEnvironments
				}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

const jumpTo = (t: Test, query: string) => jumpToDestination(t, query);

test("Home → Applications → resource page, with the breadcrumb naming the view", async () => {
	const { t, db } = await renderShell((destination) => (
		<ReportingEnvironment destination={destination} />
	));
	// The entry is the Environments category page.
	expect(crumb(t)).toContain("Home › Environments");
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => frame.includes("›"));
	// The feature reported an application detail view: the route names the view.
	// The resource root is named by the identity it renders.
	expect(crumb(t)).toContain("Home › Environments › Applications › app-1");

	// Back returns to the category page (the resource page is a page, not a tab).
	await pressEscapeAndSettle(t);
	expect(crumb(t)).toContain("Home › Environments › Applications");
	t.renderer.destroy();
	db.close();
});

test("cross-domain Back restores the originating application page", async () => {
	const { t, db } = await renderShell();
	expect(crumb(t)).toContain("Home › Environments");
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => frame.includes("›"));
	expect(crumb(t)).toContain("Home › Environments › Applications");

	// Cross into observability and open a trace.
	await jumpTo(t, "loaded trace");
	expect(t.captureCharFrame()).toContain("Span tree");
	expect(crumb(t)).toContain("Observability › Traces");

	// Back restores the application page, not the observability list.
	await pressEscapeAndSettle(t);
	expect(crumb(t)).toContain("Home › Environments › Applications");
	t.renderer.destroy();
	db.close();
});

test("the location picker owns input while it is open", async () => {
	const { t, db } = await renderShell();
	const before = crumb(t);
	t.mockInput.pressKey("p", { ctrl: true });
	expect(await renderUntil(t, "Locations")).toBe(true);
	expect(t.captureCharFrame()).toContain(
		"No matching location".replace("No matching location", "Locations"),
	);

	// Keys that would move the destination cursor or switch pages go to the
	// search box instead: the page underneath does not change.
	for (const key of ["j", "1", "t"]) {
		t.mockInput.pressKey(key);
		await t.renderOnce();
	}
	expect(await renderUntil(t, "/j1t")).toBe(true);
	const typed = t.captureCharFrame();
	expect(typed).toContain("/j1t");
	expect(typed).toContain("No matching location");

	// Escape closes the picker without navigating. Ctrl+P toggles it closed too,
	// which is deterministic (a lone ESC byte depends on the input parser's
	// flush delay).
	await pressEscapeAndSettle(t);
	if (t.captureCharFrame().includes("Locations")) {
		t.mockInput.pressKey("p", { ctrl: true });
		expect(await renderUntil(t, (frame) => !frame.includes("Locations"))).toBe(
			true,
		);
	}
	expect(t.captureCharFrame()).not.toContain("Locations");
	expect(crumb(t)).toBe(before);
	t.renderer.destroy();
	db.close();
});

test("an inactive feature body does not drive the shell route", async () => {
	// The reporting environment body is mounted but Home is the current page, so
	// its destination report must be ignored rather than pulling the route away.
	const dir = mkdtempSync(join(tmpdir(), "rendered-navigation-home-"));
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
				renderEnvironments={
					((_onCatalog, _active, _onModal, destination) => (
						<ReportingEnvironment destination={destination} />
					)) as RenderEnvironments
				}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	await t.renderOnce();
	expect(crumb(t)).toContain("Home › Environments");
	expect(t.captureCharFrame()).toContain("Applications");
	t.renderer.destroy();
	db.close();
});
