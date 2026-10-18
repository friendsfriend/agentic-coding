// One default target per app+action, for every consumer
// (`fix-default-target-after-promotion`).
//
// The motivating defect, reproduced here with a configuration that mirrors the
// live one: `apps/build/<app>-build.Dockerfile` is a *symlink* into the
// developer's own devenv-config, the env-setup workflow promoted a working
// `apps/build/<app>-build.sh` beside it, and the gate validated the shell target.
// Three consumers then disagreed — the agent tool resolver refused (or picked),
// the Environments UI's Build ran whichever rendering the picker listed first
// (the live Dockerfile), and the post-promotion smoke check started the target
// the server guessed. The draft that states the default —
// `apps/defaults/<app>.json` — is what has to survive the promotion and decide
// for all three, so this file asserts the same target id from each of them.
//
// No daemon, no network, no maven: a stub `docker` on PATH records its argv, and
// the promoted shell build script appends to the same record.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectActionTarget } from "../packages/devenv/cli/src/tui/actions/target-choice.ts";
import {
	compareSetupDefaults,
	declaredTargetId,
	readDefaultDeclaration,
	resolveLiveDefaults,
} from "../src/server/actions/default-target.ts";
import {
	type ActionRouteContext,
	type ActionRouteServices,
	createActionRouteContext,
	handleActionRoute,
	rebuildDefinitions,
	runAppBuildTestAction,
} from "../src/server/actions/routes.ts";
import {
	setupDraftChanges,
	setupDraftsDir,
} from "../src/server/environment/setup-drafts.ts";
import {
	promoteSetupDrafts,
	rollbackPromotion,
} from "../src/server/environment/setup-promote.ts";
import { validateSetupDrafts } from "../src/server/environment/setup-validate.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";

/** The target the gate validated and every consumer must agree on. */
const SHELL_TARGET = "app/shop/build/shell";
/** The live target of the other family (a symlink into `~/devenv-config`). */
const DOCKER_TARGET = "app/shop/build/docker";

const ALL_TOOLS = {
	docker: true,
	podman: false,
	dockerCompose: true,
	podmanCompose: false,
	tmux: false,
	kind: false,
	kubectl: false,
	helm: false,
};

interface Fixture {
	readonly root: string;
	readonly configDir: string;
	readonly checkout: string;
	readonly record: string;
	readonly binDir: string;
}

/**
 * A configuration laid out like the developer's: the live Dockerfile is a
 * symlink to a file in a stand-in for `~/devenv-config` (never touched), the
 * promoted shell build script sits beside it, and a compose file is the run
 * target. `declared` writes the per-app default declaration.
 */
function fixture(options: { declared?: Record<string, string> } = {}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "default-target-parity-"));
	const configDir = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	const record = path.join(root, "record");
	const binDir = path.join(root, "bin");
	const devenvConfig = path.join(root, "devenv-config");
	for (const dir of [checkout, binDir, devenvConfig]) fs.mkdirSync(dir);
	fs.mkdirSync(path.join(configDir, "apps", "build"), { recursive: true });
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	// The developer's own Dockerfile, outside the configuration: the live path is
	// only a link to it, and neither the link nor its target may be written.
	const realDockerfile = path.join(devenvConfig, "shop-build.Dockerfile");
	fs.writeFileSync(realDockerfile, "FROM scratch\n");
	fs.symlinkSync(
		realDockerfile,
		path.join(configDir, "apps", "build", "shop-build.Dockerfile"),
	);
	fs.writeFileSync(
		path.join(configDir, "apps", "build", "shop-build.sh"),
		["#!/bin/sh", `printf 'shell-build\\n' >> ${record}`, "exit 0", ""].join(
			"\n",
		),
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(configDir, "apps", "compose", "shop-compose.yml"),
		["services:", "  shop:", "    image: shop:latest", ""].join("\n"),
	);
	if (options.declared) {
		fs.mkdirSync(path.join(configDir, "apps", "defaults"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(configDir, "apps", "defaults", "shop.json"),
			`${JSON.stringify(options.declared, null, "\t")}\n`,
		);
	}
	// A stub container runtime: no daemon, no network, and every argument it was
	// handed is recorded, so the test can assert which target really ran.
	const docker = path.join(binDir, "docker");
	fs.writeFileSync(
		docker,
		["#!/bin/sh", `printf 'docker %s\\n' "$*" >> ${record}`, "exit 0", ""].join(
			"\n",
		),
	);
	fs.chmodSync(docker, 0o755);
	return { root, configDir, checkout, record, binDir };
}

