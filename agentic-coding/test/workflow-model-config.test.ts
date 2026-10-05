import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fusionPlannerCount,
	presetCatalog,
	startRouting,
} from "../src/server/operations/engine.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentsConfigPath,
	conflictingAgentsFiles,
	saveAgentsSection,
	selectAgentsConfigPath,
} from "../src/workflow/effects.ts";
import {
	type AgentsConfig,
	parseAgentsConfig,
	resolveGatePolicies,
	resolvePreset,
	resolveProfile,
	resolveRouting,
	validatePresetCoverage,
} from "../src/workflow/profiles.ts";

describe("agent configuration presets", () => {
	const baseConfig = {
		default_profile: "d",
		profiles: {
			d: { runtime: "pi-durable" },
			a: { runtime: "pi-durable" },
			b: { runtime: "pi-durable" },
		},
	};
	test("preset validation errors name preset, entry, and unknown profile", () => {
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { x: { steps: { "core.plan": "missing" } } },
			}),
		).toThrow(/preset x: unknown profile missing for step core.plan/);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: {
					y: { roles: { "core.verification": { "quality-verifier": "nope" } } },
				},
			}),
		).toThrow(/roles\["core.verification"\] was removed/);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { z: { default_profile: "ghost" } },
			}),
		).toThrow(/preset z: unknown profile in default_profile: ghost/);
		// prototype-chain names must fail with the clean validation error
		expect(() =>
			parseAgentsConfig({
				default_profile: "d",
				profiles: { d: { runtime: "constructor" as never } },
			}),
		).toThrow(/invalid runtime in profile d/);
		// profile references resolved through Object.prototype are unknown too
		expect(() =>
			parseAgentsConfig({ default_profile: "constructor", profiles: {} }),
		).toThrow(/unknown default profile: constructor/);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { x: { steps: { "core.plan": "toString" } } },
			}),
		).toThrow(/preset x: unknown profile toString for step core.plan/);
		expect(() =>
			resolveProfile("valueOf", {
				default_profile: "d",
				profiles: { d: { runtime: "pi-durable" } },
			}),
		).toThrow(/unknown agent profile: valueOf/);
	});
	test("pool defaults override preset step assignments for classifiable steps", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("no-openspec", 1);
		const config = parseAgentsConfig({
			...baseConfig,
			default_profile: "d",
			definition_defaults: { "no-openspec": "a" },
			presets: {
				mixed: {
					default_profile: "b",
					steps: { "core.implementation": "a" },
					pools: {
						"core.implementation": [
							{ label: "quick", profile: "b", default: true },
						],
					},
				},
			},
		});
		const preset = resolvePreset(config, "mixed");
		const routing = resolveRouting(
			definition,
			{
				"core.implementation": ["worker"],
				"core.verification": ["quality-verifier", "security-verifier"],
			},
			config,
			preset,
		);
		const names = routing.routes.map((route) => route.profile.name);
		// pool default for the classifiable implementation step, preset default
		// for the remainder
		expect(names).toEqual(["b", "b", "b"]);
		expect(() => resolvePreset(config, "ghost")).toThrow(
			/unknown agent preset: ghost/,
		);
		for (const inherited of ["toString", "constructor", "hasOwnProperty"])
			expect(() => resolvePreset(config, inherited)).toThrow(
				new RegExp(`unknown agent preset: ${inherited}`),
			);
	});
	test("without a preset, routing resolves exactly as before", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("no-openspec", 1);
		const config = parseAgentsConfig(baseConfig);
		const withPresetArg = resolveRouting(
			definition,
			{ "core.implementation": ["worker"] },
			config,
			undefined,
		);
		const without = resolveRouting(
			definition,
			{ "core.implementation": ["worker"] },
			config,
		);
		expect(withPresetArg.routes.map((route) => route.profile.name)).toEqual(
			without.routes.map((route) => route.profile.name),
		);
	});
	test("preset-pinned routing matches equivalent explicit routes", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("no-openspec", 1);
		const roles = {
			"core.implementation": ["worker"],
			"core.verification": ["quality-verifier"],
		};
		const explicit = parseAgentsConfig({
			...baseConfig,
			routes: { "core.implementation": "a" },
			role_routes: { "core.verification": { "quality-verifier": "b" } },
		});
		const presetBased = parseAgentsConfig({
			...baseConfig,
			presets: {
				equiv: {
					pools: {
						"core.implementation": [
							{ label: "quick", profile: "a", default: true },
						],
						"core.verification": [
							{ label: "quality", profile: "b", default: true },
						],
					},
				},
			},
		});
		expect(
			resolveRouting(
				definition,
				roles,
				presetBased,
				resolvePreset(presetBased, "equiv"),
			).routes.map((route) => [route.stepId, route.role, route.profile.name]),
		).toEqual(
			resolveRouting(definition, roles, explicit).routes.map((route) => [
				route.stepId,
				route.role,
				route.profile.name,
			]),
		);
	});
	test("coverage validation names the uncovered step and preset", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("no-openspec", 1);
		const empty = {
			default_profile: "",
			profiles: {},
		} as unknown as AgentsConfig;
		const preset = { name: "thin" };
		expect(() =>
			validatePresetCoverage(preset, definition, ["core.archive"], empty),
		).toThrow(/preset thin does not cover required step: core.archive/);
		const covered = {
			default_profile: "",
			profiles: {},
			routes: { "core.archive": "x" },
		} as unknown as AgentsConfig;
		expect(
			validatePresetCoverage(preset, definition, ["core.archive"], covered),
		).toBeUndefined();
	});
	test("routed coverage requires a pool for every classifiable step", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("openspec", 1);
		const agents = parseAgentsConfig({
			...baseConfig,
			presets: {
				thin: {
					pools: {
						"core.plan": [{ label: "a", profile: "d", default: true }],
					},
				},
			},
		});
		const preset = resolvePreset(agents, "thin");
		expect(() =>
			validatePresetCoverage(preset, definition, [], agents),
		).toThrow(
			/preset thin has no model pool for classifiable step core\.implementation/,
		);
	});
	test("pool entry rules are rejected at parse", () => {
		const profile = { runtime: "pi-durable" as const };
		expect(() =>
			parseAgentsConfig({
				profiles: { a: profile, b: profile },
				presets: {
					double: {
						pools: {
							"core.plan": [
								{ label: "x", profile: "a", default: true },
								{ label: "y", profile: "b", default: true },
							],
						},
					},
				},
			}),
		).toThrow(/needs exactly one entry marked default/);
		expect(() =>
			parseAgentsConfig({
				profiles: { a: profile },
				presets: {
					dup: {
						pools: {
							"core.plan": [
								{ label: "x", profile: "a", default: true },
								{ label: "x", profile: "a" },
							],
						},
					},
				},
			}),
		).toThrow(/duplicate label x in pool core\.plan/);
		expect(() =>
			parseAgentsConfig({
				profiles: { a: profile },
				presets: {
					unknown: {
						pools: {
							"core.plan": [{ label: "x", profile: "missing", default: true }],
						},
					},
				},
			}),
		).toThrow(/unknown profile missing in pool core\.plan entry x/);
	});
});

