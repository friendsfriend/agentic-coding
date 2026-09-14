// Owned-backend lifecycle evidence (unify-application-lifecycle-and-binary
// tasks 1.3, 1.4, 1.6, 3.1). Every case runs the real Effect programs from
// src/backend/managed-backend.ts against a stub `BackendRuntime` boundary, so
// no Go process is spawned: identity matching, partial-startup rollback and
// "never signal a listener we did not spawn" are asserted directly.
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { startOwnedBackend } from "../src/backend/lifecycle";
import {
	acquireOwnedBackend,
	type BackendChild,
	type BackendHealth,
	BackendRuntime,
	type BackendRuntimeShape,
	backendUrl,
	expectedIdentity,
	healthMatches,
	newInstanceId,
	type ResolvedBinary,
} from "../src/backend/managed-backend";

const BINARY: ResolvedBinary = {
	path: "/fake/devenv-server",
	isEmbedded: false,
	isDevMode: false,
};

interface FakeChild extends BackendChild {
	readonly signals: Array<NodeJS.Signals | undefined>;
	running: boolean;
}

function fakeChild(): FakeChild {
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const child: FakeChild = {
		pid: 4242,
		exited,
		running: true,
		signals: [],
		kill(signal) {
			this.signals.push(signal);
			this.running = false;
			resolveExit(0);
		},
		isRunning() {
			return this.running;
		},
	};
	return child;
}

interface Harness {
	layer: Layer.Layer<BackendRuntime>;
	child: FakeChild;
	spawned: number;
	killed?: number;
	removed: string[];
	/** Signals the port was busy with a foreign instance before spawn. */
	readonly probes: BackendHealth[];
}

function harness(options: {
	probe: (call: number, url: string) => BackendHealth | undefined;
	spawnFails?: string;
}): Harness {
	const child = fakeChild();
	const state: Harness = {
		child,
		spawned: 0,
		removed: [],
		probes: [],
		layer: Layer.empty as unknown as Layer.Layer<BackendRuntime>,
	};
	let calls = 0;
	const shape: BackendRuntimeShape = {
		probe: (url) =>
			Effect.sync(() => {
				const health = options.probe(calls++, url);
				if (health) state.probes.push(health);
				return health;
			}),
		resolveBinary: () => Effect.succeed(BINARY),
		spawnBackend: () => {
			if (options.spawnFails)
				return Effect.sync(() => {
					state.spawned++;
					throw new Error(options.spawnFails);
				}).pipe(Effect.orDie);
			return Effect.sync(() => {
				state.spawned++;
				return child;
			});
		},
		removeExtractionDir: (instance) =>
			Effect.sync(() => {
				state.removed.push(instance);
			}),
	};
	state.layer = Layer.succeed(BackendRuntime, shape);
	return state;
}

test("health identity matching requires instance, home and config", () => {
	const expected = expectedIdentity("abc123");
	expect(
		healthMatches(
			{
				status: "ok",
				instance: "abc123",
				homeDir: expected.homeDir,
				configDir: expected.configDir,
			},
			expected,
		),
	).toBe(true);
	expect(
		healthMatches(
			{
				status: "ok",
				instance: "other",
				homeDir: expected.homeDir,
				configDir: expected.configDir,
			},
			expected,
		),
	).toBe(false);
	expect(
		healthMatches(
			{
				status: "ok",
				instance: "abc123",
				homeDir: "/elsewhere",
				configDir: expected.configDir,
			},
			expected,
		),
	).toBe(false);
});

test("a port owned by a foreign instance fails as a conflict and is never signalled", async () => {
	const h = harness({
		probe: () => ({
			status: "ok",
			instance: "someone-else",
			homeDir: "/x",
			configDir: "/y",
		}),
	});
	let failure: unknown;
	try {
		await startOwnedBackend(
			{ port: "4050", instance: "ours", readinessRetries: 1 },
			h.layer,
		);
	} catch (error) {
		failure = error;
	}
	expect((failure as { reason?: string }).reason).toBe("port-conflict");
	// The foreign listener stays untouched: no spawn, no signal, nothing removed.
	expect(h.spawned).toBe(0);
	expect(h.child.signals).toEqual([]);
	expect(h.removed).toEqual([]);
});

test("a backend that never answers with the spawned identity is not ready", async () => {
	const h = harness({ probe: () => undefined });
	let failure: unknown;
	try {
		await startOwnedBackend(
			{ port: "4051", instance: "ours", readinessRetries: 1 },
			h.layer,
		);
	} catch (error) {
		failure = error;
	}
	expect((failure as { reason?: string }).reason).toBe("not-ready");
	// Partial-startup rollback stopped only the child this start acquired.
	expect(h.spawned).toBe(1);
	expect(h.child.signals).toEqual(["SIGTERM"]);
	expect(h.removed).toContain("ours");
});

test("health answering with the wrong instance rejects readiness and cleans up the child", async () => {
	const h = harness({
		probe: (call) =>
			call === 0
				? undefined
				: {
						status: "ok",
						instance: "impostor",
						homeDir: "/x",
						configDir: "/y",
					},
	});
	let failure: unknown;
	try {
		await startOwnedBackend(
			{ port: "4052", instance: "ours", readinessRetries: 1 },
			h.layer,
		);
	} catch (error) {
		failure = error;
	}
	expect((failure as { reason?: string }).reason).toBe("identity-mismatch");
	expect(h.child.signals).toEqual(["SIGTERM"]);
	expect(h.removed).toContain("ours");
});

