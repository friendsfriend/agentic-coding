// App family routes and status selection
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/server/{handlers_apps,handlers_build,
// handlers_infra_scripts}.go` and `server/pkg/runstatus/status_test.go`.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App, InfraService } from "../src/server/environment/config.ts";
import {
	type AppFamilyServices,
	appRuntimeStatus,
	handleAppRoute,
	matchAppRoute,
	slugify,
} from "../src/server/runtime/app-routes.ts";
import type { DockerRuntime } from "../src/server/runtime/docker.ts";
import { DockerClient } from "../src/server/runtime/docker.ts";
import { StatusManager } from "../src/server/runtime/status.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

function app(overrides: Partial<App> = {}): App {
	return {
		ident: "shop",
		displayName: "Shop",
		repositoryPath: "https://github.com/acme/shop",
		appType: "app",
		localDirectoryPath: "/tmp/shop",
		branch: "main",
		...overrides,
	};
}

interface Fixture {
	services: AppFamilyServices;
	events: {
		type: string;
		properties: Record<string, unknown>;
		timestamp?: string;
	}[];
	created: App[];
	removed: string[];
	root: string;
}

function fixture(overrides: Partial<AppFamilyServices> = {}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-app-"));
	const configDir = path.join(root, "config");
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "apps", "compose", "shop-canary-compose.yml"),
		"services: {}\n",
	);
	fs.mkdirSync(path.join(configDir, "apps", "build"), { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "apps", "build", "shop-build.Dockerfile"),
		"FROM scratch\n",
	);
	const apps = [app()];
	const infraServices: InfraService[] = [
		{
			ident: "db",
			displayName: "Database",
			type: "docker",
			localDirectoryPath: "",
			branch: "",
			appType: "infrastructure",
		} as unknown as InfraService,
		{
			ident: "dev",
			displayName: "Dev script",
			type: "script",
			logPath: path.join(root, "dev.log"),
			localDirectoryPath: "",
			branch: "",
			appType: "infrastructure",
		} as unknown as InfraService,
	];
	fs.writeFileSync(path.join(root, "dev.log"), "script output\n");
	const events: {
		type: string;
		properties: Record<string, unknown>;
		timestamp?: string;
	}[] = [];
	const created: App[] = [];
	const removed: string[] = [];
	const services: AppFamilyServices = {
		configDir,
		homeDir: path.join(root, "home"),
		apps: () => apps,
		infraServices: () => infraServices,
		getAppByIdent: (ident) =>
			apps.find((candidate) => candidate.ident === ident),
		getInfraServiceByIdent: (ident) =>
			infraServices.find((candidate) => candidate.ident === ident),
		getDisplayName: (ident) =>
			apps.find((candidate) => candidate.ident === ident)?.displayName ?? ident,
		getProjectCatalog: () => [
			{
				ident: "shop",
				displayName: "shop",
				kind: "app",
				available: true,
				availability: "available",
				capabilities: { openspec: false },
			},
		],
		git: {
			getCurrentBranch: () => "main",
			getStatus: () => "clean",
		},
		loadConfig: () => {},
		addApp: (value) => {
			created.push(value);
			apps.push(value);
		},
		removeApp: (ident) => {
			const index = apps.findIndex((candidate) => candidate.ident === ident);
			if (index < 0) throw new Error(`app ${ident} not found`);
			removed.push(ident);
			apps.splice(index, 1);
		},
		setMainWorktreeBranch: () => {},
		providers: {
			get: (name) => (name === "gh" ? { name, type: "github" } : undefined),
		},
		statusManager: new StatusManager(),
		stream: { publish: (event) => events.push(event) },
		...overrides,
	};
	return { services, events, created, removed, root };
}

