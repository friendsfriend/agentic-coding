// A real environment-server fixture for environment-tool tests
// (`fix-env-tools-round-2`).
//
// Round 1's tests for the `env_*` tools passed while production failed, because
// they injected the capabilities the real composition root supplies: a stubbed
// instance controller, a fake `scriptInfra`, a `DockerClient` built over an
// injected `fetch`. So the thing under test was never the thing that runs. This
// fixture boots the *production* composition instead:
//
//   * `createEnvironmentAuthority` (the real state store + configuration manager
//     over a throwaway `DEVENV_HOME` and `AGENTIC_CODING_CONFIG_DIR`),
//   * `createEnvironmentStack` — the same one composition the headless server and
//     the TUI use, so a capability attached by only one root fails here,
//   * `startWorkflowServer`, so every assertion goes over the real HTTP routes
//     with the real owner-scoped capability (`environmentTokenFor`),
//   * real child processes (the run scripts are temporary `sh` files),
//   * a stub `docker`/`docker-compose` on `PATH` (the argv boundary the slot
//     controller and the prune poller use) plus a fake Docker HTTP API reached
//     through `DOCKER_HOST` (the boundary `DockerClient` uses). No daemon is
//     contacted: the configuration the fixture passes is an endpoint on
//     127.0.0.1.
//
// The one production input the fixture provides directly is the workflow's
// checkout (`resolveOwnerCheckout`): the real resolver reads the workflow store
// of a repository the test did not run a workflow in, and a test has no workflow
// to point it at. Everything from the capability down is production.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
} from "../../src/server/auth.ts";
import { createEnvironmentAuthority } from "../../src/server/environment/authority.ts";
import type { App } from "../../src/server/environment/config.ts";
import type { EnvironmentStateStore } from "../../src/server/environment/state-store.ts";
import {
	createEnvironmentStack,
	type EnvironmentStack,
} from "../../src/server/environment-stack.ts";
import {
	type OwnedWorkflowServer,
	startWorkflowServer,
} from "../../src/server/lifecycle.ts";

/** Instance capability of the fixture server; never a real one. */
const INSTANCE_TOKEN = "round-2-fixture-instance-token";

/** One container the fake Docker API reports. */
export interface FakeContainer {
	readonly Id: string;
	Names: string[];
	State: string;
	Status?: string;
	Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
	Labels: Record<string, string>;
	/** The `docker inspect` health status, when the container declares a
	 * healthcheck. */
	health?: string;
	/** The bytes `docker logs` answers with. */
	logs?: string;
}

export interface RealEnvironmentServerOptions {
	/** App idents written as `apps/definitions/<ident>.json`. */
	readonly apps?: readonly string[];
	/** Shell run targets: `apps/run/<app>-default.sh` with this body. */
	readonly runScripts?: Readonly<Record<string, string>>;
	/** Compose run targets: `apps/compose/<app>-compose.yml` with this body. */
	readonly compose?: Readonly<Record<string, string>>;
	/** `infrastructure/definitions/<ident>.json` bodies, by ident. */
	readonly infrastructure?: Readonly<Record<string, unknown>>;
	/** Containers the fake Docker API reports; the test may mutate the array. */
	readonly containers?: FakeContainer[];
	/** The workflow owner the fixture acts as. */
	readonly owner?: string;
	/** The Docker endpoint the fixture's runtime selection probes. Defaults to the
	 * fixture's fake API; a closed port makes the runtime unavailable. */
	readonly dockerEndpoint?: string;
	/** Log sink for the composition's own diagnostics. */
	readonly onLog?: (message: string) => void;
}

export interface EnvironmentAnswer {
	readonly status: number;
	readonly ok: boolean;
	readonly value?: Record<string, unknown>;
	readonly error?: { code?: string; message?: string };
	readonly text: string;
}