function recorded(record: string): string {
	try {
		return fs.readFileSync(record, "utf8");
	} catch {
		return "";
	}
}

function servicesFor(
	configDir: string,
	checkout: string,
	homeDir: string,
): ActionRouteServices {
	const store = EnvironmentStateStore.open(path.join(homeDir, "db"));
	const app = { ident: "shop", localDirectoryPath: checkout };
	return {
		configDir,
		homeDir,
		apps: {
			getAppByIdent: (ident) => (ident === app.ident ? app : undefined),
			getApps: () => [app],
		},
		infraServices: [],
		state: store as unknown as ActionRouteServices["state"],
		publish: () => {},
		tools: () => ALL_TOOLS,
		tempDir: path.join(homeDir, "tmp"),
	};
}

async function call(
	context: ActionRouteContext,
	url: string,
): Promise<Response> {
	const request = new Request(`http://127.0.0.1${url}`, { method: "GET" });
	const response = await handleActionRoute(
		context,
		request,
		new URL(request.url),
	);
	if (!response) throw new Error(`no route for GET ${url}`);
	return response;
}

/** The gate, run over a legacy drafts directory (no staged root): the drafted
 * shell build script and the drafted declaration, beside the live Dockerfile. */
async function runGate(
	f: Fixture,
	record: string[],
): Promise<Awaited<ReturnType<typeof validateSetupDrafts>>> {
	const draftsDir = setupDraftsDir(f.configDir, "wf-parity");
	fs.mkdirSync(path.join(draftsDir, "apps", "build"), { recursive: true });
	fs.copyFileSync(
		path.join(f.configDir, "apps", "build", "shop-build.sh"),
		path.join(draftsDir, "apps", "build", "shop-build.sh"),
	);
	fs.mkdirSync(path.join(draftsDir, "apps", "defaults"), { recursive: true });
	fs.copyFileSync(
		path.join(f.configDir, "apps", "defaults", "shop.json"),
		path.join(draftsDir, "apps", "defaults", "shop.json"),
	);
	const created = new Map<string, string>();
	return validateSetupDrafts({
		configDir: f.configDir,
		draftsDir,
		appIdent: "shop",
		checkoutDir: f.checkout,
		startTarget: async (target) => {
			created.set(target.action, target.id);
			return { ready: true };
		},
		compileTarget: async () => {},
		buildTarget: async (target) => {
			record.push(`build:${target.id}`);
			return { ok: true, exitCode: 0, logTail: "", detail: "" };
		},
		testTarget: async (target) => {
			record.push(`test:${target.id}`);
			return { ok: true, exitCode: 0, logTail: "", detail: "" };
		},
		otherAppPorts: () => new Map<number, string>(),
		envFileVariables: () =>
			new Map([["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"]]),
		processEnv: {},
	});
}