async function call(
	services: AppFamilyServices,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const url = new URL(`http://127.0.0.1${path}`);
	const response = await handleAppRoute(
		services,
		new Request(url, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		url,
	);
	if (!response) throw new Error(`unhandled ${method} ${path}`);
	return response;
}

describe("app route matching", () => {
	test("matches every implemented row and captures the ident", () => {
		expect(matchAppRoute("GET", "/api/apps")?.path).toBe("/api/apps");
		expect(matchAppRoute("GET", "/api/apps/shop/docker")?.ident).toBe("shop");
		expect(matchAppRoute("GET", "/api/infra-services/db/logs")?.ident).toBe(
			"db",
		);
		expect(matchAppRoute("DELETE", "/api/apps/shop/delete")?.ident).toBe(
			"shop",
		);
		expect(matchAppRoute("POST", "/api/apps/create")?.path).toBe(
			"/api/apps/create",
		);
		expect(matchAppRoute("POST", "/api/example-config")?.path).toBe(
			"/api/example-config",
		);
		// Not this family's rows.
		expect(matchAppRoute("GET", "/api/apps/shop/actions")).toBeUndefined();
		expect(matchAppRoute("POST", "/api/apps")).toBeUndefined();
	});
});

describe("app reads", () => {
	test("apps carry the resolved source type and container base name", async () => {
		const { services } = fixture();
		const response = await call(services, "GET", "/api/apps");
		expect(await response.json()).toEqual({
			apps: [
				{
					ident: "shop",
					displayName: "Shop",
					localDirectoryPath: "/tmp/shop",
					repositoryPath: "https://github.com/acme/shop",
					branch: "main",
					appType: "app",
					containerBaseName: "shop",
					sourceType: "github",
				},
			],
		});
	});

	test("status assembles docker, git and runtime status", async () => {
		const { services } = fixture({
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () =>
						new Response(
							JSON.stringify([
								{
									Id: "abc",
									Names: ["/shop-1"],
									State: "running",
									Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
								},
							]),
						)) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
		});
		const response = await call(services, "GET", "/api/status");
		const body = await response.json();
		expect(body.statuses).toHaveLength(1);
		expect(body.statuses[0]).toMatchObject({
			ident: "shop",
			resourceId: "shop",
			resourceKind: "app",
			gitStatus: "clean",
			branch: "main",
			dockerInfo: {
				Status: "running",
				ContainerID: "abc",
				Ports: "8080->80/tcp",
			},
			runtimeStatus: { state: "running" },
			status: "running",
		});
	});

	test("a library reports no runtime status", async () => {
		const { services } = fixture({
			apps: () => [app({ ident: "lib", appType: "library" })],
			getAppByIdent: () => undefined,
		});
		const body = await (await call(services, "GET", "/api/status")).json();
		expect(body.statuses[0].resourceKind).toBe("library");
		expect(body.statuses[0].runtimeStatus).toBeUndefined();
	});

	test("docker info for an app answers the runtime envelope", async () => {
		const { services } = fixture({
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () =>
						new Response(
							JSON.stringify([
								{ Id: "abc", Names: ["/shop-1"], State: "exited", Ports: [] },
							]),
						)) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
		});
		expect(
			await (await call(services, "GET", "/api/apps/shop/docker")).json(),
		).toEqual({ Status: "exited", ContainerID: "abc", Ports: "" });
		const missing = await call(services, "GET", "/api/apps/nope/docker");
		expect(missing.status).toBe(404);
	});

	test("an unavailable runtime reports error, not absence", async () => {
		const { services } = fixture();
		expect(
			await (await call(services, "GET", "/api/apps/shop/docker")).json(),
		).toEqual({ Status: "error", ContainerID: "", Ports: "" });
	});

	test("git info answers branch and status", async () => {
		const { services } = fixture();
		expect(
			await (await call(services, "GET", "/api/apps/shop/git")).json(),
		).toEqual({
			branch: "main",
			status: "clean",
		});
	});

	test("projects come from the catalog projection", async () => {
		const { services } = fixture();
		expect(await (await call(services, "GET", "/api/projects")).json()).toEqual(
			{
				revision: expect.any(String),
				projects: [
					{
						ident: "shop",
						displayName: "shop",
						kind: "app",
						available: true,
						availability: "available",
						capabilities: { openspec: false },
					},
				],
			},
		);
	});
});