export interface RealEnvironmentServer {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
	readonly root: string;
	readonly configDir: string;
	readonly homeDir: string;
	readonly app: App;
	readonly checkout: string;
	/** The fixture's own environment state store (the real one). */
	readonly state: EnvironmentStateStore;
	/** The fake daemon's container list; mutate it to change what is observed. */
	readonly containers: FakeContainer[];
	/** The argv lines the stub `docker`/`docker-compose` recorded. */
	dockerCalls(): string[];
	/** Forget the container list the runtime client cached. The client caches it
	 * for half a minute, so a test that changes the fake daemon's world says so
	 * explicitly rather than waiting the cache out. */
	invalidateContainers(): void;
	/** Every diagnostic the composition logged. */
	logs(): string[];
	/** `GET /api/v1/agent-env/<path>` with the fixture owner's capability. */
	get(path: string, query?: Record<string, string>): Promise<EnvironmentAnswer>;
	/** `POST /api/v1/agent-env/<path>` with the fixture owner's capability. */
	post(
		path: string,
		body?: unknown,
		query?: Record<string, string>,
	): Promise<EnvironmentAnswer>;
	/** The owner-scoped route names the `env_*` tools call. */
	envList(query?: Record<string, string>): Promise<EnvironmentAnswer>;
	envStatus(app?: string): Promise<EnvironmentAnswer>;
	envLogs(query: Record<string, string>): Promise<EnvironmentAnswer>;
	envStart(
		apps: readonly string[],
		options?: { runtime?: string; waitSec?: number },
	): Promise<EnvironmentAnswer>;
	envStop(app: string): Promise<EnvironmentAnswer>;
	stop(): Promise<void>;
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/**
 * The fake Docker HTTP API. It answers exactly what `DockerClient` asks for and
 * nothing else, so a route that reads a container it never listed fails loudly.
 */
function startFakeDockerApi(containers: FakeContainer[]): {
	readonly port: number;
	stop(): void;
} {
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// The event stream the composition subscribes to stays open for the whole
		// test; Bun's ten-second default would cut it and log a timeout.
		idleTimeout: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/_ping") return new Response("OK", { status: 200 });
			if (url.pathname === "/events") {
				// A live stream: the listener subscribes once and stays subscribed, so
				// a test's container mutations are what change the observed state.
				return new Response(
					new ReadableStream<Uint8Array>({
						start() {},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.pathname === "/containers/json")
				return Response.json(
					containers.map((container) => ({
						Id: container.Id,
						Names: container.Names,
						State: container.State,
						Status: container.Status ?? container.State,
						Ports: container.Ports,
						Labels: container.Labels,
					})),
				);
			const inspect = url.pathname.match(/^\/containers\/([^/]+)\/json$/);
			if (inspect) {
				const name = decodeURIComponent(inspect[1] as string);
				const container = findContainer(containers, name);
				if (!container)
					return new Response(`no such container: ${name}`, { status: 404 });
				return Response.json({
					State: {
						Running: container.State === "running",
						Status: container.State,
						...(container.health
							? { Health: { Status: container.health } }
							: {}),
					},
				});
			}
			const logs = url.pathname.match(/^\/containers\/([^/]+)\/logs$/);
			if (logs) {
				const name = decodeURIComponent(logs[1] as string);
				const container = findContainer(containers, name);
				if (!container)
					return new Response(`no such container: ${name}`, { status: 404 });
				return new Response(container.logs ?? "", { status: 200 });
			}
			return new Response(`no route: ${url.pathname}`, { status: 404 });
		},
	});
	return {
		port: listener.port ?? 0,
		stop: () => {
			void listener.stop(true);
		},
	};
}

function findContainer(
	containers: FakeContainer[],
	name: string,
): FakeContainer | undefined {
	return containers.find(
		(container) =>
			container.Id === name ||
			container.Names.some((entry) => entry.replace(/^\//, "") === name),
	);
}

/** The stub container CLIs the composition's argv boundary reaches. */
function installStubDocker(binDir: string, logFile: string): void {
	for (const name of ["docker", "docker-compose"]) {
		const file = path.join(binDir, name);
		writeFile(
			file,
			`#!/bin/sh\n# Stub container CLI (fix-env-tools-round-2): records its argv and succeeds.\nprintf '%s %s\\n' "${name}" "$*" >> '${logFile}'\nexit 0\n`,
		);
		fs.chmodSync(file, 0o755);
	}
}

/**
 * Boot the production environment stack over a throwaway configuration root and
 * answer environment-tool calls through the real HTTP routes.
 */
export async function startRealEnvironmentServer(
	options: RealEnvironmentServerOptions = {},
): Promise<RealEnvironmentServer> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-env-server-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	const binDir = path.join(root, "bin");
	const dockerLog = path.join(root, "docker-cli.log");
	writeFile(path.join(dockerLog), "");
	fs.mkdirSync(path.join(configDir, "providers"), { recursive: true });
	fs.mkdirSync(homeDir, { recursive: true });
	const containers = options.containers ?? [];
	const api = startFakeDockerApi(containers);
	const dockerEndpoint =
		options.dockerEndpoint ?? `http://127.0.0.1:${api.port}`;
	installStubDocker(binDir, dockerLog);

	const appIdents = options.apps ?? ["shop"];
	for (const ident of appIdents)
		writeFile(
			path.join(configDir, "apps", "definitions", `${ident}.json`),
			`${JSON.stringify({
				ident,
				displayName: ident,
				repositoryPath: `https://example.com/${ident}.git`,
				sourceType: "git",
				gitMode: "BRANCH",
			})}\n`,
		);
	for (const [ident, body] of Object.entries(options.runScripts ?? {}))
		writeFile(path.join(configDir, "apps", "run", `${ident}-default.sh`), body);
	for (const [ident, body] of Object.entries(options.compose ?? {}))
		writeFile(
			path.join(configDir, "apps", "compose", `${ident}-compose.yml`),
			body,
		);
	for (const [ident, definition] of Object.entries(
		options.infrastructure ?? {},
	))
		writeFile(
			path.join(configDir, "infrastructure", "definitions", `${ident}.json`),
			`${JSON.stringify({ ident, ...(definition as object) })}\n`,
		);

	// The process's own environment is repointed at the fixture for everything
	// that resolves a root or spawns a child: the composition itself takes the
	// container endpoint as an option, and the children it starts (the run
	// scripts, the stub CLIs) inherit this process's environment.
	const savedEnv = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string): void => {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		process.env[key] = value;
	};
	setEnv("HOME", root);
	setEnv("AGENTIC_CODING_CONFIG_DIR", configDir);
	setEnv("DEVENV_HOME", homeDir);
	setEnv("HERDR_WIKI_DIR", path.join(root, "wiki"));
	setEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
	setEnv("DOCKER_HOST", dockerEndpoint);
	setEnv("DEVENV_CONTAINER_RUNTIME", "docker");

	const logs: string[] = [];
	const logger = (message: string): void => {
		logs.push(message);
		options.onLog?.(message);
	};

	let server: OwnedWorkflowServer | undefined;
	let stack: EnvironmentStack | undefined;
	let authority: ReturnType<typeof createEnvironmentAuthority> | undefined;
	const owner = options.owner ?? "workflow:round-2";
	try {
		authority = createEnvironmentAuthority({ homeDir, configDir, logger });
		const manager = authority.manager;
		const app = manager.getAppByIdent(appIdents[0] as string);
		if (!app) throw new Error(`the fixture's app ${appIdents[0]} did not load`);
		// The app's own checkout exists: the workflow's runs start from it.
		const checkout = app.localDirectoryPath;
		fs.mkdirSync(checkout, { recursive: true });
		stack = await createEnvironmentStack({
			manager,
			state: authority.state,
			configDir,
			homeDir,
			runtimeName: "docker",
			env: {
				...process.env,
				DOCKER_HOST: dockerEndpoint,
			},
			// The workflow registry lookup: a test has no workflow row to resolve a
			// checkout from, so it names the app's own checkout for its owner.
			resolveOwnerCheckout: (_owner, candidate): string => {
				const target =
					candidate.localDirectoryPath === ""
						? checkout
						: candidate.localDirectoryPath;
				fs.mkdirSync(target, { recursive: true });
				return target;
			},
			logger,
		});
		server = await startWorkflowServer({
			port: 0,
			token: INSTANCE_TOKEN,
			homeDir,
			configDir,
			environment: authority,
			integrations: stack.integrations,
		});
	} catch (error) {
		api.stop();
		stack?.stop();
		authority?.state.close();
		fs.rmSync(root, { recursive: true, force: true });
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		throw error;
	}

	async function request(
		method: string,
		url: string,
		body?: unknown,
	): Promise<EnvironmentAnswer> {
		const response = await fetch(url, {
			method,
			headers: {
				authorization: `Bearer ${environmentTokenFor(INSTANCE_TOKEN, owner)}`,
				[ENVIRONMENT_OWNER_HEADER]: owner,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		let parsed: Record<string, unknown> | undefined;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			parsed = undefined;
		}
		const error = parsed?.error as
			| { code?: string; message?: string }
			| undefined;
		return {
			status: response.status,
			ok: response.ok,
			...(parsed?.ok === true && parsed.value !== undefined
				? { value: parsed.value as Record<string, unknown> }
				: {}),
			...(error ? { error } : {}),
			text,
		};
	}

	const base = (): string => {
		if (!server) throw new Error("the fixture server is not running");
		return `${server.url}/api/v1/agent-env`;
	};
	const withQuery = (query?: Record<string, string>): string => {
		if (!query || Object.keys(query).length === 0) return "";
		return `?${new URLSearchParams(query).toString()}`;
	};

	const fixture: RealEnvironmentServer = {
		get url() {
			return server?.url ?? "";
		},
		token: INSTANCE_TOKEN,
		owner,
		root,
		configDir,
		homeDir,
		get app() {
			const loaded = authority?.manager.getAppByIdent(appIdents[0] as string);
			if (!loaded) throw new Error("the fixture's app disappeared");
			return loaded;
		},
		get checkout() {
			return (
				authority?.manager.getAppByIdent(appIdents[0] as string)
					?.localDirectoryPath ?? ""
			);
		},
		get state() {
			if (!authority) throw new Error("the fixture's state store is closed");
			return authority.state;
		},
		containers,
		invalidateContainers: () => stack?.runtime.docker?.client.invalidateCache(),
		dockerCalls: () => {
			try {
				return fs
					.readFileSync(dockerLog, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "");
			} catch {
				return [];
			}
		},
		logs: () => [...logs],
		get: (target, query) =>
			request("GET", `${base()}/${target}${withQuery(query)}`),
		post: (target, body, query) =>
			request("POST", `${base()}/${target}${withQuery(query)}`, body ?? {}),
		envList: (query) => request("GET", `${base()}/list${withQuery(query)}`),
		envStatus: (app) =>
			request("GET", `${base()}/status${withQuery(app ? { app } : undefined)}`),
		envLogs: (query) => request("GET", `${base()}/logs${withQuery(query)}`),
		envStart: (apps, startOptions) =>
			request("POST", `${base()}/acquire`, {
				apps: [...apps],
				...(startOptions?.runtime ? { runtime: startOptions.runtime } : {}),
				...(startOptions?.waitSec === undefined
					? {}
					: { waitSec: startOptions.waitSec }),
			}),
		envStop: (app) => request("POST", `${base()}/stop`, { app }),
		stop: async () => {
			try {
				await server?.stop();
			} catch {
				/* a fixture teardown never fails the test */
			}
			stack?.stop();
			api.stop();
			try {
				authority?.state.close();
			} catch {
				/* already closed */
			}
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
	return fixture;
}
