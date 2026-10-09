// Environment app-slot lifecycle (`add-environment-instance-lifecycle`).
//
// The slot controller owns the release half of the exclusivity model: the
// owner-bound teardown the workflow's durable `environment.teardown` effect
// calls, per-app activity coalescing, and the server-scoped idle reaper. This
// file drives the real controller; the route is covered by
// `runtime-routes.test.ts` and the workflow effect by
// `workflow-environment-teardown.test.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import {
	DockerClient,
	type DockerRuntime,
	type DockerRuntimeSelection,
} from "../src/server/runtime/docker.ts";
import {
	EnvironmentInstanceController,
	type EnvironmentInstanceError,
	type SlotEvent,
} from "../src/server/runtime/instances.ts";
import {
	DEFAULT_ENVIRONMENT_IDLE_TTL_MS,
	environmentInstanceIdleTtlMs,
} from "../src/workflow/effects.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function track(cleanup: () => void): void {
	cleanups.push(cleanup);
}

function dockerSelection(): DockerRuntimeSelection {
	return {
		runtime: RUNTIME,
		client: new DockerClient(RUNTIME, {
			fetch: (async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === "/containers/json") return Response.json([]);
				return new Response("no route", { status: 404 });
			}) as unknown as typeof fetch,
		}),
		fallbacks: [],
	};
}

function app(localDirectoryPath: string, ident = "shop") {
	return {
		ident,
		displayName: ident,
		repositoryPath: `https://example.com/${ident}`,
		appType: "app",
		localDirectoryPath,
		branch: "main",
	};
}

/** A config tree with one compose run target per app, plus one checkout. */
function fixture(
	root: string,
	idents: readonly string[],
): { configDir: string; checkout: string } {
	const configDir = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	fs.mkdirSync(checkout, { recursive: true });
	for (const ident of idents)
		fs.writeFileSync(
			path.join(configDir, "apps", "compose", `${ident}-compose.yml`),
			`services:\n  web:\n    container_name: ${ident}-web\n    image: "${ident}:latest"\n`,
		);
	return { configDir, checkout };
}

interface Harness {
	controller: EnvironmentInstanceController;
	store: EnvironmentStateStore;
	/** The checkout every owner's start runs from. */
	checkout: string;
	/** Every `compose` invocation the controller ran. */
	calls: Array<{ args: readonly string[] }>;
	events: SlotEvent[];
	clock: { ms: number };
}

/** The controller over a real temp state store, a fake docker runtime, an
 * injected clock and a recording `compose` boundary. */
function harness(options: {
	root: string;
	configDir: string;
	checkout: string;
	idents: readonly string[];
	idleTtlMs?: () => number;
	reaperIntervalMs?: number;
}): Harness {
	const store = EnvironmentStateStore.open(path.join(options.root, "db"));
	const calls: Harness["calls"] = [];
	const events: SlotEvent[] = [];
	const clock = { ms: 1_700_000_000_000 };
	const controller = new EnvironmentInstanceController({
		state: store,
		apps: () => options.idents.map((ident) => app(options.checkout, ident)),
		configDir: options.configDir,
		docker: dockerSelection(),
		observeRun: async (candidate) =>
			store.findActiveEnvironmentInstance(candidate.ident)
				? "running"
				: "stopped",
		resolveOwnerCheckout: () => options.checkout,
		now: () => new Date(clock.ms),
		sleep: async (ms) => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			clock.ms += ms;
		},
		waitPollMs: 1_000,
		...(options.idleTtlMs ? { idleTtlMs: options.idleTtlMs } : {}),
		...(options.reaperIntervalMs
			? { reaperIntervalMs: options.reaperIntervalMs }
			: {}),
		runCommand: async (_command, args) => {
			calls.push({ args });
			return { exitCode: 0, output: "" };
		},
		publish: (event) => events.push(event),
	});
	track(() => store.close());
	track(() => fs.rmSync(options.root, { recursive: true, force: true }));
	return {
		controller,
		store,
		checkout: options.checkout,
		calls,
		events,
		clock,
	};
}

/** One active row, as `acquire` would have written it. */
function hold(
	f: Harness,
	owner: string,
	ident: string,
	options: { status?: "running" | "unknown"; runtime?: string } = {},
): void {
	f.store.setEnvironmentInstance({
		id: `${owner.replace(/[^a-z0-9]+/gi, "-")}-${ident}`,
		owner,
		app: ident,
		targetId: `${ident}:${options.runtime === "script" ? "script" : "docker"}:default`,
		runtime: options.runtime ?? "docker",
		checkoutPath: f.checkout,
		imageTag: owner,
		status: options.status ?? "running",
		createdAt: new Date(f.clock.ms).toISOString(),
		lastActivityAt: new Date(f.clock.ms).toISOString(),
	});
}

