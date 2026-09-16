import { describe, expect, test } from "bun:test";
import {
	back,
	breadcrumb,
	canGoBack,
	createPageNavigation,
	createRouterState,
	currentRoute,
	dropViewState,
	isSameLocation,
	navigate,
	PAGES,
	pageLabel,
	parentRoute,
	pickerDestinations,
	resolveAvailable,
	resourceRoute,
	routeKey,
	setViewState,
	viewState,
} from "../../src/tui/shared/routes";

// Page routing (replace-nested-tabs-with-page-navigation, task 1.2): typed
// identities, structural parents, chronological Back across any number of
// feature boundaries, and route-keyed view state.

describe("page routes: structural hierarchy", () => {
	test("parent chain derives from the catalog, not from history", () => {
		const application = resourceRoute("applications", "app-1");
		const changedFiles = resourceRoute(
			"applications",
			"app-1",
			"changeRequestDetail.changedFiles",
		);
		expect(parentRoute(application)).toEqual({
			page: "environments.applications",
		});
		expect(parentRoute(changedFiles)).toEqual(
			resourceRoute("applications", "app-1", "changeRequestDetail"),
		);
		expect(breadcrumb(changedFiles).map((route) => route.page)).toEqual([
			"home",
			"environments",
			"environments.applications",
			"environments.resource",
			"environments.resource",
			"environments.resource",
		]);
	});

	test("every page reaches Home and Home has no parent", () => {
		for (const page of Object.keys(PAGES) as Array<keyof typeof PAGES>) {
			const route = { page };
			const chain = breadcrumb(route);
			expect(chain[0]?.page).toBe("home");
			if (page !== "home") expect(chain.length).toBeGreaterThan(1);
		}
		expect(parentRoute({ page: "home" })).toBeUndefined();
	});

	test("span parents to its trace, which parents to the traces list", () => {
		const span = {
			page: "observability.traces.tree.span" as const,
			resourceId: "span-9",
			params: { traceId: "trace-4" },
		};
		expect(parentRoute(span)).toEqual({
			page: "observability.traces.tree",
			resourceId: "trace-4",
		});
		const trace = parentRoute(span);
		expect(trace && parentRoute(trace)).toEqual({
			page: "observability.traces",
		});
	});

	test("breadcrumbs read as locations, and the picker lists registered pages", () => {
		expect(
			breadcrumb(resourceRoute("applications", "app-1", "jobs")).map(pageLabel),
		).toEqual([
			"Home",
			"Environments",
			"Applications",
			// The resource root is named by the identity it renders.
			"app-1",
			"Jobs",
		]);
		const picker = pickerDestinations();
		expect(picker).toContainEqual({
			page: "observability.metrics",
			label: "Metrics",
		});
		expect(picker.some((entry) => entry.page === "wiki")).toBe(true);
		// Resource destinations need an identity, so they are not picker rows.
		expect(picker.some((entry) => entry.page === "environments.resource")).toBe(
			false,
		);
	});
});

