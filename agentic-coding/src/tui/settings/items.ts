// Section item builders for Settings (centralize-application-settings). Pure
// functions: a section page renders the items its builder returns from a
// snapshot the shell resolved, so navigation and activation stay testable
// without a terminal and no builder performs I/O.
//
// Every item states its effective value and the source/scope line it came from;
// an item that cannot be edited here is marked read-only and carries the
// explanation from the inventory instead of pretending to accept an edit.
import {
	type Route,
	resourceRoute,
	type SettingsSection,
	settingsRoute,
} from "../shared/routes";
import {
	effectLabel,
	inventoryEntry,
	type SettingsEffect,
	type SettingsScope,
	scopeLabel,
} from "./catalog";

/** What activating an item does. Navigation is returned, never performed. */
export type SettingsAction =
	| { kind: "none" }
	/** Open the shared theme picker (search, live preview, save on selection). */
	| { kind: "theme-picker" }
	/** Open the shared profile/preset editor. */
	| { kind: "open-agents" }
	/** Re-read the connected server after an unavailable/error state. */
	| { kind: "retry" }
	| { kind: "navigate"; route: Route };

export interface SettingsItem {
	id: string;
	label: string;
	/** Effective value, or a short state description. */
	value: string;
	/** Source, scope and effect line. */
	detail: string;
	editable: boolean;
	action: SettingsAction;
}

export interface AgentRoutingEntry {
	label: string;
	value: string;
}

export interface AgentStatus {
	scope: SettingsScope;
	/** Configured application/library id when the page is project-scoped. */
	projectIdent?: string;
	repository?: string;
	/** Effective source and the files it was resolved from. */
	source?: string;
	files: readonly string[];
	/** Legacy sources left in place but not read, because a canonical JSON file
	 * wins at this scope. Reported so the operator can finish the migration. */
	inactiveFiles?: readonly string[];
	conflicts: string[];
	error?: string;
	profiles: Array<{ name: string; value: string }>;
	presets: Array<{ name: string; value: string }>;
	routing: AgentRoutingEntry[];
}

export interface ProviderSnapshot {
	state: "loading" | "ready" | "error";
	providers: Array<{
		name: string;
		type: string;
		username: string;
		hasToken: boolean;
		invalid: boolean;
		problem?: string;
	}>;
	error?: string;
}

export interface ProjectSnapshot {
	state: "loading" | "ready" | "error";
	revision?: string;
	projects: Array<{
		ident: string;
		displayName: string;
		kind: string;
		available: boolean;
		repository?: string;
	}>;
	error?: string;
}

export interface BackendSnapshot {
	values: Array<{
		id: string;
		label: string;
		value: string;
		source: string;
		effect: SettingsEffect;
		secret: boolean;
	}>;
}

export interface SettingsContext {
	themes: string[];
	activeTheme: string;
	/** `$AGENTIC_CODING_CONFIG_DIR/tui.json`, the client-local preference file. */
	clientSettingsPath: string;
	/** `$AGENTIC_CODING_CONFIG_DIR/themes`, loaded at startup. */
	customThemeDir: string;
	/** The Settings page this snapshot is rendered for. */
	section: SettingsSection;
	agents: AgentStatus;
	providers: ProviderSnapshot;
	projects: ProjectSnapshot;
	backend: BackendSnapshot;
}

function detailFor(
	scope: SettingsScope,
	storage: string,
	effect: SettingsEffect,
): string {
	return `${scopeLabel(scope)} · ${storage} · ${effectLabel(effect)}`;
}

/** The inventory detail line of one item id, so it is never hand-written. */
function inventoryDetail(id: string): string {
	const entry = inventoryEntry(id);
	return entry
		? detailFor(entry.scope, entry.storage, entry.effect)
		: "source unavailable";
}

function appearanceItems(context: SettingsContext): SettingsItem[] {
	return [
		{
			id: "appearance.theme",
			label: "Active theme",
			value: context.activeTheme,
			detail: `${inventoryDetail("appearance.theme")} · ${context.clientSettingsPath}`,
			editable: true,
			action: { kind: "theme-picker" },
		},
		{
			id: "appearance.theme-picker",
			label: "Choose a theme…",
			value: `${context.themes.length} available`,
			detail: `reuses the theme picker · ${context.clientSettingsPath}`,
			editable: true,
			action: { kind: "theme-picker" },
		},
		{
			id: "appearance.custom-themes",
			label: "Custom themes (files)",
			value: context.customThemeDir,
			detail: `${inventoryDetail(
				"appearance.custom-themes",
			)} · add or edit a theme file and restart`,
			editable: false,
			action: { kind: "none" },
		},
	];
}

