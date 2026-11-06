// Owned-container endpoint admission: a synthetic engine proves the handle,
// health and published-port fences and frozen credentials. It does not prove
// real container networking.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";
import { certificate } from "./fixtures/tls.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((server) => server.stop(true)));
	}
});
function engine(config: Config) {
	fs.mkdirSync(config.configDir, { recursive: true });
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	const source = `#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`;
	for (const name of ["docker", "podman"])
		fs.writeFileSync(path.join(bin, name), source, { mode: 0o700 });
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		"FIXTURE_TOKEN=original-frozen-token\n",
		{ mode: 0o600 },
	);
	const state = path.join(config.configDir, "engine.json");
	fs.writeFileSync(
		state,
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const server = serveContainerFixture(state);
	engines.push(server);
	return { bin, socket: server.socket };
}
function target(
	config: Config,
	port: number,
	options: { auth: boolean; secure: boolean },
) {
	const { bin, socket } = engine(config);
	return {
		id: "serve",
		action: "run",
		runtime: "docker",
		timeoutMs: 5000,
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: socket,
		},
		...(options.auth ? { secretRefs: { TOKEN: "FIXTURE_TOKEN" } } : {}),
		endpoints: {
			api: `${options.secure ? "https" : "http"}://127.0.0.1:${port}`,
		},
		...(options.secure ? { endpointCaRefs: { api: "local.pem" } } : {}),
		...(options.auth
			? { endpointAuthRefs: { api: { type: "bearer", variable: "TOKEN" } } }
			: {}),
		container: {
			socket,
			image: "fixture:latest",
			name: `v2-http-${options.secure ? "tls" : "plain"}`,
			command: ["serve"],
			ports: [{ host: port, container: 8080 }],
			readiness: "healthy",
			health: {
				command: "curl -f http://127.0.0.1:8080/",
				interval: "1s",
				timeout: "1s",
				retries: 1,
				startPeriod: undefined,
			},
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
test.each(["docker", "podman"])(
	"%s endpoints require exact publication and frozen credentials",
	async (runtime) => {
		const received: { url: string; authorization: string | null }[] = [];
		let api: ReturnType<typeof Bun.serve> | undefined;
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir, { recursive: true });
			certificate(config.configDir, "local");
			api = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				tls: {
					cert: fs.readFileSync(path.join(config.configDir, "local.pem")),
					key: fs.readFileSync(path.join(config.configDir, "local.key")),
				},
				fetch: (request) => {
					received.push({
						url: new URL(request.url).pathname,
						authorization: request.headers.get("authorization"),
					});
					return Response.json({
						ok: true,
						authorization: request.headers.get("authorization"),
					});
				},
			});
			const port = api.port;
			if (!port) throw new Error("Disposable server has no port");
			const value = {
				...target(config, port, { auth: true, secure: true }),
				runtime,
			};
			expect(validateProjects(config, document(config, value))).toHaveLength(1);
			expect(() =>
				validateProjects(
					config,
					document(config, {
						...value,
						container: { ...value.container, readiness: "running" },
					}),
				),
			).toThrow("health readiness, not running-only readiness");
			for (const container of [
				{ ...value.container, ports: [] },
				{
					...value.container,
					ports: [{ host: port, container: 8080, protocol: "udp" }],
				},
				{
					...value.container,
					ports: [{ host: port, container: 8080, address: "0.0.0.0" }],
				},
			])
				expect(() =>
					validateProjects(config, document(config, { ...value, container })),
				).toThrow("exact declared TCP loopback");
			expect(() =>
				validateProjects(
					config,
					document(config, {
						...value,
						endpoints: { api: `http://127.0.0.1:${port}` },
						endpointCaRefs: undefined,
					}),
				),
			).toThrow("declared HTTPS endpoint");
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify(document(config, value)),
			);
		});
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"], runtime }),
			call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/hello",
				authenticate: true,
			}),
			(messages) => {
				transcript = JSON.stringify(
					messages.messages.filter(
						(message) =>
							message.role === "toolResult" &&
							message.toolName === "env_http_request",
					),
				);
				return call("request_review", {
					path: ".",
					title: "Hold container HTTP",
				});
			},
		]);
		try {
			const task = await app.startTask(invocation);
			await approve(app, task);
			const review = await pendingReview(app, task, "Endpoint GET: api/api");
			expect(review.snapshot).not.toContain("original-frozen-token");
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"FIXTURE_TOKEN=rotated-token\n",
				{ mode: 0o600 },
			);
			expect(received).toHaveLength(0);
			await approve(app, task, "Endpoint GET: api/api");
			await pendingReview(app, task, "Hold container HTTP");
			expect(received).toEqual([
				{ url: "/hello", authorization: "Bearer original-frozen-token" },
			]);
			expect(transcript).toContain("https-verified");
			const result = JSON.parse(
				(JSON.parse(transcript) as { content: { text: string }[] }[])[0]
					?.content[0]?.text ?? "{}",
			) as { body: string };
			expect(result.body).toContain('"ok":true');
			expect(result.body).toContain("[REDACTED]");
			expect(transcript).not.toContain("original-frozen-token");
			expect(transcript).not.toContain("rotated-token");
			// Provider observations and cleanup use the same startup snapshot too;
			// removing the reference is not permission to reload or leak a new one.
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"# startup references removed\n",
				{ mode: 0o600 },
			);
			await app.cancel(task);
			const stopped = await app.environments.snapshot();
			expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
			expect(
				Object.keys(
					readEngineFile(path.join(config.configDir, "engine.json")).containers,
				),
			).toHaveLength(0);
		} finally {
			api?.stop(true);
		}
	},
	30000,
);
test("a stopped owned container grants no endpoint authority", async () => {
	let received = 0;
	let api: ReturnType<typeof Bun.serve> | undefined;
	const { app, fake, invocation } = await fixture(false, (config) => {
		api = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				received++;
				return Response.json({ ok: true });
			},
		});
		if (!api.port) throw new Error("Disposable server has no port");
		const value = target(config, api.port, { auth: false, secure: false });
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, value)),
		);
	});
	let refused = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "docker" }),
		call("env_http_request", { app: "api", endpoint: "api", path: "/hello" }),
		call("env_stop", { apps: ["api"] }),
		call("env_http_request", { app: "api", endpoint: "api", path: "/second" }),
		(messages) => {
			refused = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", { path: ".", title: "Hold stopped HTTP" });
		},
	]);
	try {
		const task = await app.startTask(invocation);
		await approve(app, task);
		await approve(app, task, "Endpoint GET: api/api");
		await pendingReview(app, task, "Hold stopped HTTP");
		expect(received).toBe(1);
		expect(refused).toContain("Endpoint requires this task's live ready");
		expect(refused).toContain("health-ready owned container");
	} finally {
		api?.stop(true);
	}
}, 30000);

