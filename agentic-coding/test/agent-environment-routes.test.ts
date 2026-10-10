// The agent environment routes (`add-agent-environment-tools`, tasks 2.1/2.2):
// owner scoping, the slot operations behind them, the redactor, and the
// transport that only ever accepts the owner-scoped capability.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionRegistry } from "../src/server/actions/registry.ts";
import {
	type ActionRouteContext,
	type ActionRouteServices,
	createActionRouteContext,
} from "../src/server/actions/routes.ts";
import { createServerApp } from "../src/server/app.ts";
import {
	createInstanceAuthority,
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import {
	type AgentEnvironmentDeps,
	handleAgentEnvironmentRoute,
} from "../src/server/environment/agent-routes.ts";
import type { App } from "../src/server/environment/config.ts";
import type { EnvironmentManager } from "../src/server/environment/manager.ts";
import { EventBroker } from "../src/server/events.ts";
import type { IntegrationServices } from "../src/server/integrations/routes.ts";
import type { DockerRuntimeSelection } from "../src/server/runtime/docker.ts";
import type { EnvironmentInstanceController } from "../src/server/runtime/instances.ts";
import { EnvironmentInstanceError } from "../src/server/runtime/instances.ts";
import type { RuntimeRouteServices } from "../src/server/runtime/routes.ts";

const OWNER = "workflow:wf-alpha";

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-routes-"));
}

function appOf(ident: string, checkout: string): App {
	return {
		ident,
		displayName: ident === "shop" ? "Shop" : ident,
		repositoryPath: `https://example.com/${ident}.git`,
		appType: "APP",
		containerBaseName: ident,
		sourceType: "git",
		gitMode: "BRANCH",
		localDirectoryPath: checkout,
		branch: "main",
	};
}

function appsDouble(apps: readonly App[]): EnvironmentManager {
	return {
		getApps: () => apps,
		getAppByIdent: (ident: string) => apps.find((app) => app.ident === ident),
	} as unknown as EnvironmentManager;
}

/** A registry whose snapshot carries the definitions `env_list` reports. */
function registryDouble(): ActionRegistry {
	return {
		snapshot: () => ({
			definitions: [
				{
					id: "app/shop/action/run/docker/default",
					type: "run",
					runtime: "docker",
					label: "Docker",
					owner: { kind: "app", id: "shop" },
					availability: { available: true },
					inputs: [],
				},
				{
					id: "app/shop/action/build/shell/default",
					type: "build",
					runtime: "shell",
					label: "Shell",
					owner: { kind: "app", id: "shop" },
					availability: { available: false, reason: "no Dockerfile" },
					inputs: [],
				},
			],
		}),
	} as unknown as ActionRegistry;
}

interface ControllerSpy {
	readonly instance: EnvironmentInstanceController;
	readonly acquired: unknown[];
	readonly stopped: string[];
	readonly touched: string[];
}

interface ControllerSpy {
	readonly instance: EnvironmentInstanceController;
	readonly acquired: unknown[];
	readonly stopped: string[];
	readonly touched: string[];
}

function controllerDouble(input: {
	slots?: Array<{
		app: string;
		holder: string | null;
		status: string | null;
		waiters: string[];
	}>;
	holders?: Record<string, { holder: string; status: string }>;
	acquire?: unknown;
	/** Rejects the acquire, as the controller does for a detected cycle. */
	acquireError?: unknown;
}): ControllerSpy {
	const acquired: unknown[] = [];
	const stopped: string[] = [];
	const touched: string[] = [];
	const instance = {
		slots: async () => input.slots ?? [],
		occupancy: async (app: string) => input.holders?.[app],
		acquire: async (request: unknown) => {
			acquired.push(request);
			if (input.acquireError) throw input.acquireError;
			return (
				input.acquire ?? { outcome: "started", owner: OWNER, instances: [] }
			);
		},
		// The real controller enforces the owner here; the double mirrors it so a
		// route that stopped without checking would fail this suite too.
		stopOwned: async (owner: string, app: string) => {
			const holder = input.holders?.[app]?.holder;
			if (holder !== owner)
				throw new EnvironmentInstanceError(
					"held-by",
					409,
					`${JSON.stringify(app)} is held by ${holder ?? "nobody"}; only its owner may stop it`,
				);
			stopped.push(app);
			return {
				app,
				status: "stopped",
				targetId: `app/${app}/run/docker`,
				runtime: "docker",
			};
		},
		touchOwnedActivity: (_owner: string, app: string) => {
			touched.push(app);
		},
	} as unknown as EnvironmentInstanceController;
	return { instance, acquired, stopped, touched };
}

