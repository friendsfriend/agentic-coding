import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
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
// The log follower names its pod as the final argv entry; per-replica lines
// stay distinguished by the pod-name suffix the adapter itself generates.
const replicaClient = podClient.replace(
	'process.env.FIXTURE_LOG_LINES??"[]"',
	'process.env["FIXTURE_LOG_LINES_"+(String(args.at(-1)).endsWith("-1")?"1":"0")]??"[]"',
);
function cluster(config: Config, upstream: number) {
	configureLocalCluster(config, replicaClient, {
		FIXTURE_STATE: path.join(config.configDir, "pods.json"),
		FIXTURE_FORWARD_PORT: String(upstream),
		FIXTURE_LOG_LINES_0: JSON.stringify(["replica-zero-marker"]),
		FIXTURE_LOG_LINES_1: JSON.stringify(["replica-one-marker"]),
	});
}
function target(portZero: number, portOne: number) {
	return {
		id: "pods",
		action: "run",
		runtime: "kubernetes",
		timeoutMs: 8000,
		kubernetes: {
			cluster: "local",
			namespace: "fixtures",
			image: "fixture:latest",
			replicas: 2,
			portForwards: [
				{ local: portZero, remote: 8080, replica: 0 },
				{ local: portOne, remote: 8080, replica: 1 },
			],
		},
		endpoints: {
			zero: `http://127.0.0.1:${portZero}`,
			one: `http://127.0.0.1:${portOne}`,
		},
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
test("pinned replica forwards admit endpoints and select per-pod logs", async () => {
	const received: string[] = [];
	let upstream: ReturnType<typeof Bun.serve> | undefined;
	const { app, config, fake, invocation } = await fixture(false, (config) => {
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
		const value = target(disposablePort(), disposablePort());
		expect(validateProjects(config, document(config, value))).toHaveLength(1);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, value)),
		);
	});
	let logs = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "kubernetes" }),
		async () => {
			await eventually(
				async () => {
					try {
						const ports = JSON.parse(
							fs.readFileSync(path.join(config.configDir, "pods.json"), "utf8"),
						);
						return Object.keys(ports.pods ?? {}).length;
					} catch {
						return 0;
					}
				},
				(count) => count === 2,
			);
			return call("env_http_request", {
				app: "api",
				endpoint: "one",
				path: "/from-one",
			});
		},
		() =>
			call("env_logs", {
				app: "api",
				replica: 0,
				tail: 50,
			}),
		(messages) => {
			logs += JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_logs",
				),
			);
			return call("env_logs", {
				app: "api",
				replica: 1,
				tail: 50,
			});
		},
		(messages) => {
			logs += JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_logs",
				),
			);
			return call("env_logs", { app: "api", tail: 50 });
		},
		(messages) => {
			logs += JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_logs",
				),
			);
			return call("request_review", { path: ".", title: "Hold replicas" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task, "Endpoint GET: api/one");
	await pendingReview(app, task, "Hold replicas");
	expect(received.filter((value) => value === "/from-one")).toHaveLength(1);
	// Each explicit selection carries exactly its own pod's marker; the merged
	// read stays refused instead of inventing a chronology.
	expect(logs).toContain("replica-zero-marker");
	expect(logs).toContain("replica-one-marker");
	expect(logs).toContain("no merge of several pod buffers is invented");
	expect(logs).not.toContain("replica-zero-markerreplica-one-marker");
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const stopped = await app.environments.snapshot();
	expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
	upstream?.stop(true);
}, 30000);
test("forward replica declarations are fenced at admission", async () => {
	const { config } = await fixture(false, () => {});
	const portZero = disposablePort(),
		portOne = disposablePort(),
		base = target(portZero, portOne);
	// Several replicas with an unpinned forward still choose no pod implicitly.
	expect(() =>
		validateProjects(
			config,
			document(config, {
				...base,
				kubernetes: {
					...base.kubernetes,
					portForwards: [{ local: portZero, remote: 8080 }],
				},
			}),
		),
	).toThrow("exactly one replica selection");
	// A single replica names no selection.
	expect(() =>
		validateProjects(
			config,
			document(config, {
				...base,
				kubernetes: {
					...base.kubernetes,
					replicas: 1,
					portForwards: [{ local: portZero, remote: 8080, replica: 0 }],
				},
			}),
		),
	).toThrow("no pod selection for a single replica");
	// A selection outside the replica count is refused.
	expect(() =>
		validateProjects(
			config,
			document(config, {
				...base,
				kubernetes: {
					...base.kubernetes,
					portForwards: [
						{ local: portZero, remote: 8080, replica: 0 },
						{ local: portOne, remote: 8080, replica: 2 },
					],
				},
			}),
		),
	).toThrow("exactly one replica selection");
	// An endpoint still needs exactly one forward on its own port.
	expect(() =>
		validateProjects(
			config,
			document(config, {
				...base,
				endpoints: { zero: `http://127.0.0.1:${portZero + 100}` },
			}),
		),
	).toThrow("exactly one declared loopback port forward");
});