function statusOf(
	f: Harness,
	owner: string,
	ident: string,
): string | undefined {
	return f.store.findEnvironmentInstance(owner, ident)?.status;
}

describe("owner-bound teardown", () => {
	test("stops every app the owner holds and frees them for the next waiter", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-teardown-"));
		const files = fixture(root, ["fe", "mw"]);
		const f = harness({ root, ...files, idents: ["fe", "mw"] });
		await f.controller.ready;
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["fe", "mw"],
			waitSec: 1,
		});
		const waiting = await f.controller.acquire({
			owner: "workflow:b",
			apps: ["fe"],
			waitSec: 0.001,
		});
		expect(waiting.outcome).toBe("waiting");

		expect(await f.controller.stopByOwner("workflow:a")).toEqual({
			owner: "workflow:a",
			apps: ["fe", "mw"],
		});
		// Every run went through the normal stop path, so the rows are `stopped`
		// and the slot is free again.
		expect(statusOf(f, "workflow:a", "fe")).toBe("stopped");
		expect(statusOf(f, "workflow:a", "mw")).toBe("stopped");
		expect(await f.controller.occupancy("fe")).toBeUndefined();
		expect(f.calls.filter((call) => call.args.includes("down"))).toHaveLength(
			2,
		);

		// Idempotent: an owner that holds nothing is a success with an empty list,
		// which is what makes a retried teardown safe.
		expect(await f.controller.stopByOwner("workflow:a")).toEqual({
			owner: "workflow:a",
			apps: [],
		});

		const granted = await f.controller.acquire({
			owner: "workflow:b",
			apps: ["fe"],
			waitSec: 1,
		});
		expect(granted.outcome).toBe("started");
	});

	test("never touches the developer's own runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-user-"));
		const files = fixture(root, ["shop"]);
		const f = harness({ root, ...files, idents: ["shop"] });
		await f.controller.ready;
		hold(f, "user", "shop");

		// The developer's own run is refused as a request error…
		await expect(f.controller.stopByOwner("user")).rejects.toMatchObject({
			code: "invalid-owner",
		} satisfies Partial<EnvironmentInstanceError>);
		// …and a workflow's teardown leaves it running, because it holds nothing.
		expect(await f.controller.stopByOwner("workflow:a")).toEqual({
			owner: "workflow:a",
			apps: [],
		});
		expect(statusOf(f, "user", "shop")).toBe("running");
		expect(await f.controller.occupancy("shop")).toMatchObject({
			holder: "user",
		});
	});

	test("refuses a malformed owner instead of releasing nothing silently", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-owner-"));
		const files = fixture(root, ["shop"]);
		const f = harness({ root, ...files, idents: ["shop"] });
		await f.controller.ready;
		await expect(f.controller.stopByOwner("run-a")).rejects.toMatchObject({
			code: "invalid-owner",
		} satisfies Partial<EnvironmentInstanceError>);
	});
});

describe("activity", () => {
	test("coalesces writes to one per app per window", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-activity-"));
		const files = fixture(root, ["shop", "free"]);
		const f = harness({ root, ...files, idents: ["shop", "free"] });
		await f.controller.ready;
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const start = f.clock.ms;

		f.controller.touchActivity("shop", start + 1_000);
		const stamp = f.store.findEnvironmentInstance(
			"workflow:a",
			"shop",
		)?.lastActivityAt;
		expect(stamp).toBe(new Date(start + 1_000).toISOString());

		// Inside the window the write is skipped, so a burst of operations is one
		// state write.
		f.controller.touchActivity("shop", start + 2_000);
		expect(
			f.store.findEnvironmentInstance("workflow:a", "shop")?.lastActivityAt,
		).toBe(stamp);

		// Past the window the app is stamped again.
		f.controller.touchActivity("shop", start + 40_000);
		expect(
			f.store.findEnvironmentInstance("workflow:a", "shop")?.lastActivityAt,
		).toBe(new Date(start + 40_000).toISOString());

		// An app nobody holds has no row to stamp, and that is not an error.
		f.controller.touchActivity("free", start + 40_000);
		expect(f.store.findActiveEnvironmentInstance("free")).toBeUndefined();
	});
});

