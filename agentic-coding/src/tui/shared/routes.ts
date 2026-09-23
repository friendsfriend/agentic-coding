// Typed page routing for the unified feature shell
// (replace-nested-tabs-with-page-navigation, task 1.2).
//
// One location model replaces per-feature stacks plus a single cross-feature
// origin. A route is a typed page identity (plus an optional resource identity
// and typed params); the structural parent of a page is derived from the page
// catalog, never from history; Back is chronological across every feature
// boundary; and per-route view state (selection, filters, drafts) is keyed by
// route identity so returning to a page restores it.
//
// Pure data and pure functions: no renderer, no stores, no `effect()` wrapper.
import { createSignal } from "solid-js";

/**
 * Top-level features of the unified shell. `workflows` no longer owns a Home
 * destination (launch-workflows-from-project-and-wiki-pages): it names the
 * Herdr-launched per-workflow dashboard pane only, which sits outside the full
 * application's page hierarchy.
 */
export type FeatureId = "environments" | "workflows" | "observability" | "wiki";

/** Base view of a resource page (its own detail view). */
export const RESOURCE_BASE_VIEW = "detail";

export type PageId =
	| "home"
	| "settings"
	| "settings.appearance"
	| "settings.agents"
	| "settings.providers"
	| "environments"
	| "environments.applications"
	| "environments.libraries"
	| "environments.infrastructure"
	| "environments.scripts"
	| "environments.kubernetes"
	| "environments.resource"
	| "observability"
	| "observability.traces"
	| "observability.traces.tree"
	| "observability.traces.tree.span"
	| "observability.metrics"
	| "observability.metrics.detail"
	| "observability.logs"
	| "observability.logs.detail"
	| "observability.topology"
	| "observability.topology.service"
	| "wiki"
	| "wiki.note"
	| "workflows.detail";

/** A location: page identity + required resource identity + typed params. */
export interface Route {
	page: PageId;
	/** Identity the page renders (application id, trace id, concept id, …). */
	resourceId?: string;
	/** Page-local discriminators (resource kind, nested view path, …). */
	params?: Readonly<Record<string, string>>;
}

export interface PageDef {
	label: string;
	/** Owning feature; absent for chrome pages that own no service body. */
	feature?: FeatureId;
	/** Structural parent. Derived from the catalog, never from history. */
	parent?: (route: Route) => Route | undefined;
	/** Destination is listed in the location picker. */
	picker?: boolean;
	/** Page requires a resource identity to render. */
	requiresResource?: boolean;
}

