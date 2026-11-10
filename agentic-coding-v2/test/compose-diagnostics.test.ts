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

test("Compose parity options reach only approved service creations with scoped, redacted secrets", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		writeDefinition(config, engineTarget(config));
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"PARITY_WEB_TOKEN=disposable-web-token\n",
			{ mode: 0o600 },
		);
	});
	await compose(invocation.repository, {
		web: {
			...service(),
			"x-secret-refs": { SERVICE_TOKEN: "PARITY_WEB_TOKEN" },
			shm_size: "512m",
			extra_hosts: ["host.docker.internal:host-gateway"],
			healthcheck: {
				test: ["CMD", "probe", "$(must-not-execute)", "it's literal"],
			},
		},
		sidecar: service(),
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", {
			path: ".",
			title: "Hold service-scoped parity fixture",
		}),
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).toContain("PARITY_WEB_TOKEN");
	expect(review.snapshot).not.toContain("disposable-web-token");
	await approve(app, task);
	await pendingReview(app, task, "Hold service-scoped parity fixture");
	const state = readEngineFile(path.join(config.configDir, "engine.json"));
	const creates = state.history.filter(
		(args) => args.includes("create") && args.includes("--network-alias"),
	);
	const web = creates.find((args) => args.includes("web"));
	const sidecar = creates.find((args) => args.includes("sidecar"));
	expect(web).toBeDefined();
	expect(sidecar).toBeDefined();
	expect(web).toContain("SERVICE_TOKEN");
	expect(sidecar).not.toContain("SERVICE_TOKEN");
	expect(web).toContain("--shm-size");
	expect(web).toContain("536870912");
	expect(web).toContain("host.docker.internal=host-gateway");
	expect(web).toContain(
		"exec 'probe' '$(must-not-execute)' 'it'\\''s literal'",
	);
	const runs = await app.environments.snapshot();
	expect(JSON.stringify(runs)).not.toContain("disposable-web-token");
	// Cleanup must use frozen references even after the credential file is gone.
	fs.unlinkSync(path.join(config.configDir, ".env"));
	await app.cancel(task);
	const stopped = readEngineFile(path.join(config.configDir, "engine.json"));
	expect(Object.keys(stopped.containers)).toHaveLength(0);
	expect(Object.keys(stopped.networks ?? {})).toHaveLength(0);
}, 30000);

test("missing service references refuse the whole stack before network creation", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		writeDefinition(config, engineTarget(config));
	});
	await compose(invocation.repository, {
		first: service(),
		last: {
			...service(),
			"x-secret-refs": { SERVICE_TOKEN: "MISSING_DISPOSABLE_PARITY_TOKEN" },
		},
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", {
			path: ".",
			title: "Missing service reference refused",
		}),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Missing service reference refused");
	const state = readEngineFile(path.join(config.configDir, "engine.json"));
	expect(state.history).toHaveLength(0);
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(Object.keys(state.networks ?? {})).toHaveLength(0);
	await app.cancel(task);
}, 30000);

test("owned restart policy survives a restart observation and cancellation stops the same creation", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config, engineTarget(config)),
	);
	await compose(invocation.repository, {
		web: { ...service(), restart: "always" },
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold restart fixture" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold restart fixture");
	const file = path.join(config.configDir, "engine.json");
	const state = readEngineFile(file);
	const original = Object.values(state.containers)[0];
	if (!original) throw new Error("Missing owned container");
	expect(state.history.find((args) => args[2] === "create")).toContain(
		"--restart",
	);
	expect(state.history.find((args) => args[2] === "create")).toContain(
		"always",
	);
	original.State.Restarting = true;
	original.State.Running = false;
	fs.writeFileSync(file, JSON.stringify(state));
	const before = state.history.length;
	await eventually(
		async () =>
			readEngineFile(file)
				.history.slice(before)
				.some((args) => args[2] === "inspect"),
		(seen) => seen,
	);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("running");
	expect(readEngineFile(file).history.some((args) => args[2] === "rm")).toBe(
		false,
	);
	await app.cancel(task);
	const stopped = readEngineFile(file);
	expect(Object.keys(stopped.containers)).toHaveLength(0);
	expect(stopped.history.find((args) => args[2] === "stop")?.at(-1)).toBe(
		original.Id,
	);
}, 30000);

