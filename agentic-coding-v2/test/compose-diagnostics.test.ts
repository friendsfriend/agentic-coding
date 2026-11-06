// Native Compose diagnostics against synthetic ownership observations and
// separately fixture-owned HTTP/PostgreSQL servers, not live engine networking.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { git } from "../src/git.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	disposablePassword,
	disposablePort,
	installPostgres,
} from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";
import { certificate } from "./fixtures/tls.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function engineTarget(config: Config, provider = "docker") {
	fs.mkdirSync(config.configDir, { recursive: true });
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	for (const name of ["docker", "podman"])
		fs.writeFileSync(
			path.join(bin, name),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
	const state = path.join(config.configDir, "engine.json");
	fs.writeFileSync(
		state,
		JSON.stringify({ next: 1, containers: {}, history: [], completionExit: 0 }),
	);
	const engine = serveContainerFixture(state);
	engines.push(engine);
	return {
		id: "serve",
		action: "run",
		runtime: "compose",
		timeoutMs: 10000,
		compose: {
			file: "compose.yaml",
			provider,
			socket: engine.socket,
			network: provider === "docker" ? "shared" : "isolated",
		},
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: engine.socket,
		},
	};
}
function writeDefinition(config: Config, target: unknown) {
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [target],
				},
			],
		}),
	);
}
async function compose(repository: string, services: Record<string, unknown>) {
	fs.writeFileSync(
		path.join(repository, "compose.yaml"),
		Bun.YAML.stringify({ services }),
	);
	await git(repository, ["add", "compose.yaml"]);
	await git(repository, [
		"commit",
		"-m",
		"Disposable Compose diagnostics fixture",
	]);
}
const service = (port?: number) => ({
	image: "fixture:latest",
	command: ["serve"],
	...(port
		? {
				ports: [
					{
						target: 8080,
						published: port,
						host_ip: "127.0.0.1",
						protocol: "tcp",
					},
				],
			}
		: {}),
});

test.each(["docker", "podman"])(
	"%s Compose binds each endpoint to its explicit service with frozen HTTPS credentials",
	async (provider) => {
		const received: string[] = [];
		let web: ReturnType<typeof Bun.serve> | undefined;
		let metrics: ReturnType<typeof Bun.serve> | undefined;
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			const target = engineTarget(config, provider);
			certificate(config.configDir, "local");
			web = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				tls: {
					cert: fs.readFileSync(path.join(config.configDir, "local.pem")),
					key: fs.readFileSync(path.join(config.configDir, "local.key")),
				},
				fetch: (request) => {
					received.push(
						`${request.method}:${request.headers.get("authorization")}`,
					);
					return Response.json({
						from: "web",
						authorization: request.headers.get("authorization"),
					});
				},
			});
			metrics = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () => {
					received.push("metrics");
					return new Response("metrics service");
				},
			});
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"FIXTURE_TOKEN=original-compose-token\n",
				{ mode: 0o600 },
			);
			writeDefinition(config, {
				...target,
				secretRefs: { TOKEN: "FIXTURE_TOKEN" },
				endpoints: {
					api: `https://127.0.0.1:${web.port}`,
					metrics: `http://127.0.0.1:${metrics.port}`,
				},
				endpointServices: { api: "web", metrics: "sidecar" },
				endpointCaRefs: { api: "local.pem" },
				endpointAuthRefs: { api: { type: "bearer", variable: "TOKEN" } },
			});
		});
		if (!web?.port || !metrics?.port)
			throw new Error("Missing disposable HTTP ports");
		await compose(invocation.repository, {
			sidecar: service(metrics.port),
			migrate: service(),
			web: {
				...service(web.port),
				depends_on: {
					migrate: { condition: "service_completed_successfully" },
				},
			},
		});
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("env_http_request", {
				app: "api",
				endpoint: "api",
				method: "POST",
				allowWrite: true,
				authenticate: true,
				body: "approved body",
			}),
			call("env_http_get", { app: "api", endpoint: "metrics" }),
			(messages) => {
				transcript = JSON.stringify(
					messages.messages.filter(
						(message) =>
							message.role === "toolResult" &&
							["env_http_request", "env_http_get"].includes(message.toolName),
					),
				);
				return call("request_review", {
					path: ".",
					title: "Hold Compose HTTP",
				});
			},
		]);
		try {
			const task = await app.startTask(invocation);
			await approve(app, task);
			const review = await pendingReview(app, task, "Endpoint POST: api/api");
			expect(review.snapshot).toContain('"service": "web"');
			expect(review.snapshot).not.toContain("original-compose-token");
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"FIXTURE_TOKEN=rotated-compose-token\n",
				{ mode: 0o600 },
			);
			await approve(app, task, "Endpoint POST: api/api");
			await approve(app, task, "Endpoint GET: api/metrics");
			await pendingReview(app, task, "Hold Compose HTTP");
			expect(received).toEqual([
				"POST:Bearer original-compose-token",
				"metrics",
			]);
			expect(transcript).toContain('\\"service\\":\\"web\\"');
			expect(transcript).toContain('\\"service\\":\\"sidecar\\"');
			expect(transcript).toContain("[REDACTED]");
			expect(transcript).not.toContain("original-compose-token");
			expect(transcript).not.toContain('"isError":true');
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"# startup references removed\n",
				{ mode: 0o600 },
			);
			await app.cancel(task);
			const stopped = await app.environments.snapshot();
			expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
			const state = readEngineFile(path.join(config.configDir, "engine.json"));
			expect(Object.keys(state.containers)).toHaveLength(0);
			expect(Object.keys(state.networks ?? {})).toHaveLength(0);
		} finally {
			web.stop(true);
			metrics.stop(true);
		}
	},
	30000,
);