describe("one default target per app+action", () => {
	test("the declaration is read from the configuration and names the shell build", () => {
		const f = fixture({ declared: { build: SHELL_TARGET } });
		expect(readDefaultDeclaration(f.configDir, "shop")).toEqual({
			actions: { build: SHELL_TARGET },
			problems: [],
		});
	});

	test("the agent tool resolver, the UI and the smoke check pick the same target", async () => {
		const f = fixture({ declared: { build: SHELL_TARGET } });
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-home-"));
		const services = servicesFor(f.configDir, f.checkout, homeDir);
		const context = createActionRouteContext(services);
		const app = services.apps.getAppByIdent("shop");
		if (!app) throw new Error("no app");
		const previousPath = process.env.PATH ?? "";
		process.env.PATH = `${f.binDir}:${previousPath}`;
		try {
			// (a) The agent tools' build (`env_build`), which must build the target
			// the gate validated and not the Dockerfile beside it.
			const built = await runAppBuildTestAction(context, {
				app,
				action: "build",
				checkoutDir: f.checkout,
			});
			expect(built.targetId).toBe(SHELL_TARGET);
			expect(built.status).toBe("completed");
			expect(recorded(f.record)).toContain("shell-build");
			expect(recorded(f.record)).not.toContain("docker build");

			// (b) The Environments UI/TUI build action: the definitions the server
			// returns carry the authoritative marking, and the UI runs that one
			// without asking (no picker, no index 0).
			await rebuildDefinitions(services, context.registry);
			const payload = (await (
				await call(context, "/api/apps/shop/actions")
			).json()) as {
				actions: Array<{
					id: string;
					type: string;
					default?: boolean;
					defaultTargetId?: string;
					availability: { available: boolean };
				}>;
			};
			const choice = selectActionTarget(payload.actions, "build");
			expect(choice.ambiguous).toBeUndefined();
			expect(choice.target?.defaultTargetId).toBe(SHELL_TARGET);

			// (c) The post-promotion smoke check's live resolution, through the same
			// rule, and the gate's own report: the same target id.
			const live = resolveLiveDefaults({
				configDir: f.configDir,
				appIdent: "shop",
				checkoutDir: f.checkout,
			});
			expect(live.build?.target?.id).toBe(SHELL_TARGET);
			expect(live.build?.source).toBe("declared");
			expect(choice.target?.defaultTargetId).toBe(live.build?.target?.id);
			expect(built.targetId).toBe(live.build?.target?.id);

			const ran: string[] = [];
			const report = await runGate(f, ran);
			const gateBuild = report.defaults.find(
				(entry) => entry.action === "build",
			);
			expect(gateBuild?.targetId).toBe(SHELL_TARGET);
			expect(gateBuild?.source).toBe("declared");
			expect(ran).toContain(`build:${SHELL_TARGET}`);
			// The gate validated it, the live resolver resolves it, and the smoke
			// check therefore has nothing to report.
			const parity = compareSetupDefaults(
				{ build: gateBuild?.targetId ?? "" },
				live,
			);
			expect(parity).toEqual({ ok: true, drift: [] });
		} finally {
			process.env.PATH = previousPath;
		}
	});

	test("a declared run default is what env_start names, and without one nothing is forced", async () => {
		const declared = fixture({
			declared: { run: "app/shop/run/docker/default" },
		});
		expect(
			declaredTargetId({
				configDir: declared.configDir,
				appIdent: "shop",
				action: "run",
				checkoutDir: declared.checkout,
			}),
		).toBe("app/shop/run/docker/default");
		// Nothing declared: the slot controller's documented runtime preference
		// stays in charge instead of a second rule being invented here.
		const silent = fixture();
		expect(
			declaredTargetId({
				configDir: silent.configDir,
				appIdent: "shop",
				action: "run",
				checkoutDir: silent.checkout,
			}),
		).toBeUndefined();
		// A declaration that names no run target of the app forces nothing either.
		const wrong = fixture({ declared: { run: "app/shop/run/podman/default" } });
		expect(
			declaredTargetId({
				configDir: wrong.configDir,
				appIdent: "shop",
				action: "run",
				checkoutDir: wrong.checkout,
			}),
		).toBeUndefined();
	});

	test("without a declaration the family choice is refused, never guessed", async () => {
		const f = fixture();
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-home-"));
		const services = servicesFor(f.configDir, f.checkout, homeDir);
		const context = createActionRouteContext(services);
		const app = services.apps.getAppByIdent("shop");
		if (!app) throw new Error("no app");
		// The non-interactive consumer fails with the candidate list and how to
		// resolve it.
		await expect(
			runAppBuildTestAction(context, {
				app,
				action: "build",
				checkoutDir: f.checkout,
			}),
		).rejects.toThrow(/apps\/defaults\/shop\.json/);

		// The interactive consumer refuses too, naming both families.
		await rebuildDefinitions(services, context.registry);
		const payload = (await (
			await call(context, "/api/apps/shop/actions")
		).json()) as {
			actions: Array<{ id: string; type: string }>;
		};
		const choice = selectActionTarget(payload.actions, "build");
		expect(choice.target).toBeUndefined();
		expect(choice.ambiguous?.length).toBeGreaterThan(0);
		expect(choice.reason).toContain("apps/defaults/shop.json");

		// And the live resolver reports the same ambiguity, so the smoke check
		// cannot report a pass for a target nobody chose.
		const live = resolveLiveDefaults({
			configDir: f.configDir,
			appIdent: "shop",
			checkoutDir: f.checkout,
		});
		expect(live.build?.target).toBeUndefined();
		expect(live.build?.ambiguous).toBe(true);
		expect(
			(live.build?.candidates ?? []).map((candidate) => candidate.id).sort(),
		).toEqual([DOCKER_TARGET, SHELL_TARGET]);
	});

	test("a promoted declaration keeps the shell target the default after promotion", async () => {
		// The layout of the already-promoted backend: both live targets exist, the
		// promotion added `apps/defaults/shop.json`, and nothing in
		// `~/devenv-config` was touched.
		const f = fixture({ declared: { build: SHELL_TARGET } });
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-home-"));
		const services = servicesFor(f.configDir, f.checkout, homeDir);
		const context = createActionRouteContext(services);
		await rebuildDefinitions(services, context.registry);
		const payload = (await (
			await call(context, "/api/apps/shop/actions")
		).json()) as {
			actions: Array<{ id: string; defaultTargetId?: string }>;
		};
		const shellDefinition = payload.actions.find(
			(definition) => definition.defaultTargetId === SHELL_TARGET,
		);
		expect(shellDefinition).toBeDefined();
		expect(shellDefinition?.id).toContain("command-shell");
		// The Dockerfile target stays live and available; it is simply not the
		// default, which is the difference between "still there" and "what runs".
		expect(
			payload.actions.some((definition) =>
				definition.id.endsWith("/action/build/docker/default"),
			),
		).toBe(true);
		// The linked Dockerfile in the developer's own configuration is untouched.
		expect(
			fs
				.lstatSync(
					path.join(f.configDir, "apps", "build", "shop-build.Dockerfile"),
				)
				.isSymbolicLink(),
		).toBe(true);
		expect(
			fs.readFileSync(
				path.join(f.root, "devenv-config", "shop-build.Dockerfile"),
				"utf8",
			),
		).toBe("FROM scratch\n");
	});
});