test("persistent native volumes retain exact creation receipts across independently approved runs, ephemeral volumes do not", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config, engineTarget(config)),
	);
	const yaml = Bun.YAML.stringify({
		volumes: { data: {}, scratch: { "x-lifetime": "ephemeral" } },
		services: {
			web: {
				...service(),
				volumes: [
					{ type: "volume", source: "data", target: "/data" },
					{ type: "volume", source: "scratch", target: "/scratch" },
				],
			},
		},
	});
	fs.writeFileSync(path.join(invocation.repository, "compose.yaml"), yaml);
	await git(invocation.repository, ["add", "compose.yaml"]);
	await git(invocation.repository, [
		"commit",
		"-m",
		"Disposable volume fixture",
	]);
	const file = path.join(config.configDir, "engine.json");
	let retained: string | undefined;
	for (const generation of [1, 2]) {
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("request_review", {
				path: ".",
				title: `Hold volume generation ${generation}`,
			}),
		]);
		const task = await app.startTask({
			...invocation,
			requestId: `volume-generation-${generation}`,
		});
		const review = await pendingReview(app, task);
		expect(review.snapshot).toContain('"lifetime": "persistent"');
		if (retained) expect(review.snapshot).toContain(retained);
		await approve(app, task);
		await pendingReview(app, task, `Hold volume generation ${generation}`);
		const running = readEngineFile(file);
		const names = Object.keys(running.volumes ?? {});
		expect(names).toHaveLength(2);
		if (retained) expect(names).toContain(retained);
		expect(Object.values(running.containers)[0]?.VolumeNames?.sort()).toEqual(
			names.sort(),
		);
		await app.cancel(task);
		const stopped = readEngineFile(file);
		expect(Object.keys(stopped.containers)).toHaveLength(0);
		expect(Object.keys(stopped.volumes ?? {})).toHaveLength(1);
		retained = Object.keys(stopped.volumes ?? {})[0];
	}
	const stopped = readEngineFile(file);
	expect(
		stopped.history.filter(
			(args) => args[2] === "volume" && args[3] === "create",
		),
	).toHaveLength(3);
	expect(
		stopped.history.filter((args) => args[2] === "volume" && args[3] === "rm"),
	).toHaveLength(2);
}, 30000);

test("lost volume creation receipts retain data and quarantine locks without creating containers", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		writeDefinition(config, engineTarget(config));
		const file = path.join(config.configDir, "engine.json"),
			state = readEngineFile(file);
		state.invalidVolumeReceipt = true;
		fs.writeFileSync(file, JSON.stringify(state));
	});
	fs.writeFileSync(
		path.join(invocation.repository, "compose.yaml"),
		Bun.YAML.stringify({
			volumes: { data: {} },
			services: {
				web: {
					...service(),
					volumes: [{ type: "volume", source: "data", target: "/data" }],
				},
			},
		}),
	);
	await git(invocation.repository, ["add", "compose.yaml"]);
	await git(invocation.repository, [
		"commit",
		"-m",
		"Uncertain volume fixture",
	]);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Volume receipt refused" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Volume receipt refused");
	const state = readEngineFile(path.join(config.configDir, "engine.json"));
	expect(Object.keys(state.volumes ?? {})).toHaveLength(1);
	expect(Object.keys(state.containers)).toHaveLength(0);
	expect(
		state.history.some((args) => args[2] === "volume" && args[3] === "rm"),
	).toBe(false);
	expect(
		fs
			.readdirSync(path.join(config.stateDir, "environment-volumes"))
			.some((file) => file.endsWith(".lock")),
	).toBe(true);
	await app.cancel(task);
}, 30000);

test("copied-label replacement volumes are not reused or removed under a fresh approval", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		writeDefinition(config, engineTarget(config)),
	);
	fs.writeFileSync(
		path.join(invocation.repository, "compose.yaml"),
		Bun.YAML.stringify({
			volumes: { data: {} },
			services: {
				web: {
					...service(),
					volumes: [{ type: "volume", source: "data", target: "/data" }],
				},
			},
		}),
	);
	await git(invocation.repository, ["add", "compose.yaml"]);
	await git(invocation.repository, [
		"commit",
		"-m",
		"Volume replacement fixture",
	]);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold original volume" }),
	]);
	const first = await app.startTask({
		...invocation,
		requestId: "volume-original",
	});
	await approve(app, first);
	await pendingReview(app, first, "Hold original volume");
	await app.cancel(first);
	const file = path.join(config.configDir, "engine.json"),
		state = readEngineFile(file);
	const original = Object.values(state.volumes ?? {})[0];
	if (!original) throw new Error("Missing persistent volume");
	original.CreatedAt = "2000-01-01T00:00:00.000Z";
	fs.writeFileSync(file, JSON.stringify(state));
	const before = state.history.length;
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Replacement refused" }),
	]);
	const second = await app.startTask({
		...invocation,
		requestId: "volume-replacement",
	});
	await approve(app, second);
	await pendingReview(app, second, "Replacement refused");
	const after = readEngineFile(file);
	expect(Object.keys(after.volumes ?? {})).toHaveLength(1);
	expect(Object.keys(after.containers)).toHaveLength(0);
	expect(
		after.history
			.slice(before)
			.some(
				(args) =>
					["create", "rm", "start", "stop"].includes(args[2] ?? "") ||
					(args[2] === "volume" && ["create", "rm"].includes(args[3] ?? "")),
			),
	).toBe(false);
	await app.cancel(second);
}, 30000);

