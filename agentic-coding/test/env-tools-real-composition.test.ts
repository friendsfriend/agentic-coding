// The `env_*` tools through the REAL composition root (`fix-env-tools-round-2`).
//
// Round 1 fixed four defects in the environment tools and their tests passed
// while the tools still failed on the developer's machine, because the tests
// injected what the production composition supplies: a stubbed instance
// controller, a fake `scriptInfra`, a `DockerClient` over an injected `fetch`.
// Every test here boots the production composition instead
// (`startRealEnvironmentServer`: real state/catalog authority, the one
// `createEnvironmentStack` both server roots use, real HTTP routes with the real
// owner capability, real `sh` children, a stub `docker` on PATH and a fake
// Docker HTTP API) and asserts on the answer the tool would print.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { environmentInstanceStorageId } from "../src/server/environment/instances/model.ts";
import {
	type FakeContainer,
	type RealEnvironmentServer,
	startRealEnvironmentServer,
} from "./support/real-environment-server.ts";

const fixtures: RealEnvironmentServer[] = [];

afterAll(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.stop();
});

async function fixture(
	options: Parameters<typeof startRealEnvironmentServer>[0] = {},
): Promise<RealEnvironmentServer> {
	const started = await startRealEnvironmentServer(options);
	fixtures.push(started);
	return started;
}

/** A real TCP listener on a free loopback port: the "published port" a docker
 * run has to answer on before it counts as ready. */
async function listen(port = 0): Promise<{
	readonly port: number;
	stop(): void;
}> {
	const listener = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port,
		socket: { data() {} },
	});
	return {
		port: listener.port,
		stop: () => listener.stop(true),
	};
}

/**
 * A loopback port with nothing listening on it yet, and the listener that later
 * makes it accept: the published port a definition declares, before and after the
 * application starts serving.
 */
async function reservePort(): Promise<{
	readonly port: number;
	start(): Promise<() => void>;
}> {
	const probe = await listen();
	const port = probe.port;
	probe.stop();
	return {
		port,
		start: async () => {
			const started = await listen(port);
			return () => started.stop();
		},
	};
}

/**
 * An HTTP endpoint a declared readiness names (`devenv:ready=<url>`): reserved
 * first, serving later, so a test can drive "not yet serving" and "serving".
 */
async function healthEndpoint(): Promise<{
	readonly port: number;
	start(): Promise<() => void>;
}> {
	const probe = await listen();
	const port = probe.port;
	probe.stop();
	return {
		port,
		start: async () => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: () => new Response("ok\n", { status: 200 }),
			});
			return () => {
				void server.stop(true);
			};
		},
	};
}

interface StatusApp {
	app: string;
	holder: string | null;
	status: string | null;
	heldByYou: boolean;
	readiness?: { ready: boolean; waitingFor?: string; lastProbe?: string };
	run?: {
		runtime: string;
		status: string;
		exitCode?: number;
		pid?: number;
		logPath?: string;
		logTail?: string;
	};
}

/** One app entry of an `env_start` answer. */
interface StartApp extends StatusApp {
	targetId?: string;
	runtime?: string;
}

function appRow(
	answer: { value?: Record<string, unknown> },
	ident: string,
): StartApp | undefined {
	const apps = (answer.value?.apps ?? []) as StartApp[];
	return apps.find((row) => row.app === ident);
}

/** A compose app's containers are matched by the compose file they were created
 * from (the label a real `compose up` writes), so the fixture's fake container
 * carries it. */
function composeLabel(fixture: RealEnvironmentServer, ident: string): string {
	return path.join(
		fixture.configDir,
		"apps",
		"compose",
		`${ident}-compose.yml`,
	);
}

/** Writes the layered workflow configuration the server reads. */
function writeConfig(
	fixture: RealEnvironmentServer,
	config: Record<string, unknown>,
): void {
	fs.writeFileSync(
		path.join(fixture.configDir, "config.json"),
		`${JSON.stringify(config)}\n`,
	);
}

