// Environment TUI journeys through the Bun runtime routes
// (`port-environment-runtimes-to-bun`, task 4.6).
//
// The environment view is a client of the app, docker and kubernetes routes: it
// hydrates `/api/status` and `/api/infra-services`, opens container log and stat
// streams, starts/stops containers and reads a cluster summary. This test drives
// the *unchanged* devenv client helpers with the payloads the Bun routes
// produce, so the journey is asserted end to end without a terminal.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "../packages/devenv/core/src/index";
import type { InfraService } from "../src/server/actions/targets.ts";
import type { App } from "../src/server/environment/config.ts";
import {
	type AppFamilyServices,
	handleAppRoute,
} from "../src/server/runtime/app-routes.ts";
import { createAppFamilyServices } from "../src/server/runtime/app-services.ts";
import {
	DockerClient,
	type DockerRuntime,
} from "../src/server/runtime/docker.ts";
import {
	KubernetesClusterService,
	type KubernetesExec,
	Runner,
} from "../src/server/runtime/kubernetes.ts";
import { StatusManager } from "../src/server/runtime/status.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

/** The app-family capability the TUI journeys read. */
function capability(options: {
	apps?: readonly App[];
	infra?: readonly InfraService[];
	scriptStatus?: (
		ident: string,
	) => Promise<{ status: string; logPath: string }>;
}): AppFamilyServices {
	const apps = options.apps ?? [
		{
			ident: "shop",
			displayName: "Shop",
			repositoryPath: "https://github.com/acme/shop",
			appType: "app",
			localDirectoryPath: "/src/shop",
			branch: "main",
			activeWorktree: "main",
		},
	];
	const infra = options.infra ?? [];
	const manager = {
		getApps: () => apps,
		getInfraServices: () => infra,
		getAppByIdent: (ident: string) => apps.find((app) => app.ident === ident),
		getInfraServiceByIdent: (ident: string) =>
			infra.find((service) => service.ident === ident),
		getDisplayName: (ident: string) => ident,
		getProjectCatalog: () => [{ ident: "shop" }],
		loadConfig: () => {},
		addApp: () => {},
		removeApp: () => {},
		setMainWorktreeBranch: () => {},
	} as unknown as Parameters<typeof createAppFamilyServices>[0]["manager"];
	return createAppFamilyServices({
		configDir: "/c",
		homeDir: "/h",
		manager,
		git: {
			getCurrentBranch: () => "main",
			getStatus: () => "clean",
		} as unknown as Parameters<typeof createAppFamilyServices>[0]["git"],
		providers: {
			get: () => undefined,
		} as unknown as Parameters<typeof createAppFamilyServices>[0]["providers"],
		...(options.scriptStatus ? { scriptStatus: options.scriptStatus } : {}),
	});
}