function agentItems(context: SettingsContext): SettingsItem[] {
	const agents = context.agents;
	const items: SettingsItem[] = [];
	const source = agents.source ?? "unavailable";
	const files = agents.files.length ? ` (${agents.files.join(", ")})` : "";
	items.push({
		id: "agents.scope",
		label: "Scope",
		value:
			agents.scope === "project"
				? `project ${agents.projectIdent ?? ""}`.trim()
				: "user configuration",
		detail: `${detailFor(agents.scope, `${source}${files}`, "next-start")}`,
		editable: false,
		action: { kind: "none" },
	});
	if (agents.repository) {
		items.push({
			id: "agents.repository",
			label: "Project checkout",
			value: agents.repository,
			detail: "where the project-scoped configuration is resolved from",
			editable: false,
			action: { kind: "none" },
		});
		items.push({
			id: "agents.reset-scope",
			label: "Reset to user scope",
			value: "",
			detail: `${detailFor("user", source, "next-start")} · leaves the project configuration untouched`,
			editable: true,
			action: { kind: "navigate", route: settingsRoute("agents") },
		});
	}
	if (agents.inactiveFiles?.length) {
		for (const file of agents.inactiveFiles) {
			items.push({
				id: `agents.inactive.${file}`,
				label: "Inactive legacy configuration",
				value: file,
				detail: detailFor(
					agents.scope,
					`${file} is read-only compatibility input; JSON is the active format`,
					"next-start",
				),
				editable: false,
				action: { kind: "none" },
			});
		}
	}
	if (agents.error) {
		items.push({
			id: "agents.error",
			label: "Configuration could not be read",
			value: agents.error,
			detail: "the last valid configuration is unchanged",
			editable: false,
			action: { kind: "none" },
		});
	}
	for (const conflict of agents.conflicts) {
		items.push({
			id: `agents.conflict.${conflict}`,
			label: "Conflicting [agents] definition",
			value: conflict,
			detail: "remove [agents] there before saving so edits are not shadowed",
			editable: false,
			action: { kind: "none" },
		});
	}
	items.push({
		id: "agents.manage",
		label: "Profiles and presets…",
		value: `${agents.profiles.length} profiles · ${agents.presets.length} presets`,
		detail: `${detailFor(
			agents.scope,
			source,
			"next-start",
		)} · explicit save, validated before write`,
		editable: true,
		action: { kind: "open-agents" },
	});
	for (const profile of agents.profiles)
		items.push({
			id: `agents.profile.${profile.name}`,
			label: `Profile ${profile.name}`,
			value: profile.value,
			detail: `${detailFor(agents.scope, source, "next-start")} · edit under Profiles and presets`,
			editable: true,
			action: { kind: "open-agents" },
		});
	for (const preset of agents.presets)
		items.push({
			id: `agents.preset.${preset.name}`,
			label: `Preset ${preset.name}`,
			value: preset.value,
			detail: `${detailFor(agents.scope, source, "next-start")} · edit under Profiles and presets`,
			editable: true,
			action: { kind: "open-agents" },
		});
	for (const entry of agents.routing)
		items.push({
			id: `agents.routing.${entry.label}`,
			label: entry.label,
			value: entry.value,
			detail: `${detailFor("user", source, "next-start")} · read-only: edit the config file`,
			editable: false,
			action: { kind: "none" },
		});
	return items;
}

function providerItems(context: SettingsContext): SettingsItem[] {
	const providers = context.providers;
	if (providers.state === "loading")
		return [
			{
				id: "providers.loading",
				label: "Providers",
				value: "loading…",
				detail: "reading provider status from the connected server",
				editable: false,
				action: { kind: "none" },
			},
		];
	if (providers.state === "error")
		return [
			{
				id: "providers.error",
				label: "Providers unavailable",
				value: providers.error ?? "unavailable",
				detail:
					"the connected server could not be read; no local configuration was written",
				editable: false,
				action: { kind: "none" },
			},
			{
				id: "providers.retry",
				label: "Retry",
				value: "",
				detail: "read the connected server again",
				editable: true,
				action: { kind: "retry" },
			},
		];
	const items: SettingsItem[] = providers.providers.map((provider) => ({
		id: `providers.${provider.name}`,
		label: provider.name,
		value: [provider.type, provider.username].filter(Boolean).join(" · "),
		detail: [
			provider.hasToken
				? "credential stored on the server (masked)"
				: "no credential stored",
			provider.invalid
				? `needs attention: ${provider.problem ?? "invalid"}`
				: "",
			"edit in Environments",
		]
			.filter(Boolean)
			.join(" · "),
		editable: true,
		action: {
			kind: "navigate",
			route: { page: "environments.applications" },
		},
	}));
	items.push({
		id: "providers.credentials",
		label: "Provider credentials",
		value: `${providers.providers.filter((provider) => provider.hasToken).length} stored`,
		detail: `${inventoryDetail("providers.credentials")} · values are never shown here`,
		editable: false,
		action: { kind: "none" },
	});
	return items;
}

