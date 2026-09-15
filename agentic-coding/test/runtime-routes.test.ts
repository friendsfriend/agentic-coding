// Runtime route and dispatch contract
// (`port-environment-runtimes-to-bun`, tasks 2.2-2.6, 3.x, 4.1).
//
// The docker and kubernetes rows keep the legacy envelopes the devenv clients
// parse: query parameters, `{error, message, code}` failures, `text/plain` logs
// and `data: {...}` SSE frames. A container lifecycle call also records a
// commandless run, because the Docker API did the work and no process ran.
import { describe, expect, test } from "bun:test";
import {
	BUN_RUNTIME_OPERATIONS,
	createBunRuntimeDispatch,
	LateRuntimeResultError,
} from "../src/server/runtime/dispatch.ts";
import type {
	DockerRuntime,
	DockerRuntimeSelection,
} from "../src/server/runtime/docker.ts";
import { DockerClient } from "../src/server/runtime/docker.ts";
import {
	KubernetesClusterService,
	type KubernetesExec,
	Runner,
} from "../src/server/runtime/kubernetes.ts";
import {
	handleRuntimeRoute,
	type RuntimeRouteServices,
} from "../src/server/runtime/routes.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

function dockerSelection(
	routes: Record<string, (request: Record<string, string | null>) => Response>,
): DockerRuntimeSelection {
	const client = new DockerClient(RUNTIME, {
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const handler =
				routes[`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`];
			if (!handler) return new Response("no route", { status: 404 });
			const params: Record<string, string | null> = {};
			for (const [key, value] of url.searchParams) params[key] = value;
			return handler(params);
		}) as unknown as typeof fetch,
	});
	return { runtime: RUNTIME, client, fallbacks: [] };
}

function kubernetesService(exec?: KubernetesExec): KubernetesClusterService {
	return new KubernetesClusterService({
		runner: new Runner({
			containerCommand: "docker",
			containerName: "docker",
			lookPath: () => "/bin/tool",
		}),
		exec: exec ?? (async () => ({ stdout: "", stderr: "" })),
	});
}

interface Recorded {
	title: string;
	appIdent: string;
	action: string;
	targetLabel?: string;
	error?: string;
}

function services(overrides: Partial<RuntimeRouteServices> = {}): {
	services: RuntimeRouteServices;
	runs: Recorded[];
	events: { type: string; properties: Record<string, unknown> }[];
} {
	const runs: Recorded[] = [];
	const events: { type: string; properties: Record<string, unknown> }[] = [];
	const base: RuntimeRouteServices = {
		kubernetes: kubernetesService(),
		apps: { getAppByIdent: () => undefined, getApps: () => [] },
		infraServices: [],
		exec: async () => ({ stdout: "", stderr: "" }),
		runner: new Runner({ lookPath: () => "/bin/tool" }),
		recordCommandlessRun: (input) => runs.push(input),
		stream: { publish: (event) => events.push(event) },
		...overrides,
	};
	return { services: base, runs, events };
}

async function call(
	svc: RuntimeRouteServices,
	method: string,
	path: string,
): Promise<Response> {
	const url = new URL(`http://127.0.0.1${path}`);
	const response = await handleRuntimeRoute(
		svc,
		new Request(url, { method }),
		url,
	);
	if (!response) throw new Error(`unhandled ${method} ${path}`);
	return response;
}

describe("docker lifecycle routes", () => {
	test("start records a commandless run, publishes the legacy event and answers", async () => {
		const {
			services: svc,
			runs,
			events,
		} = services({
			docker: dockerSelection({
				"POST /containers/abc/start": () => new Response(null, { status: 204 }),
			}),
		});
		const response = await call(
			svc,
			"POST",
			"/api/docker/start?containerID=abc&appIdent=demo",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			containerID: "abc",
			action: "started",
		});
		expect(events.map((event) => event.type)).toEqual([
			"docker.container.started",
		]);
		expect(events[0].properties).toEqual({
			containerID: "abc",
			appIdent: "demo",
		});
		// No command was fabricated for work the Docker API did.
		expect(runs).toEqual([
			{
				title: "Start container abc",
				appIdent: "demo",
				action: "docker.container.start",
				targetLabel: "abc",
			},
		]);
	});

	test("a missing containerID is a 400 and allocates no run", async () => {
		const { services: svc, runs } = services();
		const response = await call(svc, "POST", "/api/docker/stop");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Bad Request",
			message: "containerID parameter required",
			code: 400,
		});
		expect(runs).toEqual([]);
	});

	test("a failing runtime call is a 500 and the run records the error", async () => {
		const { services: svc, runs } = services({
			docker: dockerSelection({
				"POST /containers/abc/restart": () =>
					new Response("No such container: abc", { status: 404 }),
			}),
		});
		const response = await call(
			svc,
			"POST",
			"/api/docker/restart?containerID=abc",
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Internal Server Error",
			message:
				"Failed to restart container: failed to restart container abc: No such container: abc",
			code: 500,
		});
		expect(runs[0].action).toBe("docker.container.restart");
		expect(runs[0].error).toContain("No such container: abc");
	});

	test("an unavailable runtime never reports success", async () => {
		const { services: svc, runs } = services();
		const response = await call(
			svc,
			"POST",
			"/api/docker/start?containerID=abc",
		);
		expect(response.status).toBe(500);
		expect(runs[0].error).toBe("no container runtime available");
	});
});