test("Compose diagnostic selectors and publications refuse unsupported bindings before any engine effects", async () => {
	let invalid: Config | undefined;
	await expect(
		fixture(false, (config) => {
			invalid = config;
			writeDefinition(config, {
				...engineTarget(config),
				endpoints: { api: "http://127.0.0.1:12345" },
			});
		}),
	).rejects.toThrow("explicit service selector");
	if (!invalid) throw new Error("Missing refused fixture configuration");
	expect(
		readEngineFile(path.join(invalid.configDir, "engine.json")).history,
	).toHaveLength(0);
	for (const variant of ["wrong-service", "completion"] as const) {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			writeDefinition(config, {
				...engineTarget(config),
				endpoints: { api: "http://127.0.0.1:12345" },
				endpointServices: {
					api: variant === "wrong-service" ? "other" : "web",
				},
			}),
		);
		await compose(invocation.repository, {
			web: service(12345),
			other: {
				...service(),
				...(variant === "completion"
					? {
							depends_on: {
								web: { condition: "service_completed_successfully" },
							},
						}
					: {}),
			},
		});
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return fauxAssistantMessage("Binding refused");
			},
		]);
		const task = await app.startTask(invocation);
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript).toContain('"isError":true');
		expect(
			readEngineFile(path.join(config.configDir, "engine.json")).history,
		).toHaveLength(0);
	}
}, 20000);

