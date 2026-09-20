/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { BreadcrumbRow } from "../../src/tui/shared/navigation/BreadcrumbRow.tsx";
import { DestinationPage } from "../../src/tui/shared/navigation/DestinationPage.tsx";
import {
	filterPickerEntries,
	homeDestinations,
	observabilityDestinations,
} from "../../src/tui/shared/navigation/destinations.ts";
import { LocationPicker } from "../../src/tui/shared/navigation/LocationPicker.tsx";
import {
	breadcrumb,
	pageLabel,
	RESOURCE_LABEL_LIMIT,
	type Route,
} from "../../src/tui/shared/routes.ts";

// Rendered navigation checks for the page chrome
// (replace-nested-tabs-with-page-navigation, task 2.1/4.1). These assert what
// the terminal actually shows and which operation a selection dispatches.

const SURFACE = {
	environments: true,
	tracesOnly: false,
	workflows: true,
	wiki: true,
	settings: true,
};

/** Frame coordinate of `text`, so a test clicks the widget the terminal shows
 * instead of asserting an outcome it pushed in itself. */
function locate(frame: string, text: string): { x: number; y: number } {
	const lines = frame.split("\n");
	for (const [y, line] of lines.entries()) {
		const x = line.indexOf(text);
		if (x >= 0) return { x: x + 1, y };
	}
	throw new Error(`frame does not contain ${text}`);
}

test("home renders its destinations and a click moves the selection", async () => {
	const [selected, setSelected] = createSignal(0);
	const entries = homeDestinations(SURFACE);
	const t = await testRender(
		() => (
			<DestinationPage
				entries={entries}
				selectedIndex={selected()}
				onSelectIndex={setSelected}
				onOpen={() => undefined}
			/>
		),
		{ width: 100, height: 20 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Environments"));
	// The page names nothing itself: the shell chrome names the location and a
	// description/hint row is not part of a page body.
	expect(frame).not.toContain("Choose a destination");
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	expect(frame).toContain("Wiki");
	// No shell/nested navigation tab row is part of the page.
	expect(frame).not.toContain("1-4");
	// A real click on a rendered destination drives the production selection
	// handler. Opening the selection (Enter on the shell keymap) is covered by
	// the appShellMount and pageNavigation journeys.
	const observability = locate(frame, "Observability");
	await t.mockMouse.click(observability.x, observability.y);
	await t.renderOnce();
	expect(selected()).toBe(1);
	t.renderer.destroy();
});

test("a category page lists child destinations without an inner tab row", async () => {
	const t = await testRender(
		() => (
			<DestinationPage
				entries={observabilityDestinations(SURFACE)}
				selectedIndex={0}
				onSelectIndex={() => undefined}
				onOpen={() => undefined}
			/>
		),
		{ width: 100, height: 20 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Metrics"));
	expect(frame).toContain("Traces");
	expect(frame).toContain("Metrics");
	expect(frame).toContain("Logs");
	expect(frame).toContain("Topology");
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
	// Clicking the first rendered ancestor drives the production navigation
	// handler with that ancestor's route.
	const home = locate(frame, "Home");
	await t.mockMouse.click(home.x, home.y);
	await t.renderOnce();
	expect(navigated).toEqual([routes[0]]);
	t.renderer.destroy();
});

test("breadcrumbs name the resource they render, bounded", () => {
	// A resource page's current segment is the identity it renders, which is what
	// makes the removed title row redundant instead of lossy.
	expect(pageLabel({ page: "wiki.note", resourceId: "adr-7-routing" })).toBe(
		"adr-7-routing",
	);
	expect(
		pageLabel({ page: "observability.traces.tree", resourceId: "trace-4" }),
	).toBe("trace-4");
	expect(
		pageLabel({
			page: "observability.traces.tree.span",
			resourceId: "trace-4:span-9",
			params: { traceId: "trace-4" },
		}),
	).toBe("trace-4:span-9");
	// A long identity is clipped so one resource cannot push the row past the
	// terminal width.
	const long = pageLabel({
		page: "wiki.note",
		resourceId: "a-very-long-concept-identity-that-would-overflow",
	});
	expect(long.length).toBeLessThanOrEqual(RESOURCE_LABEL_LIMIT);
	expect(long.endsWith("…")).toBe(true);
	// A non-resource page keeps its catalog label.
	expect(pageLabel({ page: "observability.logs" })).toBe("Logs");
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
	// The current segment names the span identity, not a page title.
	const frame = await t.waitForFrame((value) => value.includes("span-1"));
	const lines = frame.split("\n").filter((line) => line.includes("›"));
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("…");
	expect(lines[0]?.indexOf("span-1")).toBeGreaterThan(-1);
	// The row never overflows the terminal width.
	expect(lines[0]?.trimEnd().length).toBeLessThanOrEqual(40);
	t.renderer.destroy();
});

test("a resource label is clipped rather than overflowing the row", async () => {
	const resourceId = "a-very-long-concept-identity-that-would-overflow";
	const routes = breadcrumb({ page: "wiki.note", resourceId });
	const t = await testRender(
		() => (
			<BreadcrumbRow
				ancestors={routes}
				focusedIndex={routes.length - 1}
				onSelectIndex={() => undefined}
			/>
		),
		{ width: 30, height: 5 },
	);
	const frame = await t.waitForFrame((value) => value.includes("…"));
	const lines = frame.split("\n").filter((line) => line.includes("›"));
	expect(lines).toHaveLength(1);
	expect(lines[0]?.trimEnd().length).toBeLessThanOrEqual(30);
	expect(lines[0]).not.toContain(resourceId);
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
	// The production filter and the rendered row agree, and clicking the row
	// accepts that route through the real mouse handler.
	const expected = filterPickerEntries(entries, "met");
	expect(expected[0]?.route).toEqual({ page: "observability.metrics" });
	const metrics = locate(frame, "Metrics");
	await t.mockMouse.click(metrics.x, metrics.y);
	await t.renderOnce();
	expect(accepted).toEqual([{ page: "observability.metrics" }]);
	t.renderer.destroy();
});
