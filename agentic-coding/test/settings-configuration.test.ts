// Settings: inventory completeness, safe persistence and read-only overrides
// (centralize-application-settings, tasks 1.1, 2.3, 2.4, 3.1, 3.2).
//
// Pure/writer-level checks. The rendered section pages are covered by
// test/app/settingsPages.test.tsx and the shell integration by
// test/app/tuiValidation.test.tsx.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	agentConfigRevision,
	applyAgentsMutation,
	loadAgentConfig,
} from "../src/server/config.ts";
import {
	inventoryBySection,
	inventoryGaps,
	SETTINGS_INVENTORY,
} from "../src/tui/settings/catalog.ts";
import {
	identityForgetAnchor,
	type SettingsContext,
	settingsItems,
} from "../src/tui/settings/items.ts";
import {
	readProjectStatus,
	readProviderStatus,
} from "../src/tui/settings/server-config.ts";
import { saveThemeName } from "../src/tui/shared/preferences.ts";
import {
	PAGES,
	SETTINGS_SECTIONS,
	type SettingsSection,
	settingsSectionOfPage,
	settingsSectionPage,
} from "../src/tui/shared/routes.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { saveAgentsSection, saveSidebarMode } from "../src/workflow/effects.ts";
import {
	parseAgentsConfig,
	resolvePreset,
	resolveRouting,
} from "../src/workflow/profiles.ts";
import { startRouting } from "../src/workflow/startup.ts";

