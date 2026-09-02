import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fusionPlannerCount, startRouting } from "../src/tui/dash/engine.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentsConfigPath,
	conflictingAgentsFiles,
	saveAgentsSection,
	selectAgentsConfigPath,
} from "../src/workflow/effects.ts";
import {
	type AgentsConfig,
	assertModelAvailable,
	clearModelCache,
	parseAgentsConfig,
	parseOpenCodeModels,
	parsePiModels,
	preflightProfile,
	resolvePreset,
	resolveProfile,
	resolveRouting,
	runtimeModels,
	validatePresetCoverage,
} from "../src/workflow/profiles.ts";

function stubExecutable(body: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-stub-"));
	const file = path.join(dir, `stub-${Date.now()}-${Math.random()}`);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}
const PI_LISTING = `provider       model
openai         gpt-5.4
opencode-go    ox-alpha-free
──────────────`;
const OPENCODE_LISTING = `anthropic/claude-opus-4
opencode-go/ox-alpha-free`;

describe("model availability detection", () => {
	test("parsers handle each runtime's output format", () => {
		expect(parsePiModels(PI_LISTING)).toEqual([
			"openai/gpt-5.4",
			"opencode-go/ox-alpha-free",
		]);
		expect(parseOpenCodeModels(OPENCODE_LISTING)).toEqual([
			"anthropic/claude-opus-4",
			"opencode-go/ox-alpha-free",
		]);
		expect(parsePiModels("")).toEqual([]);
	});
	test("runtimeModels caches per executable until cleared", () => {
		const pi = stubExecutable(`cat <<'EOF'
${PI_LISTING}
EOF`);
		try {
			expect([...runtimeModels(pi, "pi")].sort()).toEqual([
				"openai/gpt-5.4",
				"opencode-go/ox-alpha-free",
			]);
			// second call is served from cache (script now deleted)
			fs.unlinkSync(pi);
			expect(runtimeModels(pi, "pi").has("openai/gpt-5.4")).toBe(true);
			// cache invalidation forces a fresh (failing) enumeration
			clearModelCache();
			expect(() => runtimeModels(pi, "pi")).toThrow(/model enumeration failed/);
		} finally {
			fs.rmSync(path.dirname(pi), { recursive: true, force: true });
		}
	});
	test("preflight rejects unknown models and accepts pi thinking suffixes", () => {
		const exe = stubExecutable(`cat <<'EOF'
${PI_LISTING}
EOF`);
		try {
			const ok = parseAgentsConfig({
				default_profile: "ok",
				profiles: {
					ok: { runtime: "pi", executable: exe, model: "openai/gpt-5.4:high" },
				},
			});
			preflightProfile(resolveProfile("ok", ok), []);
			const bad = parseAgentsConfig({
				default_profile: "bad",
				profiles: {
					bad: { runtime: "pi", executable: exe, model: "openai/nope" },
				},
			});
			expect(() => preflightProfile(resolveProfile("bad", bad), [])).toThrow(
				/profile bad: unknown model openai\/nope for runtime pi \(available: openai\/gpt-5\.4/,
			);
		} finally {
			fs.rmSync(path.dirname(exe), { recursive: true, force: true });
		}
	});
	test("enumeration failure fails closed with the command error", () => {
		const exe = stubExecutable('echo "catalog unavailable" >&2\nexit 3');
		try {
			const config = parseAgentsConfig({
				default_profile: "p",
				profiles: { p: { runtime: "pi", executable: exe, model: "a/b" } },
			});
			const profile = resolveProfile("p", config);
			expect(() => assertModelAvailable(profile)).toThrow(
				/model enumeration failed \(.*--list-models\): catalog unavailable/,
			);
			expect(() => preflightProfile(profile, [])).toThrow(
				/catalog unavailable/,
			);
		} finally {
			fs.rmSync(path.dirname(exe), { recursive: true, force: true });
		}
	});
});

describe("agent configuration presets", () => {
	const baseConfig = {
		default_profile: "d",
		profiles: {
			d: { runtime: "pi" },
			a: { runtime: "opencode" },
			b: { runtime: "opencode-v2" },
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
		).toThrow(
			/preset y: unknown profile nope for role quality-verifier of step core.verification/,
		);
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
				profiles: { d: { runtime: "pi" } },
			}),
		).toThrow(/unknown agent profile: valueOf/);
	});
	test("valid presets parse and resolution follows preset roles > steps > default", () => {
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
					roles: { "core.verification": { "quality-verifier": "b" } },
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
		// role override, step assignment, preset default for uncovered role
		expect(names).toEqual(["a", "b", "b"]);
		expect(() => resolvePreset(config, "ghost")).toThrow(
			/unknown agent preset: ghost/,
		);
		// prototype-chain preset names must fail, never yield a bogus preset
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
					steps: { "core.implementation": "a" },
					roles: { "core.verification": { "quality-verifier": "b" } },
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
});

