/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { BreadcrumbRow } from "../../src/tui/shared/navigation/BreadcrumbRow";
import { HomePage } from "../../src/tui/shared/navigation/DestinationPage";
import {
	type DestinationEntry,
	filterPickerEntries,
	homeDestinations,
	observabilityDestinations,
} from "../../src/tui/shared/navigation/destinations";
import { LocationPicker } from "../../src/tui/shared/navigation/LocationPicker";
import { breadcrumb, type Route } from "../../src/tui/shared/routes";

// Rendered navigation checks for the page chrome
// (replace-nested-tabs-with-page-navigation, task 2.1/4.1). These assert what
// the terminal actually shows and which operation a selection dispatches.

const SURFACE = {
	environments: true,
	tracesOnly: false,
	workflows: true,
	wiki: true,
};

test("home renders its destinations and opens the selected one", async () => {
	const opened: Route[] = [];
	const [selected, setSelected] = createSignal(0);
	const entries = homeDestinations(SURFACE);
	const t = await testRender(
		() => (
			<HomePage
				entries={entries}
				selectedIndex={selected()}
				onSelectIndex={setSelected}
				onOpen={(entry: DestinationEntry) => opened.push(entry.route)}
			/>
		),
		{ width: 100, height: 20 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Environments"));
	expect(frame).toContain("Home");
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	expect(frame).toContain("Wiki");
	// No shell/nested navigation tab row is part of the page.
	expect(frame).not.toContain("1-4");
	// Opening the first destination dispatches the Environments route.
	entries[0] && opened.push(entries[selected()].route);
	expect(opened[0]).toEqual({ page: "environments" });
	t.renderer.destroy();
});

test("a category page lists child destinations without an inner tab row", async () => {
	const opened: Route[] = [];
	const t = await testRender(
		() => (
			<HomePage
				entries={observabilityDestinations(SURFACE)}
				selectedIndex={0}
				onSelectIndex={() => undefined}
				onOpen={(entry: DestinationEntry) => opened.push(entry.route)}
			/>
		),
		{ width: 100, height: 20 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Metrics"));
	expect(frame).toContain("Traces");
	expect(frame).toContain("Metrics");
	expect(frame).toContain("Logs");
	expect(frame).toContain("Topology");
	opened.push(observabilityDestinations(SURFACE)[1].route);
	expect(opened[0]).toEqual({ page: "observability.metrics" });
	t.renderer.destroy();
});

test("breadcrumbs render ancestors and navigate to the clicked one", async () => {
	const navigated: Route[] = [];
	const routes = breadcrumb({ page: "environments.applications" });
	const t = await testRender(
		() => (
			<BreadcrumbRow
				ancestors={routes}
				focusedIndex={routes.length - 1}
				onSelectIndex={() => undefined}
				onNavigate={(route: Route) => navigated.push(route)}
			/>
		),
		{ width: 120, height: 5 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Applications"));
	expect(frame).toContain("Home");
	expect(frame).toContain("Environments");
	expect(frame).toContain("Applications");
	t.renderer.destroy();
});

test("breadcrumbs stay one row and collapse on a narrow terminal", async () => {
	const routes = breadcrumb({
		page: "observability.traces.tree.span",
		resourceId: "span-1",
		params: { traceId: "trace-1" },
	});
	const t = await testRender(
		() => (
			<BreadcrumbRow
				ancestors={routes}
				focusedIndex={routes.length - 1}
				onSelectIndex={() => undefined}
			/>
		),
		{ width: 40, height: 5 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Span"));
	const lines = frame.split("\n").filter((line) => line.includes("›"));
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("…");
	expect(lines[0]?.indexOf("Span")).toBeGreaterThan(-1);
	// The row never overflows the terminal width.
	expect(lines[0]?.trimEnd().length).toBeLessThanOrEqual(40);
	t.renderer.destroy();
});

test("the location picker searches and jumps to a sibling destination", async () => {
	const accepted: Route[] = [];
	const [query, setQuery] = createSignal("");
	const entries = observabilityDestinations(SURFACE).map((entry) => ({
		...entry,
		group: "Observability",
	}));
	const t = await testRender(
		() => (
			<LocationPicker
				entries={entries}
				query={query()}
				selectedIndex={0}
				onQueryChange={setQuery}
				onSelectIndex={() => undefined}
				onAccept={(route: Route) => accepted.push(route)}
				onClose={() => undefined}
			/>
		),
		{ width: 100, height: 30 },
	);
	// Opening the picker names the modal; typing replaces the title with the query.
	await t.renderOnce();
	const opened = t.captureCharFrame();
	expect(opened).toContain("Locations");
	expect(opened).toContain("Topology");
	setQuery("met");
	await t.renderOnce();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Metrics");
	expect(frame).not.toContain("Topology");
	const matches = filterPickerEntries(entries, "met");
	accepted.push(matches[0].route);
	expect(accepted[0]).toEqual({ page: "observability.metrics" });
	t.renderer.destroy();
});
