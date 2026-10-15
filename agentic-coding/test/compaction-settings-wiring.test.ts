// The Compaction Settings section's shell wiring
// (fix-compaction-settings-unavailable).
//
// The section's rows come from the agent-config entry the shell resolves, so
// these tests build the context exactly the way `App.tsx` does
// (`buildSettingsContext`). A regression that drops the compaction snapshot on
// the way into the context — or that hides a read error behind the generic
// sentence — fails here instead of only in the running TUI.
import { describe, expect, test } from "bun:test";
import type { AgentConfigEntry } from "../src/tui/dash/agent-config-cache.ts";
import {
	buildSettingsContext,
	retrySettingsSection,
	settingsAgentBackedSection,
} from "../src/tui/otel/app/settings-context.ts";
import {
	type CompactionSettingsSnapshot,
	settingsItems,
} from "../src/tui/settings/items.ts";
import type { SettingsSection } from "../src/tui/shared/routes.ts";

/** Let a fire-and-forget retry's promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DEFAULTS = {
	enabled: true,
	reserveTokens: 32000,
	backgroundTokens: 32000,
	keepRecentTokens: 20000,
};

function snapshot(
	overrides: Partial<CompactionSettingsSnapshot> = {},
): CompactionSettingsSnapshot {
	return {
		configured: {},
		configuredIsDefault: true,
		effective: DEFAULTS,
		source: "default",
		validation: [],
		defaults: DEFAULTS,
		...overrides,
	};
}

/** The Settings context `App.tsx` builds for the Compaction section. */
function contextFor(
	entry: AgentConfigEntry,
	scope: { projectIdent?: string; repository?: string } = {},
) {
	return buildSettingsContext({
		themes: ["catppuccin"],
		activeTheme: "catppuccin",
		clientSettingsPath: "/tmp/tui.json",
		section: "compaction",
		...(scope.projectIdent ? { projectIdent: scope.projectIdent } : {}),
		...(scope.repository ? { repository: scope.repository } : {}),
		entry,
		providers: { state: "ready", providers: [] },
	});
}

describe("the Compaction section's shell wiring", () => {
	test("an entry carrying a snapshot renders the real rows, not 'unavailable'", () => {
		const items = settingsItems(contextFor({ compaction: snapshot() }));
		expect(items.map((item) => item.id)).not.toContain(
			"compaction.unavailable",
		);
		expect(items.find((item) => item.id === "compaction.enabled")?.value).toBe(
			"on",
		);
		expect(
			items.find((item) => item.id === "compaction.reserveTokens")?.value,
		).toBe("32000 tokens (default)");
		expect(
			items.find((item) => item.id === "compaction.keepRecentTokens")?.value,
		).toBe("20000 tokens (default)");
		expect(
			items.find((item) => item.id === "compaction.reference-window"),
		).toBeDefined();
	});

	test("a project-scoped page renders the user-scope compaction policy too", () => {
		const context = contextFor(
			{
				compaction: snapshot({
					configured: { reserveTokens: 45000 },
					configuredIsDefault: false,
					source: "agents",
					effective: { ...DEFAULTS, reserveTokens: 45000 },
				}),
			},
			{ projectIdent: "app.one", repository: "/repos/one" },
		);
		expect(context.agents.scope).toBe("project");
		expect(context.agents.projectIdent).toBe("app.one");
		const reserve = settingsItems(context).find(
			(item) => item.id === "compaction.reserveTokens",
		);
		expect(reserve?.value).toBe("45000 tokens");
		expect(reserve?.detail).toContain("[agents.compaction]");
	});

	test("a failed agents read shows its own message, not the generic sentence", () => {
		const items = settingsItems(
			contextFor({ error: "config.json: unexpected token at line 3" }),
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("compaction.unavailable");
		expect(items[0]?.value).toBe("config.json: unexpected token at line 3");
		expect(items[0]?.action).toEqual({ kind: "retry" });
	});

	test("before the first read resolves the row says loading, not unavailable", () => {
		const items = settingsItems(contextFor({}));
		expect(items[0]?.id).toBe("compaction.unavailable");
		expect(items[0]?.value).toBe("loading…");
		expect(items[0]?.action).toEqual({ kind: "retry" });
	});
});

describe("retry on the unavailable Compaction row", () => {
	test("re-reads the agent config and the rows appear", async () => {
		let entry: AgentConfigEntry = {};
		let agentsBumped = 0;
		const rowsNow = () => settingsItems(contextFor(entry));
		expect(rowsNow()[0]?.id).toBe("compaction.unavailable");

		retrySettingsSection({
			section: "compaction",
			repository: undefined,
			refreshProviders: () => {},
			refreshProjects: () => {},
			refreshAgents: async () => {
				entry = { compaction: snapshot() };
				return entry;
			},
			refreshBrowser: async () => undefined,
			bumpAgents: () => {
				agentsBumped += 1;
			},
			bumpBrowser: () => {},
		});
		await flush();

		expect(agentsBumped).toBe(1);
		expect(
			rowsNow().find((item) => item.id === "compaction.reserveTokens")?.value,
		).toBe("32000 tokens (default)");
	});

	test("keeps every other section's reads", async () => {
		const calls: string[] = [];
		const deps = (section: SettingsSection) => ({
			section,
			repository: undefined,
			refreshProviders: () => {
				calls.push("providers");
			},
			refreshProjects: () => {
				calls.push("projects");
			},
			refreshAgents: async () => {
				calls.push("agents");
			},
			refreshBrowser: async () => {
				calls.push("browser");
			},
			bumpAgents: () => {
				calls.push("bump-agents");
			},
			bumpBrowser: () => {
				calls.push("bump-browser");
			},
		});

		retrySettingsSection(deps("providers"));
		await flush();
		expect(calls).toEqual(["providers", "projects"]);

		calls.length = 0;
		retrySettingsSection(deps("browser"));
		await flush();
		expect(calls).toEqual(["browser", "bump-browser"]);

		calls.length = 0;
		retrySettingsSection(deps("agents"));
		await flush();
		expect(calls).toEqual(["providers", "projects", "agents", "bump-agents"]);
	});

	test("the agent-config-backed sections are exactly agents and compaction", () => {
		expect(settingsAgentBackedSection("agents")).toBe(true);
		expect(settingsAgentBackedSection("compaction")).toBe(true);
		expect(settingsAgentBackedSection("providers")).toBe(false);
		expect(settingsAgentBackedSection("browser")).toBe(false);
		expect(settingsAgentBackedSection(undefined)).toBe(false);
	});
});
