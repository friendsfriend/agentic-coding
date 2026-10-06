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
	agentMenuInformationalItems,
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
	test("a leftover legacy configuration is surfaced as an inactive source", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-legacy-"));
		try {
			const root = path.join(dir, "agentic-coding");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(
				path.join(root, "config.toml"),
				'[agents]\ndefault_profile = "legacy"\n',
			);
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
				// The canonical JSON wins and the leftover TOML is reported, not merged.
				expect(resolved.agents.default_profile).toBe("current");
				expect(resolved.provenance.source).toBe("user");
				expect(resolved.provenance.inactiveFiles).toEqual([
					path.join(root, "config.toml"),
				]);

				const items = settingsItems({
					themes: ["catppuccin"],
					activeTheme: "catppuccin",
					clientSettingsPath: "/tmp/tui.json",
					section: "agents",
					agents: {
						scope: "user",
						source: resolved.provenance.source,
						files: resolved.provenance.files,
						inactiveFiles: resolved.provenance.inactiveFiles,
						conflicts: [],
						profiles: [],
						presets: [],
						routing: [],
					},
					providers: { state: "ready", providers: [] },
				});
				const inactive = items.find((item) =>
					item.id.startsWith("agents.inactive."),
				);
				expect(inactive?.value).toBe(path.join(root, "config.toml"));
				expect(inactive?.detail).toContain("read-only compatibility");
				expect(inactive?.editable).toBe(false);
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

	test("a session edit preserves the file-only launch limits", () => {
		withConfig(
			{
				agents: {
					...BASE_CONFIG.agents,
					orchestrator: {
						limits: { max_active: 1, max_starts_per_day: 2 },
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
				// The ceiling has no editor here, so an unrelated session edit must not
				// drop the developer's guard from the configuration file.
				expect(loadAgentConfig().agents.orchestrator).toEqual({
					model: "vendor/m",
					thinking: "high",
					limits: { max_active: 1, max_starts_per_day: 2 },
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

	test("the launch-limits row states the enforced ceiling and marks the default", () => {
		const base = context("agents");
		const row = (agents: Partial<SettingsContext["agents"]>) =>
			settingsItems({ ...base, agents: { ...base.agents, ...agents } }).find(
				(item) => item.id === "agents.launch-limits",
			);
		// Nothing configured: the defaults are named, and the row is read-only.
		const defaults = row({});
		expect(defaults?.value).toBe("3 active · 20 starts per 24 h (defaults)");
		expect(defaults?.editable).toBe(false);
		// A configured ceiling is shown without the default marker, and a single
		// start is not pluralized.
		expect(
			row({
				orchestratorLimits: { maxActive: 1, maxStartsPerDay: 1 },
				orchestratorLimitsConfigured: true,
			})?.value,
		).toBe("1 active · 1 start per 24 h");
		// The row is not merely inventoried: it is one of the informational rows the
		// Agent Presets menu renders, so the ceiling reaches the screen.
		expect(
			agentMenuInformationalItems(settingsItems(base)).some(
				(item) => item.id === "agents.launch-limits",
			),
		).toBe(true);
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
		process.env.DEVENV_CONFIG_DIR = dir;
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
			delete process.env.DEVENV_CONFIG_DIR;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
