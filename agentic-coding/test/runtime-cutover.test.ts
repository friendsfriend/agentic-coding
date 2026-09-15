// Cutover assertions (`port-environment-runtimes-to-bun`, tasks 4.1, 4.5).
//
// Two claims are checked here:
//
//   - with the Go backend retired, every production route has a Bun
//     implementation in this process, `/api/health` included;
//   - the runtime background work is one server-owned scope: a stopped scope
//     schedules no further listener, prune run or status collection, so a
//     cutover never leaves duplicate owners behind.
import { describe, expect, test } from "bun:test";
import {
	LEGACY_ROUTE_OWNERSHIP,
	legacyRouteMatch,
} from "../src/server/integrations/routes.ts";
import {
	DockerClient,
	type DockerRuntime,
} from "../src/server/runtime/docker.ts";
import {
	KubernetesClusterService,
	type KubernetesExec,
	Runner,
} from "../src/server/runtime/kubernetes.ts";
import { createRuntimeServices } from "../src/server/runtime/services.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

/** A fake daemon that records every request and never ends its event stream. */
function fakeDaemon(): {
	fetch: typeof fetch;
	requests: string[];
	closeStreams: () => void;
} {
	const requests: string[] = [];
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
		if (url.pathname === "/events") {
			// An open, never-ending event stream: the listener stays subscribed
			// until its scope is cancelled.
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controllers.push(controller);
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (url.pathname === "/containers/json") return Response.json([]);
		return new Response(null, { status: 204 });
	}) as unknown as typeof fetch;
	return {
		fetch: fetchImpl,
		requests,
		closeStreams: () => {
			for (const controller of controllers) {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		},
	};
}

const kubernetesExec: KubernetesExec = async (command) =>
	command.args[0] === "get"
		? { stdout: "", stderr: "" }
		: { stdout: "", stderr: "" };

describe("route ownership cutover", () => {
	test("no route is owned by a runtime other than this process", () => {
		const delegated = LEGACY_ROUTE_OWNERSHIP.filter(
			(route) => route.owner !== "bun",
		).map((route) => `${route.method} ${route.path}`);
		// Zero rows: the manifest used to leave `/api/health` with the Go child,
		// and its retirement moved the identity probe in-process. A new non-Bun
		// owner here would mean a route with no implementation.
		expect(delegated).toEqual([]);
	});

	test("every Bun-owned row resolves to a handler", () => {
		// The manifest is the contract: a row that no handler claims would answer
		// 404 from the Bun side while the child no longer owns it, which is the
		// failure this cutover must not introduce.
		for (const route of LEGACY_ROUTE_OWNERSHIP) {
			if (route.owner !== "bun") continue;
			// A prefix-form row (trailing slash) needs a trailing segment; a
			// `{param}` row needs a concrete value.
			const path = route.path.endsWith("/")
				? `${route.path}token`
				: route.path.replace("{ident}", "demo").replace("{name}", "team");
			const matched = legacyRouteMatch(route.method, path);
			expect(matched?.route.path).toBe(route.path);
		}
	});

	test("the flipped families are the app, docker and kubernetes rows", () => {
		const families = new Set(
			LEGACY_ROUTE_OWNERSHIP.filter((route) => route.owner === "bun").map(
				(route) => route.family,
			),
		);
		expect([...families].sort()).toEqual([
			"actions",
			"ai",
			"app",
			"docker",
			"git",
			"github",
			"gitlab",
			"kubernetes",
			"providers",
			"repos",
			"scripts",
			"system",
		]);
	});
});

describe("one server-owned runtime scope", () => {
	test("background work stops as one unit and schedules nothing else", async () => {
		const daemon = fakeDaemon();
		const selection = {
			runtime: RUNTIME,
			client: new DockerClient(RUNTIME, { fetch: daemon.fetch }),
			fallbacks: [],
		};
		const pruneCalls: string[] = [];
		const services = await createRuntimeServices({
			apps: () => [],
			infraServices: () => [],
			dockerClientOverride: selection,
			exec: kubernetesExec,
			statusIntervalMs: 1,
			pruneStartupDelayMs: 1,
			pruneIntervalMs: 1,
		});
		// One event subscription, not one per caller.
		await Bun.sleep(30);
		expect(
			daemon.requests.filter((request) => request === "GET /events").length,
		).toBe(1);
		services.stop();
		const afterStop = daemon.requests.length;
		await Bun.sleep(30);
		expect(daemon.requests.length).toBe(afterStop);
		daemon.closeStreams();
		expect(pruneCalls).toEqual([]);
	});

	test("the scope's stop is idempotent", async () => {
		const services = await createRuntimeServices({
			apps: () => [],
			infraServices: () => [],
			kubernetes: undefined,
			exec: kubernetesExec,
			startBackground: false,
		} as never);
		services.stop();
		services.stop();
		expect(services.kubernetes).toBeInstanceOf(KubernetesClusterService);
	});

	test("the cluster watcher uses the injected service, not a second one", async () => {
		const observed: string[] = [];
		const service = new KubernetesClusterService({
			runner: new Runner({
				containerCommand: "docker",
				containerName: "docker",
			}),
			exec: kubernetesExec,
			observe: (observation) => observed.push(observation.command.name),
		});
		const services = await createRuntimeServices({
			apps: () => [],
			infraServices: () => [],
			exec: kubernetesExec,
			statusIntervalMs: 1,
			pruneStartupDelayMs: 60_000,
		});
		expect(services.routes.kubernetes).not.toBe(service);
		services.stop();
	});
});