function projectItems(context: SettingsContext): SettingsItem[] {
	const projects = context.projects;
	if (projects.state === "loading")
		return [
			{
				id: "projects.loading",
				label: "Configured projects",
				value: "loading…",
				detail: "reading the project catalog from the connected server",
				editable: false,
				action: { kind: "none" },
			},
		];
	if (projects.state === "error")
		return [
			{
				id: "projects.error",
				label: "Projects unavailable",
				value: projects.error ?? "unavailable",
				detail:
					"the connected server could not be read; no local configuration was written",
				editable: false,
				action: { kind: "none" },
			},
			{
				id: "projects.retry",
				label: "Retry",
				value: "",
				detail: "read the connected server again",
				editable: true,
				action: { kind: "retry" },
			},
		];
	const items: SettingsItem[] = projects.projects.map((project) => ({
		id: `projects.${project.ident}`,
		label: project.displayName || project.ident,
		value: `${project.kind} · ${
			project.available ? "available" : "unavailable"
		}`,
		detail: `${inventoryDetail("projects.catalog")} · opens this project's settings`,
		editable: true,
		action: {
			kind: "navigate",
			route: settingsRoute("projects", project.ident),
		},
	}));
	if (items.length)
		items.push({
			id: "projects.revision",
			label: "Catalog revision",
			value: projects.revision ?? "",
			detail: `${detailFor(
				"server",
				"projected catalog fingerprint",
				"immediate",
			)} · a changed revision means configured projects changed`,
			editable: false,
			action: { kind: "none" },
		});
	return items.length
		? items
		: [
				{
					id: "projects.empty",
					label: "No configured projects",
					value: "",
					detail: "configure an application or library in Environments first",
					editable: false,
					action: { kind: "none" },
				},
			];
}

/** Project-scoped detail: the project's own settings, scoped by its stable id. */
function projectScopeItems(
	context: SettingsContext,
	projectIdent: string,
): SettingsItem[] {
	const project = context.projects.projects.find(
		(candidate) => candidate.ident === projectIdent,
	);
	if (!project)
		return [
			{
				id: "projects.missing",
				label: projectIdent,
				value: "not configured",
				detail:
					"this project id is not in the connected server's catalog; no other identity was substituted",
				editable: false,
				action: { kind: "none" },
			},
		];
	const kind = project.kind === "library" ? "libraries" : "applications";
	return [
		{
			id: "project.ident",
			label: project.displayName || project.ident,
			value: `${project.kind} · ${project.ident}`,
			detail: `${inventoryDetail(
				"projects.catalog",
			)} · this is the stable project scope`,
			editable: false,
			action: { kind: "none" },
		},
		{
			id: "project.agent-settings",
			label: "Agent models/presets for this project",
			value: "",
			detail: `${detailFor(
				"project",
				project.repository ?? "project checkout",
				"next-start",
			)} · opens Settings scoped to this project`,
			editable: true,
			action: {
				kind: "navigate",
				route: settingsRoute("agents", project.ident),
			},
		},
		{
			id: "project.open-environments",
			label: "Open in Environments",
			value: "",
			detail:
				"reuses the environment editors for this project's repository and runtime",
			editable: true,
			action: {
				kind: "navigate",
				route: resourceRoute(kind, project.ident),
			},
		},
	];
}

function backendItems(context: SettingsContext): SettingsItem[] {
	return context.backend.values.map((value) => ({
		id: value.id,
		label: value.label,
		value: value.value,
		detail: `${scopeLabel("server")} · ${value.source} · ${effectLabel(
			value.effect,
		)}${value.secret ? " · value not shown" : ""}`,
		editable: false,
		action: { kind: "none" as const },
	}));
}

/** Items of one Settings section for the resolved snapshot. */
export function settingsItems(
	context: SettingsContext,
	projectIdent?: string,
): SettingsItem[] {
	switch (context.section) {
		case "appearance":
			return appearanceItems(context);
		case "agents":
			return agentItems(context);
		case "providers":
			return providerItems(context);
		case "projects":
			return projectIdent
				? projectScopeItems(context, projectIdent)
				: projectItems(context);
		case "backend":
			return backendItems(context);
	}
}