test.each([
	"unhealthy",
	"sibling-replacement",
	"sibling-stopped",
	"network-replacement",
	"unknown",
	"slow",
])(
	"Compose HTTP refuses %s after preparation without issuing or dispatching",
	async (variant) => {
		let requests = 0;
		const api = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				requests++;
				return new Response("must not dispatch");
			},
		});
		if (!api.port) throw new Error("Missing disposable port");
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			writeDefinition(config, {
				...engineTarget(config),
				endpoints: { api: `http://127.0.0.1:${api.port}` },
				endpointServices: { api: "web" },
			}),
		);
		await compose(invocation.repository, {
			sidecar: service(),
			web: service(api.port),
		});
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("env_http_request", { app: "api", endpoint: "api" }),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return call("request_review", {
					path: ".",
					title: "Hold refused Compose HTTP",
				});
			},
		]);
		const file = path.join(config.configDir, "engine.json");
		let original = "";
		try {
			const task = await app.startTask(invocation);
			await approve(app, task);
			await pendingReview(app, task, "Endpoint GET: api/api");
			original = fs.readFileSync(file, "utf8");
			const state = readEngineFile(file),
				containers = Object.values(state.containers);
			const web = containers.find((entry) => entry.Aliases?.includes("web"));
			const sidecar = containers.find((entry) =>
				entry.Aliases?.includes("sidecar"),
			);
			const network = Object.values(state.networks ?? {})[0];
			if (!web || !sidecar || !network)
				throw new Error("Missing disposable stack observations");
			if (variant === "unhealthy") web.State.Health = { Status: "unhealthy" };
			if (variant === "sibling-replacement") sidecar.Id = "a".repeat(64);
			if (variant === "sibling-stopped") sidecar.State.Running = false;
			if (variant === "network-replacement") network.Id = "b".repeat(64);
			if (variant === "unknown") state.offline = true;
			if (variant === "slow") state.inspectDelayMs = 5000;
			fs.writeFileSync(file, JSON.stringify(state));
			await approve(app, task, "Endpoint GET: api/api");
			await pendingReview(app, task, "Hold refused Compose HTTP");
			expect(transcript).toContain('"isError":true');
			expect(requests).toBe(0);
			expect((await app.environments.snapshot()).httpOperations).toHaveLength(
				0,
			);
			// Restore only fixture observations for disposal, never retry/adopt them.
			if (variant !== "sibling-stopped") fs.writeFileSync(file, original);
			else original = "";
			await app.cancel(task);
			original = "";
			expect(Object.keys(readEngineFile(file).containers)).toHaveLength(0);
			expect(Object.keys(readEngineFile(file).networks ?? {})).toHaveLength(0);
		} finally {
			if (original) fs.writeFileSync(file, original);
			api.stop(true);
		}
	},
	20000,
);

test("cancelling an issued Compose HTTP write drains the request before releasing the original stack", async () => {
	let requests = 0;
	let release = (_response: Response) => {};
	const pending = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const api = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => {
			requests++;
			return pending;
		},
	});
	if (!api.port) throw new Error("Missing disposable HTTP port");
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config, {
			...engineTarget(config),
			endpoints: { api: `http://127.0.0.1:${api.port}` },
			endpointServices: { api: "web" },
		}),
	);
	await compose(invocation.repository, {
		sidecar: service(),
		web: service(api.port),
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("env_http_request", {
			app: "api",
			endpoint: "api",
			method: "POST",
			allowWrite: true,
		}),
		fauxAssistantMessage("Cancelled write"),
	]);
	try {
		const task = await app.startTask(invocation);
		await approve(app, task);
		await approve(app, task, "Endpoint POST: api/api");
		await eventually(
			async () => requests,
			(value) => value === 1,
		);
		expect((await app.environments.snapshot()).httpOperations[0]?.state).toBe(
			"issued",
		);
		await app.cancel(task);
		await app.harness.waitForTask(task as TaskId, context);
		const stopped = await app.environments.snapshot();
		expect(stopped.httpOperations[0]?.state).toBe("issued");
		expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
		const state = readEngineFile(path.join(config.configDir, "engine.json"));
		expect(Object.keys(state.containers)).toHaveLength(0);
		expect(Object.keys(state.networks ?? {})).toHaveLength(0);
		expect(requests).toBe(1);
	} finally {
		release(new Response("fixture cleanup"));
		api.stop(true);
	}
}, 20000);