/** Settings sections, in listing order (centralize-application-settings). */
export const SETTINGS_SECTIONS = ["appearance", "agents", "providers"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Human labels for the Settings sections, in listing order. */
export const SETTINGS_SECTION_LABELS: Readonly<
	Record<SettingsSection, string>
> = {
	appearance: "Appearance",
	agents: "Agent Presets",
	providers: "Providers/credentials",
};

/** One-line description of what each Settings section edits and where. */
export const SETTINGS_SECTION_DESCRIPTIONS: Readonly<
	Record<SettingsSection, string>
> = {
	appearance: "Theme and client-local UI preferences",
	agents: "Model profiles and configuration presets",
	providers: "Git providers and protected credentials",
};

/** The page identity of one Settings section. */
export function settingsSectionPage(section: SettingsSection): PageId {
	return `settings.${section}` as PageId;
}

/** The Settings section a page renders, or undefined for any other page. */
export function settingsSectionOfPage(
	page: PageId,
): SettingsSection | undefined {
	if (!page.startsWith("settings.")) return undefined;
	const section = page.slice("settings.".length) as SettingsSection;
	return (SETTINGS_SECTIONS as readonly string[]).includes(section)
		? section
		: undefined;
}

/** Environment categories, in picker order. */
export const ENVIRONMENT_CATEGORIES = [
	"applications",
	"libraries",
	"infrastructure",
	"scripts",
	"kubernetes",
] as const;
export type EnvironmentCategory = (typeof ENVIRONMENT_CATEGORIES)[number];

/** Observability destinations, in picker order. */
export const OBSERVABILITY_VIEWS = [
	"traces",
	"metrics",
	"logs",
	"topology",
] as const;

/** Human labels for nested resource view paths (mirrors `appStore.viewMode`). */
export const VIEW_LABELS: Readonly<Record<string, string>> = {
	detail: "Detail",
	appDetail: "Detail",
	actions: "Actions",
	issues: "Issues",
	issueDetail: "Issue",
	issueTimeline: "Timeline",
	references: "References",
	changeRequests: "Change requests",
	changeRequestDetail: "Change request",
	changeRequestLinkedIssues: "Linked issues",
	changedFiles: "Changed files",
	discussionsView: "Discussions",
	testResults: "Test results",
	jobs: "Jobs",
	logs: "Logs",
	providers: "Providers",
	sshPicker: "SSH targets",
	agentView: "Agent",
};

const environmentsParent = (route: Route): Route => {
	const view = route.params?.view ?? RESOURCE_BASE_VIEW;
	const parentView = viewParent(view);
	if (parentView)
		return { ...route, params: { ...route.params, view: parentView } };
	const kind = route.params?.kind;
	return kind && isEnvironmentCategory(kind)
		? { page: `environments.${kind}` }
		: { page: "environments" };
};

/** The page catalog. Every page's parent chain terminates at `home`. */
export const PAGES: Readonly<Record<PageId, PageDef>> = {
	home: { label: "Home" },
	// Settings is a Home destination: one configuration surface for every
	// supported application setting (centralize-application-settings).
	settings: {
		label: "Settings",
		parent: () => ({ page: "home" }),
		picker: true,
	},
	"settings.appearance": {
		label: SETTINGS_SECTION_LABELS.appearance,
		parent: () => ({ page: "settings" }),
		picker: true,
	},
	"settings.agents": {
		label: SETTINGS_SECTION_LABELS.agents,
		parent: () => ({ page: "settings" }),
		picker: true,
	},
	"settings.providers": {
		label: SETTINGS_SECTION_LABELS.providers,
		parent: () => ({ page: "settings" }),
		picker: true,
	},
	environments: {
		label: "Environments",
		feature: "environments",
		parent: () => ({ page: "home" }),
		picker: true,
	},
	"environments.applications": {
		label: "Applications",
		feature: "environments",
		parent: () => ({ page: "environments" }),
		picker: true,
	},
	"environments.libraries": {
		label: "Libraries",
		feature: "environments",
		parent: () => ({ page: "environments" }),
		picker: true,
	},
	"environments.infrastructure": {
		label: "Infrastructure",
		feature: "environments",
		parent: () => ({ page: "environments" }),
		picker: true,
	},
	"environments.scripts": {
		label: "Scripts",
		feature: "environments",
		parent: () => ({ page: "environments" }),
		picker: true,
	},
	"environments.kubernetes": {
		label: "Kubernetes",
		feature: "environments",
		parent: () => ({ page: "environments" }),
		picker: true,
	},
	"environments.resource": {
		label: "Resource",
		feature: "environments",
		parent: environmentsParent,
		requiresResource: true,
	},
	observability: {
		label: "Observability",
		feature: "observability",
		parent: () => ({ page: "home" }),
		picker: true,
	},
	"observability.traces": {
		label: "Traces",
		feature: "observability",
		parent: () => ({ page: "observability" }),
		picker: true,
	},
	"observability.traces.tree": {
		label: "Trace",
		feature: "observability",
		// The tree identity lives in the route's resourceId; the list page is a
		// different location and must not inherit the tree's params.
		parent: () => ({ page: "observability.traces" }),
		requiresResource: true,
	},
	"observability.traces.tree.span": {
		label: "Span",
		feature: "observability",
		parent: (route) => ({
			page: "observability.traces.tree",
			resourceId: route.params?.traceId,
		}),
		requiresResource: true,
	},
	"observability.metrics": {
		label: "Metrics",
		feature: "observability",
		parent: () => ({ page: "observability" }),
		picker: true,
	},
	"observability.metrics.detail": {
		label: "Metric",
		feature: "observability",
		parent: () => ({ page: "observability.metrics" }),
		requiresResource: true,
	},
	"observability.logs": {
		label: "Logs",
		feature: "observability",
		parent: () => ({ page: "observability" }),
		picker: true,
	},
	"observability.logs.detail": {
		label: "Log",
		feature: "observability",
		parent: () => ({ page: "observability.logs" }),
		requiresResource: true,
	},
	"observability.topology": {
		label: "Topology",
		feature: "observability",
		parent: () => ({ page: "observability" }),
		picker: true,
	},
	"observability.topology.service": {
		label: "Service",
		feature: "observability",
		parent: () => ({ page: "observability.topology" }),
		requiresResource: true,
	},
	wiki: {
		label: "Wiki",
		feature: "wiki",
		parent: () => ({ page: "home" }),
		picker: true,
	},
	"wiki.note": {
		label: "Note",
		feature: "wiki",
		parent: () => ({ page: "wiki" }),
		requiresResource: true,
	},
	// The per-workflow dashboard pane (Herdr-launched `dash` mode). Not a
	// destination: no workflow list, history or reopen route reaches it, and the
	// location picker never offers it.
	"workflows.detail": {
		label: "Workflow",
		feature: "workflows",
		parent: () => ({ page: "home" }),
		requiresResource: true,
	},
};

export function isEnvironmentCategory(
	value: string,
): value is EnvironmentCategory {
	return (ENVIRONMENT_CATEGORIES as readonly string[]).includes(value);
}

/** Drop the last segment of a nested view path; undefined at the base view. */
export function viewParent(view: string): string | undefined {
	if (view === RESOURCE_BASE_VIEW) return undefined;
	const index = view.lastIndexOf(".");
	if (index === -1) return RESOURCE_BASE_VIEW;
	return view.slice(0, index);
}

/** A resource page (environment application/library or an observability detail). */
export function resourceRoute(
	kind: EnvironmentCategory,
	resourceId: string,
	view: string = RESOURCE_BASE_VIEW,
	extra?: Readonly<Record<string, string>>,
): Route {
	return {
		page: "environments.resource",
		resourceId,
		params: { kind, view, ...extra },
	};
}

/** Longest resource identity a breadcrumb segment renders before it clips. */
export const RESOURCE_LABEL_LIMIT = 24;

/** Clip a resource identity so one long id cannot push the row past the width. */
export function boundedIdentity(identity: string): string {
	return identity.length <= RESOURCE_LABEL_LIMIT
		? identity
		: `${identity.slice(0, RESOURCE_LABEL_LIMIT - 1)}…`;
}

/**
 * Pages named by the resource they render, not by a page title: the breadcrumb
 * segment carries the identity and the page renders no separate title row.
 */
const RESOURCE_NAMED_PAGES: ReadonlySet<PageId> = new Set([
	"environments.resource",
	"observability.traces.tree",
	"observability.traces.tree.span",
	"observability.metrics.detail",
	"observability.logs.detail",
	"wiki.note",
	"workflows.detail",
]);

export function pageLabel(route: Route): string {
	if (route.page === "environments.resource") {
		const view = route.params?.view;
		if (view && view !== RESOURCE_BASE_VIEW) {
			const last = view.slice(view.lastIndexOf(".") + 1);
			return VIEW_LABELS[last] ?? last;
		}
	}
	// A resource page is named by the identity it renders.
	if (RESOURCE_NAMED_PAGES.has(route.page) && route.resourceId)
		return boundedIdentity(route.resourceId);
	return PAGES[route.page].label;
}

export function featureOf(route: Route): FeatureId | undefined {
	return PAGES[route.page].feature;
}

/** Stable identity of a location: page + resource + ordered params. */
export function routeKey(route: Route): string {
	const params = route.params
		? Object.entries(route.params)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, value]) => `${key}=${value}`)
				.join(",")
		: "";
	return `${route.page}|${route.resourceId ?? ""}|${params}`;
}