describe("page routes: chronological history", () => {
	test("back unwinds multiple feature boundaries in order", () => {
		let state = createRouterState({ page: "home" });
		state = navigate(state, resourceRoute("applications", "app-1"));
		state = navigate(state, {
			page: "observability.traces.tree",
			resourceId: "trace-4",
		});
		state = navigate(state, { page: "wiki" });
		expect(currentRoute(state).page).toBe("wiki");

		state = back(state);
		expect(currentRoute(state)).toEqual({
			page: "observability.traces.tree",
			resourceId: "trace-4",
		});
		state = back(state);
		expect(currentRoute(state)).toEqual(resourceRoute("applications", "app-1"));
		state = back(state);
		expect(currentRoute(state).page).toBe("home");
		expect(canGoBack(state)).toBe(false);
		// Home has no parent: back at the first location is a no-op.
		expect(back(state)).toBe(state);
	});

	test("repeated visits are recorded once per move", () => {
		const applications = { page: "environments.applications" as const };
		const traces = { page: "observability.traces" as const };
		let state = createRouterState(applications);
		state = navigate(state, traces);
		state = navigate(state, applications);
		state = navigate(state, applications);
		state = navigate(state, traces);
		expect(state.history.map((route) => route.page)).toEqual([
			"environments.applications",
			"observability.traces",
			"environments.applications",
		]);
		expect(back(state).current).toEqual(applications);
	});

	test("filter and view-state edits are not location moves", () => {
		const traces = { page: "observability.traces" as const };
		let state = createRouterState(traces);
		state = setViewState(state, traces, { query: "checkout", sort: "latency" });
		state = setViewState(state, traces, {
			query: "checkouts",
			sort: "latency",
		});
		expect(state.history).toHaveLength(0);
		expect(viewState<{ query: string }>(state, traces)?.query).toBe(
			"checkouts",
		);
	});

	test("view state is keyed per location and survives leaving and returning", () => {
		const application = resourceRoute("applications", "app-1", "jobs");
		const other = resourceRoute("applications", "app-2");
		let state = createRouterState({ page: "environments.applications" });
		state = setViewState(state, application, { scroll: 12, filter: "queued" });
		state = setViewState(state, other, { scroll: 3 });
		state = navigate(state, application);
		state = navigate(state, { page: "wiki" });
		state = back(state);
		expect(viewState<{ scroll: number }>(state, application)?.scroll).toBe(12);
		expect(viewState<{ scroll: number }>(state, other)?.scroll).toBe(3);
		expect(
			viewState<{ scroll: number }>(state, { page: "wiki" }),
		).toBeUndefined();
	});

	test("dropping a deleted resource's state leaves other locations intact", () => {
		const deleted = resourceRoute("applications", "app-1");
		const kept = resourceRoute("applications", "app-2");
		let state = createRouterState({ page: "environments.applications" });
		state = setViewState(state, deleted, { draft: "unsubmitted" });
		state = setViewState(state, kept, { draft: "kept" });
		state = dropViewState(state, deleted);
		expect(viewState(state, deleted)).toBeUndefined();
		expect(viewState<{ draft: string }>(state, kept)?.draft).toBe("kept");
		expect(dropViewState(state, deleted)).toBe(state);
	});
});

describe("page routes: unavailable resources", () => {
	test("a deleted resource resolves to its nearest valid ancestor and reports it", () => {
		const requested = resourceRoute(
			"applications",
			"app-1",
			"changeRequestDetail",
		);
		const resolution = resolveAvailable(
			requested,
			(route) => route.page === "environments.applications",
		);
		expect(resolution.route).toEqual({ page: "environments.applications" });
		expect(resolution.unavailable).toEqual(requested);
	});

	test("an available location resolves to itself without a diagnostic", () => {
		const requested = resourceRoute("libraries", "lib-1");
		const resolution = resolveAvailable(requested, () => true);
		expect(resolution.route).toEqual(requested);
		expect(resolution.unavailable).toBeUndefined();
	});

	test("availability is checked against route identity, not list position", () => {
		const requested = resourceRoute("applications", "app-9", "jobs");
		const resolution = resolveAvailable(
			requested,
			(route) =>
				route.resourceId === "app-9" &&
				(route.params?.view ?? "detail") === "detail",
		);
		// The resource still exists, only its child view is gone: fall back to the
		// resource itself and keep the diagnostic attached to the request.
		expect(resolution.route).toEqual(resourceRoute("applications", "app-9"));
		expect(resolution.unavailable).toEqual(requested);
	});
});

describe("page routes: identity and reactive wrapper", () => {
	test("route keys distinguish params and resource identities", () => {
		expect(routeKey(resourceRoute("applications", "a", "jobs"))).not.toBe(
			routeKey(resourceRoute("applications", "a", "tests")),
		);
		expect(routeKey(resourceRoute("applications", "a"))).not.toBe(
			routeKey(resourceRoute("applications", "b")),
		);
		expect(isSameLocation({ page: "wiki" }, { page: "wiki" })).toBe(true);
		expect(isSameLocation({ page: "wiki" }, { page: "workflows" })).toBe(false);
	});

	test("the reactive wrapper exposes navigate, back and parent", () => {
		const nav = createPageNavigation(
			createRouterState({ page: "environments.applications" }),
		);
		nav.navigate(resourceRoute("applications", "app-1"));
		expect(nav.feature()).toBe("environments");
		expect(nav.canBack()).toBe(true);
		nav.goToParent();
		expect(nav.current()).toEqual({ page: "environments.applications" });
		nav.setViewState(nav.current(), { scroll: 7 });
		expect(nav.viewState<{ scroll: number }>(nav.current())?.scroll).toBe(7);
		nav.back();
		// Parent used `navigate`, so Back returns to the location it left.
		expect(nav.current()).toEqual(resourceRoute("applications", "app-1"));
		expect(nav.canBack()).toBe(true);
	});
});
