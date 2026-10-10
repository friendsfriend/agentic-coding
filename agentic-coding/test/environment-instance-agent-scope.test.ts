// The slot-controller guarantees the agent environment surface relies on
// (`add-agent-environment-tools`): an owner-scoped stop, a queue entry that is
// the same request whatever order its apps are named in, a wait that ends when
// its caller goes away, and activity stamped only on the caller's own apps.
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
import { EnvironmentInstanceController } from "../src/server/runtime/instances.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A Docker capability that observes no container: every app is free. */
function dockerSelection(): DockerRuntimeSelection {
	return {
		runtime: RUNTIME,
		client: new DockerClient(RUNTIME, {
			fetch: (async () => Response.json([])) as unknown as typeof fetch,
		}),
		fallbacks: [],
	};
}

interface Fixture {
	readonly controller: EnvironmentInstanceController;
	readonly store: EnvironmentStateStore;
	readonly clock: { ms: number };
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-scope-"));
	const configDir = path.join(root, "config");
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	const apps = ["alpha", "beta"].map((ident) => {
		const localDirectoryPath = path.join(root, "checkout", ident);
		fs.mkdirSync(localDirectoryPath, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "apps", "compose", `${ident}-compose.yml`),
			`services:\n  web:\n    image: "${ident}:latest"\n`,
		);
		return {
			ident,
			displayName: ident,
			repositoryPath: `https://example.com/${ident}`,
			appType: "APP",
			localDirectoryPath,
			branch: "main",
		};
	});
	const store = EnvironmentStateStore.open(path.join(root, "db"));
	const clock = { ms: 1_700_000_000_000 };
	const controller = new EnvironmentInstanceController({
		state: store,
		apps: () => apps,
		configDir,
		docker: dockerSelection(),
		observeRun: async () => "stopped",
		resolveOwnerCheckout: (_owner, app) => app.localDirectoryPath,
		now: () => new Date(clock.ms),
		sleep: async (ms: number) => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			clock.ms += ms;
		},
		waitPollMs: 1_000,
		runCommand: async () => ({ exitCode: 0, output: "" }),
	});
	cleanups.push(() => {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { controller, store, clock };
}

describe("an owner stops only an app it holds", () => {
	test("another owner's app is refused and keeps running", async () => {
		const f = fixture();
		const granted = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["alpha"],
			waitSec: 0.001,
		});
		expect(granted.outcome).toBe("started");
		await expect(f.controller.stopOwned("workflow:b", "alpha")).rejects.toThrow(
			/held by workflow:a/,
		);
		// The refusal is the whole point: the holder's run is untouched.
		expect(await f.controller.occupancy("alpha")).toMatchObject({
			holder: "workflow:a",
		});
		const stopped = await f.controller.stopOwned("workflow:a", "alpha");
		expect(stopped.status).toBe("stopped");
		expect(await f.controller.occupancy("alpha")).toBeUndefined();
	});

	test("an app nobody holds is not a stop", async () => {
		const f = fixture();
		await expect(f.controller.stopOwned("workflow:a", "alpha")).rejects.toThrow(
			/no environment instance holds/,
		);
	});
});

describe("a queue entry is the app set, not the app order", () => {
	test("the same apps in another order join the same entry", async () => {
		const f = fixture();
		// Another owner holds beta, so both requests below have to wait.
		await f.controller.acquire({
			owner: "workflow:b",
			apps: ["beta"],
			waitSec: 0.001,
		});
		const first = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["alpha", "beta"],
			waitSec: 0.001,
		});
		expect(first.outcome).toBe("waiting");
		const second = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["beta", "alpha"],
			waitSec: 0.001,
		});
		expect(second.outcome).toBe("waiting");
		// One entry, so the owner still heads both queues. A second entry for the
		// same owner would sit behind the first and report position 2.
		expect(second).toMatchObject({
			positions: { alpha: 1, beta: 1 },
		});
	});
});

describe("a wait ends when its caller goes away", () => {
	test("an already-aborted signal never enqueues", async () => {
		const f = fixture();
		const aborted = new AbortController();
		aborted.abort();
		const result = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["alpha"],
			waitSec: 30,
			signal: aborted.signal,
		});
		expect(result).toEqual({
			outcome: "cancelled",
			owner: "workflow:a",
			apps: ["alpha"],
		});
		// Nothing was started and nothing is queued: a later owner is granted
		// immediately.
		expect(await f.controller.occupancy("alpha")).toBeUndefined();
		const other = await f.controller.acquire({
			owner: "workflow:b",
			apps: ["alpha"],
			waitSec: 0.001,
		});
		expect(other.outcome).toBe("started");
	});

	test("an abort during the wait withdraws the entry", async () => {
		const f = fixture();
		await f.controller.acquire({
			owner: "workflow:b",
			apps: ["beta"],
			waitSec: 0.001,
		});
		const controller = new AbortController();
		// The wait is long, so the abort lands inside the poll loop rather than
		// before it.
		setTimeout(() => controller.abort(), 0);
		const result = await f.controller.acquire({
			owner: "workflow:a",
			apps: ["beta"],
			waitSec: 30,
			signal: controller.signal,
		});
		expect(result.outcome).toBe("cancelled");
		// The abandoned entry is gone: it cannot still commit a start for a caller
		// that is no longer there, and it does not hold a position.
		const beta = (await f.controller.slots()).find(
			(slot) => slot.app === "beta",
		);
		expect(beta?.waiters).toEqual([]);
	});
});

describe("activity is stamped on the caller's own apps only", () => {
	test("a foreign read does not keep another owner's app alive", async () => {
		const f = fixture();
		await f.controller.acquire({
			owner: "workflow:a",
			apps: ["alpha"],
			waitSec: 0.001,
		});
		const before =
			f.store.findActiveEnvironmentInstance("alpha")?.lastActivityAt;
		expect(before).toBeDefined();
		// Time passes, then another workflow reads the app: its read is not the
		// holder's use, so the idle reaper still sees an idle app.
		f.clock.ms += 10 * 60_000;
		f.controller.touchOwnedActivity("workflow:b", "alpha");
		expect(f.store.findActiveEnvironmentInstance("alpha")?.lastActivityAt).toBe(
			before,
		);
		// The holder's own read is activity.
		f.controller.touchOwnedActivity("workflow:a", "alpha");
		expect(
			f.store.findActiveEnvironmentInstance("alpha")?.lastActivityAt,
		).not.toBe(before);
	});
});
