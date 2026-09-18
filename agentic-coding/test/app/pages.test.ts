import { describe, expect, test } from "bun:test";
import { footerKeybinds } from "@ui";
import {
	breadcrumbSegments,
	breadcrumbWidth,
} from "../../src/tui/shared/navigation/breadcrumbs";
import {
	categoryDestinations,
	filterPickerEntries,
	homeDestinations,
	observabilityDestinations,
	pickerEntries,
} from "../../src/tui/shared/navigation/destinations";
import {
	destinationPageKeybindCatalog,
	locationPickerKeybindCatalog,
} from "../../src/tui/shared/navigation/keybinds";
import {
	breadcrumb,
	type Route,
	resourceRoute,
} from "../../src/tui/shared/routes";

// Home, category pages, breadcrumbs and the location picker
// (replace-nested-tabs-with-page-navigation, task 2.1).
//
// The full application offers exactly Environments, Observability, Wiki and
// Settings: workflow creation is contextual and there is no Workflows
// destination, list, history or reopen entry
// (launch-workflows-from-project-and-wiki-pages, task 2.4).

const FULL_SURFACE = {
	environments: true,
	tracesOnly: false,
	wiki: true,
	settings: true,
};

describe("home and category destinations", () => {
	test("home offers exactly Environments, Observability, Wiki and Settings", () => {
		expect(homeDestinations(FULL_SURFACE).map((entry) => entry.label)).toEqual([
			"Environments",
			"Observability",
			"Wiki",
			"Settings",
		]);
	});

	test("a surface without the environment backend omits Environments only", () => {
		const entries = homeDestinations({
			environments: false,
			tracesOnly: false,
			wiki: true,
			settings: true,
		});
		expect(entries.map((entry) => entry.id)).toEqual([
			"observability",
			"wiki",
			"settings",
		]);
	});

	test("environments exposes the five categories as pages", () => {
		expect(
			categoryDestinations("environments", FULL_SURFACE).map(
				(entry) => entry.id,
			),
		).toEqual([
			"environments.applications",
			"environments.libraries",
			"environments.infrastructure",
			"environments.scripts",
			"environments.kubernetes",
		]);
	});

	test("restricted telemetry keeps Traces and excludes the other views", () => {
		const restricted = observabilityDestinations({
			environments: true,
			tracesOnly: true,
			wiki: true,
			settings: true,
		});
		expect(restricted.map((entry) => entry.id)).toEqual([
			"observability.traces",
		]);
		const picker = pickerEntries({
			environments: true,
			tracesOnly: true,
			wiki: true,
			settings: true,
		});
		expect(picker.some((entry) => entry.id === "observability.metrics")).toBe(
			false,
		);
		// Wiki stays reachable when observability views are restricted.
		expect(picker.some((entry) => entry.id === "wiki")).toBe(true);
	});

	test("the picker searches labels, descriptions and groups", () => {
		const entries = pickerEntries(FULL_SURFACE);
		expect(
			filterPickerEntries(entries, "metr").map((entry) => entry.id),
		).toEqual([
			// The label match outranks the description-only matches; the requested
			// order stays stable within a rank.
			"observability.metrics",
			"settings.backend",
			"observability",
		]);
		expect(
			filterPickerEntries(entries, "applications").map((entry) => entry.id),
		).toEqual([
			// The category page outranks Environments, which only describes it.
			"environments.applications",
			"environments",
			// Settings describes its project section with the same word.
			"settings.projects",
		]);
		expect(filterPickerEntries(entries, "  ")).toHaveLength(entries.length);
		expect(filterPickerEntries(entries, "nothing-here")).toEqual([]);
	});

	test("no workflow list, history or reopen destination is offered anywhere", () => {
		const entries = pickerEntries(FULL_SURFACE);
		for (const entry of entries)
			expect(entry.id.startsWith("workflows")).toBe(false);
		expect(entries.some((entry) => entry.label === "Workflows")).toBe(false);
	});

	test("in-memory identities can be added without a global resource scan", () => {
		const extra = [
			{
				id: "resource:app-1",
				label: "checkout",
				group: "Recent",
				route: resourceRoute("applications", "app-1"),
			},
		];
		const entries = pickerEntries(
			{ ...FULL_SURFACE, environments: false },
			extra,
		);
		expect(entries).toContainEqual(extra[0]);
	});
});

describe("breadcrumb layout", () => {
	const routes: Route[] = breadcrumb(
		resourceRoute("applications", "app-1", "jobs", { kind: "applications" }),
	);

	test("wide rows render every structural ancestor", () => {
		const segments = breadcrumbSegments(routes, 120, routes.length - 1);
		expect(segments.map((segment) => segment.label)).toEqual([
			"Home",
			"Environments",
			"Applications",
			"app-1",
			"Jobs",
		]);
		expect(segments.every((segment) => segment.collapsed !== true)).toBe(true);
		expect(segments.at(-1)?.focused).toBe(true);
	});

	test("narrow rows collapse the middle and keep the current location", () => {
		const segments = breadcrumbSegments(routes, 30, routes.length - 1);
		expect(segments.map((segment) => segment.label)).toEqual([
			"Home",
			"…",
			"Jobs",
		]);
		const placeholder = segments[1];
		expect(placeholder.collapsed).toBe(true);
		expect(placeholder.collapsedRange).toEqual({ start: 1, end: 3 });
		expect(placeholder.route).toBeUndefined();
		expect(breadcrumbWidth(segments)).toBeLessThanOrEqual(30);
	});

	test("a focused hidden ancestor stays readable in the collapsed slot", () => {
		const segments = breadcrumbSegments(routes, 30, 2);
		expect(segments[1].label).toBe("Applications");
		expect(segments[1].focused).toBe(true);
		expect(segments[1].collapsed).toBe(true);
	});

	test("a single location renders one segment and copies a focused ancestor", () => {
		expect(
			breadcrumbSegments([{ page: "home" }], 10, 0).map((s) => s.label),
		).toEqual(["Home"]);
		// Mid-row ancestors still copy when the collapse hides only one middle item.
		const short = breadcrumbSegments(
			[
				{ page: "home" },
				{ page: "observability" },
				{ page: "observability.logs" },
			],
			20,
			1,
		);
		expect(short[1].label).toBe("Observability");
	});
});

describe("page keybind catalogs", () => {
	test("destination pages advertise the picker, help and quit, not tab keys", () => {
		const catalog = destinationPageKeybindCatalog();
		const keys = catalog.flatMap((section) =>
			section.keybinds.map((keybind) => keybind.key),
		);
		expect(keys).toContain("Ctrl+P");
		expect(keys).toContain("?");
		expect(keys.some((key) => /^[0-9]/.test(key))).toBe(false);
		// Pure navigation stays in the catalog but out of the footer; the page's own
		// action (`Enter` opens the highlighted destination) is advertised, so a
		// destination page never looks like it has no keys left.
		const navigation = catalog[0].keybinds;
		expect(
			navigation
				.filter((keybind) => keybind.action !== "open destination")
				.every((keybind) => keybind.standard),
		).toBe(true);
		expect(footerKeybinds(catalog).map((keybind) => keybind.action)).toContain(
			"open destination",
		);
	});

	test("the picker catalog documents search, open and close", () => {
		const keys = locationPickerKeybindCatalog().flatMap((section) =>
			section.keybinds.map((keybind) => keybind.action),
		);
		expect(keys).toContain("go to location");
		expect(keys).toContain("close picker");
	});
});
