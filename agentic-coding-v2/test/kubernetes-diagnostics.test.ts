// Owned-pod endpoint admission: the declaration must name the one loopback port
// forward the run starts, and every dispatch re-observes the owned pod and that
// forward. The fixture cluster proves the fences, not real cluster networking.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import { configureLocalCluster, podClient } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { disposablePort } from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		for (const server of servers.splice(0)) server.stop(true);
	}
});
function cluster(
	config: Config,
	upstream: number,
	environment: Record<string, string> = {},
) {
	configureLocalCluster(config, podClient, {
		FIXTURE_STATE: path.join(config.configDir, "pods.json"),
		FIXTURE_FORWARD_PORT: String(upstream),
		FIXTURE_LOG_LINES: JSON.stringify(["pod line one"]),
		...environment,
	});
}
function target(port: number) {
	return {
		id: "pods",
		action: "run",
		runtime: "kubernetes",
		timeoutMs: 8000,
		kubernetes: {
			cluster: "local",
			namespace: "fixtures",
			image: "fixture:latest",
			replicas: 1,
			portForwards: [{ local: port, remote: 8080 }],
		},
		endpoints: { api: `http://127.0.0.1:${port}` },
	};
}
const document = (config: Config, value: unknown) => ({
	version: 1,
	projects: [
		{
			id: "api",
			kind: "app",
			repository: config.repositories[0],
			targets: [value],
		},
	],
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("an owned pod endpoint requires its declared loopback forward and re-observes both per request", async () => {
	const received: string[] = [];
	let upstream: ReturnType<typeof Bun.serve> | undefined,
		forwardPort = 0;
	const { app, fake, invocation } = await fixture(false, (config) => {
		upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => {
				const url = new URL(request.url);
				received.push(url.pathname);
				return Response.json({ ok: true, path: url.pathname });
			},
		});
		if (!upstream.port) throw new Error("Disposable server has no port");
		servers.push(upstream);
		cluster(config, upstream.port);
		const port = disposablePort(),
			value = target(port);
		forwardPort = port;
		expect(validateProjects(config, document(config, value))).toHaveLength(1);
		// A declaration without the exact forward, on another port, or with more
		// than one replica never becomes an endpoint binding.
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					kubernetes: {
						...value.kubernetes,
						portForwards: [{ local: port + 1, remote: 8080 }],
					},
				}),
			),
		).toThrow("exactly one declared loopback port forward");
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					endpoints: { api: "http://127.0.0.1:1" },
				}),
			),
		).toThrow("exactly one declared loopback port forward");
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					kubernetes: { ...value.kubernetes, replicas: 2 },
				}),
			),
		).toThrow("port forwards require exactly one replica");
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, value)),
		);
	});
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "kubernetes" }),
		async () => {
			// The forward is a process, not a promise of connectivity: wait for it.
			await eventually(
				async () => {
					try {
						await fetch(`http://127.0.0.1:${forwardPort}/probe`);
						return true;
					} catch {
						return false;
					}
				},
				(ready) => ready,
			);
			return call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/hello",
			});
		},
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", { path: ".", title: "Hold pod HTTP" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task, "Endpoint GET: api/api");
	await pendingReview(app, task, "Hold pod HTTP");
	expect(received.filter((value) => value === "/hello")).toHaveLength(1);
	const result = JSON.parse(
		(JSON.parse(transcript) as { content: { text: string }[] }[])[0]?.content[0]
			?.text ?? "{}",
	) as { body: string };
	expect(result.body).toContain('"ok":true');
	expect(result.body).toContain("/hello");
	await app.cancel(task);
	const stopped = await app.environments.snapshot();
	expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
	upstream?.stop(true);
}, 30000);

test("a pod whose declared forward has exited grants no endpoint authority", async () => {
	let received = 0;
	const { app, fake, invocation } = await fixture(false, (config) => {
		const upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				received++;
				return Response.json({ ok: true });
			},
		});
		if (!upstream.port) throw new Error("Disposable server has no port");
		servers.push(upstream);
		cluster(config, upstream.port, { FIXTURE_FORWARD_EXIT_MS: "400" });
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, target(disposablePort()))),
		);
	});
	let refused = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "kubernetes" }),
		async () => {
			await Bun.sleep(900);
			return call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/hello",
			});
		},
		(messages) => {
			refused = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", { path: ".", title: "Hold pod forward" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold pod forward");
	expect(received).toBe(0);
	expect(refused).toContain(
		"ready owned pod with its declared loopback port forward",
	);
	await app.cancel(task);
}, 30000);