describe("agents section write-back", () => {
	test("parent scalar fields survive child edits", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-parent-fields-"));
		const file = path.join(dir, "config.json");
		fs.writeFileSync(
			file,
			`${JSON.stringify(
				{
					agents: {
						profiles: { "pi-a": { runtime: "pi-durable" } },
						presets: {
							base: {
								default_profile: "pi-a",
								pools: {
									"core.plan": [{ label: "a", profile: "pi-a", default: true }],
								},
							},
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			saveAgentsSection((section) => {
				section.default_profile = "pi-a";
			});
			const agents = parseAgentsConfig(
				(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
					.agents,
			);
			expect(agents.default_profile).toBe("pi-a");
			expect(agents.profiles["pi-a"]?.runtime).toBe("pi-durable");
			expect(agents.presets?.base?.default_profile).toBe("pi-a");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("round-trip preserves profiles, presets, routes, and unrelated sections", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-write-"));
		const file = path.join(dir, "config.json");
		fs.writeFileSync(
			file,
			`${JSON.stringify(
				{
					workflow: {
						max_verification_rounds: 6,
						remote: "origin",
						branch_prefix: "feature/",
						base_branch: "origin/HEAD",
					},
					ui: { theme: "catppuccin", selection_height: 10 },
					agents: {
						default_profile: "pi-a",
						profiles: { "pi-a": { runtime: "pi-durable", model: "a/b" } },
						routes: { "core.plan": "pi-a" },
						presets: {
							base: {
								default_profile: "pi-a",
								steps: { "core.plan": "pi-a" },
								pools: {
									"core.plan": [{ label: "a", profile: "pi-a", default: true }],
								},
							},
						},
					},
					telemetry: { capture_content: true },
				},
				null,
				2,
			)}\n`,
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(agentsConfigPath()).toBe(file);
			saveAgentsSection((section) => {
				const profiles = section.profiles as Record<string, unknown>;
				profiles["oc-worker"] = { runtime: "pi-durable" };
				const presets = section.presets as Record<string, unknown>;
				presets.extra = {
					default_profile: "pi-a",
					steps: { "core.archive": "pi-a" },
					pools: {
						"core.archive": [{ label: "a", profile: "pi-a", default: true }],
					},
				};
			});
			const reparsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
				string,
				Record<string, unknown>
			>;
			expect(reparsed.workflow).toEqual({
				max_verification_rounds: 6,
				remote: "origin",
				branch_prefix: "feature/",
				base_branch: "origin/HEAD",
			});
			expect(reparsed.ui.theme).toBe("catppuccin");
			expect(reparsed.telemetry.capture_content).toBe(true);
			const agents = parseAgentsConfig(reparsed.agents);
			expect(agents.default_profile).toBe("pi-a");
			expect(agents.profiles["oc-worker"]).toMatchObject({
				runtime: "pi-durable",
			});
			expect(agents.profiles["pi-a"]?.model).toBe("a/b");
			expect(agents.routes?.["core.plan"]).toBe("pi-a");
			expect(agents.presets?.base?.default_profile).toBe("pi-a");
			expect(agents.presets?.extra?.steps?.["core.archive"]).toBe("pi-a");
			saveAgentsSection((section) => {
				delete (section.presets as Record<string, unknown>).extra;
			});
			const afterDelete = parseAgentsConfig(
				(
					JSON.parse(fs.readFileSync(file, "utf8")) as Record<
						string,
						Record<string, unknown>
					>
				).agents,
			);
			expect(afterDelete.presets && "extra" in afterDelete.presets).toBe(false);
			expect(afterDelete.presets?.base?.steps?.["core.plan"]).toBe("pi-a");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("config merge hardening", () => {
	test("loadConfig ignores literal __proto__ keys from config files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-merge-"));
		const file = path.join(dir, "config.json");
		// A raw JSON literal: an object literal `__proto__` key would set the
		// prototype instead of producing the hostile own property under test.
		fs.writeFileSync(
			file,
			'{"__proto__":{"isAdmin":true},"workflow":{"max_verification_rounds":6,"remote":"origin","branch_prefix":"feature/","base_branch":"origin/HEAD"}}\n',
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			const { loadConfig } = await import("../src/workflow/effects.ts");
			const cfg = loadConfig() as unknown as Record<string, unknown>;
			expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
			expect(cfg.isAdmin).toBeUndefined();
			expect((cfg.workflow as Record<string, unknown>).remote).toBe("origin");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("write-back target selection", () => {
	// The canonical configuration root is an independent resolver input; these
	// fixtures model it inside the fixture home.
	const rootFor = (home: string) =>
		path.join(home, ".config", "agentic-coding");
	const selectTarget = (
		envPath: string | undefined,
		home: string,
		cwd: string,
	) => selectAgentsConfigPath(envPath, home, cwd, rootFor(home));

	test("agentsConfigPath prefers files that actually supply [agents]", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-target-"));
		const home = path.join(dir, "home");
		try {
			fs.mkdirSync(path.join(home, ".config", "agentic-coding"), {
				recursive: true,
			});
			fs.mkdirSync(path.join(dir, "repo", ".pi"), { recursive: true });
			const noAgents = path.join(
				home,
				".config",
				"agentic-coding",
				"config.json",
			);
			fs.writeFileSync(noAgents, '{ "ui": { "theme": "catppuccin" } }\n');
			const projectFile = path.join(dir, "repo", ".pi", "herdr-workflow.json");

			// nothing exists -> canonical JSON config path is created on save
			expect(selectTarget(undefined, path.join(dir, "none"), dir)).toBe(
				path.join(dir, "none", ".config", "agentic-coding", "config.json"),
			);
			// no candidate defines agents -> highest-priority existing file
			expect(selectTarget(undefined, home, dir)).toBe(noAgents);
			// project file defines agents and outranks them all despite merge order
			fs.writeFileSync(
				projectFile,
				'{ "agents": { "default_profile": "p" } }\n',
			);
			expect(selectTarget(undefined, home, path.join(dir, "repo"))).toBe(
				projectFile,
			);
			// when BOTH base and project define [agents], project wins at load
			// precedence (deep-merged over base), so it is the write-back target
			fs.writeFileSync(
				noAgents,
				'{ "agents": { "default_profile": "base" } }\n',
			);
			expect(selectTarget(undefined, home, path.join(dir, "repo"))).toBe(
				projectFile,
			);
			// base defines agents but project does not supply one -> base is target
			fs.rmSync(projectFile);
			expect(selectTarget(undefined, home, dir)).toBe(noAgents);
			// QUALITY-001 regression: legacy supplies [agents] while the winning
			// base (canonical JSON config) does not — loadConfig never reads the
			// legacy file in that setup, so edits must go to the canonical file
			const legacyFile = path.join(home, ".pi", "agent", "herdr-workflow.toml");
			fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
			fs.writeFileSync(legacyFile, '[agents]\ndefault_profile = "legacy"\n');
			expect(selectTarget(undefined, home, dir)).toBe(noAgents);
			// A legacy TOML overlay supplying [agents] is still the effective
			// source, so it is selected — and then refused by the writer.
			const legacyOverlay = path.join(
				dir,
				"repo",
				".pi",
				"herdr-workflow.toml",
			);
			fs.writeFileSync(legacyOverlay, '[agents]\ndefault_profile = "p"\n');
			expect(selectTarget(undefined, home, path.join(dir, "repo"))).toBe(
				legacyOverlay,
			);
			fs.rmSync(legacyOverlay);
			// explicit env always wins
			expect(
				selectTarget("/custom/config.json", home, path.join(dir, "repo")),
			).toBe("/custom/config.json");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("saveAgentsSection writes back to the resolved target file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-save-"));
		const file = path.join(dir, "config.json");
		fs.writeFileSync(
			file,
			`${JSON.stringify(
				{
					agents: {
						default_profile: "p",
						profiles: { p: { runtime: "pi-durable" } },
					},
				},
				null,
				2,
			)}\n`,
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			saveAgentsSection((section) => {
				(section.presets as Record<string, unknown>) = {
					extra: {
						default_profile: "p",
						pools: {
							"core.plan": [{ label: "a", profile: "p", default: true }],
						},
					},
				};
			});
			const reparsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
				string,
				Record<string, unknown>
			>;
			const agents = parseAgentsConfig(reparsed.agents);
			expect(agents.presets?.extra?.default_profile).toBe("p");
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a legacy TOML write target is refused, never silently converted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-toml-refuse-"));
		const file = path.join(dir, "config.toml");
		fs.writeFileSync(file, '[agents]\ndefault_profile = "p"\n');
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(agentsConfigPath()).toBe(file);
			expect(() => saveAgentsSection(() => {})).toThrow(
				/legacy TOML configuration read for compatibility/,
			);
			expect(fs.readFileSync(file, "utf8")).toBe(
				'[agents]\ndefault_profile = "p"\n',
			);
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("config source conflicts", () => {
	const rootFor = (home: string) =>
		path.join(home, ".config", "agentic-coding");

	test("conflictingAgentsFiles flags base suppliers under a project target", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-conflict-"));
		try {
			const home = path.join(dir, "home");
			fs.mkdirSync(path.join(home, ".config", "agentic-coding"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(home, ".config", "agentic-coding", "config.json"),
				'{ "agents": { "default_profile": "base" } }\n',
			);
			fs.mkdirSync(path.join(dir, "repo", ".pi"), { recursive: true });
			const projectFile = path.join(dir, "repo", ".pi", "herdr-workflow.json");
			fs.writeFileSync(
				projectFile,
				'{ "agents": { "default_profile": "p" } }\n',
			);
			// project target + base supplying [agents] -> base-only deletes resurrect
			expect(
				conflictingAgentsFiles(home, path.join(dir, "repo"), rootFor(home)),
			).toEqual([path.join(home, ".config", "agentic-coding", "config.json")]);
			// base without [agents] -> no conflict
			fs.writeFileSync(
				path.join(home, ".config", "agentic-coding", "config.json"),
				'{ "ui": { "theme": "x" } }\n',
			);
			expect(
				conflictingAgentsFiles(home, path.join(dir, "repo"), rootFor(home)),
			).toEqual([]);
			// non-project targets never conflict
			expect(conflictingAgentsFiles(home, dir, rootFor(home))).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("HERDR_WORKFLOW_CONFIG replaces the whole config incl. project overlay", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-replace-"));
		const prevCwd = process.cwd();
		try {
			const envFile = path.join(dir, "config.toml");
			fs.writeFileSync(
				envFile,
				'[workflow]\nmax_verification_rounds = 3\nremote = "env-origin"\nbranch_prefix = "feature/"\nbase_branch = "origin/HEAD"\n',
			);
			fs.mkdirSync(path.join(dir, "repo", ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "repo", ".pi", "herdr-workflow.json"),
				'{ "workflow": { "remote": "project-origin" } }\n',
			);
			process.env.HERDR_WORKFLOW_CONFIG = envFile;
			process.chdir(path.join(dir, "repo"));
			const { loadConfig } = await import("../src/workflow/effects.ts");
			const cfg = loadConfig();
			// the project overlay must NOT win over the env replacement
			expect(cfg.workflow.remote).toBe("env-origin");
			expect(cfg.workflow.max_verification_rounds).toBe(3);
		} finally {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			process.chdir(prevCwd);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("start argument threading", () => {
	test("startArgs threads the selected preset into workflow start", async () => {
		const { PRESET_CONFIG_DEFAULTS, startArgs } = await import(
			"../src/server/operations/engine.ts"
		);
		expect(
			startArgs({ repo: "/r", ticket: "", workflowId: "c", mode: "worktree" })
				.preset,
		).toBeUndefined();
		expect(
			startArgs({
				repo: "/r",
				ticket: "",
				workflowId: "c",
				mode: "worktree",
				preset: "frontier-plan",
			}).preset,
		).toBe("frontier-plan");
		// the modal's "(config defaults)" sentinel must resolve to no preset
		expect(
			startArgs({
				repo: "/r",
				ticket: "",
				workflowId: "c",
				mode: "worktree",
				preset: PRESET_CONFIG_DEFAULTS,
			}).preset,
		).toBeUndefined();
	});
});

describe("dashboard fusion start routing", () => {
	const baseConfig = {
		default_profile: "d",
		profiles: {
			d: { runtime: "pi-durable" },
			a: { runtime: "pi-durable" },
			b: { runtime: "pi-durable" },
		},
	};
	const registry = registerBuiltins();
	function routesFor(
		definitionId: string,
		agents: AgentsConfig,
		presetName?: string,
	) {
		return startRouting(
			definitionId,
			presetName,
			registry.definition(definitionId, 1),
			registry,
			agents,
		).routes.map((route) => [route.stepId, route.role, route.profile.name]);
	}
	const entry = (name: string) => ({
		label: name,
		profile: name,
		default: true,
	});
	const fusionPools = (planners: string[]) => ({
		"core.plan": [entry("d")],
		"fusion.plan": planners.map(entry),
		"fusion.consolidate": [entry("b")],
		"core.implementation": [entry("d")],
		"core.triage": [entry("d")],
		"core.verification": [entry("d")],
		"core.wiki": [entry("d")],
		"core.archive": [entry("d")],
	});

	test("fusionPlannerCount counts tagged fusion.plan defaults", () => {
		expect(fusionPlannerCount(undefined)).toBe(0);
		expect(
			fusionPlannerCount({
				name: "p",
				pools: { "fusion.plan": [{ label: "a", profile: "a" }] },
			}),
		).toBe(0);
		expect(
			fusionPlannerCount({
				name: "p",
				pools: { "fusion.plan": [entry("a"), entry("b")] },
			}),
		).toBe(2);
	});

	test("valid 2-planner preset creates ordered planner and consolidator routes", () => {
		const agents = parseAgentsConfig({
			...baseConfig,
			presets: { duo: { pools: fusionPools(["a", "b"]) } },
		});
		const routes = routesFor("openspec-fusion", agents, "duo");
		expect(routes.filter(([step]) => step === "fusion.plan")).toEqual([
			["fusion.plan", "planner-1", "a"],
			["fusion.plan", "planner-2", "b"],
		]);
		expect(routes.filter(([step]) => step === "fusion.consolidate")).toEqual([
			["fusion.consolidate", "consolidator", "b"],
		]);
		expect(
			routes
				.filter(([step]) => step === "core.implementation")
				.map((route) => route[2]),
		).toEqual(["d"]);
	});

	test("valid 5-planner preset creates planner-1 through planner-5", () => {
		const agents = parseAgentsConfig({
			...baseConfig,
			profiles: {
				...baseConfig.profiles,
				c: { runtime: "pi-durable" },
				e: { runtime: "pi-durable" },
			},
			presets: { five: { pools: fusionPools(["a", "b", "c", "d", "e"]) } },
		});
		expect(
			routesFor("openspec-fusion", agents, "five").filter(
				([step]) => step === "fusion.plan",
			),
		).toEqual([
			["fusion.plan", "planner-1", "a"],
			["fusion.plan", "planner-2", "b"],
			["fusion.plan", "planner-3", "c"],
			["fusion.plan", "planner-4", "d"],
			["fusion.plan", "planner-5", "e"],
		]);
	});

	test("fusion.plan default counts outside 2-5 are rejected at parse", () => {
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { one: { pools: fusionPools(["a"]) } },
			}),
		).toThrow(/2-5 entries marked default/);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				profiles: {
					...baseConfig.profiles,
					c: { runtime: "pi-durable" },
					e: { runtime: "pi-durable" },
					f: { runtime: "pi-durable" },
				},
				presets: {
					six: { pools: fusionPools(["a", "b", "c", "d", "e", "f"]) },
				},
			}),
		).toThrow(/2-5 entries marked default/);
	});

	test("duplicate fusion.plan default profiles are rejected at parse", () => {
		const pools = fusionPools(["a", "b"]);
		pools["fusion.plan"] = [
			{ label: "one", profile: "d", default: true },
			{ label: "two", profile: "d", default: true },
		];
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { thin: { pools } },
			}),
		).toThrow(/distinct profiles/);
	});

	test("a routed workflow without a preset fails with the Settings hint", () => {
		const agents = parseAgentsConfig(baseConfig);
		expect(() => routesFor("openspec", agents)).toThrow(/requires a preset/);
	});

	test("non-fusion workflows keep their routing without a preset", () => {
		const agents = parseAgentsConfig(baseConfig);
		const routes = routesFor("no-openspec", agents);
		expect(routes.filter(([step]) => step === "core.implementation")).toEqual([
			["core.implementation", "worker", "d"],
		]);
		expect(
			routes.filter(([step]) => step === "core.verification"),
		).toHaveLength(8);
		expect(routes.every(([, , name]) => name === "d")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Stage gate policies (add-jev-stage-gating)
// ---------------------------------------------------------------------------

describe("stage gate policy resolution", () => {
	const baseConfig = {
		default_profile: "d",
		profiles: { d: { runtime: "pi-durable" } },
	};
	const pools = {
		"core.plan": [{ label: "quick", profile: "d", default: true }],
	};
	const all = {
		planApproval: "always",
		verification: "always",
		developerReview: "always",
		wiki: "always",
	} as const;

	test("a configuration with no gates table runs every stage", () => {
		expect(resolveGatePolicies(parseAgentsConfig(baseConfig))).toEqual(all);
		expect(
			resolveGatePolicies(parseAgentsConfig(baseConfig), undefined),
		).toEqual(all);
	});

	test("a preset entry overrides the global table", () => {
		const agents = parseAgentsConfig({
			...baseConfig,
			gates: { verification: "auto", wiki: "auto" },
			presets: {
				p: { pools, gates: { verification: "always", planApproval: "auto" } },
			},
		});
		expect(resolveGatePolicies(agents, "p")).toEqual({
			planApproval: "auto",
			verification: "always",
			developerReview: "always",
			wiki: "auto",
		});
		// A preset that declares no entry for a stage takes the global table.
		expect(resolveGatePolicies(agents, "p").developerReview).toBe("always");
	});

	test("the global table applies to a preset without an entry", () => {
		const agents = parseAgentsConfig({
			...baseConfig,
			gates: { developerReview: "auto" },
			presets: { p: { pools } },
		});
		expect(resolveGatePolicies(agents, "p")).toEqual({
			...all,
			developerReview: "auto",
		});
	});

	test("an unknown stage or an invalid value is rejected, naming both", () => {
		expect(() =>
			parseAgentsConfig({ ...baseConfig, gates: { nope: "auto" } }),
		).toThrow(/unknown stage gate "nope"/);
		expect(() =>
			parseAgentsConfig({ ...baseConfig, gates: { wiki: "sometimes" } }),
		).toThrow(/stage wiki has invalid gate policy "sometimes"/);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { p: { pools, gates: { nope: "auto" } } },
			}),
		).toThrow(/preset p gates.*unknown stage gate "nope"/s);
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { p: { pools, gates: { verification: true } } },
			}),
		).toThrow(/stage verification has invalid gate policy true/);
	});

	test("a gate table never requires a profile and never satisfies the pool rule", () => {
		// A custom preset still needs at least one model pool: a gates table is
		// not model routing and must not stand in for one.
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { p: { gates: { wiki: "auto" } } },
			}),
		).toThrow(/must declare at least one model pool/);
		// And the gate table itself is accepted on an otherwise empty preset.
		const agents = parseAgentsConfig({
			...baseConfig,
			presets: { p: { pools, gates: { wiki: "auto" } } },
		});
		expect(agents.presets?.p?.gates).toEqual({ wiki: "auto" });
		expect(resolvePreset(agents, "p").gates).toEqual({ wiki: "auto" });
	});

	test("the reserved built-in preset still configures only its runtime", () => {
		expect(() =>
			parseAgentsConfig({
				...baseConfig,
				presets: { "use-default-model": { runtime: "pi-durable", gates: {} } },
			}),
		).toThrow(/reserved preset use-default-model/);
	});
});

describe("preset catalog read", () => {
	test("reports the config failure instead of an empty list", () => {
		// One profile with a removed runtime fails the whole agents config, which
		// used to look exactly like "no presets configured" in every picker.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-catalog-"));
		const file = path.join(dir, "config.json");
		const write = (agents: unknown) =>
			fs.writeFileSync(file, `${JSON.stringify({ agents }, null, 2)}\n`);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			write({
				profiles: { good: { runtime: "pi-durable" } },
				presets: {
					shipping: {
						default_profile: "good",
						pools: {
							"core.plan": [{ label: "good", profile: "good", default: true }],
						},
					},
				},
			});
			const read = presetCatalog();
			expect(read.error).toBeUndefined();
			expect(read.names).toContain("shipping");

			write({
				profiles: { stale: { runtime: "pi" } },
				presets: { shipping: { default_profile: "stale", pools: {} } },
			});
			const failed = presetCatalog();
			expect(failed.names).toEqual([]);
			expect(failed.error).toBe("invalid runtime in profile stale");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
