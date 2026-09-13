// Typed shell routing for the unified feature shell
// (compose-unified-feature-shell, task 2.2). A route carries the feature, the
// feature-local view/panel, the required resource identity the view renders,
// and an opaque feature-local selection/draft payload. Feature stacks preserve
// history and drafts while a feature is hidden, and a cross-feature navigation
// records its origin so `back()` can return to the exact originating resource.
//
// The reducers are framework-agnostic (pure data) so they can be unit-tested
// without a renderer. `createFeatureNavigation` adds a Solid-reactive wrapper
// for the shell component.
import { createSignal } from "solid-js";

/** The four top-level features of the unified shell. */
export type FeatureId = "environments" | "workflows" | "observability" | "wiki";

/** A route identity: feature + view + required resource + preserved payload. */
export interface FeatureRoute {
	feature: FeatureId;
	/** Feature-local view or panel discriminator (e.g. "detail", "traces"). */
	view: string;
	/** Required resource identity for a detail route; absent for list roots. */
	resourceId?: string;
	/** Opaque feature-local selection/search/draft, preserved across hide/show. */
	payload?: unknown;
}

/** Where the user came from before a cross-feature navigation. */
export interface RouteOrigin {
	feature: FeatureId;
	route: FeatureRoute;
}

export interface FeatureRouterState {
	active: FeatureId;
	/** Per-feature view stack; index 0 is the feature root. Never empty. */
	stacks: Record<FeatureId, FeatureRoute[]>;
	origin?: RouteOrigin;
}

function isSameRoute(a: FeatureRoute, b: FeatureRoute): boolean {
	return (
		a.feature === b.feature &&
		a.view === b.view &&
		a.resourceId === b.resourceId
	);
}

export function createFeatureRouterState(
	active: FeatureId,
	root: FeatureRoute,
): FeatureRouterState {
	const stacks = {
		environments: [rootFor("environments")],
		workflows: [rootFor("workflows")],
		observability: [rootFor("observability")],
		wiki: [rootFor("wiki")],
	} satisfies Record<FeatureId, FeatureRoute[]>;
	stacks[active] = [root];
	return { active, stacks };
}

function rootFor(feature: FeatureId): FeatureRoute {
	switch (feature) {
		case "environments":
			return { feature, view: "applications" };
		case "workflows":
			return { feature, view: "home" };
		case "observability":
			return { feature, view: "traces" };
		case "wiki":
			return { feature, view: "browse" };
	}
}

/** The route the active feature is currently showing. */
export function currentRoute(state: FeatureRouterState): FeatureRoute {
	const stack = state.stacks[state.active];
	const route = stack[stack.length - 1];
	if (!route) throw new Error("feature router stack must never be empty");
	return route;
}

/**
 * Navigate. A route in the active feature pushes onto that feature's stack (or
 * replaces an identical top). A route in another feature records the current
 * route as origin, activates the target feature, and pushes the route there.
 */
export function navigate(
	state: FeatureRouterState,
	route: FeatureRoute,
): FeatureRouterState {
	const stack = state.stacks[route.feature];
	const top = stack[stack.length - 1];
	const nextStack =
		top && isSameRoute(top, route)
			? [...stack.slice(0, -1), route]
			: [...stack, route];
	const stacks = { ...state.stacks, [route.feature]: nextStack };
	if (route.feature === state.active) {
		return { ...state, stacks };
	}
	return {
		active: route.feature,
		stacks,
		origin: { feature: state.active, route: currentRoute(state) },
	};
}

/**
 * Switch the active feature without recording history: the target feature
 * resumes at whatever route it last showed (its stack is preserved), so drafts
 * and selections survive a hide/show cycle.
 */
export function switchFeature(
	state: FeatureRouterState,
	feature: FeatureId,
): FeatureRouterState {
	if (feature === state.active) return state;
	return { ...state, active: feature };
}

/**
 * Replace the top route of `route.feature` without recording history or
 * growing the stack. Sibling navigation (observability sub-tabs, in-feature
 * panel changes) uses this so `back()` walks history, not every sibling.
 */
export function setRoute(
	state: FeatureRouterState,
	route: FeatureRoute,
): FeatureRouterState {
	const stack = state.stacks[route.feature];
	const next = stack.length === 0 ? [route] : [...stack.slice(0, -1), route];
	return { ...state, stacks: { ...state.stacks, [route.feature]: next } };
}

/**
 * Go back. Pops the active feature's own stack when it has history; otherwise
 * restores the recorded cross-feature origin. Returns the unchanged state when
 * there is nowhere to go.
 */
export function back(state: FeatureRouterState): FeatureRouterState {
	const stack = state.stacks[state.active];
	if (stack.length > 1) {
		return {
			...state,
			stacks: { ...state.stacks, [state.active]: stack.slice(0, -1) },
		};
	}
	if (state.origin) {
		return {
			active: state.origin.feature,
			stacks: state.stacks,
			origin: undefined,
		};
	}
	return state;
}

/** Drop the recorded origin without navigating (used when the shell closes the
 * cross-feature flow explicitly rather than via `back`). */
export function clearOrigin(state: FeatureRouterState): FeatureRouterState {
	return state.origin === undefined ? state : { ...state, origin: undefined };
}

/** Solid-reactive shell router: the component reads `route()`/`active()` and
 * dispatches `navigate`/`switchFeature`/`back`. */
export function createFeatureNavigation(initial: FeatureRouterState) {
	const [state, setState] = createSignal(initial);
	return {
		state,
		active: () => state().active,
		route: () => currentRoute(state()),
		navigate: (route: FeatureRoute) => setState((s) => navigate(s, route)),
		setRoute: (route: FeatureRoute) => setState((s) => setRoute(s, route)),
		switchFeature: (feature: FeatureId) =>
			setState((s) => switchFeature(s, feature)),
		back: () => setState((s) => back(s)),
		clearOrigin: () => setState((s) => clearOrigin(s)),
	};
}