describe("agents section write-back", () => {
	test("round-trip preserves profiles, presets, routes, and unrelated sections", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-write-"));
		const file = path.join(dir, "config.toml");
		fs.writeFileSync(
			file,
			`[workflow]
max_verification_rounds = 6
remote = "origin"
branch_prefix = "feature/"
base_branch = "origin/HEAD"

[ui]
theme = "catppuccin"
selection_height = 10

[projects]
root = "~/development"
max_depth = 3

[agents]
default_profile = "pi-a"

[agents.profiles.pi-a]
runtime = "pi"
model = "a/b"

[agents.routes]
"core.plan" = "pi-a"

[agents.presets.base]
default_profile = "pi-a"
[agents.presets.base.steps]
"core.plan" = "pi-a"

[telemetry]
capture_content = true
`,
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(agentsConfigPath()).toBe(file);
			saveAgentsSection((section) => {
				const profiles = section.profiles as Record<string, unknown>;
				profiles["oc-worker"] = { runtime: "opencode", agent: "build" };
				const presets = section.presets as Record<string, unknown>;
				presets.extra = {
					default_profile: "pi-a",
					steps: { "core.archive": "pi-a" },
				};
			});
			const reparsed = Bun.TOML.parse(fs.readFileSync(file, "utf8")) as Record<
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
			expect(reparsed.projects.root).toBe("~/development");
			expect(reparsed.telemetry.capture_content).toBe(true);
			const agents = parseAgentsConfig(reparsed.agents);
			expect(agents.default_profile).toBe("pi-a");
			expect(agents.profiles["oc-worker"]).toMatchObject({
				runtime: "opencode",
				agent: "build",
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
					Bun.TOML.parse(fs.readFileSync(file, "utf8")) as Record<
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
		const file = path.join(dir, "config.toml");
		fs.writeFileSync(
			file,
			'[__proto__]\nisAdmin = true\n\n[workflow]\nmax_verification_rounds = 6\nremote = "origin"\nbranch_prefix = "feature/"\nbase_branch = "origin/HEAD"\n',
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
				"config.toml",
			);
			fs.writeFileSync(noAgents, '[ui]\ntheme = "catppuccin"\n');
			const legacy = path.join(home, ".pi", "agent", "herdr-workflow.toml");
			fs.mkdirSync(path.dirname(legacy), { recursive: true });
			fs.writeFileSync(legacy, '[ui]\ntheme = "legacy"\n');
			const projectFile = path.join(dir, "repo", ".pi", "herdr-workflow.toml");

			// nothing exists -> user config path is created on save
			expect(
				selectAgentsConfigPath(undefined, path.join(dir, "none"), dir),
			).toBe(
				path.join(dir, "none", ".config", "agentic-coding", "config.toml"),
			);
			// no candidate defines agents -> highest-priority existing file
			expect(selectAgentsConfigPath(undefined, home, dir)).toBe(noAgents);
			// project file defines agents and outranks them all despite merge order
			fs.writeFileSync(projectFile, '[agents]\ndefault_profile = "p"\n');
			expect(
				selectAgentsConfigPath(undefined, home, path.join(dir, "repo")),
			).toBe(projectFile);
			// when BOTH base and project define [agents], project wins at load
			// precedence (deep-merged over base), so it is the write-back target
			fs.appendFileSync(noAgents, '[agents]\ndefault_profile = "base"\n');
			expect(
				selectAgentsConfigPath(undefined, home, path.join(dir, "repo")),
			).toBe(projectFile);
			// base defines agents but project does not supply one -> base is target
			fs.rmSync(projectFile);
			expect(selectAgentsConfigPath(undefined, home, dir)).toBe(noAgents);
			// QUALITY-001 regression: legacy supplies [agents] while the winning
			// base (canonical user config) does not — loadConfig never reads the
			// legacy file in that setup, so edits must go to the canonical file
			const legacyFile = path.join(home, ".pi", "agent", "herdr-workflow.toml");
			fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
			fs.writeFileSync(legacyFile, '[agents]\ndefault_profile = "legacy"\n');
			expect(selectAgentsConfigPath(undefined, home, dir)).toBe(noAgents);
			// explicit env always wins
			expect(
				selectAgentsConfigPath(
					"/custom/config.toml",
					home,
					path.join(dir, "repo"),
				),
			).toBe("/custom/config.toml");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("saveAgentsSection writes back to the resolved target file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-save-"));
		const file = path.join(dir, "config.toml");
		fs.writeFileSync(
			file,
			'[agents]\ndefault_profile = "p"\n\n[agents.profiles.p]\nruntime = "pi"\n',
		);
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			saveAgentsSection((section) => {
				(section.presets as Record<string, unknown>) = {
					extra: { default_profile: "p" },
				};
			});
			const reparsed = Bun.TOML.parse(fs.readFileSync(file, "utf8")) as Record<
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
});

describe("config source conflicts", () => {
	test("conflictingAgentsFiles flags base suppliers under a project target", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-conflict-"));
		try {
			const home = path.join(dir, "home");
			fs.mkdirSync(path.join(home, ".config", "agentic-coding"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(home, ".config", "agentic-coding", "config.toml"),
				'[agents]\ndefault_profile = "base"\n',
			);
			fs.mkdirSync(path.join(dir, "repo", ".pi"), { recursive: true });
			const projectFile = path.join(dir, "repo", ".pi", "herdr-workflow.toml");
			fs.writeFileSync(projectFile, '[agents]\ndefault_profile = "p"\n');
			// project target + base supplying [agents] -> base-only deletes resurrect
			expect(conflictingAgentsFiles(home, path.join(dir, "repo"))).toEqual([
				path.join(home, ".config", "agentic-coding", "config.toml"),
			]);
			// base without [agents] -> no conflict
			fs.writeFileSync(
				path.join(home, ".config", "agentic-coding", "config.toml"),
				'[ui]\ntheme = "x"\n',
			);
			expect(conflictingAgentsFiles(home, path.join(dir, "repo"))).toEqual([]);
			// non-project targets never conflict
			expect(conflictingAgentsFiles(home, dir)).toEqual([]);
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
				path.join(dir, "repo", ".pi", "herdr-workflow.toml"),
				'[workflow]\nremote = "project-origin"\n',
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
			"../src/tui/dash/engine.ts"
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

describe("dashboard openspec-fusion-full start routing", () => {
	const baseConfig = {
		default_profile: "d",
		profiles: {
			d: { runtime: "pi" },
			a: { runtime: "pi" },
			b: { runtime: "pi" },
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
	test("fusionPlannerCount derives the contiguous run and rejects gaps", () => {
		expect(fusionPlannerCount(undefined)).toBe(0);
		expect(
			fusionPlannerCount({ name: "p", roles: { "fusion.plan": {} } }),
		).toBe(0);
		expect(
			fusionPlannerCount({
				name: "p",
				roles: { "fusion.plan": { "planner-1": "a", "planner-2": "b" } },
			}),
		).toBe(2);
		expect(
			fusionPlannerCount({
				name: "p",
				roles: {
					"fusion.plan": {
						"planner-1": "a",
						"planner-2": "a",
						"planner-3": "a",
						"planner-4": "a",
						"planner-5": "a",
					},
				},
			}),
		).toBe(5);
		expect(() =>
			fusionPlannerCount({
				name: "p",
				roles: { "fusion.plan": { "planner-1": "a", "planner-3": "b" } },
			}),
		).toThrow(/contiguous planner roles/);
	});
	test("valid 2-planner preset creates ordered planner and consolidator routes", () => {
		const agents = parseAgentsConfig({
			...baseConfig,
			presets: {
				duo: {
					steps: { "fusion.consolidate": "b" },
					roles: {
						"fusion.plan": { "planner-1": "a", "planner-2": "b" },
					},
				},
			},
		});
		const routes = routesFor("openspec-fusion-full", agents, "duo");
		expect(routes.filter(([step]) => step === "fusion.plan")).toEqual([
			["fusion.plan", "planner-1", "a"],
			["fusion.plan", "planner-2", "b"],
		]);
		expect(routes.filter(([step]) => step === "fusion.consolidate")).toEqual([
			["fusion.consolidate", "consolidator", "b"],
		]);
		// remaining agent steps resolve through the config default as before
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
				c: { runtime: "pi" },
				e: { runtime: "pi" },
			},
			presets: {
				five: {
					default_profile: "d",
					roles: {
						"fusion.plan": {
							"planner-1": "a",
							"planner-2": "b",
							"planner-3": "c",
							"planner-4": "d",
							"planner-5": "e",
						},
					},
				},
			},
		});
		expect(
			routesFor("openspec-fusion-full", agents, "five").filter(
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
	test("fewer than 2 or more than 5 planners are rejected before launch", async () => {
		const one = parseAgentsConfig({
			...baseConfig,
			presets: {
				one: { roles: { "fusion.plan": { "planner-1": "a" } } },
			},
		});
		expect(() => routesFor("openspec-fusion-full", one, "one")).toThrow(
			/between 2 and 5 planner routings/,
		);
		// a gap in the run is caught during count derivation
		const gapped = parseAgentsConfig({
			...baseConfig,
			presets: {
				gapped: {
					roles: {
						"fusion.plan": {
							"planner-1": "a",
							"planner-2": "b",
							"planner-4": "a",
						},
					},
				},
			},
		});
		expect(() => routesFor("openspec-fusion-full", gapped, "gapped")).toThrow(
			/contiguous planner roles/,
		);
	});
	test("duplicate resolved planner profiles are rejected before launch", () => {
		// without per-planner role assignments every planner falls back to the
		// same profile, which the engine would reject at start time
		const fallback = parseAgentsConfig({
			...baseConfig,
			presets: {
				thin: {
					roles: {
						"fusion.plan": { "planner-1": "d", "planner-2": "d" },
					},
				},
			},
		});
		expect(() => routesFor("openspec-fusion-full", fallback, "thin")).toThrow(
			/distinct planner profiles/,
		);
	});
	test("non-fusion workflows keep their existing routing without a preset", () => {
		const agents = parseAgentsConfig(baseConfig);
		expect(routesFor("openspec-full", agents)).toEqual([
			["core.plan", "planner", "d"],
			["core.implementation", "worker", "d"],
			["core.triage", "triage", "d"],
			["core.verification", "quality-verifier", "d"],
			["core.verification", "security-verifier", "d"],
			["core.verification", "performance-verifier", "d"],
			["core.verification", "openspec-verifier", "d"],
			["core.verification", "usability-verifier", "d"],
			["core.verification", "test-verifier", "d"],
			["core.archive", "archive", "d"],
		]);
	});
});
