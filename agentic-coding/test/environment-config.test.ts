// Bun-owned configured environment: definition loading, precedence, runtime
// state separation, managed-checkout resolution and the canonical catalog
// (`port-project-catalog-and-state-to-bun`, tasks 1.3, 2.1, 2.2).
//
// Fixtures under `test/fixtures/environment/config` and `.../home` are the
// captured configuration shapes (including the runtime fields a definition
// file must never gain); the home layout is materialized into a temporary
// directory because a checked-in `.git` directory would be an embedded
// repository.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigDir, resolveDevenvHome } from "../src/backend/home.ts";
import {
	buildProjectCatalog,
	catalogPayload,
	catalogRevision,
	EnvironmentConfigError,
	expandInfraConfigPaths,
	normalizeInfraService,
	parseAppDefinition,
	parseInfraDefinition,
	projectFromApp,
	resolveActiveWorktreePath,
	resolveProjectAvailability,
} from "../src/server/environment/config.ts";
import { EnvironmentManager } from "../src/server/environment/manager.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder a definition file contains
const CONFIG_PLACEHOLDER = "${CONFIG}";

const FIXTURES = path.join(import.meta.dir, "fixtures", "environment");
const CONFIG_FIXTURES = path.join(FIXTURES, "config");

interface HomeLayout {
	dirs: string[];
	files: Record<string, string>;
}

function copyDir(source: string, target: string): void {
	fs.cpSync(source, target, { recursive: true });
}

