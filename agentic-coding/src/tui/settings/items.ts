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
	type SettingsSection,
	settingsRoute,
} from "../shared/routes.ts";
import {
	effectLabel,
	inventoryEntry,
	type SettingsEffect,
	type SettingsScope,
	scopeLabel,
} from "./catalog.ts";

/** What activating an item does. Navigation is returned, never performed. */
export type SettingsAction =
	| { kind: "none" }
	/** Open the shared theme picker (search, live preview, save on selection). */
	| { kind: "theme-picker" }
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

export interface SettingsContext {
	themes: string[];
	activeTheme: string;
	/** `$AGENTIC_CODING_CONFIG_DIR/tui.json`, the client-local preference file. */
	clientSettingsPath: string;
	/** The Settings page this snapshot is rendered for. */
	section: SettingsSection;
	agents: AgentStatus;
	providers: ProviderSnapshot;
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
			label: "Theme",
			value: context.activeTheme,
			detail: "Changes the colorscheme of the application",
			editable: true,
			action: { kind: "theme-picker" },
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
	// The section renders the two menu options as its first selectable rows; the
	// items stay declared here so the inventory reachability check can name them.
	items.push({
		id: "agents.profiles",
		label: "Model profiles",
		value: `${agents.profiles.length} configured`,
		detail: `${detailFor(agents.scope, source, "next-start")} · edit the selected profile or add one`,
		editable: true,
		action: { kind: "none" },
	});
	items.push({
		id: "agents.presets",
		label: "Presets",
		value: `${agents.presets.length} configured`,
		detail: `${detailFor(agents.scope, source, "next-start")} · edit the selected preset or add one`,
		editable: true,
		action: { kind: "none" },
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

/** Items of one Settings section for the resolved snapshot. */
export function settingsItems(context: SettingsContext): SettingsItem[] {
	switch (context.section) {
		case "appearance":
			return appearanceItems(context);
		case "agents":
			return agentItems(context);
		case "providers":
			return providerItems(context);
	}
}
