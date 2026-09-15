// Container runtime parity (`port-environment-runtimes-to-bun`, task 1.2/2.x).
//
// Ported from `server/pkg/docker/{client_test,health_test,stats_test}.go`,
// `server/pkg/server/prune_test.go` and `server/pkg/docker/runtime.go`'s
// candidate table. The fake daemon is a `fetch` so the client's transport,
// envelopes and error wrapping are exercised without a live runtime.
import { describe, expect, test } from "bun:test";
import type { DockerRuntime } from "../src/server/runtime/docker.ts";
import {
	calculateCPUPercent,
	calculateMemoryUsage,
	containerNameMatches,
	containerPruneArgs,
	containerStatusRank,
	DockerClient,
	decodeLogFrames,
	dockerTlsOptions,
	formatPorts,
	parseDockerHost,
	preferredContainerInfo,
	runSystemPrune,
	runtimeCandidates,
	startEventListener,
	startPrunePoller,
} from "../src/server/runtime/docker.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

interface Recorded {
	method: string;
	path: string;
	params: URLSearchParams;
}

/** A fake Docker daemon: routes by path, records every request. */
function fakeDaemon(routes: Record<string, (request: Recorded) => Response>) {
	const recorded: Recorded[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const entry: Recorded = {
			method: (init?.method ?? "GET").toUpperCase(),
			path: url.pathname,
			params: url.searchParams,
		};
		recorded.push(entry);
		const handler = routes[`${entry.method} ${entry.path}`];
		if (!handler) return new Response("no such route", { status: 404 });
		return handler(entry);
	}) as typeof fetch;
	return { fetchImpl, recorded };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status });
}

function containerList(): unknown[] {
	return [
		{
			Id: "exited-id",
			Names: ["/devenv-shop_1"],
			State: "exited",
			Ports: [{ PrivatePort: 8080, Type: "tcp" }],
		},
		{
			Id: "running-id",
			Names: ["/devenv-shop-1"],
			State: "running",
			Ports: [
				{ PrivatePort: 8080, PublicPort: 18080, Type: "tcp" },
				{ PrivatePort: 8080, PublicPort: 18080, Type: "tcp" },
				{ PrivatePort: 5432, Type: "tcp" },
			],
		},
	];
}

describe("container name matching (Go client_test.go fixture)", () => {
	test("matches docker and podman compose names", () => {
		const cases: [string, string, string][] = [
			["/postgres-1", "postgres", "postgres"],
			["/postgres_1", "postgres", "postgres"],
			["/devenv-postgres-1", "postgres", "postgres"],
			["/devenv_postgres_1", "postgres", "postgres"],
			["devenv_mailpit_1", "mailpit", "mailpit"],
			["compose_bhvr-site_1", "bhvr-site", ""],
		];
		for (const [name, ident, base] of cases) {
			expect(containerNameMatches(name, ident, base)).toBe(true);
		}
		expect(containerNameMatches("/other_1", "shop", "")).toBe(false);
	});
});

describe("status ranking (Go client_test.go fixture)", () => {
	test("running wins over exited in both directions", () => {
		const running = { Status: "running", ContainerID: "new", Ports: "" };
		const exited = { Status: "exited", ContainerID: "old", Ports: "" };
		expect(preferredContainerInfo(exited, running).ContainerID).toBe("new");
		expect(preferredContainerInfo(running, exited).ContainerID).toBe("new");
	});

	test("rank order matches the Go table", () => {
		expect(containerStatusRank("running")).toBeGreaterThan(
			containerStatusRank("restarting"),
		);
		expect(containerStatusRank("restarting")).toBeGreaterThan(
			containerStatusRank("paused"),
		);
		expect(containerStatusRank("paused")).toBeGreaterThan(
			containerStatusRank("created"),
		);
		expect(containerStatusRank("created")).toBeGreaterThan(
			containerStatusRank("exited"),
		);
		expect(containerStatusRank("not found")).toBe(0);
		expect(containerStatusRank("error")).toBe(-1);
	});
});

describe("port formatting", () => {
	test("formats published and unpublished ports once each", () => {
		const ports = formatPorts({
			Id: "x",
			Names: [],
			State: "running",
			Ports: [
				{ PrivatePort: 8080, PublicPort: 18080, Type: "tcp" },
				{ PrivatePort: 8080, PublicPort: 18080, Type: "tcp" },
				{ PrivatePort: 5432, Type: "tcp" },
			],
		});
		expect(ports).toBe("18080->8080/tcp, 5432/tcp");
		expect(
			formatPorts({ Id: "x", Names: [], State: "running", Ports: [] }),
		).toBe("");
	});
});