export function isSameLocation(a: Route, b: Route): boolean {
	return routeKey(a) === routeKey(b);
}

/** Root location of each feature. */
export const FEATURE_ROOTS: Readonly<Record<FeatureId, Route>> = {
	environments: { page: "environments" },
	workflows: { page: "workflows.detail" },
	observability: { page: "observability" },
	wiki: { page: "wiki" },
};

export function featureRoot(feature: FeatureId): Route {
	return FEATURE_ROOTS[feature];
}

/**
 * Last visited location of a feature, or its root when it was never visited.
 * Switching to a feature resumes where it was left; the location is remembered
 * from the route itself, so nothing about it is stored separately.
 */
export function rememberedRoute(state: RouterState, feature: FeatureId): Route {
	const locations = state.current
		? [...state.history, state.current]
		: state.history;
	for (let index = locations.length - 1; index >= 0; index -= 1) {
		const route = locations[index];
		if (featureOf(route) === feature) return route;
	}
	return featureRoot(feature);
}

/** Structural parent page of a route; undefined at Home. */
export function parentRoute(route: Route): Route | undefined {
	return PAGES[route.page].parent?.(route);
}

/** Root-first ancestor chain including the route itself. */
export function breadcrumb(route: Route): Route[] {
	const chain: Route[] = [];
	let cursor: Route | undefined = route;
	const seen = new Set<string>();
	while (cursor && !seen.has(routeKey(cursor))) {
		chain.unshift(cursor);
		seen.add(routeKey(cursor));
		cursor = parentRoute(cursor);
	}
	return chain;
}

/**
 * Project-scoped Settings route: a configured application/library ID selects the
 * scope of the same page, so a shortcut never infers a repository from cwd.
 */
export function settingsRoute(
	section: SettingsSection,
	projectIdent?: string,
): Route {
	return {
		page: settingsSectionPage(section),
		...(projectIdent ? { resourceId: projectIdent } : {}),
	};
}

/** Searchable destinations: one entry per registered picker page. */
export function pickerDestinations(): Array<{ page: PageId; label: string }> {
	return (Object.keys(PAGES) as PageId[])
		.filter((page) => PAGES[page].picker)
		.map((page) => ({ page, label: PAGES[page].label }));
}