describe("env_start and env_status agree with the run (defect A)", () => {
	test("a run that dies after the settle window is failed with its exit code and output, and no read claims running for a dead pid", async () => {
		const f = await fixture({
			runScripts: {
				shop: "#!/bin/sh\necho 'shop is starting' 1>&2\nsleep 3\nexit 3\n",
			},
		});
		const started = await f.envStart(["shop"], { runtime: "shell" });
		expect(started.ok).toBe(true);
		// The process outlives the settle window, so the start is a start.
		expect(started.value?.outcome).toBe("started");

		// Every read after the process died reports the end of the run, not a live
		// instance: the regression the round-1 tests missed, where the record
		// outlived the process it names.
		let settled: StatusApp["run"];
		const deadline = Date.now() + 15_000;
		for (;;) {
			const answer = await f.envStatus("shop");
			expect(answer.ok).toBe(true);
			const run = appRow(answer, "shop")?.run;
			if (run && run.status !== "running") {
				settled = run;
				break;
			}
			if (Date.now() > deadline) break;
			await Bun.sleep(200);
		}
		expect(settled?.status).toBe("failed");
		expect(settled?.exitCode).toBe(3);
		expect(String(settled?.logTail)).toContain("shop is starting");
		// The slot is released by the run's own death.
		const status = await f.envStatus("shop");
		expect(appRow(status, "shop")?.heldByYou ?? false).toBe(false);
		expect((await f.envStop("shop")).status).toBe(409);
	}, 60_000);

	test("a shell run that declares its readiness is not running until it serves", async () => {
		// A script run target has no container whose health a compose file
		// declares, so its own `devenv:ready=` annotation is the readiness the
		// definition declares. A start that ignored it reported `running` for a
		// dev server that was serving nothing (`fix-env-tools-round-2`).
		const published = await healthEndpoint();
		const f = await fixture({
			runScripts: {
				shop: `#!/bin/sh\n# devenv:ready=http://127.0.0.1:${published.port}/health\necho 'shop is starting' 1>&2\nsleep 30\n`,
			},
		});
		writeConfig(f, {
			environment: { instances: { readiness_timeout_seconds: 1 } },
		});
		const answer = await f.envStart(["shop"], { runtime: "shell" });
		expect(answer.ok).toBe(true);
		expect(answer.value?.outcome).toBe("starting");
		const waiting = appRow(answer, "shop");
		expect(waiting?.readiness?.ready).toBe(false);
		expect(String(waiting?.readiness?.waitingFor)).toContain(
			String(published.port),
		);
		// The status read agrees: the process is up, the application is not
		// answering its declared endpoint.
		const status = await f.envStatus("shop");
		expect(appRow(status, "shop")?.readiness?.ready).toBe(false);
		// It starts serving the endpoint its definition names.
		const stopListening = await published.start();
		const deadline = Date.now() + 10_000;
		let ready = false;
		while (!ready && Date.now() < deadline) {
			const read = await f.envStatus("shop");
			ready = appRow(read, "shop")?.readiness?.ready === true;
			if (!ready) await Bun.sleep(200);
		}
		stopListening();
		expect(ready).toBe(true);
	}, 60_000);

	test("a declared readiness that never passes still fails the start when the run dies", async () => {
		const published = await healthEndpoint();
		const f = await fixture({
			runScripts: {
				shop: `#!/bin/sh\n# devenv:ready=http://127.0.0.1:${published.port}/health\necho 'port 5173 is already in use' 1>&2\nsleep 1\nexit 7\n`,
			},
		});
		writeConfig(f, {
			environment: { instances: { readiness_timeout_seconds: 20 } },
		});
		const answer = await f.envStart(["shop"], { runtime: "shell" });
		expect(answer.status).toBe(500);
		expect(answer.error?.code).toBe("run-exited");
		expect(String(answer.error?.message)).toContain("exited with status 7");
		expect(String(answer.error?.message)).toContain(
			"port 5173 is already in use",
		);
		expect((await f.envStop("shop")).error?.code).toBe("no-holder");
	}, 60_000);

	test("a run that dies inside the settle window fails the start with its code and last output", async () => {
		const f = await fixture({
			runScripts: {
				shop: "#!/bin/sh\necho 'node_modules is missing' 1>&2\nexit 1\n",
			},
		});
		const answer = await f.envStart(["shop"], { runtime: "shell" });
		expect(answer.status).toBe(500);
		expect(answer.error?.code).toBe("run-exited");
		expect(String(answer.error?.message)).toContain("exited with status 1");
		expect(String(answer.error?.message)).toContain("node_modules is missing");
		// The failed start released the app: no holder is left behind.
		expect((await f.envStop("shop")).error?.code).toBe("no-holder");
	}, 30_000);
});