/** Write one config file and point the resolution at it for the test body. */
function withConfig<T>(content: object, run: () => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-config-"));
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
	process.env.HERDR_WORKFLOW_CONFIG = file;
	try {
		return run();
	} finally {
		delete process.env.HERDR_WORKFLOW_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const BASE_CONFIG = {
	agents: {
		default_profile: "a",
		profiles: { a: { runtime: "pi-durable" }, b: { runtime: "pi-durable" } },
		presets: {
			p: {
				default_profile: "a",
				steps: { "core.plan": "a" },
				roles: { "custom.step": { "custom-role": "b" } },
				pools: {
					"core.implementation": [{ label: "a", profile: "a", default: true }],
				},
			},
		},
	},
};

/** Rewrite the active test config as JSON (the format every write uses). */
function updateConfig(
	file: string,
	mutate: (doc: Record<string, unknown>) => void,
) {
	const document = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
		string,
		unknown
	>;
	mutate(document);
	fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

describe("settings inventory", () => {
	test("a leftover obsolete configuration is ignored, not surfaced", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-legacy-"));
		try {
			const root = path.join(dir, "agentic-coding");
			fs.mkdirSync(root, { recursive: true });
			const obsolete = path.join(root, "config.toml");
			fs.writeFileSync(obsolete, '[agents]\ndefault_profile = "legacy"\n');
			fs.writeFileSync(
				path.join(root, "config.json"),
				`${JSON.stringify({
					agents: {
						default_profile: "current",
						profiles: { current: { runtime: "pi-durable" } },
					},
				})}\n`,
			);
			process.env.AGENTIC_CODING_CONFIG_DIR = root;
			try {
				const resolved = loadAgentConfig();
				// The canonical JSON is the only source: the obsolete file is neither
				// merged nor reported, and it is left byte-identical.
				expect(resolved.agents.default_profile).toBe("current");
				expect(resolved.provenance.source).toBe("user");
				expect(resolved.provenance.files).toEqual([
					path.join(root, "config.json"),
				]);
				expect(fs.readFileSync(obsolete, "utf8")).toBe(
					'[agents]\ndefault_profile = "legacy"\n',
				);
			} finally {
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every supported setting has a destination, a scope and a source", () => {
		expect(inventoryGaps()).toEqual([]);
		for (const section of SETTINGS_SECTIONS) {
			expect(inventoryBySection(section).length).toBeGreaterThan(0);
			// The section is a registered page whose parent is the Settings landing.
			const page = settingsSectionPage(section);
			expect(PAGES[page]).toBeDefined();
			expect(PAGES[page].parent?.({ page })).toEqual({ page: "settings" });
			expect(settingsSectionOfPage(page)).toBe(section);
		}
		expect(settingsSectionOfPage("settings")).toBeUndefined();
		expect(settingsSectionOfPage("home")).toBeUndefined();
	});

	test("secrets are described, never valued, and read-only entries explain why", () => {
		for (const section of SETTINGS_SECTIONS)
			for (const entry of inventoryBySection(section)) {
				expect(entry.storage.length).toBeGreaterThan(0);
				if (!entry.editable) expect(entry.note).toBeTruthy();
			}
	});

	test("no inventory entry names a section that is no longer registered", () => {
		for (const entry of SETTINGS_INVENTORY)
			expect(SETTINGS_SECTIONS).toContain(entry.section);
	});
});

describe("agents configuration revision", () => {
	test("a write names the revision it read and is refused after another change", () => {
		withConfig(BASE_CONFIG, () => {
			const file = process.env.HERDR_WORKFLOW_CONFIG as string;
			const revision = loadAgentConfig().revision;
			expect(revision).toBe(agentConfigRevision());

			// Another client changes the agents section after the editor loaded it.
			updateConfig(file, (document) => {
				const agents = document.agents as Record<string, unknown>;
				(agents.profiles as Record<string, unknown>).c = {
					runtime: "pi-durable",
				};
			});

			expect(() =>
				applyAgentsMutation(
					{
						kind: "set-profile",
						name: "b",
						profile: { runtime: "pi-durable" },
					},
					undefined,
					revision,
				),
			).toThrow(/changed since it was loaded/);
			// The other client's change is still there: nothing was overwritten.
			expect(fs.readFileSync(file, "utf8")).toContain('"c"');

			// Re-reading and naming the current revision succeeds.
			const current = loadAgentConfig().revision;
			expect(current).not.toBe(revision);
			applyAgentsMutation(
				{ kind: "set-profile", name: "b", profile: { runtime: "pi-durable" } },
				undefined,
				current,
			);
			expect(loadAgentConfig().agents.profiles.b?.runtime).toBe("pi-durable");
			expect(loadAgentConfig().agents.profiles.c?.runtime).toBe("pi-durable");
		});
	});

	test("the revision depends on the agents section, not on unrelated keys", () => {
		withConfig(BASE_CONFIG, () => {
			const file = process.env.HERDR_WORKFLOW_CONFIG as string;
			const before = loadAgentConfig().revision;
			updateConfig(file, (document) => {
				document.workflow = { max_verification_rounds: 9 };
			});
			expect(loadAgentConfig().revision).toBe(before);
			// A caller that never tracks a revision may still write.
			applyAgentsMutation(
				{ kind: "set-profile", name: "b", profile: { runtime: "pi-durable" } },
				undefined,
				before,
			);
			expect(loadAgentConfig().agents.profiles.b?.runtime).toBe("pi-durable");
		});
	});

	test("a preset edit preserves role tables outside the edited fields", () => {
		withConfig(BASE_CONFIG, () => {
			const current = loadAgentConfig().agents.presets?.p;
			// The editor's own shaping: only the pool fields are rewritten, and
			// arbitrary role tables survive verbatim.
			applyAgentsMutation(
				{
					kind: "set-preset",
					name: "p",
					preset: {
						steps: { ...current?.steps, "core.implementation": "b" },
						roles: { ...current?.roles },
						pools: {
							"core.implementation": [
								{ label: "a", profile: "b", default: true },
							],
						},
					},
				},
				undefined,
				loadAgentConfig().revision,
			);
			const preset = loadAgentConfig().agents.presets?.p;
			expect(preset?.steps?.["core.implementation"]).toBe("b");
			expect(preset?.pools?.["core.implementation"]?.[0]?.profile).toBe("b");
			// An arbitrary role table survives verbatim.
			expect(preset?.roles?.["custom.step"]?.["custom-role"]).toBe("b");
		});
	});
});

describe("subsequent starts versus a running workflow's resolved routing", () => {
	const baseConfig = {
		default_profile: "a",
		profiles: { a: { runtime: "pi-durable" }, b: { runtime: "pi-durable" } },
	} as const;
	const registry = registerBuiltins();

	test("a saved preset affects the next start and is not re-resolved for the running one", () => {
		const definition = registry.definition("no-openspec", 1);
		const roles = { "core.implementation": ["worker"] };
		const profileFor = (
			routes: ReadonlyArray<{ stepId: string; profile: { name: string } }>,
		) =>
			routes.find((route) => route.stepId === "core.implementation")?.profile
				.name;
		const before = parseAgentsConfig({
			...baseConfig,
			profiles: { ...baseConfig.profiles },
			presets: {
				p: {
					pools: {
						"core.implementation": [
							{ label: "a", profile: "a", default: true },
						],
					},
				},
			},
		});
		const started = startRouting(
			"no-openspec",
			"p",
			definition,
			registry,
			before,
		);
		expect(profileFor(started.routes)).toBe("a");

		// The preset is saved with a different assignment for the next start.
		const after = parseAgentsConfig({
			...baseConfig,
			profiles: { ...baseConfig.profiles },
			presets: {
				p: {
					pools: {
						"core.implementation": [
							{ label: "b", profile: "b", default: true },
						],
					},
				},
			},
		});
		// The running workflow keeps its own resolved routing (it is recorded in the
		// run input, not re-resolved), while a new start sees the new preset.
		expect(profileFor(started.routes)).toBe("a");
		expect(
			profileFor(
				startRouting("no-openspec", "p", definition, registry, after).routes,
			),
		).toBe("b");
		// Resolution still follows preset roles > steps > preset default.
		const resolved = resolveRouting(
			definition,
			roles,
			after,
			resolvePreset(after, "p"),
		);
		expect(profileFor(resolved.routes)).toBe("b");
	});
});

describe("orchestrator monitor configuration", () => {
	test("the picker's write stores the mode, refuses an unknown one, and drops the default", () => {
		withConfig(BASE_CONFIG, () => {
			applyAgentsMutation(
				{
					kind: "set-orchestrator",
					orchestrator: {
						model: "vendor/m",
						thinking: "high",
						monitor: "notify",
					},
				},
				undefined,
				loadAgentConfig().revision,
			);
			expect(loadAgentConfig().agents.orchestrator).toEqual({
				model: "vendor/m",
				thinking: "high",
				monitor: "notify",
			});
			// A mode the parser would refuse never reaches the file.
			expect(() =>
				applyAgentsMutation(
					{
						kind: "set-orchestrator",
						orchestrator: { monitor: "loud" },
					},
					undefined,
					loadAgentConfig().revision,
				),
			).toThrow(/monitor must be one of wake, notify, off/);
			expect(loadAgentConfig().agents.orchestrator?.monitor).toBe("notify");
			// Selecting the default row removes the key: an absent mode is `wake`.
			applyAgentsMutation(
				{
					kind: "set-orchestrator",
					orchestrator: { model: "vendor/m", thinking: "high" },
				},
				undefined,
				loadAgentConfig().revision,
			);
			expect(loadAgentConfig().agents.orchestrator?.monitor).toBeUndefined();
			expect(loadAgentConfig().agents.orchestrator?.model).toBe("vendor/m");
		});
	});

	test("a session edit preserves the file-only event bounds", () => {
		withConfig(
			{
				agents: {
					...BASE_CONFIG.agents,
					orchestrator: {
						stall_minutes: 45,
						reconcile_seconds: 60,
					},
				},
			},
			() => {
				applyAgentsMutation(
					{
						kind: "set-orchestrator",
						orchestrator: { model: "vendor/m", thinking: "high" },
					},
					undefined,
					loadAgentConfig().revision,
				);
				// Neither has an editor here, so an unrelated session edit must not
				// drop the developer's bound from the configuration file.
				expect(loadAgentConfig().agents.orchestrator).toEqual({
					model: "vendor/m",
					thinking: "high",
					stall_minutes: 45,
					reconcile_seconds: 60,
				});
			},
		);
	});
});

describe("remote settings reads fail without a local fallback", () => {
	test("an unavailable server is an error, not local configuration", async () => {
		await expect(readProviderStatus("http://127.0.0.1:1")).rejects.toThrow();
		await expect(
			readProjectStatus({ baseUrl: "http://127.0.0.1:1" }),
		).rejects.toThrow();
	});
});

describe("section items surface every inventoried setting", () => {
	/** A snapshot covering every section with one entry of each kind. */
	function context(section: SettingsSection): SettingsContext {
		return {
			themes: ["catppuccin", "dracula"],
			activeTheme: "catppuccin",
			clientSettingsPath: "/tmp/tui.json",
			section,
			agents: {
				scope: "project",
				projectIdent: "checkout",
				repository: "/repo/checkout",
				source: "project",
				files: ["/repo/checkout/.pi/herdr-workflow.toml"],
				conflicts: [],
				profiles: [{ name: "pi-a", value: "pi · a/b" }],
				presets: [{ name: "p", value: "1 steps" }],
				routing: [{ label: "Default profile", value: "pi-a" }],
			},
			providers: {
				state: "ready",
				providers: [
					{
						name: "github",
						type: "github",
						username: "octocat",
						hasToken: true,
						invalid: false,
					},
				],
			},
			// One stage with one role and one credential, so the section renders a
			// row for every kind of inventoried setting: the catalog, the credential
			// and the identity cache's bounds and its entries.
			stages: {
				configDir: "/tmp/agentic-coding",
				stages: [
					{
						ident: "grid-int",
						displayName: "Grid integration",
						environment: "integration",
						system: "grid",
						access: "read-only",
						exclusive: false,
						apps: [
							{
								key: "web",
								label: "Grid web",
								url: "https://grid-int.example.test/",
								kind: "ui",
								roles: [
									{
										role: "clerk",
										login: "web-form",
										loginKind: "form",
										credentialStatus: "missing GRID_INT_CLERK_PASSWORD",
										loginMode: "handoff",
										cacheable: true,
										credentials: [
											{
												field: "password",
												variable: "GRID_INT_CLERK_PASSWORD",
												status: "missing GRID_INT_CLERK_PASSWORD",
											},
										],
									},
								],
							},
						],
						origins: ["https://grid-int.example.test"],
						readOnlyExceptions: [],
						limits: {
							maxSessions: 1,
							maxActionsPerMinute: 30,
							maxWaitSeconds: 120,
							maxScreenshots: 20,
							maxRecordingMinutes: 5,
							maxLoginHandoffSeconds: 900,
						},
						identityCache: {
							enabled: true,
							ttlMinutes: 240,
							maxEntries: 8,
							refreshSeconds: 120,
						},
						data: {},
						wiki: { processes: [] },
						diagnostics: [],
					},
				],
				excluded: [],
			},
			stageIdentities: {
				entries: [
					{
						stage: "grid-int",
						role: "clerk",
						capturedAt: Date.now() - 60_000,
						expiresAt: Date.now() + 60_000,
						truncated: 0,
					},
				],
			},
		};
	}

	const sections: SettingsSection[] = [...SETTINGS_SECTIONS];

	test("every inventory entry has at least one rendered item", () => {
		for (const section of sections) {
			const items = settingsItems(context(section));
			for (const entry of inventoryBySection(section)) {
				const matches = entry.items.filter((prefix) =>
					items.some((item) => item.id.startsWith(prefix)),
				);
				expect(matches.length).toBeGreaterThan(0);
			}
		}
	});

	test("the identity cache shows its bounds, one row per key, and all three forget scopes", () => {
		// `add-stage-identity-cache` task 3.1: the rows a developer reads and
		// activates. The ids alone would pass the inventory test whatever they
		// said, so each row's *value* and *action* is pinned here.
		const base = context("stages");
		const stage = base.stages?.stages[0];
		if (!stage) throw new Error("the fixture must carry one stage");
		const items = settingsItems({
			...base,
			stageIdentities: {
				entries: [
					{
						stage: "grid-int",
						role: "clerk",
						capturedAt: Date.now() - 60_000,
						expiresAt: Date.now() + 10_800_000,
						// A capture that hit the bounds: the row says so, and says
						// nothing about *what* was dropped.
						truncated: 3,
					},
					{
						stage: "grid-int",
						role: "admin",
						capturedAt: Date.now() - 30_000,
						expiresAt: Date.now() + 10_830_000,
						truncated: 0,
					},
					// A stage the allow-list no longer names: the entries outlive the
					// file, so they still have to be reachable and forgettable.
					{
						stage: "retired",
						role: "clerk",
						capturedAt: Date.now() - 5_000,
						expiresAt: Date.now() + 10_855_000,
						truncated: 0,
					},
				],
			},
		});
		const bounds = items.find((item) => item.id === "stages.identity.grid-int");
		expect(bounds?.value).toContain("ttl 240 min");
		expect(bounds?.value).toContain("server-wide cap 8 entries");
		expect(bounds?.value).toContain("2 cached");
		expect(bounds?.editable).toBe(true);
		// Enter on the bounds row is the stage-wide scope: one forget for every role
		// of that stage, and the action names no role.
		expect(bounds?.action).toEqual({
			kind: "stage-identity-forget",
			stage: "grid-int",
			label: "all 2 cached sign-ins of Grid integration",
		});
		const clerk = items.find(
			(item) => item.id === "stages.identity.grid-int.clerk",
		);
		expect(clerk?.action).toEqual({
			kind: "stage-identity-forget",
			stage: "grid-int",
			role: "clerk",
			label: "clerk · Grid integration",
		});
		expect(clerk?.value).toContain("captured 1 min ago");
		expect(clerk?.value).toContain("expires in 180 min");
		// The count of dropped values is reported; the row that stored whole says
		// nothing about dropping.
		expect(clerk?.value).toContain("3 values");
		const admin = items.find(
			(item) => item.id === "stages.identity.grid-int.admin",
		);
		expect(admin?.value).not.toContain("values");
		// The row says what is held, never what it holds.
		expect(JSON.stringify(clerk)).not.toContain("SENT");
		const orphan = items.find(
			(item) => item.id === "stages.identity.orphan.retired",
		);
		expect(orphan?.action).toEqual({
			kind: "stage-identity-forget",
			stage: "retired",
			label: "the cached sign-ins of the stage retired",
		});
		expect(
			items.some((item) => item.id === "stages.identity.retired.clerk"),
		).toBe(true);
		// The widest scope is one row, last in the section, naming no key at all.
		const all = items.find((item) => item.id === "stages.identity.all");
		expect(all?.action).toEqual({
			kind: "stage-identity-forget",
			label: "all 3 cached sign-ins",
		});
		expect(all?.value).toBe("3 cached · server-wide");
		if (!all) throw new Error("the forget-all row must exist");
		if (!orphan) throw new Error("the orphan row must exist");
		expect(items.indexOf(all)).toBeGreaterThan(items.indexOf(orphan));
	});

	test("an armed wide forget says so on its own row", () => {
		// The confirmation lives in a signal the shell owns; a row that never renders
		// it makes the second Enter invisible until something is forgotten (USAB-302).
		const base = context("stages");
		const armed = settingsItems({
			...base,
			stageIdentityArmed: { stage: "grid-int" },
		});
		const bounds = armed.find((item) => item.id === "stages.identity.grid-int");
		expect(bounds?.value).toContain("armed: press Enter again");
		expect(bounds?.detail).toContain("this one forgets them");
		// Only the armed scope's row: the widest row and another stage's keep their
		// ordinary text.
		expect(
			armed.find((item) => item.id === "stages.identity.all")?.value,
		).not.toContain("armed");
		const everything = settingsItems({ ...base, stageIdentityArmed: {} });
		expect(
			everything.find((item) => item.id === "stages.identity.all")?.value,
		).toContain("armed: press Enter again");
		expect(
			everything.find((item) => item.id === "stages.identity.grid-int")?.value,
		).not.toContain("armed");
		// A one-press `(stage, role)` row is never armed, so nothing on the section
		// claims a confirmation that does not exist.
		expect(
			settingsItems({
				...base,
				stageIdentityArmed: { stage: "grid-int", role: "clerk" },
			}).find((item) => item.id === "stages.identity.grid-int")?.value,
		).not.toContain("armed");
	});

	test("a forget leaves the cursor where one Enter cannot forget an unchosen key", () => {
		// Forgetting one `(stage, role)` removes its row, and the index it held now
		// names a sibling entry row — a *one-press* forget. Landing there would let
		// the next Enter silently drop a sign-in nobody chose (USAB-301).
		const base = context("stages");
		const withTwo = (entries: SettingsContext["stageIdentities"]) =>
			settingsItems({
				...base,
				stageIdentities: entries,
			});
		const entry = (role: string) => ({
			stage: "grid-int",
			role,
			capturedAt: Date.now() - 60_000,
			expiresAt: Date.now() + 10_800_000,
			truncated: 0,
		});
		const before = withTwo({ entries: [entry("clerk"), entry("admin")] });
		const from = before.findIndex(
			(item) => item.id === "stages.identity.grid-int.admin",
		);
		expect(from).toBeGreaterThan(0);
		// What the section renders once the admin's sign-in is gone: the clerk's entry
		// row now sits where the admin's was.
		const after = withTwo({ entries: [entry("clerk")] });
		const landed = identityForgetAnchor(
			after,
			{ stage: "grid-int", role: "admin" },
			from,
		);
		const row = after[landed];
		expect(row?.id).not.toBe("stages.identity.grid-int.clerk");
		// It is the stage's own bounds row: an arm again, never a forgot-this-second.
		expect(row?.id).toBe("stages.identity.grid-int");
		// The same for the widest scope: with every entry gone the section keeps no
		// forget row at all, so the cursor steps up to something inert.
		const everything = withTwo({ entries: [] });
		const landedWide = identityForgetAnchor(
			everything,
			{},
			everything.findIndex((item) => item.id === "stages.identity.grid-int") +
				1,
		);
		expect(everything[landedWide]?.action.kind).not.toBe(
			"stage-identity-forget",
		);
		// And with nothing to fall back to it never leaves the list.
		expect(identityForgetAnchor([], { stage: "grid-int" }, 5)).toBe(0);
	});

	test("an identity listing that was never read says unknown, not empty", () => {
		const base = context("stages");
		const items = settingsItems({ ...base, stageIdentities: undefined });
		const bounds = items.find((item) => item.id === "stages.identity.grid-int");
		// "0 cached" would be a claim about a cache nobody read (TESTQ-017).
		expect(bounds?.value).toContain("contents unknown");
		expect(bounds?.value).not.toContain("0 cached");
		// Nothing to forget, so nothing is offered: an armed row over an unknown
		// listing is an action whose count nobody knows.
		expect(bounds?.editable).toBe(false);
		expect(bounds?.action).toEqual({ kind: "none" });
		expect(items.some((item) => item.id === "stages.identity.all")).toBe(false);
	});

	test("a failed identity read is reported on its own rows, and the catalog stays usable", () => {
		const base = context("stages");
		const items = settingsItems({
			...base,
			stageIdentities: undefined,
			stageIdentityError: "the server answered 503",
		});
		const unreadable = items.find(
			(item) => item.id === "stages.identity.unreadable",
		);
		expect(unreadable?.value).toBe("unreadable");
		expect(unreadable?.detail).toContain("the server answered 503");
		expect(unreadable?.editable).toBe(false);
		// The credential rows are what the section is for, and a failed identity
		// read never hides them.
		expect(
			items.some(
				(item) =>
					item.id.startsWith("stages.") && item.id.includes("credential"),
			),
		).toBe(true);
	});

	test("a stage that opted out says so, and its row forgets nothing", () => {
		const base = context("stages");
		const catalog = base.stages;
		const stage = catalog?.stages[0];
		if (!catalog || !stage) throw new Error("the fixture must carry one stage");
		const items = settingsItems({
			...base,
			stages: {
				...catalog,
				stages: [
					{
						...stage,
						identityCache: {
							...(stage.identityCache ?? {
								ttlMinutes: 240,
								maxEntries: 8,
								refreshSeconds: 120,
							}),
							enabled: false,
						},
					},
				],
			},
			stageIdentities: { entries: [] },
		});
		const bounds = items.find((item) => item.id === "stages.identity.grid-int");
		expect(bounds?.value).toBe("off (identityCache: false)");
		expect(bounds?.editable).toBe(false);
		expect(bounds?.action).toEqual({ kind: "none" });
		// Nothing is cached, so there is no entry row and no forget-all row.
		expect(
			items.some((item) => item.id.startsWith("stages.identity.grid-int.")),
		).toBe(false);
		expect(items.some((item) => item.id === "stages.identity.all")).toBe(false);
	});

	test("the orchestrator row carries the monitor mode the config stores", () => {
		const entry = inventoryBySection("agents").find(
			(candidate) => candidate.id === "agents.orchestrator",
		);
		expect(entry?.storage).toContain("monitor");
		const base = context("agents");
		const items = settingsItems({
			...base,
			agents: {
				...base.agents,
				orchestrator: {
					model: "vendor/m",
					thinking: "high",
					monitor: "notify",
				},
			},
		});
		const item = items.find(
			(candidate) => candidate.id === "agents.orchestrator",
		);
		expect(item?.label).toBe("Orchestrator session");
		expect(item?.value).toBe("vendor/m · high · monitor notify");
		// An absent mode reads as the default, never as an empty value.
		const unset = settingsItems({
			...base,
			agents: { ...base.agents, orchestrator: undefined },
		});
		expect(
			unset.find((candidate) => candidate.id === "agents.orchestrator")?.value,
		).toContain("monitor wake");
	});

	test("every rendered item belongs to an inventoried setting", () => {
		for (const section of sections) {
			const entries = inventoryBySection(section);
			for (const item of settingsItems(context(section)))
				expect(
					entries.some((entry) =>
						entry.items.some((prefix) => item.id.startsWith(prefix)),
					),
				).toBe(true);
		}
	});

	test("provider credentials are shown as status only", () => {
		const items = settingsItems(context("providers"));
		const provider = items.find((item) => item.id === "providers.github");
		expect(provider?.detail).toContain(
			"credential stored on the server (masked)",
		);
		const credentials = items.find(
			(item) => item.id === "providers.credentials",
		);
		expect(credentials?.editable).toBe(false);
		expect(credentials?.value).toBe("1 stored");
		// No credential value can appear in a rendered item.
		expect(JSON.stringify(items)).not.toMatch(/token/i);
	});

	test("an unavailable server renders a retry instead of an edit", () => {
		const offline = {
			...context("providers"),
			providers: { state: "error" as const, providers: [], error: "401" },
		};
		const items = settingsItems(offline);
		expect(items.map((item) => item.id)).toEqual([
			"providers.error",
			"providers.retry",
		]);
		expect(items[0]?.detail).toContain("no local configuration was written");
		expect(items[1]?.action).toEqual({ kind: "retry" });
	});
});

describe("settings writes and reads fail safely", () => {
	test("an obsolete write target is refused before anything is created", () => {
		// An explicit replacement file pointing at an obsolete path must not be
		// materialized with JSON contents: the reader would then reject it, and a
		// write into a path the previous build refused would be silent.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-write-target-"));
		const obsolete = path.join(dir, "herdr-workflow.toml");
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = obsolete;
		try {
			expect(() => saveAgentsSection(() => {})).toThrow(
				/is not the current JSON configuration format/,
			);
			expect(() => saveSidebarMode("permanent")).toThrow(
				/is not the current JSON configuration format/,
			);
			expect(fs.existsSync(obsolete)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unauthorized server read is reported, never replaced by local state", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					JSON.stringify({
						error: {
							code: "unauthorized",
							message: "missing instance capability",
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		});
		try {
			await expect(
				readProviderStatus(`http://127.0.0.1:${server.port}`),
			).rejects.toThrow(/401/);
			await expect(
				readProjectStatus({ baseUrl: `http://127.0.0.1:${server.port}` }),
			).rejects.toThrow(/401/);
		} finally {
			await server.stop(true);
		}
	});

	test("a provider's stored secret is never decoded into the settings snapshot", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json([
					{
						name: "github",
						type: "github",
						username: "octocat",
						has_token: true,
						// A server that over-shares must not leak through this reader.
						token: "ghp_super_secret_value",
					},
				]),
		});
		try {
			const providers = await readProviderStatus(
				`http://127.0.0.1:${server.port}`,
			);
			expect(providers).toEqual([
				{
					name: "github",
					type: "github",
					username: "octocat",
					hasToken: true,
					invalid: false,
				},
			]);
			expect(JSON.stringify(providers)).not.toContain("ghp_super_secret_value");
		} finally {
			await server.stop(true);
		}
	});

	test("a failed theme save leaves the last valid preference file intact", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-perms-"));
		process.env.AGENTIC_CODING_CONFIG_DIR = dir;
		const file = path.join(dir, "tui.json");
		fs.writeFileSync(file, `${JSON.stringify({ theme: "catppuccin" })}\n`);
		try {
			if (process.getuid?.() === 0) return; // root bypasses the permission bit
			fs.chmodSync(dir, 0o500);
			expect(() => saveThemeName("dracula")).toThrow();
			fs.chmodSync(dir, 0o700);
			expect(fs.readFileSync(file, "utf8")).toContain("catppuccin");
		} finally {
			fs.chmodSync(dir, 0o700);
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