function materializeHome(): string {
	const layout = JSON.parse(
		fs.readFileSync(path.join(FIXTURES, "home", "layout.json"), "utf8"),
	) as HomeLayout;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-home-"));
	for (const relative of layout.dirs)
		fs.mkdirSync(path.join(dir, relative), { recursive: true });
	for (const [relative, content] of Object.entries(layout.files)) {
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return dir;
}

function withTempDir(prefix: string, work: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		work(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("configured environment configuration", () => {
	test("app/library definitions load with stable identities and no runtime fields", () => {
		const configDir = path.join(CONFIG_FIXTURES, "principal");
		const manager = new EnvironmentManager({
			homeDir: path.join(configDir, "..", "unused-home"),
			configDir,
		});
		manager.loadCatalogConfig();

		const apps = manager.getApps();
		expect(apps.map((app) => app.ident)).toEqual([
			"alpha",
			"beta",
			"shared-lib",
		]);
		// The libraries directory contributes LIB entries; apps contribute APP.
		expect(apps.map((app) => app.appType)).toEqual(["APP", "APP", "LIB"]);
		// A missing ident falls back to the file name.
		expect(manager.getAppByIdent("beta")).toMatchObject({
			displayName: "Beta App",
			repositoryPath: "https://example.com/team/beta.git",
			provider: "github",
		});
		// Runtime fields present in a definition file are ignored, not adopted.
		const alpha = manager.getAppByIdent("alpha");
		expect(alpha).toBeDefined();
		expect(alpha?.branch).toBe("");
		expect(alpha?.activeWorktree).toBeUndefined();
		expect(alpha?.localDirectoryPath).toBe(
			path.join(configDir, "..", "unused-home", "alpha", "alpha"),
		);
		expect(alpha?.containerBaseName).toBe("alpha-container");
		expect(alpha?.gitMode).toBe("WORKTREE");
	});

	test("infrastructure definitions expand $CONFIG and normalize defaults", () => {
		const configDir = path.join(CONFIG_FIXTURES, "principal");
		const manager = new EnvironmentManager({
			homeDir: path.join(configDir, "..", "unused-home"),
			configDir,
		});
		manager.loadCatalogConfig();

		const services = manager.getInfraServices();
		expect(services.map((service) => service.ident)).toEqual([
			"docker-infra",
			"k8s-infra",
			"script-infra",
		]);
		// Docker services keep whatever status they declared (Go does not default
		// it); script and kubernetes services default to "stopped".
		expect(services[0]).toMatchObject({ type: "docker" });
		expect(services[0]?.status).toBeUndefined();
		const script = services.at(-1);
		expect(script).toMatchObject({
			type: "script",
			shellPath: `${configDir}/scripts/up.sh`,
			cwd: `${configDir}/work`,
			logPath: `${configDir}/logs/script.log`,
			defaultRunner: "shell",
			status: "stopped",
		});
		expect(script?.env).toEqual({ DEVENV_SCRIPT: "1" });
		const kubernetes = services[1]?.kubernetes;
		expect(kubernetes).toMatchObject({
			chartPath: `${configDir}/charts/app`,
			profile: "local",
			release: "k8s-infra",
			namespace: "default",
			values: [`${configDir}/charts/values/local.yaml`],
		});
	});

	test("a failed load keeps the previous snapshot and reports a diagnostic", () => {
		withTempDir("env-config-", (dir) => {
			copyDir(path.join(CONFIG_FIXTURES, "principal"), dir);
			const manager = new EnvironmentManager({ homeDir: dir, configDir: dir });
			manager.loadCatalogConfig();
			expect(manager.getApps()).toHaveLength(3);

			// Break the configuration: the reload must fail and nothing may be
			// partially published.
			fs.writeFileSync(
				path.join(dir, "infrastructure", "definitions", "broken.json"),
				'{ "ident": "broken", "type": "kubernetes" }',
			);
			expect(() => manager.loadCatalogConfig()).toThrow(EnvironmentConfigError);
			expect(manager.getApps()).toHaveLength(3);
			expect(manager.getInfraServices().map((s) => s.ident)).toEqual([
				"docker-infra",
				"k8s-infra",
				"script-infra",
			]);
		});
	});

	test("unparseable definitions fail loudly with the offending file", () => {
		withTempDir("env-config-", (dir) => {
			copyDir(path.join(CONFIG_FIXTURES, "unparseable-app"), dir);
			const manager = new EnvironmentManager({ homeDir: dir, configDir: dir });
			expect(() => manager.loadCatalogConfig()).toThrow(/broken\.json/);
		});
	});

	test("invalid infrastructure definitions fail with the file and the reason", () => {
		withTempDir("env-config-", (dir) => {
			copyDir(path.join(CONFIG_FIXTURES, "invalid-infra"), dir);
			const manager = new EnvironmentManager({ homeDir: dir, configDir: dir });
			expect(() => manager.loadCatalogConfig()).toThrow(
				/invalid infra service file broken\.json.*requires shellPath or powerShellPath/,
			);
		});
	});

	test("duplicate configured idents are a catalog error, not a collapse", () => {
		const configDir = path.join(CONFIG_FIXTURES, "duplicate-ident");
		const manager = new EnvironmentManager({
			homeDir: path.join(configDir, "..", "unused-home"),
			configDir,
		});
		manager.loadCatalogConfig();
		expect(() => manager.getProjectCatalog()).toThrow(
			/duplicate configured project ident "dup"/,
		);
	});
});

describe("home, config and environment precedence", () => {
	test("DEVENV_HOME wins, then the config .env, then ~/devenv", () => {
		const previous = {
			home: process.env.DEVENV_HOME,
			config: process.env.DEVENV_CONFIG_DIR,
		};
		try {
			delete process.env.DEVENV_HOME;
			delete process.env.DEVENV_CONFIG_DIR;
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
			// No config-dir override: the documented canonical root fallback.
			expect(resolveConfigDir()).toBe(
				path.join(os.homedir(), ".config", "agentic-coding"),
			);

			withTempDir("env-config-", (dir) => {
				// No override and no readable .env here: ~/devenv is used.
				process.env.DEVENV_CONFIG_DIR = dir;
				expect(resolveDevenvHome()).toBe(path.join(os.homedir(), "devenv"));

				// The fixture .env sets DEVENV_HOME with $HOME expansion.
				fs.copyFileSync(
					path.join(CONFIG_FIXTURES, "principal", ".env"),
					path.join(dir, ".env"),
				);
				expect(resolveConfigDir()).toBe(dir);
				expect(resolveDevenvHome()).toBe(
					path.join(os.homedir(), ".devenv-fixture-home"),
				);

				// An explicit DEVENV_HOME beats the config .env.
				process.env.DEVENV_HOME = path.join(dir, "explicit-home");
				expect(resolveDevenvHome()).toBe(path.join(dir, "explicit-home"));
			});
		} finally {
			if (previous.home === undefined) delete process.env.DEVENV_HOME;
			else process.env.DEVENV_HOME = previous.home;
			if (previous.config === undefined) delete process.env.DEVENV_CONFIG_DIR;
			else process.env.DEVENV_CONFIG_DIR = previous.config;
		}
	});

	test("$CONFIG expansion is applied to every path-bearing infra field", () => {
		const service = expandInfraConfigPaths(
			{
				displayName: "S",
				ident: "s",
				type: "kubernetes",
				cwd: `${CONFIG_PLACEHOLDER}/cwd`,
				kubernetes: {
					chartPath: "$CONFIG/chart",
					values: [`${CONFIG_PLACEHOLDER}/v.yaml`],
				},
			},
			"/cfg",
		);
		expect(service.cwd).toBe("/cfg/cwd");
		expect(service.kubernetes?.chartPath).toBe("/cfg/chart");
		expect(service.kubernetes?.values).toEqual(["/cfg/v.yaml"]);
	});

	test("normalization rejects unsupported service types and missing fields", () => {
		expect(() =>
			normalizeInfraService({ displayName: "x", ident: "x", type: "podman" }),
		).toThrow(/unsupported infra service type/);
		expect(() =>
			normalizeInfraService({
				displayName: "x",
				ident: "x",
				type: "kubernetes",
			}),
		).toThrow(/requires kubernetes config/);
		expect(() =>
			normalizeInfraService({
				displayName: "x",
				ident: "x",
				type: "script",
				defaultRunner: "shell",
			}),
		).toThrow(/requires shellPath or powerShellPath/);
	});

	test("definitions are parsed independently of the filesystem", () => {
		expect(parseAppDefinition("named.json", "{}", "APP")).toMatchObject({
			ident: "named",
			appType: "APP",
		});
		expect(
			parseInfraDefinition("infra.json", '{ "type": "docker" }'),
		).toMatchObject({ ident: "infra", type: "docker" });
		expect(() => parseAppDefinition("x.json", "not json", "APP")).toThrow(
			EnvironmentConfigError,
		);
	});
});

describe("managed checkout and runtime state", () => {
	test("active worktree resolution falls back to the primary worktree", () => {
		const home = materializeHome();
		try {
			const exists = (target: string) => fs.existsSync(target);
			// Linked worktree exists -> the linked checkout is used.
			expect(
				resolveActiveWorktreePath(
					home,
					{
						ident: "alpha",
						activeWorktree: "feature/x",
						mainWorktreeBranch: "main",
					},
					exists,
				),
			).toBe(path.join(home, "alpha", "alpha.feature-x"));
			// Linked worktree removed -> primary fallback.
			expect(
				resolveActiveWorktreePath(
					home,
					{
						ident: "beta",
						activeWorktree: "feature/gone",
						mainWorktreeBranch: "main",
					},
					exists,
				),
			).toBe(path.join(home, "beta", "beta"));
			// Active branch equals the main worktree branch -> primary.
			expect(
				resolveActiveWorktreePath(
					home,
					{
						ident: "gamma",
						activeWorktree: "trunk",
						mainWorktreeBranch: "trunk",
					},
					exists,
				),
			).toBe(path.join(home, "gamma", "gamma"));
			// Legacy row without a main-worktree branch still uses the linked
			// worktree while it exists.
			expect(
				resolveActiveWorktreePath(
					home,
					{
						ident: "alpha",
						activeWorktree: "feature/x",
						mainWorktreeBranch: "",
					},
					exists,
				),
			).toBe(path.join(home, "alpha", "alpha.feature-x"));
			// A branch containing slashes maps onto the sanitized directory name.
			fs.mkdirSync(path.join(home, "alpha", "alpha.feature-nested-sub"));
			expect(
				resolveActiveWorktreePath(
					home,
					{
						ident: "alpha",
						activeWorktree: "feature/nested/sub",
						mainWorktreeBranch: "main",
					},
					exists,
				),
			).toBe(path.join(home, "alpha", "alpha.feature-nested-sub"));
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("loading overlays runtime state, refreshes branches and backfills legacy rows", () => {
		const home = materializeHome();
		const configDir = path.join(CONFIG_FIXTURES, "worktree-apps");
		const warnings: string[] = [];
		try {
			const store = EnvironmentStateStore.open(path.join(home, "db"));
			try {
				store.setAppState({
					ident: "alpha",
					branch: "stale/branch",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				});
				store.setAppState({
					ident: "beta",
					branch: "stale/branch",
					activeWorktree: "feature/gone",
					mainWorktreeBranch: "main",
				});
				// Legacy row: the main-worktree branch was never persisted.
				store.setActiveWorktree("gamma", "trunk");
				store.setBranch("gamma", "trunk");

				const manager = new EnvironmentManager({
					homeDir: home,
					configDir,
					store,
					logger: (message) => warnings.push(message),
				});
				manager.loadConfig();

				expect(manager.getAppByIdent("alpha")).toMatchObject({
					activeWorktree: "feature/x",
					branch: "feature/x",
					mainWorktreeBranch: "main",
					localDirectoryPath: path.join(home, "alpha", "alpha.feature-x"),
				});
				expect(manager.getAppByIdent("beta")).toMatchObject({
					activeWorktree: "feature/gone",
					branch: "main",
					localDirectoryPath: path.join(home, "beta", "beta"),
				});
				// The legacy row is backfilled from the primary worktree's HEAD
				// and persisted, so the fallback stays correct afterwards.
				expect(store.getAppState("gamma").mainWorktreeBranch).toBe("trunk");
				expect(manager.getAppByIdent("gamma")?.mainWorktreeBranch).toBe(
					"trunk",
				);
				expect(warnings.join("\n")).toContain("backfilled MainWorktreeBranch");
				// An app without a runtime row is simply not cloned yet.
				expect(manager.getAppByIdent("delta")).toMatchObject({
					branch: "",
					localDirectoryPath: path.join(home, "delta", "delta"),
				});
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("the read-only catalog load never writes runtime state", () => {
		const home = materializeHome();
		const configDir = path.join(CONFIG_FIXTURES, "worktree-apps");
		try {
			const store = EnvironmentStateStore.open(path.join(home, "db"));
			try {
				store.setActiveWorktree("gamma", "trunk");
				store.setBranch("gamma", "trunk");
				const manager = new EnvironmentManager({
					homeDir: home,
					configDir,
					store,
				});
				manager.loadCatalogConfig();
				// No backfill write, and the primary fallback applies instead.
				expect(store.getAppState("gamma").mainWorktreeBranch).toBe("");
				expect(manager.getAppByIdent("gamma")).toMatchObject({
					activeWorktree: "trunk",
					localDirectoryPath: path.join(home, "gamma", "gamma"),
				});
				// No branch refresh either: the stale stored branch is kept.
				expect(manager.getAppByIdent("gamma")?.branch).toBe("trunk");
			} finally {
				store.close();
			}
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("switching the active worktree persists state and never rewrites definitions", () => {
		const home = materializeHome();
		withTempDir("env-config-", (configDir) => {
			copyDir(path.join(CONFIG_FIXTURES, "worktree-apps"), configDir);
			try {
				const store = EnvironmentStateStore.open(path.join(home, "db"));
				try {
					const manager = new EnvironmentManager({
						homeDir: home,
						configDir,
						store,
					});
					manager.loadCatalogConfig();
					const before = fs.readFileSync(
						path.join(configDir, "apps", "definitions", "alpha.json"),
						"utf8",
					);
					manager.updateAppActiveWorktree("alpha", "feature/x");
					expect(store.getAppState("alpha")).toMatchObject({
						ident: "alpha",
						branch: "feature/x",
						activeWorktree: "feature/x",
					});
					expect(manager.getAppByIdent("alpha")?.localDirectoryPath).toBe(
						path.join(home, "alpha", "alpha.feature-x"),
					);
					expect(
						fs.readFileSync(
							path.join(configDir, "apps", "definitions", "alpha.json"),
							"utf8",
						),
					).toBe(before);

					manager.setMainWorktreeBranch("alpha", "main");
					expect(store.getAppState("alpha").mainWorktreeBranch).toBe("main");
					expect(() => manager.updateAppActiveWorktree("nope", "x")).toThrow(
						/not found/,
					);
				} finally {
					store.close();
				}
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
			}
		});
	});

	test("saveConfig writes definitions without runtime fields and drops stale files", () => {
		const home = materializeHome();
		withTempDir("env-config-", (configDir) => {
			copyDir(path.join(CONFIG_FIXTURES, "worktree-apps"), configDir);
			const store = EnvironmentStateStore.open(path.join(home, "db"));
			try {
				const manager = new EnvironmentManager({
					homeDir: home,
					configDir,
					store,
				});
				manager.loadCatalogConfig();
				manager.updateAppActiveWorktree("alpha", "feature/x");
				fs.writeFileSync(
					path.join(configDir, "apps", "definitions", "stale.json"),
					'{ "ident": "stale", "displayName": "Stale", "repositoryPath": "x" }',
				);
				manager.saveConfig();

				const written = JSON.parse(
					fs.readFileSync(
						path.join(configDir, "apps", "definitions", "alpha.json"),
						"utf8",
					),
				) as Record<string, unknown>;
				expect(written).toEqual({
					ident: "alpha",
					displayName: "Alpha",
					repositoryPath: "https://example.com/team/alpha.git",
					gitMode: "WORKTREE",
				});
				expect(
					fs.existsSync(
						path.join(configDir, "apps", "definitions", "stale.json"),
					),
				).toBe(false);
			} finally {
				store.close();
				fs.rmSync(home, { recursive: true, force: true });
			}
		});
	});
});

describe("project catalog projection", () => {
	test("availability separates configured identity from the resolved checkout", () => {
		const shared = {
			displayName: "Shared",
			repositoryPath: "https://example.com/team/shared.git",
			appType: "APP",
			localDirectoryPath: "",
			branch: "",
		};
		const observation = {
			pathKind: (target: string) =>
				target === "/managed/available"
					? ("directory" as const)
					: target === "/managed/file"
						? ("not-directory" as const)
						: ("missing" as const),
			resolveCanonicalRoot: (checkout: string) =>
				checkout === "/managed/available"
					? { root: "/repos/shared" }
					: { error: "not a Git repository" },
			openspecConfigured: (root: string) => root === "/repos/shared",
		};
		const projects = [
			{
				...shared,
				ident: "available",
				localDirectoryPath: "/managed/available",
			},
			{ ...shared, ident: "uncloned", localDirectoryPath: "/managed/uncloned" },
			{ ...shared, ident: "invalid", localDirectoryPath: "/managed/file" },
			{ ...shared, ident: "unknown", localDirectoryPath: "" },
		].map((app) =>
			resolveProjectAvailability(projectFromApp(app), observation),
		);

		expect(projects[0]).toMatchObject({
			ident: "available",
			availability: "available",
			available: true,
			canonicalRoot: "/repos/shared",
			activeCheckout: "/managed/available",
			capabilities: { openspec: true },
		});
		expect(projects[1]).toMatchObject({
			ident: "uncloned",
			availability: "missing",
			available: false,
			detail: "checkout is not cloned at the expected managed location",
		});
		expect(projects[2]).toMatchObject({
			ident: "invalid",
			availability: "invalid",
			detail: "checkout path exists but is not a directory",
		});
		expect(projects[3]).toMatchObject({
			ident: "unknown",
			availability: "unresolved",
			detail: "no managed checkout path is known",
		});
	});

	test("catalog ordering and revision are stable and duplicate-free", () => {
		const apps = ["zeta", "alpha", "mid"].map((ident) => ({
			ident,
			displayName: ident,
			repositoryPath: `https://example.com/${ident}.git`,
			appType: "APP",
			localDirectoryPath: "",
			branch: "",
		}));
		const projects = buildProjectCatalog(apps);
		expect(projects.map((project) => project.ident)).toEqual([
			"alpha",
			"mid",
			"zeta",
		]);
		expect(catalogRevision(projects)).toBe(catalogRevision(projects));
		expect(catalogRevision(projects)).toHaveLength(16);
		expect(catalogRevision(projects)).not.toBe(
			catalogRevision(buildProjectCatalog(apps.slice(1))),
		);
		// Go's `omitempty` behavior: absent optional fields are absent, not empty.
		expect(catalogPayload(projects)).not.toContain("canonicalRoot");
		expect(() =>
			buildProjectCatalog([...apps, { ...apps[0], displayName: "again" }]),
		).toThrow(/duplicate configured project ident "zeta"/);
	});

	test("a library without a checkout is still a catalog entry", () => {
		const manager = new EnvironmentManager({
			homeDir: path.join(CONFIG_FIXTURES, "unused-home"),
			configDir: path.join(CONFIG_FIXTURES, "principal"),
		});
		manager.loadCatalogConfig();
		const projects = manager.getProjectCatalog();
		expect(projects.map((project) => project.ident)).toEqual([
			"alpha",
			"beta",
			"shared-lib",
		]);
		expect(projects.every((project) => !project.available)).toBe(true);
		expect(projects.at(-1)?.kind).toBe("library");
	});
});

describe("manager state isolation", () => {
	test("a manager without a state store still projects the catalog", () => {
		const manager = new EnvironmentManager({
			homeDir: path.join(CONFIG_FIXTURES, "unused-home"),
			configDir: path.join(CONFIG_FIXTURES, "principal"),
		});
		manager.loadConfig();
		expect(manager.getApps()).toHaveLength(3);
		expect(manager.getDisplayName("alpha")).toBe("Alpha App");
		expect(manager.getDisplayName("docker-infra")).toBe("Docker Infra");
		expect(manager.getDisplayName("unknown-ident")).toBe("unknown-ident");
	});

	test("reloading after a definition is added publishes the new snapshot", () => {
		withTempDir("env-config-", (configDir) => {
			copyDir(path.join(CONFIG_FIXTURES, "worktree-apps"), configDir);
			const manager = new EnvironmentManager({
				homeDir: path.join(configDir, "home"),
				configDir,
			});
			manager.loadCatalogConfig();
			expect(manager.getApps()).toHaveLength(4);
			fs.writeFileSync(
				path.join(configDir, "apps", "definitions", "epsilon.json"),
				'{"ident":"epsilon","displayName":"Epsilon","repositoryPath":"https://example.com/epsilon.git"}',
			);
			manager.loadCatalogConfig();
			expect(manager.getApps().map((app) => app.ident)).toEqual([
				"alpha",
				"beta",
				"delta",
				"epsilon",
				"gamma",
			]);
		});
	});
});
