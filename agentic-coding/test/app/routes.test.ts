import { describe, expect, test } from "bun:test";
import {
	back,
	clearOrigin,
	createFeatureRouterState,
	currentRoute,
	navigate,
	setRoute,
	switchFeature,
} from "../../src/tui/shared/routes";

describe("unified feature shell routes (compose-unified-feature-shell)", () => {
	test("starts on the supplied feature root with a non-empty stack", () => {
		const state = createFeatureRouterState("observability", {
			feature: "observability",
			view: "traces",
		});
		expect(state.active).toBe("observability");
		expect(currentRoute(state)).toEqual({
			feature: "observability",
			view: "traces",
		});
	});

	test("pushes a feature-local view and back restores the previous route", () => {
		const root = createFeatureRouterState("workflows", {
			feature: "workflows",
			view: "home",
		});
		const detail = navigate(root, {
			feature: "workflows",
			view: "detail",
			resourceId: "compose-unified-feature-shell",
		});
		expect(currentRoute(detail)).toEqual({
			feature: "workflows",
			view: "detail",
			resourceId: "compose-unified-feature-shell",
		});
		expect(currentRoute(back(detail))).toEqual({
			feature: "workflows",
			view: "home",
		});
	});

	test("an identical top route is replaced, not duplicated", () => {
		const root = createFeatureRouterState("wiki", {
			feature: "wiki",
			view: "browse",
		});
		const note = { feature: "wiki", view: "note", resourceId: "a.md" } as const;
		const once = navigate(root, note);
		const twice = navigate(once, { ...note, payload: { cursor: 4 } });
		expect(twice.stacks.wiki).toHaveLength(2);
		expect(currentRoute(twice)).toEqual({
			feature: "wiki",
			view: "note",
			resourceId: "a.md",
			payload: { cursor: 4 },
		});
	});

	test("cross-feature navigation records origin and back restores the originating resource", () => {
		const workflows = navigate(
			createFeatureRouterState("workflows", {
				feature: "workflows",
				view: "home",
			}),
			{ feature: "workflows", view: "detail", resourceId: "wf-1" },
		);
		const telemetry = navigate(workflows, {
			feature: "observability",
			view: "traces",
		});
		expect(telemetry.active).toBe("observability");
		expect(telemetry.origin).toEqual({
			feature: "workflows",
			route: {
				feature: "workflows",
				view: "detail",
				resourceId: "wf-1",
			},
		});
		const restored = back(telemetry);
		expect(restored.active).toBe("workflows");
		expect(restored.origin).toBeUndefined();
		expect(currentRoute(restored)).toEqual({
			feature: "workflows",
			view: "detail",
			resourceId: "wf-1",
		});
	});

	test("back prefers feature-local history before the cross-feature origin", () => {
		const workflows = navigate(
			createFeatureRouterState("workflows", {
				feature: "workflows",
				view: "home",
			}),
			{ feature: "workflows", view: "detail", resourceId: "wf-1" },
		);
		const telemetry = navigate(workflows, {
			feature: "observability",
			view: "traces",
		});
		const span = navigate(telemetry, {
			feature: "observability",
			view: "span",
			resourceId: "span-9",
		});
		// First back pops the observability stack...
		const detail = back(span);
		expect(currentRoute(detail)).toEqual({
			feature: "observability",
			view: "traces",
		});
		// ...and the next back crosses back to the originating workflow detail.
		const restored = back(detail);
		expect(restored.active).toBe("workflows");
		expect(currentRoute(restored).resourceId).toBe("wf-1");
	});

	test("switching features preserves each feature's stack and draft payload", () => {
		const workflows = navigate(
			createFeatureRouterState("workflows", {
				feature: "workflows",
				view: "home",
			}),
			{
				feature: "workflows",
				view: "detail",
				resourceId: "wf-1",
				payload: { draft: "half-typed review" },
			},
		);
		const environments = switchFeature(workflows, "environments");
		expect(environments.active).toBe("environments");
		const restored = switchFeature(environments, "workflows");
		expect(currentRoute(restored)).toEqual({
			feature: "workflows",
			view: "detail",
			resourceId: "wf-1",
			payload: { draft: "half-typed review" },
		});
	});

	test("setRoute replaces the top route without growing per-feature history", () => {
		const root = createFeatureRouterState("observability", {
			feature: "observability",
			view: "traces",
		});
		const replaced = setRoute(root, {
			feature: "observability",
			view: "logs",
		});
		expect(replaced.stacks.observability).toHaveLength(1);
		expect(currentRoute(replaced).view).toBe("logs");
	});

	test("back at a feature root with no origin is a no-op", () => {
		const root = createFeatureRouterState("environments", {
			feature: "environments",
			view: "applications",
		});
		expect(back(root)).toBe(root);
	});

	test("clearOrigin drops the recorded origin without navigating", () => {
		const telemetry = navigate(
			createFeatureRouterState("workflows", {
				feature: "workflows",
				view: "home",
			}),
			{ feature: "observability", view: "logs" },
		);
		const cleared = clearOrigin(telemetry);
		expect(cleared.active).toBe("observability");
		expect(cleared.origin).toBeUndefined();
		// With the origin gone, back only pops local history and never leaves the feature.
		const popped = back(cleared);
		expect(popped.active).toBe("observability");
		expect(currentRoute(popped).view).toBe("traces");
		expect(popped.origin).toBeUndefined();
	});
});