describe("profiles", () => {
	test("an app reports its profile variants and Dockerfile presence", async () => {
		const { services } = fixture();
		expect(
			await (await call(services, "GET", "/api/apps/shop/profiles")).json(),
		).toEqual({ profiles: ["canary"], hasDockerfile: true });
	});

	test("an infrastructure service gets an empty list with the default option", async () => {
		const { services } = fixture();
		expect(
			// The profile picker asks the app route for an infrastructure ident
			// before starting it; Go answered with the default-only option set.
			await (await call(services, "GET", "/api/apps/db/profiles")).json(),
		).toEqual({ profiles: [], hasDockerfile: true });
	});

	test("an unknown ident is a 404", async () => {
		const { services } = fixture();
		expect(
			(await call(services, "GET", "/api/apps/nope/profiles")).status,
		).toBe(404);
	});
});

describe("infrastructure services", () => {
	test("docker and script services report their own status source", async () => {
		const { services } = fixture({
			scriptStatus: async () => ({
				status: "running (pid 42)",
				logPath: "/tmp/dev.log",
			}),
		});
		const body = await (
			await call(services, "GET", "/api/infra-services")
		).json();
		expect(body.services[0]).toMatchObject({
			ident: "db",
			resourceKind: "infrastructure",
			containerBaseName: "db",
			status: "stopped",
			runtimeStatus: { state: "stopped" },
		});
		expect(body.services[1]).toMatchObject({
			ident: "dev",
			type: "script",
			status: "running (pid 42)",
			runtimeStatus: { state: "running", detail: "pid 42" },
			logPath: "/tmp/dev.log",
		});
	});

	test("a kubernetes service reports the cluster observation", async () => {
		const { services } = fixture({
			infraServices: () => [
				{
					ident: "k8s",
					displayName: "Cluster",
					type: "kubernetes",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
				} as unknown as InfraService,
			],
			// The provider maps the Helm release status before normalizing it, as
			// `MapHelmStatus` did, so the route only sees a runtime state.
			kubernetesStatus: () => "running",
		});
		const body = await (
			await call(services, "GET", "/api/infra-services")
		).json();
		expect(body.services[0].status).toBe("running");
	});

	test("script logs are served as text and a missing path is a 404", async () => {
		const { services } = fixture({
			scriptStatus: async () => ({ status: "stopped", logPath: "" }),
		});
		const missing = await call(services, "GET", "/api/infra-services/dev/logs");
		expect(missing.status).toBe(404);
		const nonScript = await call(
			services,
			"GET",
			"/api/infra-services/db/logs",
		);
		expect(nonScript.status).toBe(404);
	});

	test("a script log path that exists is served verbatim", async () => {
		const { services, root } = fixture({
			scriptStatus: async () => ({
				status: "running",
				logPath: path.join(root, "dev.log"),
			}),
		});
		const response = await call(
			services,
			"GET",
			"/api/infra-services/dev/logs",
		);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(await response.text()).toBe("script output\n");
	});
});