describe("idle reaper", () => {
	test("releases an idle agent-held app, publishes the reap, and the queue grants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-reap-"));
		const files = fixture(root, ["shop"]);
		const f = harness({ root, ...files, idents: ["shop"] });
		await f.controller.ready;
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		const waiting = await f.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 0.001,
		});
		expect(waiting.outcome).toBe("waiting");

		// Nothing is reaped while the app is still fresh…
		expect(await f.controller.reapIdleApps(60_000)).toEqual([]);
		// …and past the TTL the forgotten run goes through the normal stop path.
		f.clock.ms += 5 * 60_000;
		expect(await f.controller.reapIdleApps(60_000)).toEqual([
			{ app: "shop", owner: "workflow:a" },
		]);
		expect(statusOf(f, "workflow:a", "shop")).toBe("stopped");
		expect(f.events).toContainEqual({
			domain: "environment",
			kind: "environment.slot.reaped",
			resource: "shop",
			payload: { app: "shop", owner: "workflow:a" },
		});
		expect(await f.controller.occupancy("shop")).toBeUndefined();

		// The grant follows on the waiter's own next poll.
		const granted = await f.controller.acquire({
			owner: "workflow:b",
			apps: ["shop"],
			waitSec: 1,
		});
		expect(granted.outcome).toBe("started");
	});

	test("skips a user-held app, an unobserved app, and a waiting owner's app", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-reap-skip-"));
		const files = fixture(root, ["fe", "mw", "dev", "stuck"]);
		const f = harness({
			root,
			...files,
			idents: ["fe", "mw", "dev", "stuck"],
		});
		await f.controller.ready;
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["fe"],
			waitSec: 1,
		});
		await f.controller.acquire({
			owner: "workflow:b",
			apps: ["mw"],
			waitSec: 1,
		});
		// `a` still needs `fe`: it is queued for `mw`, which `b` holds.
		const waiting = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["mw"],
			waitSec: 0.001,
		});
		expect(waiting.outcome).toBe("waiting");
		hold(f, "user", "dev");
		// An unobserved run (a script whose process nobody can confirm) stays
		// `unknown`, and the reaper never claims an unobserved run is idle.
		hold(f, "workflow:c", "stuck", { status: "unknown", runtime: "script" });
		f.clock.ms += 60 * 60_000;

		const reaped = await f.controller.reapIdleApps(60_000);
		expect(reaped.map((entry) => entry.app)).toEqual(["mw"]);
		expect(statusOf(f, "workflow:a", "fe")).toBe("running");
		expect(statusOf(f, "user", "dev")).toBe("running");
		expect(statusOf(f, "workflow:c", "stuck")).toBe("unknown");
	});

	test("runs on its interval until it is stopped", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-reaper-loop-"));
		const files = fixture(root, ["shop", "other"]);
		const f = harness({
			root,
			...files,
			idents: ["shop", "other"],
			idleTtlMs: () => 0,
			reaperIntervalMs: 1_000,
		});
		await f.controller.ready;
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});

		const stop = f.controller.startIdleReaper();
		await Bun.sleep(5);
		stop();
		expect(statusOf(f, "workflow:a", "shop")).toBe("stopped");

		// A stopped reaper leaves the next holder alone, even past any TTL.
		await f.controller.acquire({
			owner: "workflow:b",
			apps: ["other"],
			waitSec: 1,
		});
		f.clock.ms += 60 * 60_000;
		await Bun.sleep(5);
		expect(statusOf(f, "workflow:b", "other")).toBe("running");
	});

	test("an external signal ends the loop as well", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "slots-reaper-signal-"));
		const files = fixture(root, ["shop", "other"]);
		const f = harness({
			root,
			...files,
			idents: ["shop", "other"],
			idleTtlMs: () => 0,
			reaperIntervalMs: 1_000,
		});
		await f.controller.ready;
		const aborter = new AbortController();
		f.controller.startIdleReaper({ signal: aborter.signal });
		aborter.abort();
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["shop"],
			waitSec: 1,
		});
		await Bun.sleep(5);
		expect(statusOf(f, "workflow:a", "shop")).toBe("running");
	});
});

describe("idle TTL setting", () => {
	test("defaults to 30 minutes and reads the configured value", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slots-ttl-"));
		const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
		const previousFile = process.env.HERDR_WORKFLOW_CONFIG;
		const file = path.join(dir, "config.json");
		try {
			// No configuration anywhere: the built-in default keeps the lifecycle on.
			process.env.AGENTIC_CODING_CONFIG_DIR = dir;
			delete process.env.HERDR_WORKFLOW_CONFIG;
			expect(DEFAULT_ENVIRONMENT_IDLE_TTL_MS).toBe(30 * 60 * 1000);
			expect(environmentInstanceIdleTtlMs()).toBe(30 * 60 * 1000);

			fs.writeFileSync(
				file,
				`${JSON.stringify({ environment: { instances: { idle_ttl_minutes: 5 } } })}\n`,
			);
			process.env.HERDR_WORKFLOW_CONFIG = file;
			expect(environmentInstanceIdleTtlMs()).toBe(5 * 60 * 1000);

			// An unusable value never disables the release lifecycle.
			fs.writeFileSync(
				file,
				`${JSON.stringify({ environment: { instances: { idle_ttl_minutes: 0 } } })}\n`,
			);
			expect(environmentInstanceIdleTtlMs()).toBe(
				DEFAULT_ENVIRONMENT_IDLE_TTL_MS,
			);
		} finally {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
			if (previousFile === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previousFile;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