export interface RouterState {
	current: Route;
	/** Prior locations, oldest first. Back pops the last entry. */
	history: Route[];
	/** Locations left by Back, oldest first. Forward pops the last entry. */
	forward: Route[];
	/** Route-keyed view state, preserved independently of page visibility. */
	viewState: Record<string, unknown>;
}

export function createRouterState(current: Route): RouterState {
	return { current, history: [], forward: [], viewState: {} };
}

export function currentRoute(state: RouterState): Route {
	return state.current;
}

export function canGoBack(state: RouterState): boolean {
	return state.history.length > 0;
}

/**
 * Navigate to a location. Records the previous location in history unless it is
 * the same location (re-entering where you already are is not a move). A new
 * move invalidates the forward branch, as in a vim jump list.
 */
export function navigate(state: RouterState, route: Route): RouterState {
	if (isSameLocation(state.current, route)) return { ...state, current: route };
	return {
		...state,
		current: route,
		history: [...state.history, state.current],
		forward: [],
	};
}

/**
 * Replace the current location without recording history: used when a requested
 * resource turned out to be unavailable, so the fallback ancestor does not
 * become a second history entry (Back would otherwise return to the dead
 * identity).
 */
export function replace(state: RouterState, route: Route): RouterState {
	if (isSameLocation(state.current, route)) return state;
	return { ...state, current: route };
}

/**
 * Go Back in chronological order. Home has no parent and history never
 * fabricates an entry, so at the first location this is a no-op. The location
 * left behind is remembered for Forward.
 */
export function back(state: RouterState): RouterState {
	const previous = state.history.at(-1);
	if (!previous) return state;
	return {
		...state,
		current: previous,
		history: state.history.slice(0, -1),
		forward: [...state.forward, state.current],
	};
}

/** Whether Back has left a location that Forward can restore. */
export function canGoForward(state: RouterState): boolean {
	return state.forward.length > 0;
}

/**
 * Go Forward in chronological order: restore the location the last Back left,
 * recording the current one in history so Back returns to it again.
 */
export function forward(state: RouterState): RouterState {
	const next = state.forward.at(-1);
	if (!next) return state;
	return {
		...state,
		current: next,
		history: [...state.history, state.current],
		forward: state.forward.slice(0, -1),
	};
}

/** Open the structural parent of the current location (never history). */
export function goToParent(state: RouterState): RouterState {
	const parent = parentRoute(state.current);
	return parent ? navigate(state, parent) : state;
}

export interface Resolution {
	route: Route;
	/** The requested route that was unavailable, when a fallback applied. */
	unavailable?: Route;
}

/**
 * Resolve a requested location against availability. A missing resource falls
 * back to the nearest valid structural ancestor and reports the request, so the
 * caller can surface a diagnostic without substituting another identity.
 */
export function resolveAvailable(
	route: Route,
	isAvailable: (route: Route) => boolean,
): Resolution {
	if (isAvailable(route)) return { route };
	let cursor = parentRoute(route);
	while (cursor) {
		if (isAvailable(cursor)) return { route: cursor, unavailable: route };
		cursor = parentRoute(cursor);
	}
	return { route, unavailable: route };
}

export function setViewState<T>(
	state: RouterState,
	route: Route,
	value: T,
): RouterState {
	return {
		...state,
		viewState: { ...state.viewState, [routeKey(route)]: value },
	};
}

export function viewState<T>(state: RouterState, route: Route): T | undefined {
	return state.viewState[routeKey(route)] as T | undefined;
}

/** Drop the state of one location (e.g. a deleted resource). */
export function dropViewState(state: RouterState, route: Route): RouterState {
	const key = routeKey(route);
	if (!(key in state.viewState)) return state;
	const { [key]: _dropped, ...rest } = state.viewState;
	return { ...state, viewState: rest };
}

/** Solid-reactive wrapper: components read `current()` and dispatch operations. */
export function createPageNavigation(initial: RouterState) {
	const [state, setState] = createSignal(initial);
	return {
		state,
		current: () => state().current,
		feature: () => featureOf(state().current),
		canBack: () => canGoBack(state()),
		canForward: () => canGoForward(state()),
		remembered: (feature: FeatureId) => rememberedRoute(state(), feature),
		navigate: (route: Route) => setState((s) => navigate(s, route)),
		replace: (route: Route) => setState((s) => replace(s, route)),
		back: () => setState((s) => back(s)),
		forward: () => setState((s) => forward(s)),
		goToParent: () => setState((s) => goToParent(s)),
		resolve: (route: Route, isAvailable: (route: Route) => boolean) =>
			setState((s) => navigate(s, resolveAvailable(route, isAvailable).route)),
		viewState: <T>(route: Route): T | undefined => viewState<T>(state(), route),
		setViewState: <T>(route: Route, value: T) =>
			setState((s) => setViewState(s, route, value)),
		dropViewState: (route: Route) => setState((s) => dropViewState(s, route)),
	};
}