describe("mutations", () => {
	test("create validates, slugs, seeds the branch and publishes", async () => {
		const { services, events, created } = fixture();
		const response = await call(services, "POST", "/api/apps/create", {
			displayName: "My Shop!",
			repositoryURL: "https://github.com/acme/my-shop",
			branch: "main",
			provider: "gh",
		});
		expect(response.status).toBe(201);
		expect(created[0].ident).toBe("my-shop");
		expect(await response.json()).toMatchObject({
			ident: "my-shop",
			sourceType: "github",
		});
		expect(events).toEqual([
			{
				type: "apps.updated",
				properties: { action: "created", ident: "my-shop" },
				timestamp: expect.any(String),
			},
		]);
	});

	test("create rejects missing fields, an unknown provider and an empty slug", async () => {
		const { services } = fixture();
		expect(
			(
				await call(services, "POST", "/api/apps/create", {
					displayName: "Shop",
					repositoryURL: "u",
					branch: "main",
				})
			).status,
		).toBe(400);
		const unknown = await call(services, "POST", "/api/apps/create", {
			displayName: "Shop",
			repositoryURL: "u",
			branch: "main",
			provider: "nope",
		});
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({
			message: 'Provider "nope" not found',
		});
		const emptySlug = await call(services, "POST", "/api/apps/create", {
			displayName: "!!!",
			repositoryURL: "u",
			branch: "main",
			provider: "gh",
		});
		expect(emptySlug.status).toBe(400);
		expect(await emptySlug.json()).toMatchObject({
			message: "displayName must contain at least one alphanumeric character",
		});
	});

	test("example config writes the tree, reloads and answers ok", async () => {
		let reloaded = 0;
		const { services, root } = fixture({
			loadConfig: () => {
				reloaded++;
			},
		});
		// Generation refuses a non-empty config directory, so the seeded fixture
		// tree is cleared: this is a clean-directory run.
		fs.rmSync(path.join(root, "config"), { recursive: true, force: true });
		const response = await call(services, "POST", "/api/example-config");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(reloaded).toBe(1);
	});

	test("a refused example-config run answers the legacy 409 envelope", async () => {
		let reloaded = 0;
		const { services, root } = fixture({
			loadConfig: () => {
				reloaded++;
			},
		});
		// A stray file makes the config directory non-empty.
		fs.writeFileSync(path.join(root, "config", "keep"), "x");
		const response = await call(services, "POST", "/api/example-config");
		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain("config directory");
		expect(reloaded).toBe(0);
	});

	test("delete removes the app and publishes, an unknown ident is a 404", async () => {
		const { services, events, removed } = fixture();
		const response = await call(services, "DELETE", "/api/apps/shop/delete");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			message: "App removed successfully",
		});
		expect(removed).toEqual(["shop"]);
		expect(events[0].properties).toEqual({ action: "deleted", ident: "shop" });
		expect(
			(await call(services, "DELETE", "/api/apps/shop/delete")).status,
		).toBe(404);
	});
});

describe("runtime status selection (Go runstatus fixture)", () => {
	const withObservation = (observation: {
		kubernetesStatus?: string;
		lastRunRuntime?: string;
		shellTmuxRunActive?: boolean;
	}) => observation;

	test("the highest-ranked observation wins regardless of runtime type", () => {
		expect(
			appRuntimeStatus(
				withObservation({ kubernetesStatus: "running (1/1 pods)" }),
				{
					Status: "exited",
					ContainerID: "",
					Ports: "",
				},
			),
		).toEqual({ state: "running", detail: "1/1 pods" });
	});

	test("two equally running observations aggregate", () => {
		expect(
			appRuntimeStatus(withObservation({ kubernetesStatus: "running" }), {
				Status: "running",
				ContainerID: "x",
				Ports: "",
			}),
		).toEqual({ state: "running", detail: "2 targets" });
	});

	test("a shell tmux run counts only for a shell last-run runtime", () => {
		expect(
			appRuntimeStatus(
				withObservation({ lastRunRuntime: "shell", shellTmuxRunActive: true }),
				{ Status: "not found", ContainerID: "", Ports: "" },
			),
		).toEqual({ state: "running" });
		expect(
			appRuntimeStatus(
				withObservation({
					lastRunRuntime: "docker",
					shellTmuxRunActive: true,
				}),
				{ Status: "not found", ContainerID: "", Ports: "" },
			),
		).toEqual({ state: "stopped" });
	});

	test("an unavailable runtime observation is stopped, never a failure", () => {
		expect(
			appRuntimeStatus(withObservation({}), {
				Status: "error",
				ContainerID: "",
				Ports: "",
			}),
		).toEqual({ state: "stopped" });
	});
});

describe("slugify", () => {
	test("matches Go's slug rules", () => {
		expect(slugify("My Shop!")).toBe("my-shop");
		expect(slugify("  Already-Slugged  ")).toBe("already-slugged");
		expect(slugify("!!!")).toBe("");
	});
});
