// Before/after parity and cross-consumer root sharing for the configuration
// migration (unify-json-configuration-directory, tasks 6.2 and 6.4). Every case
// runs against temporary directories with an injected environment; no test
// touches real user configuration, real secrets or a running server.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	configDirEnv,
	resolveConfigDir,
	resolveDevenvHome,
} from "../src/backend/home.ts";
import { applyMigration, planMigration } from "../src/config-migration.ts";
import { CONFIG_ROOT_VAR, configRootEnv } from "../src/config-root.ts";
import { configDir as preferencesConfigDir } from "../src/tui/shared/preferences.ts";
import { loadConfigWithProvenance } from "../src/workflow/effects.ts";
import { parseAgentsConfig, resolvePreset } from "../src/workflow/profiles.ts";

/** A realistic machine-specific configuration, shaped like a migrated user file. */
const RICH_CONFIG = `[agents]
default_profile = "pi-planner"

[agents.profiles.pi-planner]
runtime = "pi"
model = "eon/claude-opus-4-8"
thinking = "high"

[agents.profiles.oc-worker]
runtime = "opencode"
agent = "build"

[agents.profiles.custom-tool]
runtime = "pi"
executable = "/usr/local/bin/pi"
capabilities = ["prompt", "run-environment"]

[agents.routes]
"core.triage" = "oc-worker"

[agents.roles]
"core.verification" = "oc-worker"

[agents.presets.frontier-plan]
description = "Frontier planning, cheap workers"
default_profile = "pi-planner"

[agents.presets.frontier-plan.steps]
"core.plan" = "pi-planner"
"core.implementation" = "oc-worker"

[agents.presets.frontier-plan.roles."custom.step"]
custom-role = "oc-worker"

[[agents.presets.frontier-plan.pools."core.plan"]]
label = "planner"
profile = "pi-planner"
default = true

[[agents.presets.frontier-plan.pools."core.implementation"]]
label = "worker"
profile = "oc-worker"
default = true

[workflow]
max_verification_rounds = 20
remote = "origin"
branch_prefix = "feature/"
base_branch = "origin/HEAD"

[projects]
root = "~/development"
max_depth = 3

[wiki]
root = "~/.config/agentic-coding/wiki"
reviewer = "reviewer@example.com"

[telemetry]
capture_content = false

[ui]
theme = "catppuccin"
selection_height = 10
herdr_sidebar = true
`;

interface Fixture {
	dir: string;
	source: string;
	target: string;
	home: string;
}

function fixture(configToml = RICH_CONFIG): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-parity-"));
	const source = path.join(dir, "devenv");
	const target = path.join(dir, "agentic-coding");
	const home = path.join(dir, "home");
	for (const directory of [source, target, home]) fs.mkdirSync(directory);
	fs.writeFileSync(path.join(target, "config.toml"), configToml);
	return { dir, source, target, home };
}

function write(file: string, content: string, mode = 0o644): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, { mode });
}

/** The effective agents configuration, resolved exactly as a workflow does. */
function effectiveAgents(root: string) {
	const resolved = loadConfigWithProvenance({ repositoryIndependent: true });
	const parsed = parseAgentsConfig(resolved.config.agents, resolved.config);
	const preset = parsed.presets?.["frontier-plan"]
		? resolvePreset(parsed, "frontier-plan")
		: undefined;
	return {
		provenance: resolved.provenance,
		routing: {
			defaultProfile: parsed.default_profile,
			routes: parsed.routes,
			roleRoutes: parsed.role_routes,
			preset,
			arbitraryRoles: parsed.presets?.["frontier-plan"]?.roles,
		},
		config: resolved.config,
		root,
	};
}