describe("env_status agrees with observation in every phase (defect E)", () => {
	test("a persisted running row whose process is gone is not reported running", async () => {
		const f = await fixture({ runScripts: { shop: "#!/bin/sh\nsleep 30\n" } });
		// A row a previous server process left behind: the run belongs to a
		// process this server never started, so nothing here can observe it.
		const now = new Date().toISOString();
		f.state.setEnvironmentInstance({
			id: environmentInstanceStorageId(f.owner, "shop"),
			owner: f.owner,
			app: "shop",
			targetId: "app/shop/action/run/shell/default",
			runtime: "shell",
			checkoutPath: f.checkout,
			imageTag: "round-2",
			status: "running",
			createdAt: now,
			lastActivityAt: now,
		});
		const answer = await f.envStatus("shop");
		const row = appRow(answer, "shop");
		expect(row?.run?.status).not.toBe("running");
		// The slot still holds the app: an unobservable run is never claimed gone.
		expect(row?.heldByYou).toBe(true);
	}, 30_000);

	test("a stopped run reports stopped after env_stop", async () => {
		const f = await fixture({ runScripts: { shop: "#!/bin/sh\nsleep 30\n" } });
		const started = await f.envStart(["shop"], { runtime: "shell" });
		expect(started.value?.outcome).toBe("started");
		const stopped = await f.envStop("shop");
		expect(stopped.ok).toBe(true);
		const answer = await f.envStatus("shop");
		const row = appRow(answer, "shop");
		expect(row?.heldByYou ?? false).toBe(false);
		expect(row?.run?.status).not.toBe("running");
	}, 30_000);
});

