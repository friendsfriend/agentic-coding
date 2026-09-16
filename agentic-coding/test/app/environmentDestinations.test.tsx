/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createEffect } from "solid-js";
import {
	requestedCategory,
	viewModeForPath,
	viewPathForMode,
} from "../../packages/devenv/cli/src/tui/destination-sync";
import {
	createAppDetailStore,
	createAppStore,
	type TabType,
} from "../../packages/devenv/cli/src/tui/stores";

// Environments destination pages
// (replace-nested-tabs-with-page-navigation, task 2.2): the embedded feature
// takes its category and nested view from the shell route and reports its own
// destination changes back, so the two never disagree and no inner navigation
// tab row is involved. The translations themselves are the shipped helpers; the
// harness below only proves they compose in the same order the feature runs.

function TestHarness(props: {
	destination: {
		category?: TabType;
		view?: string;
		onChange?: (destination: { category: string; view: string }) => void;
	};
	onReady: (stores: {
		appStore: ReturnType<typeof createAppStore>;
		appDetailStore: ReturnType<typeof createAppDetailStore>;
	}) => void;
}) {
	const appStore = createAppStore();
	const appDetailStore = createAppDetailStore();
	// The feature's own sync: route request → store, store → route report.
	const tabs = () => appStore.tableTabs().map((tab) => tab.id);
	createEffect(() => {
		const category = requestedCategory(props.destination.category, tabs());
		if (category && category !== appStore.activeTab())
			appStore.setActiveTab(category);
		if (props.destination.view === undefined) return;
		const wanted = viewModeForPath(props.destination.view);
		if (wanted !== appStore.viewMode()) appStore.resetViewStack(wanted);
	});
	createEffect(() => {
		props.destination.onChange?.({
			category: appStore.activeTab(),
			view: viewPathForMode(appStore.viewMode()),
		});
	});
	props.onReady({ appStore, appDetailStore });
	return <text>{`${appStore.activeTab()}:${appStore.viewMode()}`}</text>;
}

test("the shipped destination helpers translate both directions", () => {
	expect(viewPathForMode("table")).toBe("");
	expect(viewPathForMode("jobs")).toBe("changeRequestDetail.jobs");
	expect(viewPathForMode("appDetail")).toBe("appDetail");
	expect(viewModeForPath("changeRequestDetail.changedFiles")).toBe(
		"changedFiles",
	);
	expect(viewModeForPath("appDetail")).toBe("appDetail");
	expect(viewModeForPath(undefined)).toBe("table");
	expect(viewModeForPath("")).toBe("table");
	// A category the store does not have is not requested.
	expect(requestedCategory("libraries", ["applications", "libraries"])).toBe(
		"libraries",
	);
	expect(requestedCategory("kubernetes", ["applications"])).toBeUndefined();
	expect(requestedCategory(undefined, ["applications"])).toBeUndefined();
});

test("the route names the category and nested view; the feature reports changes back", async () => {
	let stores:
		| {
				appStore: ReturnType<typeof createAppStore>;
				appDetailStore: ReturnType<typeof createAppDetailStore>;
		  }
		| undefined;
	const reported: Array<{ category: string; view: string }> = [];
	// The shell updates its route from the feature's report, as the real shell
	// does; otherwise the route would keep re-requesting the old destination.
	const destination: {
		category?: TabType;
		view?: string;
		onChange: (change: { category: string; view: string }) => void;
	} = {
		category: "libraries",
		view: "changeRequestDetail.jobs",
		onChange: (change) => {
			reported.push(change);
			destination.category = change.category as TabType;
			destination.view = change.view;
		},
	};
	const t = await testRender(
		() => (
			<TestHarness
				destination={destination}
				onReady={(ready) => {
					stores = ready;
				}}
			/>
		),
		{ width: 60, height: 5 },
	);
	await t.renderOnce();
	expect(stores).toBeDefined();
	// The route request reached the store: category and the nested view path.
	expect(stores?.appStore.activeTab()).toBe("libraries");
	expect(stores?.appStore.viewMode()).toBe("jobs");
	// The feature reported its destination back so the route can follow.
	expect(reported.at(-1)).toEqual({
		category: "libraries",
		view: "changeRequestDetail.jobs",
	});

	// A feature-side move (the table selection opening the detail view) is
	// reported as the parent view path, not as a stale one.
	stores?.appStore.resetViewStack("appDetail");
	await t.renderOnce();
	expect(reported.at(-1)).toEqual({ category: "libraries", view: "appDetail" });

	// Returning to the table reports the category destination (view ""), which
	// is the shell's category page.
	stores?.appStore.resetViewStack("table");
	await t.renderOnce();
	expect(reported.at(-1)).toEqual({ category: "libraries", view: "" });
	t.renderer.destroy();
});
