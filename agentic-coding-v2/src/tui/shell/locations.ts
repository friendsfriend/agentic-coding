import type { Page } from "./navigation.ts";

/** One jumpable location. v1 published the same catalog to its Home listing and
 * its location picker, so a destination can never exist in one surface only. */
export interface LocationEntry {
	id: string;
	label: string;
	description: string;
	group: string;
	page: Page;
	resource: string | null;
}

/** The shell's pages in listing order. One table drives the Home list, the
 * picker and the page-name lookup, so their labels and order stay identical. */
export const PAGE_LOCATIONS: ReadonlyArray<{
	page: Page;
	label: string;
	description: string;
}> = [
	{ page: "home", label: "Home", description: "Destinations" },
	{
		page: "tasks",
		label: "Tasks & reviews",
		description: "Admitted native tasks, their reviews and evidence",
	},
	{
		page: "environments",
		label: "Environments",
		description: "Run, build and inspect native application environments",
	},
	{
		page: "providers",
		label: "Providers",
		description: "Authenticated source hosts and their repositories",
	},
	{
		page: "profiles",
		label: "Profiles & models",
		description: "Agent profiles and the models they bundle",
	},
	{
		page: "skills",
		label: "Skills",
		description: "Loaded skill instructions and their files",
	},
	{
		page: "observability",
		label: "Observability",
		description: "Traces, metrics, logs and service topology",
	},
	{
		page: "schedules",
		label: "Schedules",
		description: "Recurring native skill runs and their occurrences",
	},
	{ page: "wiki", label: "Wiki", description: "Repository knowledge notes" },
	{
		page: "settings",
		label: "Settings",
		description: "Application settings, agent profiles and appearance",
	},
];

/** Every page as a destination. Sessions are reached from the sidebar, not
 * here, because a session identity is runtime state rather than a location. */
export function locationEntries(): LocationEntry[] {
	return PAGE_LOCATIONS.map((entry) => ({
		id: entry.page,
		label: entry.label,
		description: entry.description,
		group: "Destinations",
		page: entry.page,
		resource: null,
	}));
}

/** Filtered, bounded picker rows for one search query. `every` keeps the
 * unfiltered order so a cleared query restores the exact listing. */
export function filterLocations(
	entries: readonly LocationEntry[],
	query: string,
): LocationEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...entries];
	return entries.filter((entry) =>
		`${entry.label} ${entry.description} ${entry.group}`
			.toLowerCase()
			.includes(needle),
	);
}