describe("a docker run is ready only when the application serves (defect B)", () => {
	test("env_start waits for the healthcheck and the published port, and env_status agrees while it waits", async () => {
		// A readiness bound of one second, so the bound-expiry path is reached in
		// the test without waiting the production two minutes.
		const container: FakeContainer = {
			Id: "shop-1",
			Names: ["/shop-web-1"],
			State: "running",
			Status: "Up 2 seconds (health: starting)",
			Ports: [{ PrivatePort: 8080, PublicPort: 0, Type: "tcp" }],
			Labels: { "com.docker.compose.project": "shop" },
			health: "starting",
		};
		const f = await fixture({
			compose: {
				shop: 'services:\n  web:\n    image: "shop:latest"\n    ports:\n      - "8080:8080"\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]\n',
			},
			containers: [container],
		});
		container.Labels["com.docker.compose.project.config_files"] = composeLabel(
			f,
			"shop",
		);
		writeConfig(f, {
			environment: { instances: { readiness_timeout_seconds: 1 } },
		});
		// The definition's own readiness: the published port does not answer yet.
		const start = f.envStart(["shop"], { runtime: "docker" });
		const expired = await start;
		expect(expired.ok).toBe(true);
		expect(expired.value?.outcome).toBe("starting");
		// The answer names what it is waiting for and the last probe result.
		const waiting = appRow(expired, "shop");
		expect(String(waiting?.readiness?.waitingFor)).toContain("health");
		expect(waiting?.readiness?.ready).toBe(false);
		// The status read agrees with the observation: the containers are up, the
		// application is not serving.
		const whileStarting = await f.envStatus("shop");
		expect(appRow(whileStarting, "shop")?.readiness?.ready).toBe(false);
		expect(
			String(appRow(whileStarting, "shop")?.readiness?.waitingFor),
		).toContain("health");

		// The application starts serving: the port answers and the healthcheck
		// turns healthy, so the next read reports it running.
		const listener = await listen();
		container.Ports = [
			{ PrivatePort: 8080, PublicPort: listener.port, Type: "tcp" },
		];
		container.health = "healthy";
		container.Status = "Up 5 seconds (healthy)";
		f.invalidateContainers();
		const deadline = Date.now() + 10_000;
		let serving = false;
		while (!serving && Date.now() < deadline) {
			const answer = await f.envStatus("shop");
			const readiness = appRow(answer, "shop")?.readiness;
			serving = readiness?.ready === true;
			if (!serving) await Bun.sleep(200);
		}
		listener.stop();
		expect(serving).toBe(true);
	}, 60_000);

	test("env_start reports started only after the declared readiness passed", async () => {
		// The published port the compose file declares, with the application not
		// listening on it yet.
		const published = await reservePort();
		const container: FakeContainer = {
			Id: "shop-1",
			Names: ["/shop-web-1"],
			State: "running",
			Ports: [{ PrivatePort: 8080, PublicPort: published.port, Type: "tcp" }],
			Labels: { "com.docker.compose.project": "shop" },
			// No healthcheck: this definition declares its readiness through the
			// published port alone.
		};
		const f = await fixture({
			compose: { shop: 'services:\n  web:\n    image: "shop:latest"\n' },
			containers: [container],
		});
		container.Labels["com.docker.compose.project.config_files"] = composeLabel(
			f,
			"shop",
		);
		writeConfig(f, {
			environment: { instances: { readiness_timeout_seconds: 20 } },
		});
		// The container is up but its published port does not answer yet: the start
		// has to stay in the request until the application serves, so the wait is
		// measured instead of raced.
		const startedAt = Date.now();
		const start = f.envStart(["shop"], { runtime: "docker" });
		await Bun.sleep(1200);
		const stopListening = await published.start();
		const answer = await start;
		const waited = Date.now() - startedAt;
		stopListening();
		expect(answer.ok).toBe(true);
		expect(answer.value?.outcome).toBe("started");
		expect(waited).toBeGreaterThanOrEqual(1200);
		expect(appRow(answer, "shop")?.readiness?.ready).toBe(true);
	}, 60_000);

	test("a container that is gone fails the start with its logs", async () => {
		const container: FakeContainer = {
			Id: "shop-1",
			Names: ["/shop-web-1"],
			State: "running",
			Ports: [],
			Labels: { "com.docker.compose.project": "shop" },
			// The definition declares a healthcheck, so the start waits for it
			// instead of answering as soon as the container exists.
			health: "starting",
			logs: "vite: port 5173 is already in use\nexit 1\n",
		};
		const f = await fixture({
			compose: {
				shop: 'services:\n  web:\n    image: "shop:latest"\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]\n',
			},
			containers: [container],
		});
		container.Labels["com.docker.compose.project.config_files"] = composeLabel(
			f,
			"shop",
		);
		writeConfig(f, {
			environment: { instances: { readiness_timeout_seconds: 20 } },
		});
		const start = f.envStart(["shop"], { runtime: "docker" });
		// The run dies while the start is waiting: the container exits.
		await Bun.sleep(1000);
		container.State = "exited";
		container.Status = "Exited (1) 1 second ago";
		f.invalidateContainers();
		const answer = await start;
		expect(answer.status).toBe(500);
		expect(String(answer.error?.message)).toContain("5173 is already in use");
	}, 60_000);
});