test.each(["rotation", "sibling-replacement", "cancellation"])(
	"Compose PostgreSQL service lifecycle: %s",
	async (variant) => {
		const port = disposablePort();
		let command = "";
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			installPostgres(config, port);
			const file = path.join(config.configDir, "environments.json");
			const definition = JSON.parse(fs.readFileSync(file, "utf8"));
			const selected = definition.projects[1].targets[0];
			command = selected.command;
			definition.projects[1].targets = [
				{
					...engineTarget(config),
					secretRefs: selected.secretRefs,
					queryConnection: selected.queryConnection,
					queryService: "database",
				},
			];
			fs.writeFileSync(file, JSON.stringify(definition));
		});
		await compose(invocation.repository, {
			sidecar: service(),
			database: service(port),
		});
		const server = Bun.spawn(["/bin/sh", "-c", `exec ${command}`], {
			env: {
				...process.env,
				CONFIG_DIR: config.configDir,
				PORT: String(port),
				PGPASSWORD: disposablePassword,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const file = path.join(config.configDir, "engine.json");
		let original = "";
		try {
			const reader = server.stdout.getReader();
			let output = "";
			while (!output.includes("STORE_READY")) {
				const part = await reader.read();
				if (part.done) throw new Error("Disposable PostgreSQL server exited");
				output += new TextDecoder().decode(part.value);
			}
			reader.releaseLock();
			let transcript = "";
			fake.setResponses([
				call("env_start", { apps: ["api"] }),
				call("db_query", {
					infra: "store",
					sql:
						variant === "cancellation"
							? "SELECT pg_sleep(20) /* NATIVE_SQL_PROBE */"
							: "SELECT value FROM fixture_secrets /* NATIVE_SQL_PROBE */",
				}),
				(messages) => {
					transcript = JSON.stringify(messages.messages);
					return call("request_review", {
						path: ".",
						title: "Hold Compose SQL",
					});
				},
			]);
			const task = await app.startTask(invocation);
			await approve(app, task);
			const review = await pendingReview(app, task, "Query store");
			expect(review.snapshot).toContain('"service": "database"');
			expect(review.snapshot).not.toContain(disposablePassword);
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"# startup references removed\n",
				{ mode: 0o600 },
			);
			original = fs.readFileSync(file, "utf8");
			if (variant === "sibling-replacement") {
				const state = readEngineFile(file),
					sidecar = Object.values(state.containers).find((entry) =>
						entry.Aliases?.includes("sidecar"),
					);
				if (!sidecar) throw new Error("Missing disposable sibling");
				sidecar.Id = "c".repeat(64);
				fs.writeFileSync(file, JSON.stringify(state));
			}
			await approve(app, task, "Query store");
			if (variant === "cancellation") {
				await eventually(
					async () => fs.existsSync(path.join(config.configDir, "sql-probes")),
					Boolean,
				);
				expect(
					(await app.environments.snapshot()).queryOperations[0]?.state,
				).toBe("issued");
			} else {
				await pendingReview(app, task, "Hold Compose SQL");
				expect(transcript).not.toContain(disposablePassword);
				if (variant === "rotation") {
					expect(transcript).toContain('\\"service\\":\\"database\\"');
					expect(transcript).toContain("[REDACTED]");
					expect(
						(await app.environments.snapshot()).queryOperations[0]?.state,
					).toBe("completed");
				} else {
					expect(transcript).toContain('"isError":true');
					expect(
						(await app.environments.snapshot()).queryOperations,
					).toHaveLength(0);
					expect(fs.existsSync(path.join(config.configDir, "sql-probes"))).toBe(
						false,
					);
					fs.writeFileSync(file, original);
				}
			}
			await app.cancel(task);
			const stopped = await app.environments.snapshot();
			expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
			expect(Object.keys(readEngineFile(file).containers)).toHaveLength(0);
			expect(Object.keys(readEngineFile(file).networks ?? {})).toHaveLength(0);
			if (variant === "cancellation") {
				expect(stopped.queryOperations[0]?.state).toBe("issued");
				expect(
					fs
						.readFileSync(path.join(config.configDir, "sql-probes"), "utf8")
						.trim(),
				).toBe("query");
			}
			original = "";
		} finally {
			if (original) fs.writeFileSync(file, original);
			await app.close();
			server.kill("SIGKILL");
			await server.exited;
		}
	},
	30000,
);