test.each(["unhealthy", "replacement", "unknown", "delayed", "cancelled"])(
	"container endpoint admission rejects %s after approval preparation",
	async (scenario) => {
		let requests = 0;
		const endpoint = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				requests++;
				return new Response("must not be reached");
			},
		});
		try {
			const { app, config, fake, invocation } = await fixture(
				false,
				(config) => {
					if (!endpoint.port)
						throw new Error("Disposable endpoint has no port");
					const value = target(config, endpoint.port, {
						auth: false,
						secure: false,
					});
					fs.writeFileSync(
						path.join(config.configDir, "environments.json"),
						JSON.stringify(document(config, value)),
					);
				},
			);
			let refused = "";
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				call("env_http_request", {
					app: "api",
					endpoint: "api",
					path: "/not-sent",
				}),
				(messages) => {
					refused = JSON.stringify(
						messages.messages.filter(
							(message) =>
								message.role === "toolResult" &&
								message.toolName === "env_http_request",
						),
					);
					return call("request_review", {
						path: ".",
						title: "Hold refused endpoint",
					});
				},
			]);
			const task = await app.startTask(invocation);
			await approve(app, task);
			await pendingReview(app, task, "Endpoint GET: api/api");
			const file = path.join(config.configDir, "engine.json"),
				original = fs.readFileSync(file, "utf8"),
				state = readEngineFile(file);
			try {
				if (scenario === "cancelled") {
					await app.cancel(task);
				} else {
					const container = Object.values(state.containers)[0];
					if (!container) throw new Error("Fixture container was not created");
					if (scenario === "unhealthy")
						container.State.Health = { Status: "unhealthy" };
					if (scenario === "replacement")
						container.Id = "replacement-with-copied-labels";
					if (scenario === "unknown") state.offline = true;
					if (scenario === "delayed") state.inspectDelayMs = 5000;
					fs.writeFileSync(file, JSON.stringify(state));
					await approve(app, task, "Endpoint GET: api/api");
					await pendingReview(app, task, "Hold refused endpoint");
					expect(refused).toContain('"isError":true');
				}
				expect(requests).toBe(0);
				expect((await app.environments.snapshot()).httpOperations).toHaveLength(
					0,
				);
			} finally {
				if (scenario !== "cancelled") fs.writeFileSync(file, original);
			}
		} finally {
			endpoint.stop(true);
		}
	},
	15000,
);

test("cancelling issued container HTTP drains the request before releasing the live container", async () => {
	let requests = 0,
		release = () => {};
	const endpoint = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async () => {
			requests++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return new Response("late response");
		},
	});
	try {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			if (!endpoint.port) throw new Error("Disposable endpoint has no port");
			const value = target(config, endpoint.port, {
				auth: false,
				secure: false,
			});
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify(document(config, value)),
			);
		});
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/write-once",
				method: "POST",
				allowWrite: true,
				body: "disposable mutation",
			}),
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await approve(app, task, "Endpoint POST: api/api");
		await eventually(
			async () => requests,
			(count) => count === 1,
		);
		const issued = await app.environments.snapshot();
		expect(issued.httpOperations[0]?.state).toBe("issued");
		expect(issued.runs.every((run) => run.state === "running")).toBe(true);
		const started = Date.now();
		await app.cancel(task);
		expect(Date.now() - started).toBeLessThan(5000);
		const stopped = await app.environments.snapshot();
		expect(stopped.httpOperations[0]?.state).toBe("issued");
		expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
		expect(
			Object.keys(
				readEngineFile(path.join(config.configDir, "engine.json")).containers,
			),
		).toHaveLength(0);
		expect(requests).toBe(1);
	} finally {
		release();
		endpoint.stop(true);
	}
}, 15000);