describe("container and infrastructure reads through the routes (defects C and D)", () => {
	test("env_logs reads a docker app's compose containers", async () => {
		const container: FakeContainer = {
			Id: "shop-1",
			Names: ["/shop-web-1"],
			State: "running",
			Ports: [],
			Labels: { "com.docker.compose.project": "shop" },
			logs: "shop log line one\nshop log line two\n",
		};
		const f = await fixture({
			compose: { shop: 'services:\n  web:\n    image: "shop:latest"\n' },
			containers: [container],
		});
		container.Labels["com.docker.compose.project.config_files"] = path.join(
			f.configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		const answer = await f.envLogs({ app: "shop" });
		expect(answer.ok).toBe(true);
		expect(String(answer.value?.source)).toContain("docker");
		expect(((answer.value?.lines ?? []) as string[]).join("\n")).toContain(
			"shop log line one",
		);
	}, 30_000);

	test("env_logs reads an infrastructure service's container", async () => {
		const container: FakeContainer = {
			Id: "mailpit-1",
			Names: ["/mailpit-1"],
			State: "running",
			Ports: [],
			Labels: { "com.docker.compose.project": "mailpit" },
			logs: "mailpit ready on :1025\n",
		};
		const f = await fixture({
			infrastructure: {
				mailpit: {
					displayName: "Mailpit",
					type: "docker",
					containerBaseName: "mailpit",
				},
			},
			containers: [container],
		});
		const answer = await f.envLogs({ app: "mailpit", infra: "1" });
		expect(answer.ok).toBe(true);
		expect(((answer.value?.lines ?? []) as string[]).join("\n")).toContain(
			"mailpit ready on :1025",
		);
	}, 30_000);

	test("an infrastructure service's state is a real probe", async () => {
		const running = {
			Id: "mailpit-1",
			Names: ["/mailpit-1"],
			State: "running",
			Status: "Up 3 minutes",
			Ports: [],
			Labels: {},
		} satisfies FakeContainer;
		const f = await fixture({
			infrastructure: {
				mailpit: { displayName: "Mailpit", type: "docker" },
				"playwright-server": {
					displayName: "Playwright",
					type: "docker",
				},
			},
			containers: [running],
		});
		const absent = await f.envStatus("playwright-server");
		const absentRow = (
			(absent.value?.infrastructure ?? []) as Array<{ state: string }>
		)[0];
		// No container exists: that is not "unknown", it is a service that was
		// never created (the round-1 defect answered `unknown`).
		expect(absentRow?.state).toBe("not-created");
		const present = await f.envStatus("mailpit");
		expect(
			((present.value?.infrastructure ?? []) as Array<{ state: string }>)[0]
				?.state,
		).toBe("running");
		// A container that exited is stopped, not unknown.
		running.State = "exited";
		running.Status = "Exited (0) 2 minutes ago";
		f.invalidateContainers();
		const stopped = await f.envStatus("mailpit");
		const stoppedRow = (
			(stopped.value?.infrastructure ?? []) as Array<{ state: string }>
		)[0];
		expect(stoppedRow?.state).toBe("stopped");
	}, 30_000);

	test("without a container runtime the infrastructure state is unknown, not another claim", async () => {
		const f = await fixture({
			infrastructure: { "playwright-server": { type: "docker" } },
			dockerEndpoint: "http://127.0.0.1:1",
		});
		const answer = await f.envStatus("playwright-server");
		expect(
			((answer.value?.infrastructure ?? []) as Array<{ state: string }>)[0]
				?.state,
		).toBe("unknown");
	}, 30_000);
});

describe("both server roots build the one environment composition", () => {
	test("the headless server and the TUI attach the same stack", () => {
		const root = path.join(import.meta.dir, "..");
		for (const file of ["src/server-command.ts", "src/tui/index.tsx"]) {
			const source = fs.readFileSync(path.join(root, file), "utf8");
			// The runtime capability the agent environment routes read is attached
			// by exactly one composition; a root that assembles the integration
			// services by hand is how the TUI lost its container runtime
			// (`fix-env-tools-round-2`).
			expect(source).toContain("createEnvironmentStack(");
			expect(source).not.toContain("createIntegrationServices({");
		}
	});
});