/** A drafted declaration plus the promoted shell build definition. */
function draftDeclaration(f: Fixture, declared: string): string {
	const draftsDir = setupDraftsDir(f.configDir, "wf-declare");
	fs.mkdirSync(path.join(draftsDir, "apps", "defaults"), { recursive: true });
	fs.mkdirSync(path.join(draftsDir, "apps", "build"), { recursive: true });
	fs.writeFileSync(
		path.join(draftsDir, "apps", "defaults", "shop.json"),
		`${JSON.stringify({ build: declared }, null, "\t")}\n`,
	);
	fs.copyFileSync(
		path.join(f.configDir, "apps", "build", "shop-build.sh"),
		path.join(draftsDir, "apps", "build", "shop-build.sh"),
	);
	return draftsDir;
}

describe("the drafted default declaration", () => {
	test("the approval diff says which default it declares and what was ambiguous", () => {
		const f = fixture();
		const draftsDir = draftDeclaration(f, SHELL_TARGET);
		const changes = setupDraftChanges(f.configDir, draftsDir);
		const declaration = changes.find(
			(change) => change.path === "apps/defaults/shop.json",
		);
		expect(declaration).toBeDefined();
		// The developer reads the *decision*, not just a JSON blob: which action,
		// which target, and the families the live configuration had to choose
		// between before the declaration existed.
		expect(declaration?.diff).toContain(
			`# default build for shop = ${JSON.stringify(SHELL_TARGET)} (was ambiguous: docker, shell)`,
		);
	});

	test("a declaration that names no existing target fails the gate", async () => {
		const f = fixture();
		const draftsDir = draftDeclaration(f, "app/shop/build/nonexistent");
		const report = await validateSetupDrafts({
			configDir: f.configDir,
			draftsDir,
			appIdent: "shop",
			checkoutDir: f.checkout,
			startTarget: async () => ({ ready: true }),
			compileTarget: async () => {},
			otherAppPorts: () => new Map<number, string>(),
			envFileVariables: () => new Map<string, string>(),
			processEnv: {},
		});
		expect(report.ok).toBe(false);
		const finding = report.findings.find(
			(entry) => entry.check === "no-default-target",
		);
		expect(finding?.message).toContain("apps/defaults/shop.json");
		expect(finding?.message).toContain("app/shop/build/nonexistent");
	});

	test("promotion publishes it and a rollback removes it, leaving the linked Dockerfile alone", async () => {
		const f = fixture();
		const draftsDir = draftDeclaration(f, SHELL_TARGET);
		const backupDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "default-target-backup-"),
		);
		const liveDockerfile = path.join(
			f.configDir,
			"apps",
			"build",
			"shop-build.Dockerfile",
		);
		const promoted = await promoteSetupDrafts({
			configDir: f.configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-declare",
			runId: "2026-01-01T00:00:00.000Z",
			secret: "promotion-secret",
			reload: () => {},
		});
		expect(promoted.ok).toBe(true);
		// The promoted declaration is the live one, and it decides the default for
		// every consumer that reads the live configuration.
		const liveDeclaration = path.join(
			f.configDir,
			"apps",
			"defaults",
			"shop.json",
		);
		expect(fs.existsSync(liveDeclaration)).toBe(true);
		expect(readDefaultDeclaration(f.configDir, "shop").actions.build).toBe(
			SHELL_TARGET,
		);
		expect(
			resolveLiveDefaults({
				configDir: f.configDir,
				appIdent: "shop",
				checkoutDir: f.checkout,
			}).build?.target?.id,
		).toBe(SHELL_TARGET);
		// The live Dockerfile link was not drafted, so the promotion never touched
		// it: still the same link, still the same target bytes.
		expect(fs.lstatSync(liveDockerfile).isSymbolicLink()).toBe(true);
		expect(
			fs.readFileSync(
				path.join(f.root, "devenv-config", "shop-build.Dockerfile"),
				"utf8",
			),
		).toBe("FROM scratch\n");

		const rolled = await rollbackPromotion({
			configDir: f.configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-declare",
			runId: "2026-01-01T00:00:00.000Z",
			secret: "promotion-secret",
		});
		expect(rolled.ok).toBe(true);
		// A rollback removes exactly what the promotion added: the declaration and
		// the build script are gone, so the app is back to the ambiguous state the
		// developer decided against — never silently to a guessed default.
		expect(rolled.removed).toContain("apps/defaults/shop.json");
		expect(fs.existsSync(liveDeclaration)).toBe(false);
		expect(readDefaultDeclaration(f.configDir, "shop").actions).toEqual({});
		expect(fs.lstatSync(liveDockerfile).isSymbolicLink()).toBe(true);
	});

	test("an existing declaration is backed up and a rollback restores the previous one", async () => {
		const f = fixture({ declared: { build: DOCKER_TARGET } });
		const draftsDir = draftDeclaration(f, SHELL_TARGET);
		const backupDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "default-target-backup-"),
		);
		const promoted = await promoteSetupDrafts({
			configDir: f.configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-declare",
			runId: "2026-01-01T00:00:00.000Z",
			secret: "promotion-secret",
			reload: () => {},
		});
		expect(promoted.ok).toBe(true);
		expect(readDefaultDeclaration(f.configDir, "shop").actions.build).toBe(
			SHELL_TARGET,
		);
		expect(
			fs.readFileSync(
				path.join(backupDir, "apps", "defaults", "shop.json"),
				"utf8",
			),
		).toContain(DOCKER_TARGET);
		const rolled = await rollbackPromotion({
			configDir: f.configDir,
			draftsDir,
			backupDir,
			workflowId: "wf-declare",
			runId: "2026-01-01T00:00:00.000Z",
			secret: "promotion-secret",
		});
		expect(rolled.ok).toBe(true);
		expect(readDefaultDeclaration(f.configDir, "shop").actions.build).toBe(
			DOCKER_TARGET,
		);
	});
});