describe("conversion parity", () => {
	test("profiles, presets, roles, default harness and settings are unchanged", () => {
		const f = fixture();
		process.env[CONFIG_ROOT_VAR] = f.target;
		try {
			const before = effectiveAgents(f.target);
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			const after = effectiveAgents(f.target);

			// The hard break strips presets; every other non-secret effective value
			// survives the format change.
			expect(before.routing.preset).toBeDefined();
			expect(after.routing.preset).toBeUndefined();
			expect(after.routing.defaultProfile).toEqual(
				before.routing.defaultProfile,
			);
			expect(after.routing.routes).toEqual(before.routing.routes);
			expect(after.routing.roleRoutes).toEqual(before.routing.roleRoutes);
			expect(after.config.workflow).toEqual(before.config.workflow);
			expect(after.config.ui).toEqual(before.config.ui);
			expect(after.config.wiki).toEqual(before.config.wiki);
			expect(after.config.telemetry).toEqual(before.config.telemetry);
			// The built-in harness selection still has no model of its own.
			expect(before.routing.preset?.runtime).toBeUndefined();
			expect(
				(after.config.agents as { profiles: Record<string, unknown> }).profiles,
			).toEqual(
				(before.config.agents as { profiles: Record<string, unknown> })
					.profiles,
			);
			// Provenance now names the JSON file as the active source.
			expect(before.provenance.source).toBe("legacy");
			expect(after.provenance.source).toBe("user");
			expect(after.provenance.files).toEqual([
				path.join(f.target, "config.json"),
			]);
			expect(after.provenance.inactiveFiles).toEqual([
				path.join(f.target, "config.toml"),
			]);
		} finally {
			delete process.env[CONFIG_ROOT_VAR];
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a project JSON overlay still overrides the converted base", () => {
		const f = fixture();
		process.env[CONFIG_ROOT_VAR] = f.target;
		try {
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			const repo = path.join(f.dir, "repo");
			write(
				path.join(repo, ".pi", "herdr-workflow.json"),
				`${JSON.stringify({
					workflow: { remote: "project-remote" },
					agents: { profiles: { "project-only": { runtime: "pi" } } },
				})}\n`,
			);
			const resolved = loadConfigWithProvenance({ repository: repo });
			expect(resolved.provenance.source).toBe("project");
			expect(resolved.config.workflow.remote).toBe("project-remote");
			// The base keeps the fields the overlay does not mention.
			expect(resolved.config.workflow.max_verification_rounds).toBe(20);
			expect(
				(resolved.config.agents as { profiles: Record<string, unknown> })
					.profiles["pi-planner"],
			).toBeDefined();
		} finally {
			delete process.env[CONFIG_ROOT_VAR];
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("two overlay formats at one scope are refused instead of merged", () => {
		const f = fixture();
		try {
			const repo = path.join(f.dir, "repo");
			write(
				path.join(repo, ".pi", "herdr-workflow.json"),
				'{ "workflow": { "remote": "json-remote" } }\n',
			);
			write(
				path.join(repo, ".pi", "herdr-workflow.toml"),
				'[workflow]\nremote = "toml-remote"\n',
			);
			expect(() => loadConfigWithProvenance({ repository: repo })).toThrow(
				/keep one format/,
			);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an explicit replacement skips the project overlay and stays read-only", () => {
		const f = fixture();
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		try {
			const repo = path.join(f.dir, "repo");
			write(
				path.join(repo, ".pi", "herdr-workflow.json"),
				'{ "workflow": { "remote": "project-remote" } }\n',
			);
			const explicit = path.join(f.dir, "selected.toml");
			write(
				explicit,
				'[workflow]\nmax_verification_rounds = 3\nremote = "env-origin"\nbranch_prefix = "feature/"\nbase_branch = "origin/HEAD"\n',
			);
			process.env.HERDR_WORKFLOW_CONFIG = explicit;
			const resolved = loadConfigWithProvenance({ repository: repo });
			expect(resolved.provenance.source).toBe("environment");
			expect(resolved.config.workflow.remote).toBe("env-origin");
			expect(resolved.config.workflow.max_verification_rounds).toBe(3);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a repository-independent resolution ignores the working directory", () => {
		const f = fixture();
		const previousCwd = process.cwd();
		try {
			const repo = path.join(f.dir, "repo");
			write(
				path.join(repo, ".pi", "herdr-workflow.json"),
				'{ "workflow": { "remote": "project-remote" } }\n',
			);
			process.chdir(repo);
			const resolved = loadConfigWithProvenance({
				repositoryIndependent: true,
			});
			expect(resolved.provenance.source).not.toBe("project");
			expect(resolved.config.workflow.remote).toBe("origin");
		} finally {
			process.chdir(previousCwd);
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("runtime data is never relocated", () => {
	test("migration leaves the runtime home, state database and checkouts alone", () => {
		const f = fixture();
		const previousHome = process.env.DEVENV_HOME;
		try {
			// A runtime home with a state database and a checkout, plus a root `.env`
			// that selects it.
			const runtime = path.join(f.dir, "runtime-home");
			write(path.join(runtime, "db", "state.db"), "sqlite-bytes\n");
			write(path.join(runtime, "checkout", "app", "file.txt"), "checkout\n");
			write(path.join(f.source, ".env"), `DEVENV_HOME=${runtime}\n`);
			delete process.env.DEVENV_HOME;
			process.env[CONFIG_ROOT_VAR] = f.target;

			const before = {
				db: fs.readFileSync(path.join(runtime, "db", "state.db"), "utf8"),
				checkout: fs.readFileSync(
					path.join(runtime, "checkout", "app", "file.txt"),
					"utf8",
				),
			};
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			// The root `.env` that selects the runtime home moves with the
			// configuration, and resolves to the same place it always did.
			expect(resolveDevenvHome()).toBe(runtime);
			expect(
				fs.readFileSync(path.join(runtime, "db", "state.db"), "utf8"),
			).toBe(before.db);
			expect(
				fs.readFileSync(
					path.join(runtime, "checkout", "app", "file.txt"),
					"utf8",
				),
			).toBe(before.checkout);
			// No planned action touches the runtime home.
			const plan = planMigration({
				source: f.source,
				target: f.target,
				home: f.home,
			});
			expect(
				plan.actions.some(
					(action) =>
						action.from.startsWith(runtime) || action.to.startsWith(runtime),
				),
			).toBe(false);
		} finally {
			if (previousHome === undefined) delete process.env.DEVENV_HOME;
			else process.env.DEVENV_HOME = previousHome;
			delete process.env[CONFIG_ROOT_VAR];
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

describe("every consumer shares the selected root", () => {
	test("the backend, preferences, workflow loader and subprocess env agree", () => {
		const f = fixture();
		try {
			process.env[CONFIG_ROOT_VAR] = f.target;
			expect(resolveConfigDir()).toBe(f.target);
			expect(preferencesConfigDir()).toBe(f.target);
			// The child-process fragment names the resolved root explicitly.
			expect(configRootEnv(f.target)).toEqual({ [CONFIG_ROOT_VAR]: f.target });
			expect(configDirEnv()).toEqual({ [CONFIG_ROOT_VAR]: f.target });
			// Declared paths derive from the same root.
			const resolved = loadConfigWithProvenance({
				repositoryIndependent: true,
			});
			expect(resolved.provenance.files[0]).toBe(
				path.join(f.target, "config.toml"),
			);
		} finally {
			delete process.env[CONFIG_ROOT_VAR];
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a child process resolves the same root it was handed", () => {
		const f = fixture();
		try {
			const script = path.join(f.dir, "probe.ts");
			write(
				script,
				`import { resolveConfigDir } from ${JSON.stringify(
					path.resolve(import.meta.dir, "..", "src", "backend", "home.ts"),
				)};\nconsole.log(resolveConfigDir());\n`,
			);
			const result = Bun.spawnSync([process.execPath, script], {
				env: { ...process.env, ...configRootEnv(f.target) },
			});
			expect(result.stdout.toString().trim()).toBe(f.target);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("a migration writes only its target and leaves other roots byte-identical", () => {
		const f = fixture();
		try {
			const other = path.join(f.dir, "other-root");
			write(
				path.join(other, "config.json"),
				'{ "ui": { "theme": "dracula" } }\n',
			);
			write(path.join(other, ".env"), "OTHER_TOKEN=other\n", 0o600);
			const snapshot = (root: string) =>
				fs
					.readdirSync(root, { recursive: true })
					.map((entry) => String(entry))
					.sort()
					.map(
						(entry) =>
							`${entry}:${sha(fs.readFileSync(path.join(root, entry)))}`,
					);

			const before = snapshot(other);
			const legacyBefore = snapshot(f.source);
			applyMigration(
				planMigration({ source: f.source, target: f.target, home: f.home }),
			);
			expect(snapshot(other)).toEqual(before);
			// The legacy source root is preserved exactly (logs and all).
			expect(snapshot(f.source)).toEqual(legacyBefore);
		} finally {
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
});

function sha(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}