describe("docker stream routes", () => {
	test("logs answer text/plain and a missing parameter is a 400", async () => {
		const { services: svc } = services({
			docker: dockerSelection({
				"GET /containers/abc/logs": (request) => {
					expect(request.tail).toBe("1000");
					return new Response("line one\nline two\n");
				},
			}),
		});
		const ok = await call(svc, "GET", "/api/docker/logs?containerID=abc");
		expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await ok.text()).toBe("line one\nline two\n");
		const bad = await call(svc, "GET", "/api/docker/logs");
		expect(bad.status).toBe(400);
	});

	test("the log stream emits one JSON frame per line", async () => {
		const { services: svc } = services({
			docker: dockerSelection({
				"GET /containers/abc/logs": () => new Response("one\ntwo\n"),
			}),
		});
		const response = await call(
			svc,
			"GET",
			"/api/docker/logs/stream?containerID=abc&tail=50",
		);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe(
			`data: ${JSON.stringify({ line: "one" })}\n\ndata: ${JSON.stringify({ line: "two" })}\n\n`,
		);
	});

	test("the stats stream emits the Go wire shape and an error frame on failure", async () => {
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
		const { services: svc } = services({
			docker: dockerSelection({
				"GET /containers/abc/stats": () =>
					new Response(
						`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
					),
			}),
		});
		const response = await call(
			svc,
			"GET",
			"/api/docker/stats/stream?containerID=abc",
		);
		const body = await response.text();
		const payload = JSON.parse(body.slice("data: ".length));
		// cpuDelta 500 over systemDelta 1000 is 50%.
		expect(payload.cpuPercent).toBeCloseTo(50, 1);
		expect(payload.memoryUsage).toBe(50);
		expect(payload.memoryLimit).toBe(100);
		expect(payload.memoryPercent).toBe(50);
		expect(typeof payload.timestamp).toBe("string");

		const failing = services({
			docker: dockerSelection({
				"GET /containers/abc/stats": () =>
					new Response("boom", { status: 500 }),
			}),
		});
		const errorResponse = await call(
			failing.services,
			"GET",
			"/api/docker/stats/stream?containerID=abc",
		);
		expect(await errorResponse.text()).toContain('"error"');
	});
});

describe("kubernetes routes", () => {
	test("cluster status and refresh answer the collected status", async () => {
		const exec: KubernetesExec = async (command) => {
			if (command.args[0] === "get") return { stdout: "devenv\n", stderr: "" };
			if (command.args.includes("version"))
				return {
					stdout: '{"serverVersion":{"gitVersion":"v1.29.0"}}',
					stderr: "",
				};
			if (command.args.includes("nodes"))
				return {
					stdout:
						'{"items":[{"metadata":{"name":"devenv-control-plane"},"status":{"nodeInfo":{"kubeletVersion":"v1.29.0"},"conditions":[{"type":"Ready","status":"True"}]}}]}',
					stderr: "",
				};
			if (command.args.includes("pods"))
				return { stdout: '{"items":[]}', stderr: "" };
			if (command.name === "helm") return { stdout: "[]", stderr: "" };
			// Node container enumeration and stats keep the cluster `running`
			// instead of degrading it on an unobservable node stat.
			if (command.args[0] === "ps")
				return { stdout: "devenv-control-plane\n", stderr: "" };
			if (command.args[0] === "stats")
				return {
					stdout:
						'{"CPUPerc":"12.5%","MemUsage":"128MiB / 1GiB","MemPerc":"12.5%"}',
					stderr: "",
				};
			return { stdout: "", stderr: "" };
		};
		const { services: svc } = services({
			kubernetes: kubernetesService(exec),
			exec,
		});
		const response = await call(svc, "GET", "/api/kubernetes/cluster");
		const status = await response.json();
		expect(response.status).toBe(200);
		expect(status.state).toBe("running");
		expect(status.kubernetesVersion).toBe("v1.29.0");
		expect(status.nodes[0]).toEqual({
			name: "devenv-control-plane",
			ready: true,
			kubeletVersion: "v1.29.0",
		});
		const refreshed = await call(
			svc,
			"POST",
			"/api/kubernetes/cluster/refresh",
		);
		expect((await refreshed.json()).state).toBe("running");
	});

	test("logs are prefixed with their pod and an unknown target is a 404", async () => {
		const exec: KubernetesExec = async (command) => {
			if (command.args.some((arg) => arg.startsWith("jsonpath")))
				return { stdout: "api-1\napi-2\n", stderr: "" };
			return { stdout: "hello\nworld\n", stderr: "" };
		};
		const { services: svc } = services({
			kubernetes: kubernetesService(exec),
			exec,
			infraServices: [
				{
					ident: "cache",
					type: "kubernetes",
					kubernetes: { release: "cache", namespace: "infra" },
				},
			],
		});
		const response = await call(
			svc,
			"GET",
			"/api/kubernetes/logs?appIdent=cache",
		);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(await response.text()).toBe(
			"[api-1] hello\n[api-1] world\n[api-2] hello\n[api-2] world\n",
		);
		const missing = await call(
			svc,
			"GET",
			"/api/kubernetes/logs?appIdent=nope",
		);
		expect(missing.status).toBe(404);
		const noParam = await call(svc, "GET", "/api/kubernetes/logs");
		expect(noParam.status).toBe(400);
	});

	test("a cluster with no pods says so instead of failing", async () => {
		const exec: KubernetesExec = async () => ({ stdout: "", stderr: "" });
		const { services: svc } = services({
			kubernetes: kubernetesService(exec),
			exec,
			apps: {
				getAppByIdent: (ident) =>
					ident === "shop"
						? { ident, localDirectoryPath: "/tmp/shop" }
						: undefined,
				getApps: () => [],
			},
			resolveKubernetesTarget: () => ({
				chartPath: "/tmp/shop/chart",
				release: "shop",
				namespace: "apps",
			}),
		});
		const response = await call(
			svc,
			"GET",
			"/api/kubernetes/logs?appIdent=shop",
		);
		expect(await response.text()).toBe(
			"No pods found for release shop in namespace apps",
		);
	});

	test("no kubernetes run target is an error, not empty logs", async () => {
		const { services: svc } = services({
			apps: {
				getAppByIdent: (ident) => ({ ident, localDirectoryPath: "/tmp/shop" }),
				getApps: () => [],
			},
		});
		const response = await call(
			svc,
			"GET",
			"/api/kubernetes/logs?appIdent=shop",
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			message: "no Kubernetes run target found for shop",
		});
	});
});

describe("Bun runtime dispatch", () => {
	test("the operation set is the closed SDK-only set", () => {
		expect([...BUN_RUNTIME_OPERATIONS]).toEqual([
			"docker.container.start",
			"docker.container.stop",
			"docker.container.restart",
			"kubernetes.cluster.refresh",
		]);
	});

	test("an unknown operation fails loudly", async () => {
		const dispatch = createBunRuntimeDispatch({});
		const result = await dispatch.execute({
			operation: "docker.container.remove",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unsupported runtime operation");
	});

	test("an attached runtime performs the container operation", async () => {
		const calls: string[] = [];
		const selection = dockerSelection({
			"POST /containers/abc/start": () => {
				calls.push("start");
				return new Response(null, { status: 204 });
			},
		});
		const dispatch = createBunRuntimeDispatch({ docker: selection });
		const result = await dispatch.execute({
			operation: "docker.container.start",
			containerId: "abc",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["start"]);
	});

	test("a detached runtime fails instead of reporting success", async () => {
		const dispatch = createBunRuntimeDispatch({});
		const result = await dispatch.execute({
			operation: "docker.container.start",
			containerId: "abc",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(result).toEqual({
			ok: false,
			output: "",
			error: "no container runtime available",
		});
	});

	test("a cancel before the call short-circuits, and a late result is rejected", async () => {
		const controller = new AbortController();
		controller.abort();
		const selection = dockerSelection({});
		const dispatch = createBunRuntimeDispatch({ docker: selection });
		expect(
			await dispatch.execute({
				operation: "docker.container.start",
				containerId: "abc",
				owner: { runId: "r", stepId: "s", commandId: "c" },
				signal: controller.signal,
			}),
		).toEqual({ ok: false, output: "", error: "operation canceled" });

		const lateController = new AbortController();
		const lateSelection = dockerSelection({
			"POST /containers/abc/start": () => {
				lateController.abort();
				return new Response(null, { status: 204 });
			},
		});
		const lateDispatch = createBunRuntimeDispatch({ docker: lateSelection });
		await expect(
			lateDispatch.execute({
				operation: "docker.container.start",
				containerId: "abc",
				owner: { runId: "r", stepId: "s", commandId: "c" },
				signal: lateController.signal,
			}),
		).rejects.toBeInstanceOf(LateRuntimeResultError);
	});

	test("cluster refresh returns the observed state, never a fabricated success", async () => {
		const exec: KubernetesExec = async (command) =>
			command.args[0] === "get"
				? { stdout: "", stderr: "" }
				: { stdout: "", stderr: "" };
		const dispatch = createBunRuntimeDispatch({
			kubernetes: kubernetesService(exec),
		});
		const result = await dispatch.execute({
			operation: "kubernetes.cluster.refresh",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.output).toBe("cluster missing");
	});
});