/** Serves the app family over a real HTTP server the devenv client can reach. */
async function serve(services: AppFamilyServices): Promise<{
	url: string;
	stop: () => void;
}> {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const response = await handleAppRoute(services, request, url);
			return response ?? new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

describe("environment status journey", () => {
	test("the client reads apps, status and infrastructure in the route shapes", async () => {
		const selection = {
			runtime: RUNTIME,
			client: new DockerClient(RUNTIME, {
				fetch: (async (input: RequestInfo | URL) => {
					const url = new URL(String(input));
					if (url.pathname === "/containers/json") {
						return Response.json([
							{
								Id: "shop-1",
								Names: ["/devenv-shop-1"],
								State: "running",
								Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
							},
						]);
					}
					return new Response(null, { status: 204 });
				}) as unknown as typeof fetch,
			}),
			fallbacks: [],
		};
		const services = capability({
			infra: [
				{
					ident: "clock",
					displayName: "Clock",
					type: "script",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
					logPath: "/h/clock.log",
				} as unknown as InfraService,
			],
			scriptStatus: async () => ({
				status: "running (pid 42)",
				logPath: "/h/clock.log",
			}),
		});
		// The docker capability is attached through the same seam the composition
		// uses, so the status journey exercises the real client.
		Object.assign(services, { docker: selection });
		const server = await serve(services);
		try {
			const client = createClient(server.url, fetch as never, () => {});
			const apps = await client.getApps();
			expect(apps[0]?.ident).toBe("shop");

			const statuses = await client.getStatus();
			expect(statuses[0]).toMatchObject({
				ident: "shop",
				resourceKind: "app",
				branch: "main",
				gitStatus: "clean",
				status: "running",
				dockerInfo: {
					Status: "running",
					ContainerID: "shop-1",
					Ports: "8080->80/tcp",
				},
			});

			const infraServices = await client.getInfraServices();
			expect(infraServices[0]).toMatchObject({
				ident: "clock",
				type: "script",
				status: "running (pid 42)",
				logPath: "/h/clock.log",
			});

			const dockerInfo = await client.getDockerInfo("shop");
			expect(dockerInfo).toMatchObject({
				Status: "running",
				ContainerID: "shop-1",
			});

			const git = await client.getGitInfo("shop");
			expect(git).toEqual({ branch: "main", status: "clean" });
		} finally {
			server.stop();
		}
	});

	test("a script service's log is served to the log view", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-journey-log-"));
		const logPath = path.join(root, "clock.log");
		fs.writeFileSync(logPath, "tick 1\ntick 2\n");
		const services = capability({
			infra: [
				{
					ident: "clock",
					displayName: "Clock",
					type: "script",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
					logPath,
				} as unknown as InfraService,
			],
			scriptStatus: async () => ({ status: "running", logPath }),
		});
		const server = await serve(services);
		try {
			const response = await fetch(
				`${server.url}/api/infra-services/clock/logs`,
			);
			expect(response.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			expect(await response.text()).toBe("tick 1\ntick 2\n");
		} finally {
			server.stop();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the operation status a start publishes reaches the client", async () => {
		const statusManager = new StatusManager();
		const services = capability({});
		Object.assign(services, { statusManager });
		const update = statusManager.startOperation("shop", "start");
		update("start successful");
		const server = await serve(services);
		try {
			const client = createClient(server.url, fetch as never, () => {});
			const statuses = await client.getStatus();
			expect(statuses[0]?.operationStatus).toEqual({
				operation: "start",
				status: "completed",
				message: "start successful",
			});
		} finally {
			server.stop();
		}
	});
});

describe("kubernetes journey", () => {
	test("the cluster summary the TUI renders comes from the Bun service", async () => {
		const exec: KubernetesExec = async (command) => {
			if (command.args[0] === "get" && command.args[1] === "clusters") {
				return { stdout: "devenv\n", stderr: "" };
			}
			if (command.args.includes("version")) {
				return {
					stdout: '{"serverVersion":{"gitVersion":"v1.29.0"}}',
					stderr: "",
				};
			}
			if (command.args.includes("nodes")) {
				return {
					stdout:
						'{"items":[{"metadata":{"name":"devenv-control-plane"},"status":{"nodeInfo":{"kubeletVersion":"v1.29.0"},"conditions":[{"type":"Ready","status":"True"}]}}]}',
					stderr: "",
				};
			}
			if (command.args.includes("pods")) {
				return {
					stdout:
						'{"items":[{"metadata":{"name":"api-1","namespace":"apps"},"status":{"phase":"Running"}}]}',
					stderr: "",
				};
			}
			if (command.name === "helm") {
				return {
					stdout:
						'[{"name":"api","namespace":"apps","status":"deployed","chart":"api-0.1.0","revision":"1"}]',
					stderr: "",
				};
			}
			if (command.args[0] === "ps") {
				return { stdout: "devenv-control-plane\n", stderr: "" };
			}
			if (command.args[0] === "stats") {
				return {
					stdout:
						'{"CPUPerc":"5%","MemUsage":"64MiB / 1GiB","MemPerc":"6.25%"}',
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};
		const kubernetes = new KubernetesClusterService({
			runner: new Runner({
				containerCommand: "docker",
				containerName: "docker",
				lookPath: () => "/bin/tool",
			}),
			exec,
			now: () => 0,
		});
		const status = await kubernetes.status();
		// The shape the environment view renders: state, version, nodes, pods,
		// releases and node stats.
		expect(status.state).toBe("running");
		expect(status.kubernetesVersion).toBe("v1.29.0");
		expect(status.nodes[0]).toMatchObject({
			name: "devenv-control-plane",
			ready: true,
		});
		expect(status.pods).toMatchObject({ total: 1, running: 1 });
		expect(status.podList[0]).toMatchObject({
			name: "api-1",
			namespace: "apps",
		});
		expect(status.releases[0]).toMatchObject({
			name: "api",
			status: "deployed",
		});
		expect(status.stats?.cpuPercent).toBe(5);
	});
});
