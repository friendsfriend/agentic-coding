// Settings inventory (centralize-application-settings, task 1.1).
//
// One recorded table of every supported application setting the shell exposes:
// owning section, owner module, editing scope, storage, whether the value is a
// secret, when a saved change takes effect and whether Settings can edit it.
// The inventory is the acceptance artifact for "every supported setting has an
// inventoried destination" — `test/app/settings.test.ts` asserts each entry
// resolves to a Settings section page, a scope and a storage description, and
// that no section is empty. Runtime values are resolved by the section item
// builders (`items.ts`); this module stays pure data + pure selectors.
//
// Human-readable mirror: `docs/settings-inventory.md`.
import {
	SETTINGS_SECTIONS,
	type SettingsSection,
	settingsSectionPage,
} from "../shared/routes.ts";

/** Where a setting is edited and where its value actually lives. */
export type SettingsScope =
	/** Client-local UI preference: `$AGENTIC_CODING_CONFIG_DIR/tui.json`. */
	| "client"
	/** User-level configuration (no project selected). */
	| "user"
	/** Project-scoped configuration (a configured application/library id). */
	| "project"
	/** Owned by the connected server process and its configuration directory. */
	| "server";

/** When a saved value takes effect. */
export type SettingsEffect =
	/** Applied as soon as it is saved. */
	| "immediate"
	/** Affects the next workflow start; running workflows keep their pins. */
	| "next-start"
	/** Needs a restart of the owning process before it applies. */
	| "restart";

export interface SettingsInventoryEntry {
	/** Stable inventory identity, also the section item id. */
	id: string;
	section: SettingsSection;
	label: string;
	/** Module that owns the value and its validation. */
	owner: string;
	scope: SettingsScope;
	/** Path/key description, never a secret value. */
	storage: string;
	/** True when the value is a credential: masked, never in ordinary payloads. */
	secret: boolean;
	effect: SettingsEffect;
	/** False for read-only overrides and file-only settings with no editor. */
	editable: boolean;
	/** Item-id prefixes this entry surfaces in its section. Reachability is
	 * asserted against the rendered items, so no supported setting can be
	 * inventoried and then never shown (task 3.3). */
	items: readonly string[];
	/** Why an entry is not editable here, when it is not. */
	note?: string;
}

export const SETTINGS_INVENTORY: readonly SettingsInventoryEntry[] = [
	{
		id: "appearance.theme",
		section: "appearance",
		label: "Theme",
		owner: "src/tui/shared/preferences.ts",
		scope: "client",
		storage: "$AGENTIC_CODING_CONFIG_DIR/tui.json · theme",
		secret: false,
		effect: "immediate",
		editable: true,
		items: ["appearance."],
	},
	{
		id: "agents.profiles",
		section: "agents",
		label: "Agent profiles",
		owner: "src/server/config.ts",
		scope: "user",
		storage: "[agents.profiles] in the layered workflow config",
		secret: false,
		effect: "next-start",
		editable: true,
		items: ["agents.profiles"],
	},
	{
		id: "agents.presets",
		section: "agents",
		label: "Agent presets",
		owner: "src/server/config.ts",
		scope: "user",
		storage: "[agents.presets] in the layered workflow config",
		secret: false,
		effect: "next-start",
		editable: true,
		items: ["agents.presets"],
	},
	{
		id: "agents.routing",
		section: "agents",
		label: "Routing and definition defaults",
		owner: "src/workflow/profiles.ts",
		scope: "user",
		storage:
			"[agents] default_profile, routes, role_routes, definition_defaults (layered config)",
		secret: false,
		effect: "next-start",
		editable: false,
		items: [
			"agents.scope",
			"agents.repository",
			"agents.reset-scope",
			"agents.error",
			"agents.conflict.",
			"agents.routing.",
		],
		note: "No bounded editor: the effective value and its source are shown; edit the config file.",
	},
	{
		id: "providers.entries",
		section: "providers",
		label: "Git providers",
		owner: "server integration families (/api/providers)",
		scope: "server",
		storage:
			"$AGENTIC_CODING_CONFIG_DIR/providers · served by the connected server",
		secret: true,
		effect: "immediate",
		editable: true,
		items: ["providers.", "providers.retry"],
	},
	{
		id: "providers.credentials",
		section: "providers",
		label: "Provider credentials",
		owner: "src/workflow/credentials.ts, src/server/credentials.ts",
		scope: "server",
		storage:
			"Protected credential store; prompts are single-owner and ephemeral",
		secret: true,
		effect: "immediate",
		editable: false,
		items: ["providers.credentials", "providers.retry"],
		note: "Status only: secrets are entered through the credential flow and never shown or routed here.",
	},
];

/** Every inventory entry of one section, in declaration order. */
export function inventoryBySection(
	section: SettingsSection,
): SettingsInventoryEntry[] {
	return SETTINGS_INVENTORY.filter((entry) => entry.section === section);
}

export function inventoryEntry(id: string): SettingsInventoryEntry | undefined {
	return SETTINGS_INVENTORY.find((entry) => entry.id === id);
}

/**
 * Coverage check used by the validation test and by the section renderer: every
 * section owns at least one inventory entry, every entry names a section that is
 * registered as a page, and no entry is missing a scope or storage description.
 */
export function inventoryGaps(): string[] {
	const gaps: string[] = [];
	for (const section of SETTINGS_SECTIONS) {
		if (inventoryBySection(section).length === 0)
			gaps.push(`section ${section} has no inventory entry`);
		if (!settingsSectionPage(section).startsWith("settings."))
			gaps.push(`section ${section} has no settings page`);
	}
	for (const entry of SETTINGS_INVENTORY) {
		if (!entry.scope) gaps.push(`${entry.id} has no scope`);
		if (!entry.storage) gaps.push(`${entry.id} has no storage description`);
		if (!entry.editable && !entry.note)
			gaps.push(`${entry.id} is read-only without an explanation`);
	}
	return gaps;
}

/** One-line effective-source description for a scope. */
export function scopeLabel(scope: SettingsScope): string {
	switch (scope) {
		case "client":
			return "this client";
		case "user":
			return "user configuration";
		case "project":
			return "project configuration";
		case "server":
			return "connected server";
	}
}

/** One-line effect description shown next to a value. */
export function effectLabel(effect: SettingsEffect): string {
	switch (effect) {
		case "immediate":
			return "applies immediately";
		case "next-start":
			return "applies to the next workflow start";
		case "restart":
			return "needs a restart";
	}
}
