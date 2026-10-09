// Environment app slots: one copy of an app at a time
// (`make-app-runs-exclusive`). The controller replaced the parallel
// per-instance start with a single slot per app: occupancy from rows plus run
// observation, a FIFO wait with a bounded long poll, all-or-nothing multi-app
// grants, deadlock detection, human holders and developer force release.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	environmentInstanceId,
	environmentInstanceStorageId,
	parseEnvironmentOwner,
} from "../src/server/environment/instances/model.ts";
import { resolveInstanceVariables } from "../src/server/environment/instances/variables.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import {
	DockerClient,
	type DockerRuntime,
	type DockerRuntimeSelection,
} from "../src/server/runtime/docker.ts";
import {
	type AppSlot,
	EnvironmentInstanceController,
	type EnvironmentInstanceError,
	type RunObservationState,
	type SlotEvent,
} from "../src/server/runtime/instances.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

const openHarnesses: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of openHarnesses.splice(0)) cleanup();
});

function tempState(prefix: string): {
	dir: string;
	store: EnvironmentStateStore;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slots-${prefix}-`));
	return { dir, store: EnvironmentStateStore.open(dir) };
}

function app(localDirectoryPath: string, ident = "shop") {
	return {
		ident,
		displayName: ident,
		repositoryPath: "https://example.com/shop",
		appType: "app",
		localDirectoryPath,
		branch: "main",
	};
}

/** A compose target with static names and ports, plus a shell run target. */
function composeFixture(
	root: string,
	source = `services:\n  web:\n    container_name: shop-web\n    image: "shop:latest"\n    ports:\n      - "8080:80"\n`,
) {
	const configDir = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	fs.mkdirSync(path.join(configDir, "apps", "run"), { recursive: true });
	fs.mkdirSync(checkout, { recursive: true });
	const sourcePath = path.join(
		configDir,
		"apps",
		"compose",
		"shop-compose.yml",
	);
	fs.writeFileSync(sourcePath, source);
	fs.writeFileSync(
		path.join(configDir, "apps", "run", "shop-default.sh"),
		"#!/bin/sh\n",
	);
	return { configDir, checkout, sourcePath };
}

function scriptFixture(root: string) {
	const configDir = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	fs.mkdirSync(path.join(configDir, "apps", "run"), { recursive: true });
	fs.mkdirSync(checkout, { recursive: true });
	const sourcePath = path.join(configDir, "apps", "run", "shop-default.sh");
	fs.writeFileSync(sourcePath, "#!/bin/sh\n");
	return { configDir, checkout, sourcePath };
}

function dockerSelection(): DockerRuntimeSelection {
	return containerDocker([]);
}

interface FakeContainer {
	Id: string;
	Names: string[];
	State: string;
	Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
	Labels: Record<string, string>;
}

/** A container of a parallel-era `<app>-<instance>` compose project. */
function legacyContainer(
	project: string,
	id = `legacy-${project}`,
): FakeContainer {
	return {
		Id: id,
		Names: [`/${project}-web-1`],
		State: "running",
		Ports: [],
		Labels: { "com.docker.compose.project": project },
	};
}

/**
 * A Docker capability over a mutable container list: `allContainers` reports the
 * list, `removeContainer` removes from it, so a sweep's effect is observable.
 * `failReads` makes the list read reject (an unobservable runtime).
 */
function containerDocker(
	containers: FakeContainer[],
	options: { failReads?: boolean } = {},
): DockerRuntimeSelection {
	return {
		runtime: RUNTIME,
		client: new DockerClient(RUNTIME, {
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/containers/json") {
					if (options.failReads)
						return new Response("socket down", { status: 500 });
					return Response.json(containers);
				}
				if ((init?.method ?? "GET") === "DELETE") {
					const id = url.pathname.split("/").pop() ?? "";
					const index = containers.findIndex((item) => item.Id === id);
					if (index >= 0) containers.splice(index, 1);
					return new Response(null, { status: 204 });
				}
				return new Response("no route", { status: 404 });
			}) as unknown as typeof fetch,
		}),
		fallbacks: [],
	};
}

/** A script lifecycle that never spawns a process. */
function fakeScriptInfra() {
	const running = new Set<string>();
	return {
		launch: async (input: { ident: string }) => {
			running.add(input.ident);
			return { status: "running", logPath: "" };
		},
		status: async (ident: string) => ({
			status: running.has(ident) ? "running" : "stopped",
			logPath: "",
		}),
		observe: async (ident: string) => ({
			status: running.has(ident) ? "running" : "stopped",
			logPath: "",
		}),
		stop: async (ident: string) => {
			running.delete(ident);
		},
		executionHandle: (ident: string) =>
			running.has(ident)
				? { mode: "logged", runner: "shell", startedAt: "", pid: 4242 }
				: undefined,
	};
}

/**
 * A script lifecycle whose launch resolves only after the spawned process had
 * time to exit: the window between `launch` resolving and the
 * `starting -> running` CAS.
 */
function spawningScriptInfra(spawnDelayMs: number) {
	const running = new Set<string>();
	const pids = new Map<string, number | undefined>();
	return {
		launch: async (input: { ident: string; spawn: () => { pid?: number } }) => {
			running.add(input.ident);
			pids.set(input.ident, input.spawn().pid);
			await Bun.sleep(spawnDelayMs);
			return { status: "running", logPath: "" };
		},
		status: async (ident: string) => ({
			status: running.has(ident) ? "running" : "stopped",
			logPath: "",
		}),
		observe: async (ident: string) => ({
			status: running.has(ident) ? "running" : "stopped",
			logPath: "",
		}),
		stop: async (ident: string) => {
			running.delete(ident);
		},
		executionHandle: (ident: string) =>
			running.has(ident)
				? {
						mode: "logged",
						runner: "shell",
						startedAt: "",
						pid: pids.get(ident),
					}
				: undefined,
	};
}

interface Harness {
	readonly controller: EnvironmentInstanceController;
	readonly store: EnvironmentStateStore;
	readonly calls: Array<{
		command: string;
		args: readonly string[];
		env: Readonly<Record<string, string>>;
	}>;
	readonly events: SlotEvent[];
	/** The injected wall clock; advancing it drives queue expiry. */
	readonly clock: { ms: number };
	/** Apps the injected observation reports as running. */
	readonly running: Set<string>;
	refreshScriptRows(): Promise<void>;
	occupancy(appIdent: string): Promise<unknown>;
	slots(): Promise<AppSlot[]>;
}

function harness(options: {
	root: string;
	configDir: string;
	checkout: string;
	apps: () => ReturnType<typeof app>[];
	store: EnvironmentStateStore;
	docker?: DockerRuntimeSelection;
	resolveDocker?: () => Promise<DockerRuntimeSelection | undefined>;
	observeRun?: (
		candidate: ReturnType<typeof app>,
	) => Promise<RunObservationState>;
	scriptInfra?:
		| ReturnType<typeof fakeScriptInfra>
		| ReturnType<typeof spawningScriptInfra>;
	/** Poll cadence; a small value with a small clock step exercises the wait loop. */
	waitPollMs?: number;
}): Harness {
	const calls: Harness["calls"] = [] as unknown as Harness["calls"];
	const events: SlotEvent[] = [];
	const running = new Set<string>();
	const clock = { ms: 1_700_000_000_000 };
	const controller = new EnvironmentInstanceController({
		state: options.store,
		apps: options.apps,
		configDir: options.configDir,
		...(options.docker ? { docker: options.docker } : {}),
		...(options.resolveDocker ? { resolveDocker: options.resolveDocker } : {}),
		...(options.scriptInfra ? { scriptInfra: options.scriptInfra } : {}),
		observeRun:
			options.observeRun ??
			(async (candidate) =>
				running.has(candidate.ident) ? "running" : "stopped"),
		resolveOwnerCheckout: (owner, candidate) => {
			// A managed checkout exists before anything runs from it.
			const checkout = path.join(
				options.root,
				"owners",
				owner.replace(/[^a-z0-9]+/gi, "-"),
				candidate.ident,
			);
			fs.mkdirSync(checkout, { recursive: true });
			return checkout;
		},
		now: () => new Date(clock.ms),
		sleep: async (ms: number) => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			clock.ms += ms;
		},
		waitPollMs: options.waitPollMs ?? 1_000,
		runCommand: async (command, args, commandOptions) => {
			calls.push({ command, args, env: commandOptions.env });
			return { exitCode: 0, output: "" };
		},
		publish: (event) => events.push(event),
	});
	return {
		controller,
		store: options.store,
		calls,
		events,
		clock,
		running,
		refreshScriptRows: () =>
			(
				controller as unknown as { refreshScriptRows(): Promise<void> }
			).refreshScriptRows(),
		occupancy: (appIdent) => controller.occupancy(appIdent),
		slots: () => controller.slots(),
	};
}

function track(cleanups: Array<() => void>): void {
	openHarnesses.push(() => {
		for (const cleanup of cleanups) cleanup();
	});
}

describe("environment owner identity and variables", () => {
	test("parses owners and makes stable sanitized app-scoped workflow ids", () => {
		expect(parseEnvironmentOwner("user")).toBe("user");
		expect(parseEnvironmentOwner("workflow:abc/feature branch")).toBe(
			"workflow:abc/feature branch",
		);
		const id = environmentInstanceId("workflow:abc/feature branch", "shop");
		expect(id).toBe(
			environmentInstanceId("workflow:abc/feature branch", "shop"),
		);
		expect(id).toMatch(/^[a-z0-9-]{1,24}$/);
		expect(
			environmentInstanceId("workflow:abc/feature branch", "store"),
		).not.toBe(id);
		expect(environmentInstanceId("workflow:a", "shop")).not.toBe(
			environmentInstanceId("workflow:b", "shop"),
		);
		expect(environmentInstanceId("user", "shop")).toBe("default");
		expect(environmentInstanceStorageId("user", "shop")).not.toBe(
			environmentInstanceStorageId("user", "store"),
		);
		expect(() => parseEnvironmentOwner("workflow:")).toThrow(/owner/);
		expect(() => parseEnvironmentOwner("team:abc")).toThrow(/owner/);
		expect(() => parseEnvironmentOwner("workflow:unsafe\u0000id")).toThrow(
			/control characters/,
		);
		expect(() => environmentInstanceId("user", "bad\u0000app")).toThrow(
			/control characters/,
		);
	});

	test("injects only the owner and the checkout directory", () => {
		expect(
			resolveInstanceVariables({ owner: "user", appDir: "/apps/shop" }),
		).toEqual({ AC_OWNER: "user", AC_APP_DIR: "/apps/shop" });
		expect(
			resolveInstanceVariables({
				owner: "workflow:abc",
				appDir: "/worktrees/abc/shop",
			}),
		).toEqual({
			AC_OWNER: "workflow:abc",
			AC_APP_DIR: "/worktrees/abc/shop",
		});
	});
});

describe("app slot occupancy", () => {
	test("an active row, an observed run and an unobservable runtime all hold", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-occupancy-"));
		const fixture = composeFixture(root);
		const state = tempState("occupancy");
		const appInstance = app(fixture.checkout);
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [appInstance],
			store: state.store,
			docker: dockerSelection(),
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);

		// Free: no row, nothing observed.
		expect(await slots.occupancy("shop")).toBeUndefined();

		// The developer's own run holds the app without a persisted row.
		slots.running.add("shop");
		expect(await slots.occupancy("shop")).toEqual({
			holder: "user",
			status: "running",
		});
		const waitingForDeveloper = await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(waitingForDeveloper).toMatchObject({
			outcome: "waiting",
			holders: { shop: "user" },
			positions: { shop: 1 },
		});
		expect(slots.calls).toHaveLength(0);

		// An unobservable runtime is occupied, never absent.
		slots.running.delete("shop");
		const unobservable = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [appInstance],
			store: state.store,
			observeRun: async () => "unknown",
		});
		expect(await unobservable.occupancy("shop")).toEqual({
			holder: "user",
			status: "unknown",
		});
		expect(
			await unobservable.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 0.001,
			}),
		).toMatchObject({ outcome: "waiting", holders: { shop: "user" } });
	});

	test("reconcile keeps an unobservable instance occupied", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-reconcile-"));
		const fixture = composeFixture(root);
		const state = tempState("reconcile");
		const appInstance = app(fixture.checkout);
		state.store.setEnvironmentInstance({
			id: environmentInstanceStorageId("workflow:a", "shop"),
			owner: "workflow:a",
			app: "shop",
			targetId: "shop:docker:default",
			runtime: "docker",
			checkoutPath: path.join(root, "owners", "a", "shop"),
			imageTag: "tag",
			status: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: new Date(0).toISOString(),
		});
		// No Docker runtime is available at startup: that is not an absence.
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [appInstance],
			store: state.store,
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.ready;
		expect(await slots.occupancy("shop")).toEqual({
			holder: "workflow:a",
			status: "unknown",
		});
		const waiting = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(waiting).toMatchObject({
			outcome: "waiting",
			holders: { shop: "workflow:a" },
		});
		expect(slots.calls).toHaveLength(0);
	});
});

describe("app slot starts", () => {
	test("runs the definition's own project, names and ports once per app", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-start-"));
		const fixture = composeFixture(root);
		const state = tempState("start");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: state.store,
			docker: dockerSelection(),
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		const originalToken = process.env.AGENTIC_WORKFLOW_TOKEN;
		const originalDockerHost = process.env.DOCKER_HOST;
		process.env.AGENTIC_WORKFLOW_TOKEN = "must-not-reach-instance";
		process.env.DOCKER_HOST = "unix:///tmp/docker.sock";
		try {
			const started = await slots.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 1,
			});
			if (started.outcome !== "started") throw new Error("not started");
			const instance = started.instances[0];
			if (!instance) throw new Error("no instance");
			expect(instance).toMatchObject({
				owner: "workflow:a",
				app: "shop",
				status: "running",
			});
			// No per-instance compose project: the definition's own names and
			// ports are what every routing definition already assumes.
			expect(slots.calls).toHaveLength(1);
			expect(slots.calls[0]?.command).toBe("docker-compose");
			expect(slots.calls[0]?.args).toEqual([
				"-f",
				fixture.sourcePath,
				"up",
				"-d",
			]);
			expect(slots.calls[0]?.env.AC_OWNER).toBe("workflow:a");
			expect(slots.calls[0]?.env.AC_APP_DIR).toBe(
				path.join(root, "owners", "workflow-a", "shop"),
			);
			// No instance identity and no allocated ports reach the definition.
			for (const key of Object.keys(slots.calls[0]?.env ?? {}))
				expect(key).not.toMatch(/^AC_(INSTANCE|IMAGE_TAG|PORT_)/);
			expect(slots.calls[0]?.env.AGENTIC_WORKFLOW_TOKEN).toBeUndefined();
			expect(slots.calls[0]?.env.DOCKER_HOST).toBe("unix:///tmp/docker.sock");
			// The definition keeps its own container name and host port.
			const source = fs.readFileSync(fixture.sourcePath, "utf8");
			expect(source).toContain("container_name: shop-web");
			expect(source).toContain('"8080:80"');

			const again = await slots.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 1,
			});
			expect(again.outcome).toBe("already-running");
			expect(slots.calls).toHaveLength(1);

			expect(await slots.slots()).toEqual([
				{
					app: "shop",
					holder: "workflow:a",
					status: "running",
					waiters: [],
				},
			]);

			const stopped = await slots.controller.stopApp("shop");
			expect(stopped.status).toBe("stopped");
			expect(slots.calls[1]?.args).toEqual(["-f", fixture.sourcePath, "down"]);
			expect(await slots.occupancy("shop")).toBeUndefined();
		} finally {
			if (originalToken === undefined)
				delete process.env.AGENTIC_WORKFLOW_TOKEN;
			else process.env.AGENTIC_WORKFLOW_TOKEN = originalToken;
			if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = originalDockerHost;
		}
	});

	test("starts and stops a script target through its lifecycle owner", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-script-"));
		const fixture = scriptFixture(root);
		const state = tempState("script");
		const scriptInfra = fakeScriptInfra();
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: state.store,
			scriptInfra,
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		const started = await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		if (started.outcome !== "started") throw new Error("not started");
		expect(started.instances[0]?.runtime).toBe("shell");
		expect((await slots.slots())[0]).toMatchObject({
			holder: "workflow:a",
			status: "running",
		});
		const stopped = await slots.controller.release("shop");
		expect(stopped.status).toBe("released-by-developer");
		expect(await slots.occupancy("shop")).toBeUndefined();
	});
});

describe("app slot queue", () => {
	test("a second workflow waits, then runs from its own checkout", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-wait-"));
		const fixture = composeFixture(root);
		const state = tempState("wait");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: state.store,
			docker: dockerSelection(),
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		const first = await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(first.outcome).toBe("started");

		const waiting = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(waiting).toEqual({
			outcome: "waiting",
			owner: "workflow:b",
			apps: ["shop"],
			positions: { shop: 1 },
			holders: { shop: "workflow:a" },
		});
		// Waiting starts nothing: the holder's copy is still the only one.
		expect(slots.calls).toHaveLength(1);

		await slots.controller.stopApp("shop");
		const granted = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		if (granted.outcome !== "started") throw new Error("not granted");
		// calls[1] is the holder's `down`; calls[2] is the waiter's `up`.
		expect(slots.calls[2]?.env.AC_OWNER).toBe("workflow:b");
		expect(slots.calls[2]?.env.AC_APP_DIR).toBe(
			path.join(root, "owners", "workflow-b", "shop"),
		);
		expect(slots.calls).toHaveLength(3);
	});

	test("a re-poll within the grace keeps the queue position", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-grace-"));
		const fixture = composeFixture(root);
		const state = tempState("grace");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: state.store,
			docker: dockerSelection(),
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const first = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(first).toMatchObject({ positions: { shop: 1 } });
		const second = await slots.controller.acquire({
			owner: "workflow:c",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(second).toMatchObject({ positions: { shop: 2 } });
		const repoll = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(repoll).toMatchObject({
			outcome: "waiting",
			positions: { shop: 1 },
		});
	});

	test("an entry that is not re-polled within the grace expires", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-expire-"));
		const fixture = composeFixture(root);
		const state = tempState("expire");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: state.store,
			docker: dockerSelection(),
		});
		track([
			() => state.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const first = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(first).toMatchObject({ positions: { shop: 1 } });
		// Sixty seconds pass: the grace is over and `b` stops being a waiter.
		slots.clock.ms += 61_000;
		const head = await slots.controller.acquire({
			owner: "workflow:c",
			apps: ["shop"],
			waitSec: 0.001,
		});
		expect(head).toMatchObject({ outcome: "waiting", positions: { shop: 1 } });
		// `b` is a new entry now, behind the owner that kept polling.
		const again = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 0.001,
		});
		expect(again).toMatchObject({ outcome: "waiting", positions: { shop: 2 } });
	});

	test("a multi-app request waits until every app is free", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-multi-"));
		const fixture = composeFixture(root);
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "compose", "shop-compose.yml"),
			`services:\n  web:\n    container_name: shop-web\n    image: "shop:latest"\n`,
		);
		const store = tempState("multi");
		const apps = [app(fixture.checkout, "shop"), app(fixture.checkout, "api")];
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "compose", "api-compose.yml"),
			`services:\n  web:\n    container_name: api-web\n    image: "api:latest"\n`,
		);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const waiting = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop", "api"],
			waitSec: 1,
		});
		expect(waiting).toMatchObject({
			outcome: "waiting",
			positions: { shop: 1, api: 1 },
			holders: { shop: "workflow:a" },
		});
		// All-or-nothing: the free app is not started on its own.
		expect(slots.calls).toHaveLength(1);
		await slots.controller.stopApp("shop");
		const granted = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop", "api"],
			waitSec: 1,
		});
		if (granted.outcome !== "started") throw new Error("not granted");
		expect(granted.instances.map((instance) => instance.app)).toEqual([
			"shop",
			"api",
		]);
	});

	test("crossed holds fail with the deadlock naming the cycle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-deadlock-"));
		const fixture = composeFixture(root);
		const store = tempState("deadlock");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		for (const ident of ["fe", "mw"])
			fs.writeFileSync(
				path.join(fixture.configDir, "apps", "compose", `${ident}-compose.yml`),
				`services:\n  web:\n    container_name: ${ident}-web\n    image: "${ident}:latest"\n`,
			);
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		// `a` starts waiting for `mw`, which `b` holds.
		const aWait = slots.controller.acquire({
			owner: "workflow:a",
			apps: ["mw"],
			waitSec: 1,
		});
		await Bun.sleep(2);
		let deadlock: EnvironmentInstanceError | undefined;
		try {
			await slots.controller.acquire({
				owner: "workflow:b",
				apps: ["fe"],
				waitSec: 1,
			});
		} catch (error) {
			deadlock = error as EnvironmentInstanceError;
		}
		expect(deadlock?.code).toBe("deadlock");
		for (const named of ["workflow:a", "workflow:b", "fe", "mw"])
			expect(deadlock?.message).toContain(named);
		await aWait;
	});

	test("the developer never closes a wait cycle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-user-"));
		const fixture = composeFixture(root);
		const store = tempState("user");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		for (const ident of ["fe", "mw"])
			fs.writeFileSync(
				path.join(fixture.configDir, "apps", "compose", `${ident}-compose.yml`),
				`services:\n  web:\n    container_name: ${ident}-web\n    image: "${ident}:latest"\n`,
			);
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		slots.running.add("mw");
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		const aWait = slots.controller.acquire({
			owner: "workflow:a",
			apps: ["mw"],
			waitSec: 1,
		});
		await Bun.sleep(2);
		// `a` waits for a developer-held app; `b` also waiting for it is no cycle.
		const b = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		expect(b).toMatchObject({ outcome: "waiting", holders: { mw: "user" } });
		await aWait;
	});

	test("a waiting owner keeps the slots it holds", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-held-"));
		const fixture = composeFixture(root);
		const store = tempState("held");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		for (const ident of ["fe", "mw"])
			fs.writeFileSync(
				path.join(fixture.configDir, "apps", "compose", `${ident}-compose.yml`),
				`services:\n  web:\n    container_name: ${ident}-web\n    image: "${ident}:latest"\n`,
			);
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		const running = store.store.findEnvironmentInstance("workflow:a", "fe");
		const activityBefore = Date.parse(running?.lastActivityAt ?? "");
		const waiting = await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["mw"],
			waitSec: 1,
		});
		expect(waiting.outcome).toBe("waiting");
		// Waiting does not release what the owner already runs…
		expect(await slots.occupancy("fe")).toMatchObject({
			holder: "workflow:a",
			status: "running",
		});
		const held = (await slots.slots()).find((slot) => slot.app === "fe");
		expect(held).toMatchObject({ holder: "workflow:a", status: "running" });
		// …and the request itself is activity, so an idle lifecycle cannot reap an
		// app this owner still needs.
		expect(
			Date.parse(
				store.store.findEnvironmentInstance("workflow:a", "fe")
					?.lastActivityAt ?? "",
			),
		).toBeGreaterThan(activityBefore);
		// The app it waits for names its waiter, so a reaper can exclude it.
		expect(
			(await slots.slots()).find((slot) => slot.app === "mw")?.waiters,
		).toContain("workflow:a");
	});
});

describe("developer force release", () => {
	test("stops the holder, tells it, and grants the next waiter", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-release-"));
		const fixture = composeFixture(root);
		const store = tempState("release");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const waiting = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(waiting.outcome).toBe("waiting");
		const released = await slots.controller.release("shop");
		expect(released.status).toBe("released-by-developer");
		// The holder's run was stopped through the normal stop path.
		expect(slots.calls[1]?.args).toEqual(["-f", fixture.sourcePath, "down"]);
		expect(
			store.store.findEnvironmentInstance("workflow:a", "shop")?.status,
		).toBe("released-by-developer");

		// The holder reads the notice on its next call, then starts cleanly.
		const notice = await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(notice).toEqual({
			outcome: "released-by-developer",
			owner: "workflow:a",
			apps: ["shop"],
		});

		const granted = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(granted.outcome).toBe("started");
		// calls[1] is the holder's `down`; calls[2] is the waiter's `up`.
		expect(slots.calls[2]?.env.AC_OWNER).toBe("workflow:b");
	});

	test("release without a holder is refused", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-noholder-"));
		const fixture = composeFixture(root);
		const store = tempState("noholder");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await expect(slots.controller.release("shop")).rejects.toMatchObject({
			code: "no-holder",
		});
	});
});

describe("app slot notifications", () => {
	test("publishes a wait once per entry and a grant per app", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-events-"));
		const fixture = composeFixture(root);
		const store = tempState("events");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		// The holder's own grant is not a wait; only the queue entry is announced.
		slots.events.length = 0;
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		// Re-polling does not re-announce the same queue entry.
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(slots.events).toEqual([
			{
				domain: "environment",
				kind: "environment.slot.waiting",
				resource: "shop",
				payload: {
					app: "shop",
					waiter: "workflow:b",
					holder: "workflow:a",
					position: 1,
				},
			},
		]);
		await slots.controller.stopApp("shop");
		const granted = await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(granted.outcome).toBe("started");
		expect(slots.events[1]).toEqual({
			domain: "environment",
			kind: "environment.slot.granted",
			resource: "shop",
			payload: { app: "shop", owner: "workflow:b" },
		});
	});
});

describe("app slot request bounds", () => {
	test("refuses unknown apps, malformed owners and oversized requests", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-bounds-"));
		const fixture = composeFixture(root);
		const store = tempState("bounds");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await expect(
			slots.controller.acquire({ owner: "team:a", apps: ["shop"] }),
		).rejects.toMatchObject({ code: "invalid-owner" });
		await expect(
			slots.controller.acquire({ owner: "workflow:a", apps: [] }),
		).rejects.toMatchObject({ code: "apps-required" });
		await expect(
			slots.controller.acquire({ owner: "workflow:a", apps: ["missing"] }),
		).rejects.toMatchObject({ code: "app-not-found" });
		await expect(
			slots.controller.acquire({
				owner: "workflow:a",
				apps: Array.from({ length: 17 }, () => "shop"),
			}),
		).rejects.toMatchObject({ code: "too-many-apps" });
	});
});

// Verifier regressions (`make-app-runs-exclusive` round 1): the release notice
// must survive an in-flight wait, a queue entry must have exactly one poll loop,
// a lost script handle must not lock an app, a crossing pair must deadlock, a
// retired parallel-era row must not be claimed stopped, and observation must not
// run on the queue cadence.
describe("app slot regressions", () => {
	/** Two apps (`fe` and `mw`) with static compose definitions. */
	function twoApps(root: string) {
		const fixture = composeFixture(root);
		for (const ident of ["shop", "fe", "mw"])
			fs.writeFileSync(
				path.join(fixture.configDir, "apps", "compose", `${ident}-compose.yml`),
				`services:\n  web:\n    container_name: ${ident}-web\n    image: "${ident}:latest"\n`,
			);
		return fixture;
	}

	test("a release during an in-flight wait is delivered, not undone", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-inflight-"));
		const fixture = twoApps(root);
		const store = tempState("inflight");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		// `a` holds `fe` and waits for `mw`; the developer releases `fe` under it.
		const inFlight = slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe", "mw"],
			waitSec: 5,
		});
		await Bun.sleep(2);
		const startsBefore = slots.calls.length;
		await slots.controller.release("fe");
		expect(await inFlight).toEqual({
			outcome: "released-by-developer",
			owner: "workflow:a",
			apps: ["fe"],
		});
		// The released app is never restarted by the poll that was waiting.
		expect(slots.calls.length).toBe(startsBefore + 1);
		expect(slots.calls[startsBefore]?.args).toEqual([
			"-f",
			path.join(fixture.configDir, "apps", "compose", "fe-compose.yml"),
			"down",
		]);
	});

	test("one owner and app set runs exactly one poll loop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-mutex-"));
		const fixture = composeFixture(root);
		const store = tempState("mutex");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		const [first, second] = await Promise.all([
			slots.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 1,
			}),
			slots.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 1,
			}),
		]);
		expect(first.outcome).toBe("started");
		// The second request joins the loop in flight instead of racing it.
		expect(second.outcome).toBe("started");
		expect(slots.calls).toHaveLength(1);
		expect(
			slots.events.filter((event) => event.kind === "environment.slot.granted"),
		).toHaveLength(1);
	});

	test("crossing requests deadlock instead of both waiting", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-race-"));
		const fixture = twoApps(root);
		const store = tempState("race");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		await slots.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		// Both cross-requests arrive before either has published its wait edge.
		const results = await Promise.allSettled([
			slots.controller.acquire({
				owner: "workflow:a",
				apps: ["mw"],
				waitSec: 0.05,
			}),
			slots.controller.acquire({
				owner: "workflow:b",
				apps: ["fe"],
				waitSec: 0.05,
			}),
		]);
		const deadlocks = results.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason as EnvironmentInstanceError).code === "deadlock",
		);
		expect(deadlocks.length).toBeGreaterThanOrEqual(1);
		for (const result of results)
			expect(
				result.status === "fulfilled" ? result.value.outcome : "",
			).not.toBe("started");
	});

	test("a script slot survives a lost handle and can still be released", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-handle-"));
		const fixture = scriptFixture(root);
		const store = tempState("handle");
		const first = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			scriptInfra: fakeScriptInfra(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await first.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		// A restart: the same rows, a fresh lifecycle owner with no handles.
		const restarted = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			scriptInfra: fakeScriptInfra(),
		});
		await restarted.controller.ready;
		// The handle is gone, so the app stays occupied as `unknown`…
		expect(await restarted.occupancy("shop")).toMatchObject({
			holder: "workflow:a",
			status: "unknown",
		});
		// …but the developer's release is the documented escape hatch and must work.
		expect((await restarted.controller.release("shop")).status).toBe(
			"released-by-developer",
		);
		expect(await restarted.occupancy("shop")).toBeUndefined();
	});

	test("a script that exits before the start settles never holds the app", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-early-exit-"));
		const fixture = scriptFixture(root);
		const store = tempState("early-exit");
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			scriptInfra: spawningScriptInfra(50),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await expect(
			slots.controller.acquire({
				owner: "workflow:a",
				apps: ["shop"],
				waitSec: 1,
			}),
		).rejects.toMatchObject({ code: "start-failed" });
		// The settled row is terminal, so the app is free again.
		const record = store.store.findEnvironmentInstance("workflow:a", "shop");
		expect(["stopped", "failed"]).toContain(record?.status ?? "missing");
		expect(await slots.occupancy("shop")).toBeUndefined();
	});

	test("a retired parallel-era row is only confirmed stopped by observation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-retired-"));
		const fixture = composeFixture(root);
		const seed = (dir: string, runtime: string) => {
			const state = EnvironmentStateStore.open(dir);
			state.setEnvironmentInstance({
				id: "legacy-row",
				owner: "workflow:old",
				app: "shop",
				targetId: "shop:docker:default",
				runtime,
				checkoutPath: fixture.checkout,
				imageTag: "legacy",
				status: "superseded",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastActivityAt: "2026-01-01T00:00:00.000Z",
			});
			return state;
		};
		const states: EnvironmentStateStore[] = [];
		track([
			() => {
				for (const state of states) state.close();
			},
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		const run = async (options: {
			runtime: string;
			docker?: DockerRuntimeSelection;
			scriptInfra?: ReturnType<typeof fakeScriptInfra>;
		}) => {
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "slots-retired-state-"),
			);
			const state = seed(dir, options.runtime);
			states.push(state);
			const slots = harness({
				root,
				configDir: fixture.configDir,
				checkout: fixture.checkout,
				apps: () => [app(fixture.checkout)],
				store: state,
				...(options.docker ? { docker: options.docker } : {}),
				...(options.scriptInfra ? { scriptInfra: options.scriptInfra } : {}),
			});
			await slots.controller.ready;
			return state.getEnvironmentInstance("legacy-row")?.status;
		};
		// An unobservable Docker runtime must not turn a retired row into stopped,
		// because nothing confirmed its container is gone.
		expect(await run({ runtime: "docker" })).toBe("superseded");
		// A Docker capability that reports no container of the row confirms it.
		expect(await run({ runtime: "docker", docker: dockerSelection() })).toBe(
			"stopped",
		);
		// A container of the row's own parallel-era project keeps it honest.
		expect(
			await run({
				runtime: "docker",
				docker: containerDocker([legacyContainer("shop-legacy-row")]),
			}),
		).toBe("superseded");
		// A runtime whose read fails is unobservable, never an absence.
		expect(
			await run({
				runtime: "docker",
				docker: containerDocker([], { failReads: true }),
			}),
		).toBe("superseded");
		// A parallel-era script process does not survive a restart.
		expect(
			await run({ runtime: "shell", scriptInfra: fakeScriptInfra() }),
		).toBe("stopped");
	});

	test("a release clears a retired parallel-era run and leaves the live one alone", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-sweep-"));
		const fixture = composeFixture(root);
		const store = EnvironmentStateStore.open(
			fs.mkdtempSync(path.join(os.tmpdir(), "slots-sweep-state-")),
		);
		const containers = [
			legacyContainer("shop-legacy-row"),
			// The app's current run: same compose file, its own project label.
			{
				...legacyContainer("compose", "live-1"),
				Labels: {
					"com.docker.compose.project": "compose",
					"com.docker.compose.project.config_files": fixture.sourcePath,
				},
			},
		];
		store.setEnvironmentInstance({
			id: "legacy-row",
			owner: "workflow:old",
			app: "shop",
			targetId: "shop:docker:default",
			runtime: "docker",
			checkoutPath: fixture.checkout,
			imageTag: "legacy",
			status: "superseded",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		});
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store,
			docker: containerDocker(containers),
		});
		track([
			() => store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		// The app has no active holder: the retired row is all that is left, and the
		// documented remedy must still work.
		const released = await slots.controller.release("shop");
		expect(released.status).toBe("stopped");
		expect(slots.calls[0]?.args).toEqual([
			"-p",
			"shop-legacy-row",
			"-f",
			fixture.sourcePath,
			"down",
		]);
		// Only the retired project's container was removed; the app's live run,
		// which shares the same compose file, was left alone.
		expect(containers.map((container) => container.Id)).toEqual(["live-1"]);
		expect(store.getEnvironmentInstance("legacy-row")?.status).toBe("stopped");
	});

	test("a retired run that survives the sweep keeps its honest status", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-sweep-left-"));
		const fixture = composeFixture(root);
		const store = EnvironmentStateStore.open(
			fs.mkdtempSync(path.join(os.tmpdir(), "slots-sweep-left-state-")),
		);
		store.setEnvironmentInstance({
			id: "legacy-row",
			owner: "workflow:old",
			app: "shop",
			targetId: "shop:docker:default",
			runtime: "docker",
			checkoutPath: fixture.checkout,
			imageTag: "legacy",
			status: "superseded",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		});
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store,
			// The container is never observable and never removed.
			docker: containerDocker([legacyContainer("shop-legacy-row")], {
				failReads: true,
			}),
		});
		track([
			() => store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		// The stop still succeeds — it cannot fail on best-effort clean-up — and the
		// row keeps the status that tells the truth about it.
		expect((await slots.controller.stopApp("shop")).status).toBe("superseded");
		expect(store.getEnvironmentInstance("legacy-row")?.status).toBe(
			"superseded",
		);
	});

	test("observation is not re-run on the queue cadence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-cadence-"));
		const fixture = composeFixture(root);
		const store = tempState("cadence");
		let observed = 0;
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => [app(fixture.checkout)],
			store: store.store,
			docker: dockerSelection(),
			// A 25 ms queue cadence with a 25 ms clock step: one second of waiting
			// is ~40 poll turns, but observation must stay far below that.
			waitPollMs: 25,
			observeRun: async () => {
				observed++;
				return "running";
			},
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		slots.running.add("shop");
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(observed).toBeLessThanOrEqual(5);
		expect(observed).toBeGreaterThanOrEqual(1);
	});

	test("a free app blocked by queue order is not reported as held by the developer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-freeholder-"));
		const fixture = twoApps(root);
		const store = tempState("freeholder");
		const apps = [app(fixture.checkout, "fe"), app(fixture.checkout, "mw")];
		const slots = harness({
			root,
			configDir: fixture.configDir,
			checkout: fixture.checkout,
			apps: () => apps,
			store: store.store,
			docker: dockerSelection(),
		});
		track([
			() => store.store.close(),
			() => fs.rmSync(root, { recursive: true, force: true }),
		]);
		await slots.controller.acquire({
			owner: "workflow:a",
			apps: ["mw"],
			waitSec: 1,
		});
		// A multi-app waiter ahead of a single-app one, for an app nobody holds.
		const big = slots.controller.acquire({
			owner: "workflow:b",
			apps: ["fe", "mw"],
			waitSec: 1,
		});
		await Bun.sleep(2);
		const small = await slots.controller.acquire({
			owner: "workflow:c",
			apps: ["fe"],
			waitSec: 0.001,
		});
		expect(small).toEqual({
			outcome: "waiting",
			owner: "workflow:c",
			apps: ["fe"],
			positions: { fe: 2 },
			holders: {},
		});
		await big;
	});
});