describe("runtime selection", () => {
	test("docker has one candidate that inherits DOCKER_HOST", () => {
		expect(
			runtimeCandidates("docker", { DOCKER_HOST: "tcp://1.2.3.4:2375" }),
		).toEqual([
			{ name: "docker", command: "docker", host: "tcp://1.2.3.4:2375" },
		]);
	});

	test("podman prefers explicit host, then DOCKER_HOST, then sockets", () => {
		expect(
			runtimeCandidates("podman", {
				DEVENV_PODMAN_HOST: "unix:///custom.sock",
			}),
		).toEqual([
			{ name: "podman", command: "podman", host: "unix:///custom.sock" },
		]);
		expect(
			runtimeCandidates("podman", { DOCKER_HOST: "unix:///env.sock" }),
		).toEqual([
			{ name: "podman", command: "podman", host: "unix:///env.sock" },
		]);
		const sockets = runtimeCandidates("podman", {}, 1000, "/home/dev");
		expect(sockets.map((candidate) => candidate.host)).toEqual([
			"unix:///run/user/1000/podman/podman.sock",
			"unix:///run/podman/podman.sock",
			"unix:///home/dev/.local/share/containers/podman/machine/podman.sock",
		]);
	});

	test("honours DOCKER_TLS_VERIFY and DOCKER_CERT_PATH like client.FromEnv", () => {
		const certs = (path: string) => `contents-of-${path}`;
		expect(dockerTlsOptions({}, certs)).toBeUndefined();
		expect(dockerTlsOptions({ DOCKER_TLS_VERIFY: "1" }, certs)).toEqual({
			ca: undefined,
		});
		expect(
			dockerTlsOptions(
				{ DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/certs" },
				certs,
			),
		).toEqual({
			ca: "contents-of-/certs/ca.pem",
			cert: "contents-of-/certs/cert.pem",
			key: "contents-of-/certs/key.pem",
		});
		// A TCP endpoint with TLS verification becomes https, and the request
		// carries the certificate material.
		expect(
			parseDockerHost("tcp://daemon:2376", {
				DOCKER_TLS_VERIFY: "1",
				DOCKER_CERT_PATH: "/certs",
			}).url,
		).toBe("https://daemon:2376");
		expect(parseDockerHost("tcp://daemon:2375", {}).url).toBe(
			"http://daemon:2375",
		);
	});

	test("a TLS request carries the certificate material", async () => {
		const inits: RequestInit[] = [];
		const client = new DockerClient(
			{ name: "docker", command: "docker", host: "tcp://daemon:2376" },
			{
				env: { DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/certs" },
				fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
					inits.push(init ?? {});
					return Response.json([]);
				}) as unknown as typeof fetch,
			},
		);
		await client.allContainers();
		// The endpoint is https and the request carries TLS material; the file
		// contents come from `DOCKER_CERT_PATH`, which the unit above pins.
		expect((inits[0] as { tls?: unknown }).tls).toBeDefined();
		expect(inits[0]?.signal).toBeDefined();
	});

	test("parses the host forms the runtime table produces", () => {
		expect(parseDockerHost("unix:///var/run/docker.sock")).toEqual({
			unix: "/var/run/docker.sock",
			url: "http://docker",
		});
		expect(parseDockerHost("tcp://127.0.0.1:2375")).toEqual({
			url: "http://127.0.0.1:2375",
		});
	});
});