test("config-captured Compose runs native shorthand without creating or reading a repository Compose file", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		const target = engineTarget(config);
		target.compose = {
			...target.compose,
			...{
				source: Bun.YAML.stringify({
					name: "fixture-project",
					networks: { local: { driver: "bridge" } },
					volumes: { data: { "x-lifetime": "ephemeral" } },
					services: {
						web: {
							image: "fixture:latest",
							container_name: "fixture-captured-web",
							networks: ["local"],
							command:
								"serve --name 'quoted value' --literal '$(not-executed)'",
							environment: ["PUBLIC-SETTING=value=with=equals"],
							volumes: ["data:/data:rw"],
							ports: ["43210:8080/tcp"],
						},
					},
				}),
			},
		};
		writeDefinition(config, target);
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold captured source" }),
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).toContain("fixture-captured-web");
	await approve(app, task);
	await pendingReview(app, task, "Hold captured source");
	const state = readEngineFile(path.join(config.configDir, "engine.json"));
	const creation = state.history.find((args) => args[2] === "create");
	expect(creation).toContain("PUBLIC-SETTING");
	expect(creation).toContain("127.0.0.1:43210:8080/tcp");
	expect(creation?.slice(-5)).toEqual([
		"serve",
		"--name",
		"quoted value",
		"--literal",
		"$(not-executed)",
	]);
	expect(fs.existsSync(path.join(invocation.repository, "compose.yaml"))).toBe(
		false,
	);
	await app.cancel(task);
	expect(
		Object.keys(
			readEngineFile(path.join(config.configDir, "engine.json")).volumes ?? {},
		),
	).toHaveLength(0);
}, 30000);

test("captured native builds transport encoded templates and file credentials only through BuildKit secret environments", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		const base = engineTarget(config);
		const secretFile = path.join(config.configDir, "fixture.npmrc");
		fs.writeFileSync(
			secretFile,
			"//fixture.invalid/:_authToken=disposable-build-token\n",
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"FIXTURE_BUILD_USER=fixture-user\nFIXTURE_BUILD_PASSWORD=fixture&password\n",
			{ mode: 0o600 },
		);
		writeDefinition(config, {
			id: "build",
			action: "build",
			runtime: "docker",
			timeoutMs: 10000,
			environment: {
				...base.environment,
				FIXTURE_BUILD_SECRETS_RECEIPT: path.join(
					config.configDir,
					"secret-digests.json",
				),
			},
			secretRefs: {
				BUILD_USER: "FIXTURE_BUILD_USER",
				BUILD_PASSWORD: "FIXTURE_BUILD_PASSWORD",
			},
			container: {
				socket: base.compose.socket,
				image: "fixture:built",
				dockerfileSource:
					"FROM fixture:latest\nRUN --mount=type=secret,id=settings,target=/run/secrets/settings.xml probe\n",
				buildSecrets: {
					settings: {
						template: `<settings><user>\${USERNAME}</user><password>\${PASSWORD}</password></settings>`,
						encoding: "xml",
						refs: { USERNAME: "BUILD_USER", PASSWORD: "BUILD_PASSWORD" },
					},
					npmrc: { file: secretFile },
				},
			},
		});
	});
	fake.setResponses([
		call("env_build", { app: "api" }),
		call("request_review", { path: ".", title: "Build secret receipt" }),
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).toContain("FIXTURE_BUILD_PASSWORD");
	expect(review.snapshot).not.toContain("fixture&password");
	await approve(app, task);
	await pendingReview(app, task, "Build secret receipt");
	const state = readEngineFile(path.join(config.configDir, "engine.json"));
	const build = state.history.find((args) => args[2] === "build");
	expect(build).toContain("id=settings,env=ACV2_BUILD_SECRET_0");
	expect(build).toContain("id=npmrc,env=ACV2_BUILD_SECRET_1");
	const sourceFile = build?.[(build?.indexOf("--file") ?? -2) + 1];
	expect(sourceFile).toBeDefined();
	if (sourceFile) expect(fs.existsSync(sourceFile)).toBe(false);
	expect(fs.existsSync(path.join(invocation.repository, "settings.xml"))).toBe(
		false,
	);
	expect(fs.existsSync(path.join(invocation.repository, ".npmrc"))).toBe(false);
	const hashes = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "secret-digests.json"), "utf8"),
	);
	expect(hashes.ACV2_BUILD_SECRET_0).toBe(
		new Bun.CryptoHasher("sha256")
			.update(
				"<settings><user>fixture-user</user><password>fixture&amp;password</password></settings>",
			)
			.digest("hex"),
	);
	expect(hashes.ACV2_BUILD_SECRET_1).toBe(
		new Bun.CryptoHasher("sha256")
			.update("//fixture.invalid/:_authToken=disposable-build-token\n")
			.digest("hex"),
	);
	const snapshot = JSON.stringify(await app.environments.snapshot());
	expect(snapshot).not.toContain("fixture&password");
	expect(snapshot).not.toContain("fixture&amp;password");
	expect(snapshot).not.toContain("disposable-build-token");
	await app.cancel(task);
}, 15000);
