// Destination catalog for the page-based shell
// (replace-nested-tabs-with-page-navigation, task 2.1).
//
// Pages and the location picker share one catalog, so a destination can never
// exist in the picker without a page (or vice versa). Restrictions are applied
// here, once: a restricted surface returns a catalog that simply does not
// contain the excluded destinations.
import {
	ENVIRONMENT_CATEGORIES,
	OBSERVABILITY_VIEWS,
	type PageId,
	type Route,
	SETTINGS_SECTION_DESCRIPTIONS,
	SETTINGS_SECTION_LABELS,
	SETTINGS_SECTIONS,
	settingsSectionPage,
} from "../routes.ts";

/** Which surfaces the running shell actually renders. */
export interface DestinationSurface {
	/** The owned/attached environment backend exposes the Environments feature. */
	environments: boolean;
	/** Telemetry restrictions hide metrics/logs/topology everywhere. */
	tracesOnly: boolean;
	/** The Wiki body is rendered (home mode): repository-independent review. */
	wiki: boolean;
	/** The shell owns configuration: Home exposes Settings
	 * (centralize-application-settings). */
	settings: boolean;
}

export interface DestinationEntry {
	/** Stable picker identity. */
	id: string;
	label: string;
	/** One-line description shown by the picker. */
	description?: string;
	/** Group heading in the picker. */
	group: string;
	/** Location the entry opens; absent for an in-place `action` entry. */
	route?: Route;
	/**
	 * In-place action instead of navigation: the one Home entry that opens the
	 * shell's workflow form rather than a page. Pickers never carry these (an
	 * action has no location to jump to).
	 */
	action?: () => void;
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
	applications: "Applications",
	libraries: "Libraries",
	infrastructure: "Infrastructure",
	scripts: "Scripts",
	kubernetes: "Kubernetes",
};

const CATEGORY_DESCRIPTIONS: Readonly<Record<string, string>> = {
	applications: "Run, inspect and act on applications",
	libraries: "Built libraries and their change requests",
	infrastructure: "Infrastructure services and their logs",
	scripts: "Configured scripts and task runs",
	kubernetes: "Cluster status, workloads and pods",
};

const VIEW_DESCRIPTIONS: Readonly<Record<string, string>> = {
	traces: "Distributed traces and span trees",
	metrics: "Metric series and their detail",
	logs: "Log records and their detail",
	topology: "Service map and service detail",
};

/** Home destinations, in listing order. */
export function homeDestinations(
	surface: DestinationSurface,
): DestinationEntry[] {
	const entries: DestinationEntry[] = [];
	if (surface.environments) {
		entries.push({
			id: "environments",
			label: "Environments",
			description: "Applications, libraries, infrastructure, scripts, cluster",
			group: "Destinations",
			route: { page: "environments" },
		});
	}
	entries.push({
		id: "observability",
		label: "Observability",
		description: surface.tracesOnly
			? "Traces (metrics, logs and topology are restricted)"
			: "Traces, metrics, logs and topology",
		group: "Destinations",
		route: { page: "observability" },
	});
	// Wiki is repository-independent and survives telemetry restrictions, but it
	// only exists where the shell renders the Wiki body.
	if (surface.wiki) {
		entries.push({
			id: "wiki",
			label: "Wiki",
			description: "Review repository knowledge without a workflow",
			group: "Destinations",
			route: { page: "wiki" },
		});
	}
	// Workflow creation is contextual (application/library resource pages) or
	// independent (Wiki), plus Home's "New workflow" action for a path outside
	// the configured projects: there is no Workflows list, history or reopen
	// entry anywhere in the full application
	// (launch-workflows-from-project-and-wiki-pages).
	if (surface.settings) {
		entries.push({
			id: "settings",
			label: "Settings",
			description:
				"Appearance, agent models, providers, projects and backend configuration",
			group: "Destinations",
			route: { page: "settings" },
		});
	}
	return entries;
}

/** Child destinations of the Settings landing page. */
export function settingsDestinations(): DestinationEntry[] {
	return SETTINGS_SECTIONS.map((section) => ({
		id: `settings.${section}`,
		label: SETTINGS_SECTION_LABELS[section],
		description: SETTINGS_SECTION_DESCRIPTIONS[section],
		group: "Settings",
		route: { page: settingsSectionPage(section) },
	}));
}

/** Child destinations of the Environments category page. */
export function environmentDestinations(): DestinationEntry[] {
	return ENVIRONMENT_CATEGORIES.map((category) => ({
		id: `environments.${category}`,
		label: CATEGORY_LABELS[category] ?? category,
		description: CATEGORY_DESCRIPTIONS[category],
		group: "Environments",
		route: { page: `environments.${category}` as PageId },
	}));
}

/** Child destinations of the Observability category page, restrictions applied. */
export function observabilityDestinations(
	surface: DestinationSurface,
): DestinationEntry[] {
	const views: readonly string[] = surface.tracesOnly
		? ["traces"]
		: OBSERVABILITY_VIEWS;
	return views.map((view) => ({
		id: `observability.${view}`,
		label: `${view.charAt(0).toUpperCase()}${view.slice(1)}`,
		description: VIEW_DESCRIPTIONS[view],
		group: "Observability",
		route: { page: `observability.${view}` as PageId },
	}));
}

/** Child destinations of a category page, keyed by the parent page. */
export function categoryDestinations(
	page: "environments" | "observability",
	surface: DestinationSurface,
): DestinationEntry[] {
	return page === "environments"
		? environmentDestinations()
		: observabilityDestinations(surface);
}

/**
 * Home's workflow-creation action: the one launch that is not tied to a page,
 * so the label and description live here with the other destinations while the
 * shell owns the form it opens. Appended by the shell, never offered by the
 * location picker.
 */
export function homeLaunchEntry(open: () => void): DestinationEntry {
	return {
		id: "workflow.new",
		label: "New workflow",
		description:
			"Start a workflow in the working directory or a path you enter",
		group: "Destinations",
		action: open,
	};
}

/**
 * Location-picker entries: every registered destination plus in-memory
 * identities the caller supplies (recent resources, ancestors, siblings). The
 * catalog never scans a repository or invents a global resource index.
 */
export function pickerEntries(
	surface: DestinationSurface,
	extra: readonly DestinationEntry[] = [],
): DestinationEntry[] {
	const entries = [
		...homeDestinations(surface),
		...(surface.environments ? environmentDestinations() : []),
		...observabilityDestinations(surface),
		...(surface.settings ? settingsDestinations() : []),
		...extra,
	];
	return entries
		.filter((entry) => entry.route !== undefined)
		.map(({ id, label, description, group, route }) => ({
			id,
			label,
			description,
			group,
			route,
		}));
}

/**
 * Filter picker entries by a case-insensitive label/description query. A label
 * match outranks a description-only match, so typing a destination name selects
 * that destination rather than a parent whose description mentions it.
 */
export function filterPickerEntries(
	entries: readonly DestinationEntry[],
	query: string,
): DestinationEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...entries];
	const rank = (entry: DestinationEntry): number => {
		const label = entry.label.toLowerCase();
		if (label === needle) return 0;
		if (label.startsWith(needle)) return 1;
		if (label.includes(needle)) return 2;
		return 3;
	};
	return entries
		.map((entry, index) => ({ entry, index, rank: rank(entry) }))
		.filter(({ entry }) =>
			`${entry.label} ${entry.description ?? ""} ${entry.group}`
				.toLowerCase()
				.includes(needle),
		)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(({ entry }) => entry);
}
