// Composition wiring for app slots (`make-app-runs-exclusive`).
//
// The controller's own behaviour is covered by `environment-instances.test.ts`,
// but two bridges live in the composition and would otherwise fail silently:
// the developer-run refusal built from `instances.occupancy()` in
// `integrations/services.ts`, and the dashboard-envelope fan-out attached by
// `lifecycle.ts`. This file drives the *real* `createIntegrationServices` so
// removing either wire fails a test.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope } from "../src/contracts/environment.ts";
import { EnvironmentManager } from "../src/server/environment/manager.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import { createIntegrationServices } from "../src/server/integrations/services.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	DockerClient,
	type DockerRuntime,
	type DockerRuntimeSelection,
} from "../src/server/runtime/docker.ts";
import type { SlotEvent } from "../src/server/runtime/instances.ts";
import type { RuntimeRouteServices } from "../src/server/runtime/routes.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The app's compose file, so the app has a run target to observe. */
function composeSource(configDir: string): string {
	const sourcePath = path.join(
		configDir,
		"apps",
		"compose",
		"shop-compose.yml",
	);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(
		sourcePath,
		`services:\n  web:\n    container_name: shop-web\n    image: "shop:latest"\n`,
	);
	return sourcePath;
}

/** A Docker capability over the app's live container, removable by DELETE. */
function runningContainer(sourcePath: string): {
	selection: DockerRuntimeSelection;
	containers: Array<Record<string, unknown>>;
} {
	const containers: Array<Record<string, unknown>> = [
		{
			Id: "container-1",
			Names: ["/shop-web"],
			State: "running",
			Ports: [],
			Labels: {
				"com.docker.compose.project": "compose",
				"com.docker.compose.project.config_files": sourcePath,
			},
		},
	];
	const selection: DockerRuntimeSelection = {
		runtime: RUNTIME,
		client: new DockerClient(RUNTIME, {
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/containers/json")
					return Response.json(containers);
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
	return { selection, containers };
}

function compose(): {
	root: string;
	configDir: string;
	state: EnvironmentStateStore;
	services: ReturnType<typeof createIntegrationServices>;
	events: SlotEvent[];
	appDirectory: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "slot-wiring-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	fs.mkdirSync(path.join(configDir, "apps", "definitions"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(configDir, "providers"), { recursive: true });
	for (const ident of ["shop", "free"])
		fs.writeFileSync(
			path.join(configDir, "apps", "definitions", `${ident}.json`),
			`${JSON.stringify({
				ident,
				displayName: ident === "shop" ? "Shop" : "Free",
				repositoryPath: `https://example.com/${ident}.git`,
				sourceType: "git",
				gitMode: "BRANCH",
			})}\n`,
		);
	const sourcePath = composeSource(configDir);
	// Only the `shop` app has a container of its own; `free` has none.
	const state = EnvironmentStateStore.open(path.join(homeDir, "db"));
	const manager = new EnvironmentManager({ homeDir, configDir, store: state });
	manager.loadConfig();
	const appDirectory =
		manager.getAppByIdent("shop")?.localDirectoryPath ?? homeDir;
	const runtime = {
		docker: runningContainer(sourcePath).selection,
	} as unknown as RuntimeRouteServices;
	const services = createIntegrationServices({
		manager,
		state,
		configDir,
		homeDir,
		runtime,
		logger: () => {},
	});
	const events: SlotEvent[] = [];
	// `createServerApp` performs exactly this attachment.
	services.attachDashboardEvents?.((event) => events.push(event));
	cleanups.push(() => {
		state.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		configDir,
		state,
		services,
		events,
		appDirectory,
	};
}

/** An active row held by an agent, as `acquire` would have written it. */
function hold(f: ReturnType<typeof compose>, ident: string): void {
	f.state.setEnvironmentInstance({
		id: `workflow-a-${ident}`,
		owner: "workflow:a",
		app: ident,
		targetId: `${ident}:docker:default`,
		runtime: "docker",
		checkoutPath: f.appDirectory,
		imageTag: "workflow-a",
		status: "running",
		createdAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
	});
}

describe("composed slot wiring", () => {
	test("the developer-run refusal comes from the composed slot", async () => {
		const f = compose();
		hold(f, "shop");
		// Reconciliation observes the app's own container, so the row stays
		// `running` and the composed guard reports its holder.
		await f.services.instances?.ready;
		expect(await f.services.actions?.services.humanRunGuard?.("shop")).toEqual({
			holder: "workflow:a",
		});
		// A free app is not held by anyone.
		expect(
			await f.services.actions?.services.humanRunGuard?.("free"),
		).toBeUndefined();
	});

	test("a waiting and a granted slot reach the dashboard envelopes", async () => {
		const f = compose();
		hold(f, "shop");
		await f.services.instances?.ready;
		// A second owner waits for the held app: the developer sees why.
		const waiting = await f.services.instances?.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 0.001,
		});
		expect(waiting).toMatchObject({
			outcome: "waiting",
			positions: { shop: 1 },
			holders: { shop: "workflow:a" },
		});
		expect(f.events).toContainEqual({
			domain: "environment",
			kind: "environment.slot.waiting",
			resource: "shop",
			payload: {
				app: "shop",
				waiter: "workflow:b",
				holder: "workflow:a",
				position: 1,
			},
		});
		// The holder re-requests what it already runs: a grant, and the shell is
		// told about it.
		const granted = await f.services.instances?.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(granted?.outcome).toBe("already-running");
		expect(f.events).toContainEqual({
			domain: "environment",
			kind: "environment.slot.granted",
			resource: "shop",
			payload: { app: "shop", owner: "workflow:a" },
		});
	});

	test("a free app is acquired without observation noise", async () => {
		const f = compose();
		await f.services.instances?.ready;
		expect(await f.services.instances?.occupancy("free")).toBeUndefined();
	});

	test("the composed stop yields an agent-held slot and tells the holder", async () => {
		const f = compose();
		hold(f, "shop");
		await f.services.instances?.ready;
		// A second owner is queued behind the holder, so the yield must be real.
		await f.services.instances?.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 0.001,
		});
		expect(
			await f.services.actions?.services.humanStopRelease?.("shop"),
		).toBeUndefined();
		// The holder is told — its next call reads the notice — and the app is free
		// again, so the queued waiter can be granted.
		expect(f.state.findEnvironmentInstance("workflow:a", "shop")?.status).toBe(
			"released-by-developer",
		);
		expect(await f.services.instances?.occupancy("shop")).toBeUndefined();
	});

	test("a stop whose yield fails reports a warning instead of throwing", async () => {
		const f = compose();
		hold(f, "shop");
		await f.services.instances?.ready;
		// A release that cannot proceed: the holder's row is mid-transition.
		f.state.updateEnvironmentInstanceStatus(
			"workflow-a-shop",
			"starting",
			new Date().toISOString(),
		);
		const warning =
			await f.services.actions?.services.humanStopRelease?.("shop");
		expect(warning).toContain("shop");
		expect(warning).toContain("could not be released");
	});

	test("the lifecycle attachment carries a slot event to the broker", async () => {
		const f = compose();
		hold(f, "shop");
		await f.services.instances?.ready;
		// The attachment lives in `startWorkflowServer`, so only a server that owns
		// these integrations can prove a wait reaches the dashboard hub.
		const server = await startWorkflowServer({
			port: 0,
			ownTelemetry: false,
			integrations: f.services,
		});
		try {
			const received: EventEnvelope[] = [];
			const subscription = server.app.events.open({}, (event) =>
				received.push(event),
			);
			const waiting = await f.services.instances?.acquire({
				owner: "workflow:b",
				apps: ["shop"],
				waitSec: 0.001,
			});
			expect(waiting?.outcome).toBe("waiting");
			expect(received).toContainEqual({
				instance: server.instance,
				sequence: expect.any(Number),
				domain: "environment",
				kind: "environment.slot.waiting",
				resource: "shop",
				at: expect.any(String),
				payload: {
					app: "shop",
					waiter: "workflow:b",
					holder: "workflow:a",
					position: 1,
				},
			});
			subscription.unsubscribe();
		} finally {
			await server.stop();
		}
	});

	test("the server-scoped reaper releases an idle held app", async () => {
		const f = compose();
		// An agent-held app nobody has touched for an hour, and a one-minute TTL
		// from the layered configuration: the server's first reap pass releases it
		// through the composed stop path.
		const idle = new Date(Date.now() - 60 * 60_000).toISOString();
		f.state.setEnvironmentInstance({
			id: "workflow-a-shop",
			owner: "workflow:a",
			app: "shop",
			targetId: "shop:docker:default",
			runtime: "docker",
			checkoutPath: f.appDirectory,
			imageTag: "workflow-a",
			status: "running",
			createdAt: idle,
			lastActivityAt: idle,
		});
		const previousConfig = process.env.HERDR_WORKFLOW_CONFIG;
		const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-config-"));
		const configFile = path.join(configRoot, "config.json");
		fs.writeFileSync(
			configFile,
			`${JSON.stringify({ environment: { instances: { idle_ttl_minutes: 1 } } })}\n`,
		);
		process.env.HERDR_WORKFLOW_CONFIG = configFile;
		cleanups.push(() => {
			if (previousConfig === undefined)
				delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previousConfig;
			fs.rmSync(configRoot, { recursive: true, force: true });
		});
		await f.services.instances?.ready;
		// Only `startWorkflowServer` starts the reaper, so a server that owns these
		// integrations is what proves the wire.
		const server = await startWorkflowServer({
			port: 0,
			ownTelemetry: false,
			integrations: f.services,
		});
		try {
			const deadline = Date.now() + 2_000;
			while (
				Date.now() < deadline &&
				f.state.findActiveEnvironmentInstance("shop") !== undefined
			)
				await Bun.sleep(10);
			expect(f.state.findActiveEnvironmentInstance("shop")).toBeUndefined();
			expect(
				f.state.findEnvironmentInstance("workflow:a", "shop")?.status,
			).toBe("stopped");
		} finally {
			await server.stop();
		}
	});
});
