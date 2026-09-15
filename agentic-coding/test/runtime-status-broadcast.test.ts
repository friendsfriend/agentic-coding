// Status broadcast pollers
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/server/server.go`: the git, reconciliation and script
// health pollers, and the signature dedupe that keeps a poller silent when
// nothing changed.
import { describe, expect, test } from "bun:test";
import type { App, InfraService } from "../src/server/environment/config.ts";
import type { AppFamilyServices } from "../src/server/runtime/app-routes.ts";
import { StatusManager } from "../src/server/runtime/status.ts";
import {
	StatusBroadcaster,
	type StatusEvent,
	startStatusPollers,
} from "../src/server/runtime/status-broadcast.ts";

function app(overrides: Partial<App> = {}): App {
	return {
		ident: "api",
		displayName: "Api",
		repositoryPath: "https://github.com/acme/api",
		appType: "app",
		localDirectoryPath: "/src/api",
		branch: "main",
		...overrides,
	};
}

function fixture(overrides: Partial<AppFamilyServices> = {}): {
	services: AppFamilyServices;
	branch: { value: string };
} {
	const branch = { value: "main" };
	const services: AppFamilyServices = {
		configDir: "/c",
		homeDir: "/h",
		apps: () => [app()],
		infraServices: () => [] as InfraService[],
		getAppByIdent: (ident) => (ident === "api" ? app() : undefined),
		getInfraServiceByIdent: () => undefined,
		getDisplayName: (ident) => ident,
		getProjectCatalog: () => [],
		git: {
			getCurrentBranch: () => branch.value,
			getStatus: () => "clean",
		},
		loadConfig: () => {},
		addApp: () => {},
		removeApp: () => {},
		setMainWorktreeBranch: () => {},
		providers: { get: () => undefined },
		statusManager: new StatusManager(),
		runObservation: async () => ({}),
		...overrides,
	};
	return { services, branch };
}

describe("status broadcaster", () => {
	test("publishes only when the properties changed", () => {
		const events: StatusEvent[] = [];
		const broadcaster = new StatusBroadcaster({
			publish: (event) => events.push(event),
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		expect(broadcaster.publishStatus("api", { status: "running" })).toBe(true);
		expect(broadcaster.publishStatus("api", { status: "running" })).toBe(false);
		expect(broadcaster.publishStatus("api", { status: "stopped" })).toBe(true);
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({
			type: "status.updated",
			properties: { status: "running" },
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		expect(broadcaster.tracked()).toBe(1);
	});

	test("different idents are tracked independently", () => {
		const broadcaster = new StatusBroadcaster({ publish: () => {} });
		expect(broadcaster.publishStatus("api", { status: "running" })).toBe(true);
		expect(broadcaster.publishStatus("worker", { status: "running" })).toBe(
			true,
		);
		expect(broadcaster.tracked()).toBe(2);
	});
});

/** A poller the test does not drive parks instead of publishing: the fixture
 * isolates one poller at a time. */
function idle(): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 60_000);
		(timer as unknown as { unref?: () => void }).unref?.();
	});
}

describe("status pollers", () => {
	test("a git change publishes once and repeats stay silent", async () => {
		const { services, branch } = fixture();
		const events: StatusEvent[] = [];
		const controller = new AbortController();
		const sleeps: number[] = [];
		startStatusPollers({
			services,
			signal: controller.signal,
			publish: (event) => events.push(event),
			gitIntervalMs: 5,
			reconciliationIntervalMs: 1_000_000,
			scriptIntervalMs: 1_000_000,
			sleep: async (ms) => {
				if (ms !== 5) return idle();
				sleeps.push(ms);
				if (sleeps.length === 2) controller.abort();
			},
		});
		await Bun.sleep(10);
		// First poll publishes, second poll sees an identical signature.
		expect(events.length).toBe(1);
		expect(events[0].properties.ident).toBe("api");
		expect(events[0].properties.branch).toBe("main");
		expect(sleeps[0]).toBe(5);

		branch.value = "feature";
		const resumed = new AbortController();
		const more: StatusEvent[] = [];
		const sleeps2: number[] = [];
		startStatusPollers({
			services,
			signal: resumed.signal,
			publish: (event) => more.push(event),
			gitIntervalMs: 5,
			reconciliationIntervalMs: 1_000_000,
			scriptIntervalMs: 1_000_000,
			sleep: async (ms) => {
				if (ms !== 5) return idle();
				sleeps2.push(ms);
				if (sleeps2.length === 2) resumed.abort();
			},
		});
		await Bun.sleep(10);
		expect(more[0].properties.branch).toBe("feature");
	});

	test("an aborted scope publishes nothing more", async () => {
		const { services } = fixture();
		const events: StatusEvent[] = [];
		const controller = new AbortController();
		controller.abort();
		startStatusPollers({
			services,
			signal: controller.signal,
			publish: (event) => events.push(event),
			gitIntervalMs: 1,
			reconciliationIntervalMs: 1,
			scriptIntervalMs: 1,
		});
		await Bun.sleep(20);
		expect(events).toEqual([]);
	});

	test("the reconciliation poller covers apps and infrastructure", async () => {
		const { services } = fixture({
			infraServices: () => [
				{
					ident: "clock",
					displayName: "Clock",
					type: "script",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
				} as unknown as InfraService,
			],
			scriptStatus: async () => ({
				status: "running (pid 1)",
				logPath: "/h/clock.log",
			}),
		});
		const events: StatusEvent[] = [];
		const controller = new AbortController();
		let iterations = 0;
		startStatusPollers({
			services,
			signal: controller.signal,
			publish: (event) => events.push(event),
			gitIntervalMs: 1_000_000,
			reconciliationIntervalMs: 5,
			scriptIntervalMs: 1_000_000,
			sleep: async (ms) => {
				if (ms !== 5) return idle();
				iterations++;
				if (iterations === 2) controller.abort();
			},
		});
		await Bun.sleep(10);
		const idents = events.map((event) => event.properties.ident);
		expect(idents).toContain("api");
		expect(idents).toContain("clock");
		const script = events.find((event) => event.properties.ident === "clock");
		expect(script?.properties.status).toBe("running (pid 1)");
	});

	test("the script poller reads only script services", async () => {
		const { services } = fixture({
			infraServices: () => [
				{
					ident: "clock",
					displayName: "Clock",
					type: "script",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
				} as unknown as InfraService,
				{
					ident: "db",
					displayName: "Db",
					type: "docker",
					localDirectoryPath: "",
					branch: "",
					appType: "infrastructure",
				} as unknown as InfraService,
			],
			scriptStatus: async () => ({ status: "stopped", logPath: "" }),
		});
		const events: StatusEvent[] = [];
		const controller = new AbortController();
		let iterations = 0;
		startStatusPollers({
			services,
			signal: controller.signal,
			publish: (event) => events.push(event),
			gitIntervalMs: 1_000_000,
			reconciliationIntervalMs: 1_000_000,
			scriptIntervalMs: 5,
			sleep: async (ms) => {
				if (ms !== 5) return idle();
				iterations++;
				if (iterations === 2) controller.abort();
			},
		});
		await Bun.sleep(10);
		expect(events.map((event) => event.properties.ident)).toEqual(["clock"]);
	});

	test("a failing observation is logged, not published as a state", async () => {
		const { services } = fixture({
			apps: () => [app({ ident: "broken" })],
			runObservation: async () => {
				throw new Error("tmux unavailable");
			},
		});
		const events: StatusEvent[] = [];
		const logged: string[] = [];
		const controller = new AbortController();
		let iterations = 0;
		startStatusPollers({
			services,
			signal: controller.signal,
			publish: (event) => events.push(event),
			gitIntervalMs: 5,
			reconciliationIntervalMs: 1_000_000,
			scriptIntervalMs: 1_000_000,
			logger: (message) => logged.push(message),
			sleep: async (ms) => {
				if (ms !== 5) return idle();
				iterations++;
				if (iterations === 2) controller.abort();
			},
		});
		await Bun.sleep(10);
		expect(events).toEqual([]);
		expect(logged[0]).toContain("broken");
	});
});
