// The Settings snapshot and the section retry the OTel shell wires from its own
// signals (fix-compaction-settings-unavailable). Extracted from `App.tsx` so
// the mapping from an agent-config entry into the section context — the
// compaction snapshot included — and what a retry on an unavailable row
// re-reads are testable without a terminal.
import type { BrowserStatusResponse } from "../../../contracts/browser.ts";
import type { ClassifierStatusResponse } from "../../../contracts/gateway.ts";
import {
	type AgentsConfig,
	BUILTIN_PRESET_NAME,
	GATE_STAGES,
} from "../../../workflow/profiles.ts";
import type { AgentConfigEntry } from "../../dash/agent-config-cache.ts";
import {
	type CompactionSettingsSnapshot,
	fileJudgmentSummaryLabel,
	type ProviderSnapshot,
	type SettingsContext,
} from "../../settings/items.ts";
import type { SettingsSection } from "../../shared/routes.ts";

/**
 * Read-only routing values for the Settings agent section: the agent settings a
 * preset editor does not own (default profile, per-step routes, role routes and
 * definition defaults). They are resolved into the agents snapshot so the
 * section's inventory stays complete; the actionable-only Agent Presets menu
 * does not render read-only rows, so these values have no menu surface.
 */
function agentRoutingEntries(
	agents: AgentsConfig,
): Array<{ label: string; value: string }> {
	const entries: Array<{ label: string; value: string }> = [
		{
			label: "Default profile",
			value: agents.default_profile ?? "(unset)",
		},
	];
	for (const [step, profile] of Object.entries(agents.routes ?? {}))
		entries.push({ label: `Route ${step}`, value: profile });
	for (const [step, roles] of Object.entries(agents.role_routes ?? {}))
		for (const [role, profile] of Object.entries(roles))
			entries.push({ label: `Role route ${step}.${role}`, value: profile });
	for (const [definition, profile] of Object.entries(
		agents.definition_defaults ?? {},
	))
		entries.push({ label: `Definition default ${definition}`, value: profile });
	// The global stage-gate table has no bounded editor, so this read-only
	// surface is the only place a user can confirm what a run falls back to
	// for a stage its preset does not own.
	for (const stage of GATE_STAGES)
		entries.push({
			label: `Stage gate ${stage}`,
			value: agents.gates?.[stage] ?? "always (default)",
		});
	// The per-file judgment sweep is `[agents]` configuration with no bounded
	// editor either, so its effective state is reported here. The label is built
	// by the settings item builder so the inventory row stays testable without a
	// terminal.
	entries.push({
		label: "File judgment sweep",
		value: fileJudgmentSummaryLabel(agents.file_judgment),
	});
	return entries;
}

/** The compaction snapshot an agent-config entry carries. The entry types the
 * field `unknown` because the settings surface keeps no runtime dependency on
 * the server module that owns the read; the server's read is structurally
 * compatible, so the snapshot is adopted whenever it is an object at all. */
export function compactionSnapshot(
	value: unknown,
): CompactionSettingsSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as CompactionSettingsSnapshot;
}

/** Everything `settingsContext()` needs from the shell's signals; every source
 * is resolved by the caller so this builder stays pure and testable. */
export interface SettingsContextInput {
	themes: string[];
	activeTheme: string;
	/** `$AGENTIC_CODING_CONFIG_DIR/tui.json`, the client-local preference file. */
	clientSettingsPath: string;
	/** The Settings page this snapshot is rendered for. */
	section: SettingsSection;
	/** Configured application/library id when the page is project-scoped. */
	projectIdent?: string;
	/** Repository the project-scoped agent configuration resolves from. */
	repository?: string;
	/** The effective agent configuration, its provenance and its compaction
	 * snapshot, exactly as the cache resolved them. */
	entry: AgentConfigEntry;
	providers: ProviderSnapshot;
	classifier?: ClassifierStatusResponse;
	browser?: BrowserStatusResponse;
}

/**
 * One snapshot of the values a section shows. The compaction policy is read
 * from the same entry as the rest of `[agents]`; omitting it made the
 * Compaction section claim the configuration could not be read even when the
 * read had succeeded (fix-compaction-settings-unavailable).
 */
export function buildSettingsContext(
	input: SettingsContextInput,
): SettingsContext {
	const entry = input.entry;
	const agents = entry.agents;
	const projectIdent = input.projectIdent;
	const compaction = compactionSnapshot(entry.compaction);
	return {
		themes: input.themes,
		activeTheme: input.activeTheme,
		clientSettingsPath: input.clientSettingsPath,
		section: input.section,
		agents: {
			scope: projectIdent ? "project" : "user",
			...(projectIdent ? { projectIdent } : {}),
			...(input.repository ? { repository: input.repository } : {}),
			...(entry.provenance?.source ? { source: entry.provenance.source } : {}),
			files: entry.provenance?.files ?? [],
			conflicts: entry.conflicts ?? [],
			...(entry.error ? { error: entry.error } : {}),
			profiles: Object.entries(agents?.profiles ?? {}).map(
				([name, profile]) => ({
					name,
					value: [profile.runtime, profile.model].filter(Boolean).join(" · "),
				}),
			),
			presets: Object.entries(agents?.presets ?? {})
				.filter(([name]) => name !== BUILTIN_PRESET_NAME)
				.map(([name, preset]) => ({
					name,
					value: `${Object.keys(preset.steps ?? {}).length} steps`,
				})),
			routing: agents ? agentRoutingEntries(agents) : [],
			...(agents?.orchestrator ? { orchestrator: agents.orchestrator } : {}),
			// The durable compaction policy rides in the same read. It is user-scope
			// whatever the page's scope, so a project-scoped page renders it too.
			...(compaction ? { compaction } : {}),
		},
		providers: input.providers,
		...(input.classifier ? { classifier: input.classifier } : {}),
		...(input.browser ? { browser: input.browser } : {}),
	};
}

/** True when the section's rows come from the agent-config read: `agents`, and
 * `compaction`, whose snapshot travels in the same entry. */
export function settingsAgentBackedSection(
	section: SettingsSection | undefined,
): boolean {
	return section === "agents" || section === "compaction";
}

/** The shell-owned reads a retry performs, injected so the dispatch itself is
 * testable. */
export interface SettingsRetryDeps {
	section: SettingsSection | undefined;
	repository: string | undefined;
	refreshProviders: () => void;
	refreshProjects: () => void;
	/** Re-read the agent-config entry the agents/compaction rows render. */
	refreshAgents: (repository?: string) => Promise<unknown>;
	refreshBrowser: () => Promise<unknown>;
	/** Re-read the snapshot signal once a read lands, so the section re-renders. */
	bumpAgents: () => void;
	bumpBrowser: () => void;
}

/**
 * Re-read exactly what the visible section's rows come from. The Browser
 * section owns its own server read; the agents-backed sections share the
 * agent-config read, so Enter on the unavailable Compaction row really reads
 * the configuration again instead of leaving the row unchanged. The other
 * sections keep their previous behaviour (providers and projects re-read).
 */
export function retrySettingsSection(deps: SettingsRetryDeps): void {
	if (deps.section === "browser") {
		void deps.refreshBrowser().then(deps.bumpBrowser);
		return;
	}
	deps.refreshProviders();
	deps.refreshProjects();
	if (settingsAgentBackedSection(deps.section))
		void deps.refreshAgents(deps.repository).then(deps.bumpAgents);
}