describe("client reads", () => {
	test("getInfo prefers the running container and reports its ports", async () => {
		const daemon = fakeDaemon({
			"GET /containers/json": () => json(containerList()),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		const info = await client.getInfo({
			ident: "shop",
			containerBaseName: "shop",
		});
		expect(info).toEqual({
			Status: "running",
			ContainerID: "running-id",
			Ports: "18080->8080/tcp, 5432/tcp",
		});
	});

	test("an unavailable daemon reports error, never absence", async () => {
		const client = new DockerClient(RUNTIME, {
			fetch: (async () => {
				throw new Error("connect ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		expect(
			await client.getInfo({ ident: "shop", containerBaseName: "" }),
		).toEqual({
			Status: "error",
			ContainerID: "",
			Ports: "",
		});
	});

	test("batchGetInfo initializes requested targets and fills matches", async () => {
		let calls = 0;
		const daemon = fakeDaemon({
			"GET /containers/json": () => {
				calls++;
				return json(containerList());
			},
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		const results = await client.batchGetInfo(
			[
				{ ident: "shop", containerBaseName: "shop" },
				{ ident: "other", containerBaseName: "" },
			],
			[{ ident: "shop-db", containerBaseName: "" }],
		);
		expect(results.get("shop")?.Status).toBe("running");
		expect(results.get("other")?.Status).toBe("not found");
		expect(results.get("shop-db")?.Status).toBe("not found");
		// One list call for the whole batch.
		expect(calls).toBe(1);
	});

	test("getAllContainerIDsForApp only returns running containers from a fresh list", async () => {
		const daemon = fakeDaemon({
			"GET /containers/json": () => json(containerList()),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		expect(
			await client.allContainerIdsForApp({
				ident: "shop",
				containerBaseName: "",
			}),
		).toEqual(["running-id"]);
	});

	test("the container cache is used until it is invalidated", async () => {
		let calls = 0;
		const daemon = fakeDaemon({
			"GET /containers/json": () => {
				calls++;
				return json(containerList());
			},
		});
		let now = 0;
		const client = new DockerClient(RUNTIME, {
			fetch: daemon.fetchImpl,
			now: () => now,
		});
		await client.getInfo({ ident: "shop", containerBaseName: "" });
		await client.getInfo({ ident: "shop", containerBaseName: "" });
		expect(calls).toBe(1);
		now += 31_000;
		await client.getInfo({ ident: "shop", containerBaseName: "" });
		expect(calls).toBe(2);
	});
});

describe("client lifecycle", () => {
	test("start/stop/restart use the documented argv-equivalent requests", async () => {
		const daemon = fakeDaemon({
			"POST /containers/abc/start": () => new Response(null, { status: 204 }),
			"POST /containers/abc/stop": () => new Response(null, { status: 204 }),
			"POST /containers/abc/restart": () => new Response(null, { status: 204 }),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		await client.startContainer("abc");
		await client.stopContainer("abc");
		await client.restartContainer("abc");
		expect(
			daemon.recorded.map((entry) => `${entry.method} ${entry.path}`),
		).toEqual([
			"POST /containers/abc/start",
			"POST /containers/abc/stop",
			"POST /containers/abc/restart",
		]);
		// A graceful stop and restart keep the 10 second timeout.
		expect(daemon.recorded[1].params.get("t")).toBe("10");
		expect(daemon.recorded[2].params.get("t")).toBe("10");
	});

	test("a failing lifecycle call reports Go's wrapped message", async () => {
		const daemon = fakeDaemon({
			"POST /containers/abc/start": () =>
				new Response("No such container: abc", { status: 404 }),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		await expect(client.startContainer("abc")).rejects.toThrow(
			"failed to start container abc: No such container: abc",
		);
	});

	test("kill and remove runs kill then force remove", async () => {
		const daemon = fakeDaemon({
			"POST /containers/abc/kill": () => new Response(null, { status: 204 }),
			"DELETE /containers/abc": () => new Response(null, { status: 204 }),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		await client.killAndRemoveContainer("abc");
		expect(
			daemon.recorded.map((entry) => `${entry.method} ${entry.path}`),
		).toEqual(["POST /containers/abc/kill", "DELETE /containers/abc"]);
		expect(daemon.recorded[0].params.get("signal")).toBe("SIGKILL");
		expect(daemon.recorded[1].params.get("force")).toBe("true");
	});
});

describe("log frames", () => {
	test("decodes a multiplexed stream and passes a TTY stream through", () => {
		// Docker frames the size big-endian: stream, 3 zero bytes, 4-byte size.
		const body = new Uint8Array([
			1,
			0,
			0,
			0,
			0,
			0,
			0,
			5,
			104,
			101,
			108,
			108,
			111, // stdout "hello"
			2,
			0,
			0,
			0,
			0,
			0,
			0,
			4,
			98,
			111,
			111,
			109, // stderr "boom"
		]);
		expect(decodeLogFrames(body)).toBe("helloboom");
		const raw = new TextEncoder().encode("plain tty output\n");
		expect(decodeLogFrames(raw)).toBe("plain tty output\n");
	});

	test("getContainerLogs asks for a 1000 line tail and demultiplexes", async () => {
		const daemon = fakeDaemon({
			"GET /containers/abc/logs": (request) => {
				expect(request.params.get("tail")).toBe("1000");
				expect(request.params.get("follow")).toBeNull();
				return new Response(
					new Uint8Array([1, 0, 0, 0, 0, 0, 0, 3, 97, 98, 99]),
				);
			},
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		expect(await client.getContainerLogs("abc")).toBe("abc");
	});
});

describe("stats calculation (Go stats_test.go fixture)", () => {
	test("normal, first-frame, capped and zero-delta CPU", () => {
		expect(
			calculateCPUPercent({
				cpu_stats: {
					cpu_usage: { total_usage: 500 },
					system_cpu_usage: 10000,
					online_cpus: 4,
				},
				precpu_stats: {
					cpu_usage: { total_usage: 400 },
					system_cpu_usage: 9000,
				},
			}),
		).toBeCloseTo(10, 1);
		expect(
			calculateCPUPercent({
				cpu_stats: {
					cpu_usage: { total_usage: 500 },
					system_cpu_usage: 10000,
					online_cpus: 4,
				},
				precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
			}),
		).toBe(0);
		expect(
			calculateCPUPercent({
				cpu_stats: {
					cpu_usage: { total_usage: 20000 },
					system_cpu_usage: 10000,
					online_cpus: 4,
				},
				precpu_stats: {
					cpu_usage: { total_usage: 1000 },
					system_cpu_usage: 9000,
				},
			}),
		).toBe(100);
		expect(
			calculateCPUPercent({
				cpu_stats: {
					cpu_usage: { total_usage: 500 },
					system_cpu_usage: 10000,
					online_cpus: 1,
				},
				precpu_stats: {
					cpu_usage: { total_usage: 400 },
					system_cpu_usage: 10000,
				},
			}),
		).toBe(0);
	});

	test("memory: cgroup v2, v1 cache, raw and zero limit", () => {
		expect(
			calculateMemoryUsage({
				memory_stats: {
					usage: 1_000_000,
					limit: 4_000_000,
					stats: { inactive_file: 200_000 },
				},
			}),
		).toEqual({ usage: 800_000, limit: 4_000_000, percent: 20 });
		expect(
			calculateMemoryUsage({
				memory_stats: {
					usage: 1_000_000,
					limit: 4_000_000,
					stats: { cache: 300_000 },
				},
			}).usage,
		).toBe(700_000);
		expect(
			calculateMemoryUsage({
				memory_stats: { usage: 1_000_000, limit: 4_000_000, stats: {} },
			}).usage,
		).toBe(1_000_000);
		expect(
			calculateMemoryUsage({
				memory_stats: { usage: 500_000, limit: 0, stats: {} },
			}),
		).toEqual({ usage: 500_000, limit: 0, percent: 0 });
	});
});

describe("streams", () => {
	test("the stats stream skips the first frame and emits the wire shape", async () => {
		const frames = [
			{
				cpu_stats: {
					cpu_usage: { total_usage: 500 },
					system_cpu_usage: 10000,
					online_cpus: 1,
				},
				precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
				memory_stats: { usage: 10, limit: 100 },
			},
			{
				cpu_stats: {
					cpu_usage: { total_usage: 1000 },
					system_cpu_usage: 10000,
					online_cpus: 1,
				},
				precpu_stats: {
					cpu_usage: { total_usage: 500 },
					system_cpu_usage: 9000,
				},
				memory_stats: { usage: 50, limit: 100 },
			},
		];
		const daemon = fakeDaemon({
			"GET /containers/abc/stats": () =>
				new Response(
					`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
					{
						headers: { "content-type": "application/json" },
					},
				),
		});
		const client = new DockerClient(RUNTIME, {
			fetch: daemon.fetchImpl,
			now: () => 0,
		});
		const seen = [];
		for await (const entry of client.stats("abc")) seen.push(entry);
		expect(seen).toHaveLength(1);
		expect(seen[0].memoryUsage).toBe(50);
		expect(seen[0].timestamp).toBe(new Date(0).toISOString());
	});

	test("the log stream splits lines and tolerates a TTY body", async () => {
		const body = new TextEncoder().encode("one\ntwo\n");
		const daemon = fakeDaemon({
			"GET /containers/abc/logs": (request) => {
				expect(request.params.get("follow")).toBe("1");
				expect(request.params.get("tail")).toBe("100");
				return new Response(body);
			},
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		const lines: string[] = [];
		for await (const line of client.logLines("abc")) lines.push(line);
		expect(lines).toEqual(["one", "two"]);
	});

	test("an event is attributed to its container and invalidates the cache", async () => {
		const event = JSON.stringify({
			Action: "start",
			time: 1_700_000_000,
			Actor: { ID: "running-id", Attributes: { name: "devenv-shop-1" } },
		});
		const daemon = fakeDaemon({
			"GET /events": () => new Response(`${event}\n`),
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		const seen = [];
		for await (const item of client.events()) seen.push(item);
		expect(seen).toEqual([
			{
				containerId: "running-id",
				containerName: "devenv-shop-1",
				action: "start",
				time: new Date(1_700_000_000_000),
			},
		]);
	});

	test("a listener reconnects with backoff and stops during backoff", async () => {
		let attempts = 0;
		const daemon = fakeDaemon({
			"GET /events": () => {
				attempts++;
				return new Response("", { status: 500 });
			},
		});
		const client = new DockerClient(RUNTIME, { fetch: daemon.fetchImpl });
		const controller = new AbortController();
		const sleeps: number[] = [];
		const handle = startEventListener({
			client,
			signal: controller.signal,
			onEvent: () => {},
			sleep: async (ms) => {
				sleeps.push(ms);
				if (sleeps.length >= 3) controller.abort();
			},
		});
		await Bun.sleep(20);
		expect(handle.reconnects()).toBeGreaterThan(0);
		expect(sleeps[0]).toBe(1000);
		expect(sleeps[1]).toBe(2000);
		expect(sleeps[2]).toBe(4000);
		const before = attempts;
		await Bun.sleep(20);
		expect(attempts).toBe(before);
	});
});

describe("health gate (Go health_test.go fixture)", () => {
	const inspect = (state: Record<string, unknown>) =>
		fakeDaemon({
			"GET /containers/api/json": () => json({ State: state }),
		});

	test("healthy and running-without-healthcheck resolve", async () => {
		const healthy = new DockerClient(RUNTIME, {
			fetch: inspect({ Running: true, Health: { Status: "healthy" } })
				.fetchImpl,
		});
		await healthy.waitForHealthy("api", 1000);
		const plain = new DockerClient(RUNTIME, {
			fetch: inspect({ Running: true }).fetchImpl,
		});
		await plain.waitForHealthy("api", 1000);
	});

	test("an unhealthy container fails", async () => {
		const unhealthy = new DockerClient(RUNTIME, {
			fetch: inspect({ Running: true, Health: { Status: "unhealthy" } })
				.fetchImpl,
		});
		await expect(unhealthy.waitForHealthy("api", 1000)).rejects.toThrow(
			'container "api" is unhealthy',
		);
	});

	test("a container that never runs times out with Go's message", async () => {
		let now = 0;
		const daemon = fakeDaemon({
			"GET /containers/api/json": () => {
				// Every inspect costs time, so the bounded wait terminates.
				now += 60;
				return json({ State: { Running: false } });
			},
		});
		const client = new DockerClient(RUNTIME, {
			fetch: daemon.fetchImpl,
			now: () => now,
		});
		await expect(
			client.waitForHealthy("api", 100, undefined, undefined, 1),
		).rejects.toThrow('container "api" readiness timeout after 100ms');
	});
});

describe("prune policy (Go prune_test.go fixture)", () => {
	test("prune args preserve tagged images", () => {
		expect(containerPruneArgs()).toEqual([
			"system",
			"prune",
			"--force",
			"--filter",
			"until=24h",
		]);
		expect(containerPruneArgs()).not.toContain("--all");
	});

	test("a missing runtime is skipped and the other still prunes", async () => {
		const calls: string[] = [];
		await runSystemPrune({
			runCommand: async (command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				if (command === "docker")
					return { error: new Error("not installed"), output: "" };
				return { output: "" };
			},
		});
		expect(calls).toEqual([
			"docker version",
			"podman version",
			"podman system prune --force --filter until=24h",
		]);
	});

	test("the poller runs once after the startup delay and stops on abort", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		const sleeps: number[] = [];
		startPrunePoller({
			signal: controller.signal,
			runCommand: async (command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				return { error: new Error("not installed"), output: "" };
			},
			sleep: async (ms, signal) => {
				sleeps.push(ms);
				if (sleeps.length === 2) controller.abort();
				void signal;
			},
		});
		await Bun.sleep(10);
		expect(sleeps[0]).toBe(5000);
		expect(calls.filter((call) => call.endsWith("version")).length).toBe(2);
		const before = calls.length;
		await Bun.sleep(10);
		expect(calls.length).toBe(before);
	});
});