interface CallResult {
	readonly status: number;
	readonly body: Record<string, unknown>;
	readonly text: string;
}

async function call(
	deps: AgentEnvironmentDeps,
	method: string,
	routePath: string,
	init: { body?: unknown } = {},
): Promise<CallResult> {
	const response = await handleAgentEnvironmentRoute(
		deps,
		new Request(`http://127.0.0.1:4050${routePath}`, {
			method,
			...(init.body === undefined
				? {}
				: {
						body: JSON.stringify(init.body),
						headers: { "content-type": "application/json" },
					}),
		}),
		new URL(`http://127.0.0.1:4050${routePath}`),
		OWNER,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	return { status: response.status, body: JSON.parse(text), text };
}

function payloadOf(result: CallResult): Record<string, unknown> {
	const value = result.body.value;
	if (typeof value !== "object" || value === null)
		throw new Error(`no value in ${result.text}`);
	return value as Record<string, unknown>;
}

describe("the agent environment routes are owner-scoped", () => {
	test("the list reports holders, waiters and the app's targets", async () => {
		const controller = controllerDouble({
			slots: [
				{
					app: "shop",
					holder: "workflow:other",
					status: "running",
					waiters: [OWNER],
				},
			],
		});
		const result = await call(
			{
				configDir: "",
				instances: controller.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
				registry: registryDouble(),
			},
			"GET",
			"/api/v1/agent-env/list",
		);
		expect(result.status).toBe(200);
		const value = payloadOf(result);
		expect(value.owner).toBe(OWNER);
		const apps = value.apps as Array<Record<string, unknown>>;
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({
			app: "shop",
			holder: "workflow:other",
			status: "running",
			waiters: [OWNER],
			heldByYou: false,
		});
		expect(apps[0]?.targets).toEqual([
			{
				id: "app/shop/action/run/docker/default",
				action: "run",
				runtime: "docker",
				label: "Docker",
				available: true,
			},
			{
				id: "app/shop/action/build/shell/default",
				action: "build",
				runtime: "shell",
				label: "Shell",
				available: false,
				reason: "no Dockerfile",
			},
		]);
	});

	test("acquire always asks for the derived owner, never one from the body", async () => {
		const controller = controllerDouble({
			acquire: {
				outcome: "waiting",
				owner: OWNER,
				apps: ["shop"],
				positions: { shop: 1 },
				holders: { shop: "workflow:other" },
			},
		});
		const result = await call(
			{
				configDir: "",
				instances: controller.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
			},
			"POST",
			"/api/v1/agent-env/acquire",
			{ body: { apps: "shop", waitSec: 30 } },
		);
		expect(result.status).toBe(200);
		expect(payloadOf(result)).toMatchObject({
			outcome: "waiting",
			owner: OWNER,
			positions: { shop: 1 },
			holders: { shop: "workflow:other" },
		});
		expect(controller.acquired[0]).toMatchObject({
			owner: OWNER,
			apps: ["shop"],
			waitSec: 30,
		});
	});

	test("an owner can never stop an app held by another owner", async () => {
		const controller = controllerDouble({
			holders: { shop: { holder: "workflow:other", status: "running" } },
		});
		const result = await call(
			{
				configDir: "",
				instances: controller.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
			},
			"POST",
			"/api/v1/agent-env/stop",
			{ body: { app: "shop" } },
		);
		expect(result.status).toBe(409);
		expect(JSON.stringify(result.body)).toContain("held by workflow:other");
		// The refusal is the whole point: the other owner's run was never
		// touched, so it keeps running.
		expect(controller.stopped).toEqual([]);
	});

	test("an owner stops its own app and a free app is not a stop", async () => {
		const held = controllerDouble({
			holders: { shop: { holder: OWNER, status: "running" } },
		});
		const stopped = await call(
			{
				configDir: "",
				instances: held.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
			},
			"POST",
			"/api/v1/agent-env/stop",
			{ body: { app: "shop" } },
		);
		expect(stopped.status).toBe(200);
		expect(held.stopped).toEqual(["shop"]);
		expect(payloadOf(stopped)).toMatchObject({
			app: "shop",
			status: "stopped",
		});

		const free = controllerDouble({});
		const missing = await call(
			{
				configDir: "",
				instances: free.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
			},
			"POST",
			"/api/v1/agent-env/stop",
			{ body: { app: "shop" } },
		);
		expect(missing.status).toBe(409);
		expect(free.stopped).toEqual([]);
	});

	test("status reports the holder and the developer's release notice", async () => {
		const controller = controllerDouble({
			slots: [
				{
					app: "shop",
					holder: OWNER,
					status: "released-by-developer",
					waiters: [],
				},
			],
		});
		const result = await call(
			{
				configDir: "",
				instances: controller.instance,
				apps: appsDouble([appOf("shop", "/repos/shop")]),
			},
			"GET",
			"/api/v1/agent-env/status?app=shop",
		);
		expect(result.status).toBe(200);
		const apps = payloadOf(result).apps as Array<Record<string, unknown>>;
		expect(apps[0]).toMatchObject({
			app: "shop",
			holder: OWNER,
			status: "released-by-developer",
			heldByYou: true,
		});
		expect(String(apps[0]?.notice)).toContain("env_start again");
	});

	test("an unknown route under the prefix is a 404, not a silent success", async () => {
		const result = await call(
			{ configDir: "", instances: controllerDouble({}).instance },
			"GET",
			"/api/v1/agent-env/nope",
		);
		expect(result.status).toBe(404);
	});

	test("a missing capability answers 503 instead of an empty environment", async () => {
		const result = await call(
			{ configDir: "" },
			"GET",
			"/api/v1/agent-env/list",
		);
		expect(result.status).toBe(503);
	});
});

describe("the agent environment response is bounded and redacted", () => {
	function logsFixture(): {
		deps: AgentEnvironmentDeps;
		configDir: string;
		cleanup: () => void;
	} {
		const root = tempRoot();
		const configDir = path.join(root, "config");
		const checkout = path.join(root, "shop");
		fs.mkdirSync(configDir, { recursive: true });
		fs.mkdirSync(checkout, { recursive: true });
		// The app's compose file is what its container's config-file label names.
		fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
		const composePath = path.join(
			configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		fs.writeFileSync(
			composePath,
			"services:\n  web:\n    image: shop:latest\n",
		);
		// A configuration `.env` value and a secret action input: both must come
		// back as the marker, and a short value must survive untouched.
		fs.writeFileSync(
			path.join(configDir, ".env"),
			"ICON_APPLICATION_MASTERPASSWORD=hunter2-shared-secret\nSHORT=x\n",
		);
		const registry = {
			snapshot: () => ({
				definitions: [
					{
						id: "app/shop/action/run/docker/default",
						type: "run",
						runtime: "docker",
						label: "Docker",
						owner: { kind: "app", id: "shop" },
						availability: { available: true },
						inputs: [
							{
								key: "registry.token",
								visibility: "secret",
								default: "hunter2-action-secret",
							},
						],
					},
				],
			}),
		} as unknown as ActionRegistry;
		const logs = [
			"ICON_APPLICATION_MASTERPASSWORD=hunter2-shared-secret",
			"registry pull token hunter2-action-secret",
			"SHORT=x is not a secret",
			"boot ok",
		].join("\n");
		const docker = {
			client: {
				allContainers: async () => [
					{
						Id: "container-1",
						Names: ["/shop-web"],
						State: "running",
						Ports: [],
						Labels: {
							"com.docker.compose.project": "shop",
							"com.docker.compose.project.config_files": composePath,
						},
					},
				],
				getContainerLogs: async () => logs,
			},
		} as unknown as DockerRuntimeSelection;
		return {
			deps: {
				configDir,
				registry,
				instances: controllerDouble({}).instance,
				apps: appsDouble([appOf("shop", checkout)]),
				runtime: { docker } as unknown as RuntimeRouteServices,
			},
			configDir,
			cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		};
	}

	test("configuration and action secrets become the redaction marker", async () => {
		const fixture = logsFixture();
		try {
			const result = await call(
				fixture.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop",
			);
			expect(result.status).toBe(200);
			expect(result.text).not.toContain("hunter2-shared-secret");
			expect(result.text).not.toContain("hunter2-action-secret");
			expect(result.text).toContain(
				"«redacted:ICON_APPLICATION_MASTERPASSWORD»",
			);
			expect(result.text).toContain("«redacted:registry.token»");
			// A value too short to be replaced everywhere is still a secret in the
			// one form that names it, so an app that dumps its environment cannot
			// leak one either.
			expect(result.text).toContain("SHORT=«redacted:SHORT» is not a secret");
			const value = payloadOf(result);
			expect(value.source).toContain("docker");
			expect(value.lines).toHaveLength(4);
		} finally {
			fixture.cleanup();
		}
	});

	test("tail, grep and since bound what comes back", async () => {
		const fixture = logsFixture();
		try {
			const tailed = await call(
				fixture.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop&tail=2",
			);
			const lines = payloadOf(tailed).lines as string[];
			expect(lines).toHaveLength(2);
			expect(lines[1]).toContain("boot ok");
			expect(payloadOf(tailed).truncated).toBe(true);

			const grepped = await call(
				fixture.deps,
				"GET",
				`/api/v1/agent-env/logs?app=shop&grep=${encodeURIComponent("boot")}`,
			);
			expect(payloadOf(grepped).lines).toHaveLength(1);
			expect(payloadOf(grepped).matched).toBe(1);

			// A `since` in the future drops every timestamped line, and the lines
			// this source never stamped are kept.
			const future = await call(
				fixture.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop&since=2999-01-01T00:00:00Z",
			);
			expect(payloadOf(future).lines).toHaveLength(4);

			const missing = await call(
				fixture.deps,
				"GET",
				"/api/v1/agent-env/logs?app=nope",
			);
			expect(missing.status).toBe(404);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("env_build and env_test run in the workflow's checkout", () => {
	function buildFixture(script: string): {
		deps: AgentEnvironmentDeps;
		context: ActionRouteContext;
		checkout: string;
		cleanup: () => void;
	} {
		const root = tempRoot();
		const configDir = path.join(root, "config");
		const checkout = path.join(root, "workflow-checkout");
		fs.mkdirSync(path.join(configDir, "apps", "build"), { recursive: true });
		fs.mkdirSync(checkout, { recursive: true });
		// A shell build target is what the app offers; its script is the command.
		// Both actions get one so the build and test routes are both exercisable.
		for (const action of ["build", "test"])
			fs.writeFileSync(
				path.join(configDir, "apps", "build", `shop-${action}.sh`),
				`#!/bin/sh\n${script}\n`,
				{ mode: 0o755 },
			);
		const app = appOf("shop", path.join(root, "app-checkout"));
		const services: ActionRouteServices = {
			configDir,
			homeDir: root,
			apps: {
				getAppByIdent: (ident: string) => (ident === "shop" ? app : undefined),
				getApps: () => [app],
			},
			infraServices: [],
			state: {
				addActionEvent: () => {},
				getActionEventsSince: () => [],
				getActionEventsBetween: () => [],
				addActionLogEvent: () => {},
				getActionLogEvents: () => [],
				getScriptArgsHistory: () => [],
				addScriptArgsHistory: () => {},
			},
			publish: () => {},
			logger: () => {},
		};
		const context = createActionRouteContext(services);
		return {
			deps: {
				configDir,
				instances: controllerDouble({}).instance,
				apps: appsDouble([app]),
				registry: registryDouble(),
				actions: context,
				resolveOwnerCheckout: () => checkout,
			},
			context,
			checkout,
			cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		};
	}

	test("a build runs the app's action against the workflow's checkout and reports its output", async () => {
		const fixture = buildFixture("pwd; echo built-ok");
		try {
			const result = await call(
				fixture.deps,
				"POST",
				"/api/v1/agent-env/build",
				{ body: { app: "shop" } },
			);
			expect(result.status).toBe(200);
			const value = payloadOf(result);
			expect(value).toMatchObject({
				owner: OWNER,
				app: "shop",
				action: "build",
				status: "completed",
				exitCode: 0,
				truncated: false,
			});
			expect(String(value.output)).toContain("built-ok");
			// The action ran in the workflow's checkout, not the app's.
			expect(String(value.output)).toContain(fixture.checkout);
			// It is a real run: it appears in the action history.
			expect(fixture.context.runs.all().length).toBe(1);
		} finally {
			fixture.cleanup();
		}
	});

	test("a failing build is a result with its output, not a transport error", async () => {
		const fixture = buildFixture("echo boom >&2; exit 3");
		try {
			const result = await call(
				fixture.deps,
				"POST",
				"/api/v1/agent-env/test",
				{ body: { app: "shop" } },
			);
			expect(result.status).toBe(200);
			const value = payloadOf(result);
			expect(value.status).toBe("failed");
			expect(value.exitCode).toBe(3);
			expect(String(value.output)).toContain("boom");
		} finally {
			fixture.cleanup();
		}
	});

	test("a build without a resolvable workflow checkout is refused", async () => {
		const fixture = buildFixture("echo built-ok");
		try {
			const result = await call(
				{ ...fixture.deps, resolveOwnerCheckout: () => undefined },
				"POST",
				"/api/v1/agent-env/build",
				{ body: { app: "shop" } },
			);
			expect(result.status).toBe(409);
			expect(JSON.stringify(result.body)).toContain("no managed checkout");
		} finally {
			fixture.cleanup();
		}
	});

	test("an app+action already running is a conflict, not a bad request", async () => {
		const fixture = buildFixture("echo built-ok");
		try {
			// A run of the same app and action is already registered, as the
			// developer's own build would leave it.
			fixture.context.runs.start(
				{
					id: "action-other",
					title: "Other build",
					appIdent: "shop",
					action: "build",
					status: "active",
					steps: [],
				},
				"shop",
				"build",
			);
			const result = await call(
				fixture.deps,
				"POST",
				"/api/v1/agent-env/build",
				{ body: { app: "shop" } },
			);
			expect(result.status).toBe(409);
			expect(result.body.error).toMatchObject({ code: "action-active" });
		} finally {
			fixture.cleanup();
		}
	});
});

describe("the transport accepts only the owner-scoped capability", () => {
	const authority = createInstanceAuthority("inst-1", "instance-token-value");

	function serverFor(configDir: string) {
		const integrations = {
			apps: {
				getAppByIdent: () => undefined,
				getApps: () => [],
				updateAppActiveWorktree: () => {},
				loadConfig: () => {},
			},
			resolveOwnerCheckout: () => undefined,
		} as unknown as IntegrationServices;
		return createServerApp({
			authority,
			events: new EventBroker(authority.instance),
			credentials: new CredentialRegistry(),
			configDir,
			integrations,
		});
	}

	test("the instance token and the orchestrator capability never open an agent route", async () => {
		const configDir = tempRoot();
		try {
			const app = serverFor(configDir);
			const headers = (token: string) => ({
				authorization: `Bearer ${token}`,
				[ENVIRONMENT_OWNER_HEADER]: OWNER,
			});
			for (const token of [
				authority.token,
				orchestratorTokenFor(authority.token),
			]) {
				const response = await app.fetch(
					new Request("http://127.0.0.1:4050/api/v1/agent-env/list", {
						headers: headers(token),
					}),
				);
				expect(response.status).toBe(401);
				expect(await response.text()).toContain(
					"invalid agent environment capability",
				);
			}
			// Without the owner header the request does not even reach the
			// capability check.
			const bare = await app.fetch(
				new Request("http://127.0.0.1:4050/api/v1/agent-env/list", {
					headers: { authorization: `Bearer ${authority.token}` },
				}),
			);
			expect(bare.status).toBe(401);
			// The capability opens it, and the answer is the redacted envelope.
			const allowed = await app.fetch(
				new Request("http://127.0.0.1:4050/api/v1/agent-env/list", {
					headers: headers(environmentTokenFor(authority.token, OWNER)),
				}),
			);
			// No slot capability is attached to this server, so the route reports
			// that rather than an empty environment.
			expect(allowed.status).toBe(503);
			expect(await allowed.text()).toContain("slot capability is not attached");
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("a request without any capability is refused before the routes run", async () => {
		const configDir = tempRoot();
		try {
			const app = serverFor(configDir);
			const response = await app.fetch(
				new Request("http://127.0.0.1:4050/api/v1/agent-env/list"),
			);
			expect(response.status).toBe(401);
			expect(await response.text()).toContain(
				"missing or invalid agent environment owner",
			);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("the agent environment surface forwards what the caller asked for", () => {
	function depsWith(controller: ControllerSpy): AgentEnvironmentDeps {
		return {
			configDir: "",
			instances: controller.instance,
			apps: appsDouble([appOf("shop", "/repos/shop")]),
		};
	}

	test("acquire carries the target, profile, runtime and the caller's signal", async () => {
		const controller = controllerDouble({
			acquire: { outcome: "started", owner: OWNER, instances: [] },
		});
		const result = await call(
			depsWith(controller),
			"POST",
			"/api/v1/agent-env/acquire",
			{
				body: {
					apps: ["shop"],
					target: "app/shop/run/docker/default",
					profile: "dev",
					runtime: "shell",
					waitSec: 5,
				},
			},
		);
		expect(result.status).toBe(200);
		expect(controller.acquired[0]).toMatchObject({
			owner: OWNER,
			apps: ["shop"],
			target: "app/shop/run/docker/default",
			profile: "dev",
			runtime: "shell",
			waitSec: 5,
		});
		// The request's own signal travels with it, so a caller that goes away ends
		// the server-side wait instead of leaving an abandoned long poll.
		expect(controller.acquired[0]).toHaveProperty("signal");
	});

	test("a cancelled wait is answered as a cancelled outcome", async () => {
		const controller = controllerDouble({
			acquire: { outcome: "cancelled", owner: OWNER, apps: ["shop"] },
		});
		const result = await call(
			depsWith(controller),
			"POST",
			"/api/v1/agent-env/acquire",
			{ body: { apps: "shop" } },
		);
		expect(result.status).toBe(200);
		expect(String(payloadOf(result).notice)).toContain("cancelled");
	});

	test("a detected cycle is an answer, not a transport failure", async () => {
		const controller = controllerDouble({
			acquireError: new EnvironmentInstanceError(
				"deadlock",
				409,
				"deadlock: workflow:a -> workflow:b",
			),
		});
		const result = await call(
			depsWith(controller),
			"POST",
			"/api/v1/agent-env/acquire",
			{ body: { apps: "shop" } },
		);
		// The tool has a `deadlock` branch to report, so the route must answer one
		// as a value rather than as an error envelope.
		expect(result.status).toBe(200);
		expect(payloadOf(result)).toMatchObject({
			outcome: "deadlock",
			owner: OWNER,
		});
		expect(result.text).toContain("workflow:a -> workflow:b");
	});

	test("every operation reports its use of the caller's apps", async () => {
		const controller = controllerDouble({
			holders: { shop: { holder: OWNER, status: "running" } },
		});
		await call(depsWith(controller), "POST", "/api/v1/agent-env/stop", {
			body: { app: "shop" },
		});
		expect(controller.touched).toEqual(["shop"]);
	});
});

describe("env_logs bounds and selects its source", () => {
	interface LogsHarness {
		readonly deps: AgentEnvironmentDeps;
		readonly cleanup: () => void;
	}

	function logsHarness(
		options: {
			readonly logText?: string;
			readonly containers?: Array<{ Id: string; Names: string[] }>;
			readonly envFile?: string;
			readonly infra?: { ident: string; type: string; logPath?: string };
		} = {},
	): LogsHarness {
		const root = tempRoot();
		const configDir = path.join(root, "config");
		const checkout = path.join(root, "shop");
		fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
		fs.mkdirSync(checkout, { recursive: true });
		const composePath = path.join(
			configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		fs.writeFileSync(
			composePath,
			"services:\n  web:\n    image: shop:latest\n",
		);
		if (options.envFile)
			fs.writeFileSync(path.join(configDir, ".env"), options.envFile);
		const containers = (
			options.containers ?? [{ Id: "container-1", Names: ["/shop-web"] }]
		).map((container) => ({
			...container,
			State: "running",
			Ports: [],
			Labels: { "com.docker.compose.project.config_files": composePath },
		}));
		const docker = {
			client: {
				allContainers: async () => containers,
				getContainerLogs: async () => options.logText ?? "boot ok\n",
			},
		} as unknown as DockerRuntimeSelection;
		return {
			deps: {
				configDir,
				instances: controllerDouble({}).instance,
				apps: appsDouble([appOf("shop", checkout)]),
				runtime: {
					docker,
					infraServices: options.infra ? [options.infra] : [],
				} as unknown as RuntimeRouteServices,
			},
			cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		};
	}

	test("a script service's log file is the source, and infra means infra only", async () => {
		const root = tempRoot();
		try {
			const logPath = path.join(root, "db.log");
			fs.writeFileSync(logPath, "line one\nline two\nline three\n");
			const harness = logsHarness({
				infra: { ident: "db", type: "script", logPath },
			});
			try {
				const read = await call(
					harness.deps,
					"GET",
					"/api/v1/agent-env/logs?app=db&infra=1&tail=2",
				);
				expect(read.status).toBe(200);
				const value = payloadOf(read);
				expect(value.source).toBe(logPath);
				expect(value.lines).toEqual(["line two", "line three"]);
				// `infra=1` resolves the ident as infrastructure only: an app ident is
				// not silently read as an app.
				const app = await call(
					harness.deps,
					"GET",
					"/api/v1/agent-env/logs?app=shop&infra=1",
				);
				expect(app.status).toBe(404);
			} finally {
				harness.cleanup();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("service narrows the docker fan-out to one container", async () => {
		const harness = logsHarness({
			logText: "ready\n",
			containers: [
				{ Id: "container-web", Names: ["/shop-web"] },
				{ Id: "container-worker", Names: ["/shop-worker"] },
			],
		});
		try {
			const all = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop",
			);
			expect(payloadOf(all).lines).toHaveLength(2);
			const worker = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop&service=worker",
			);
			expect(payloadOf(worker).lines).toEqual(["[shop-worker] ready"]);
		} finally {
			harness.cleanup();
		}
	});

	test("a single oversized line is cut by the character budget", async () => {
		const harness = logsHarness({ logText: `${"x".repeat(60_000)}\n` });
		try {
			const result = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop",
			);
			const value = payloadOf(result);
			expect(value.truncated).toBe(true);
			const line = (value.lines as string[])[0] as string;
			expect(line.endsWith("…")).toBe(true);
			expect(line.length).toBeLessThan(40_100);
		} finally {
			harness.cleanup();
		}
	});

	test("grep is a literal substring, never a compiled pattern", async () => {
		const harness = logsHarness({ logText: "aaab\nxx\n" });
		try {
			// A regex would match `aaab` for `a+b` and everything for `.*`; a literal
			// filter matches neither, which is what keeps an untrusted pattern off
			// the shared event loop.
			for (const pattern of ["a+b", ".*", "(a+)+$"]) {
				const result = await call(
					harness.deps,
					"GET",
					`/api/v1/agent-env/logs?app=shop&grep=${encodeURIComponent(pattern)}`,
				);
				expect(payloadOf(result).lines).toEqual([]);
				expect(payloadOf(result).matched).toBe(0);
			}
			const literal = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop&grep=aaab",
			);
			expect(payloadOf(literal).lines).toEqual(["[shop-web] aaab"]);
		} finally {
			harness.cleanup();
		}
	});

	test("a since that is not an instant is refused, not silently ignored", async () => {
		const harness = logsHarness({ logText: "boot ok\n" });
		try {
			const result = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop&since=10m",
			);
			expect(result.status).toBe(400);
			expect(result.body.error).toMatchObject({ code: "invalid-since" });
		} finally {
			harness.cleanup();
		}
	});

	test("a declared secret is redacted out of error text too", async () => {
		const harness = logsHarness({
			envFile: "ICON_APPLICATION_MASTERPASSWORD=hunter2-shared-secret\n",
		});
		try {
			// The ident is echoed in the not-found message, which is the one path
			// where the text is assembled from caller-supplied input.
			const result = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=hunter2-shared-secret",
			);
			expect(result.status).toBe(404);
			expect(result.text).not.toContain("hunter2-shared-secret");
			expect(result.text).toContain(
				"«redacted:ICON_APPLICATION_MASTERPASSWORD»",
			);
		} finally {
			harness.cleanup();
		}
	});

	test("a short declared secret is redacted where it is named", async () => {
		const harness = logsHarness({
			envFile: "POSTGRES_PASSWORD=abc12\n",
			logText: "POSTGRES_PASSWORD=abc12 and abc12 on its own\n",
		});
		try {
			const result = await call(
				harness.deps,
				"GET",
				"/api/v1/agent-env/logs?app=shop",
			);
			const line = (payloadOf(result).lines as string[])[0] as string;
			// The assignment is redacted; a bare occurrence of a five-character
			// value is not, or every `abc12`-like string in ordinary output would
			// become a marker.
			expect(line).toContain("POSTGRES_PASSWORD=«redacted:POSTGRES_PASSWORD»");
			expect(line).toContain("abc12 on its own");
		} finally {
			harness.cleanup();
		}
	});
});

describe("the list and status report only real apps", () => {
	test("a library app is not offered to an agent", async () => {
		const controller = controllerDouble({});
		const library = {
			...appOf("shared-lib", "/repos/shared-lib"),
			appType: "LIB",
		};
		const result = await call(
			{
				configDir: "",
				instances: controller.instance,
				apps: appsDouble([appOf("shop", "/repos/shop"), library]),
			},
			"GET",
			"/api/v1/agent-env/list",
		);
		const apps = payloadOf(result).apps as Array<Record<string, unknown>>;
		expect(apps.map((app) => app.app)).toEqual(["shop"]);
	});

	test("status without an app reports every slot", async () => {
		const controller = controllerDouble({
			slots: [
				{ app: "shop", holder: OWNER, status: "running", waiters: [] },
				{
					app: "free",
					holder: "workflow:other",
					status: "running",
					waiters: [OWNER],
				},
			],
		});
		const result = await call(
			{ configDir: "", instances: controller.instance },
			"GET",
			"/api/v1/agent-env/status",
		);
		const apps = payloadOf(result).apps as Array<Record<string, unknown>>;
		expect(apps.map((app) => app.app)).toEqual(["shop", "free"]);
		expect(apps[0]?.heldByYou).toBe(true);
		expect(apps[1]?.heldByYou).toBe(false);
	});
});