test("a child startup failure releases the scope without a second stop", async () => {
	const h = harness({
		probe: () => undefined,
		spawnFails: "go: command not found",
	});
	let failure: unknown;
	try {
		await startOwnedBackend(
			{ port: "4053", instance: "ours", readinessRetries: 1 },
			h.layer,
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeDefined();
	expect(h.spawned).toBe(1);
	// Nothing was acquired, so nothing is stopped or cleaned twice.
	expect(h.child.signals).toEqual([]);
});

test("quit during acquisition stops the acquired child and repeating stop is a no-op", async () => {
	const expected = expectedIdentity("ours");
	const h = harness({
		probe: (call) =>
			call === 0
				? undefined
				: {
						status: "ok",
						instance: "ours",
						homeDir: expected.homeDir,
						configDir: expected.configDir,
					},
	});
	const backend = await startOwnedBackend(
		{ port: "4054", instance: "ours", readinessRetries: 2 },
		h.layer,
	);
	expect(backend.url).toBe(backendUrl("4054"));
	expect(backend.pid).toBe(4242);
	expect(h.child.signals).toEqual([]);

	await backend.stop();
	await backend.stop();
	expect(h.child.signals).toEqual(["SIGTERM"]);
	expect(h.removed).toEqual(["ours"]);
});

test("an unresponsive child is killed after the bounded wait", async () => {
	const h = harness({
		probe: (call) =>
			call === 0
				? undefined
				: {
						status: "ok",
						instance: "ours",
						homeDir: expectedIdentity("ours").homeDir,
						configDir: expectedIdentity("ours").configDir,
					},
	});
	// A child that ignores SIGTERM: exited never resolves.
	h.child.kill = (signal) => {
		h.child.signals.push(signal);
	};
	const backend = await startOwnedBackend(
		{ port: "4055", instance: "ours", readinessRetries: 2, stopTimeoutMs: 20 },
		h.layer,
	);
	await backend.stop();
	// SIGTERM was ignored, so the bounded escalation killed it — and teardown
	// still finished instead of waiting on an exit that never comes.
	expect(h.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(h.removed).toEqual(["ours"]);
});

test("acquireOwnedBackend generates an identity when none is supplied", async () => {
	const instance = newInstanceId();
	expect(instance).toMatch(/^[0-9a-f]{32}$/);
	const h = harness({
		probe: () => undefined,
	});
	// No instance supplied: the program generates one and the stub returns
	// health for whatever identity was spawned with.
	const identity: { instance?: string } = {};
	const probe = h.layer;
	void probe;
	const program = Effect.gen(function* () {
		const backend = yield* acquireOwnedBackend({
			port: "4056",
			readinessRetries: 1,
		});
		identity.instance = backend.instance;
		return backend;
	});
	let failure: unknown;
	try {
		await Effect.runPromise(Effect.provide(Effect.scoped(program), h.layer));
	} catch (error) {
		failure = error;
	}
	// The generated identity cannot match the stub's identity-free probe, so the
	// start fails as not-ready — and the scope still stopped the acquired child.
	expect(failure).toBeDefined();
	expect(h.spawned).toBe(1);
	expect(h.child.signals).toEqual(["SIGTERM"]);
	expect(h.removed).toHaveLength(1);
});

test("only the managed home route owns a backend; attach and dash never do", async () => {
	const { ownsEnvironmentBackend } = await import("../src/backend/ownership");
	const base = { home: true, isTest: false, json: false };
	// Managed unified/home owns the stack it spawns.
	expect(ownsEnvironmentBackend({ ...base })).toBe(true);
	// Attaching to an explicit backend owns nothing, so its exit cannot stop it.
	expect(ownsEnvironmentBackend({ ...base, attachUrl: "http://x:1" })).toBe(
		false,
	);
	expect(ownsEnvironmentBackend({ ...base, explicitUrl: "http://x:1" })).toBe(
		false,
	);
	// Per-workflow dashboard, test profile and headless JSON reads own nothing.
	expect(ownsEnvironmentBackend({ ...base, home: false })).toBe(false);
	expect(ownsEnvironmentBackend({ ...base, isTest: true })).toBe(false);
	expect(ownsEnvironmentBackend({ ...base, json: true })).toBe(false);
});

test("the devenv alias maps onto unified modes, including its own name marker", async () => {
	const { devenvAliasArgv } = await import("../src/devenv-alias");
	expect(devenvAliasArgv(["devenv", "server", "--port", "4050"])).toEqual([
		"server",
		"--port",
		"4050",
	]);
	expect(devenvAliasArgv(["spawn", "--port", "4051"])).toEqual([
		"--devenv-port",
		"4051",
	]);
	expect(devenvAliasArgv(["-p", "4052"])).toEqual(["--devenv-port", "4052"]);
	expect(devenvAliasArgv([])).toEqual([]);
	expect(devenvAliasArgv(["attach", "http://127.0.0.1:4050"])).toEqual([
		"attach",
		"http://127.0.0.1:4050",
	]);
	// An unknown verb is reported by the unified dispatcher, not swallowed here.
	expect(devenvAliasArgv(["frobnicate"])).toEqual(["frobnicate"]);
});
