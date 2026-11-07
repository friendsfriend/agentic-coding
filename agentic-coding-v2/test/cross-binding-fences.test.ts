import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Endpoints, services, published ports and port forwards must agree with each
// other and with the runtime. Draft creation stores content unvalidated;
// schema inspection refuses the inconsistent declaration before approval.
// Details stay withheld by design, so this proves the boundary, not messages.
const compose = (override: Record<string, unknown>) => ({
	id: "run",
	action: "run",
	runtime: "compose",
	compose: {
		file: "compose.yml",
		provider: "docker",
		socket: "/var/run/docker.sock",
	},
	...override,
});
const refusedPlans: Array<
	[string, Record<string, unknown>, "app" | "infrastructure"]
> = [
	[
		"service selectors on a shell target",
		{
			id: "run",
			action: "run",
			runtime: "shell",
			command: "serve",
			readyText: "ready",
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
		},
		"app",
	],
	[
		"query service on a shell target",
		{
			id: "run",
			action: "run",
			runtime: "shell",
			command: "serve",
			readyText: "ready",
			queryService: "db",
		},
		"app",
	],
	[
		"compose endpoint without a service selector",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: {},
		}),
		"app",
	],
	[
		"selector for an undeclared endpoint",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web", ghost: "worker" },
		}),
		"app",
	],
	[
		"invalid selector value",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "Web!" },
		}),
		"app",
	],
	[
		"query service without a query connection",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
			queryService: "db",
		}),
		"app",
	],
	[
		"invalid query service selector",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
			queryService: "Bad!",
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
			secretRefs: { U: "U", P: "P" },
		}),
		"infrastructure",
	],
	[
		"container endpoints without health readiness",
		{
			id: "run",
			action: "run",
			runtime: "docker",
			container: { socket: "/var/run/docker.sock", image: "fixture:latest" },
			endpoints: { api: "http://127.0.0.1:8080/v1" },
		},
		"app",
	],
	[
		"container endpoint on an unpublished port",
		{
			id: "run",
			action: "run",
			runtime: "docker",
			container: {
				socket: "/var/run/docker.sock",
				image: "fixture:latest",
				readiness: "healthy",
				ports: [{ host: 18080, container: 8080 }],
			},
			endpoints: { api: "http://127.0.0.1:9999/v1" },
		},
		"app",
	],
	[
		"pod endpoints without a forward on the endpoint port",
		{
			id: "run",
			action: "run",
			runtime: "kubernetes",
			kubernetes: {
				cluster: "fixture",
				namespace: "work",
				image: "fixture:latest",
				replicas: 1,
				readinessProbe: { tcpSocket: { port: 8080 } },
			},
			endpoints: { api: "http://127.0.0.1:8080/v1" },
		},
		"app",
	],
	[
		"pod query without a forward on the query port",
		{
			id: "run",
			action: "run",
			runtime: "kubernetes",
			kubernetes: {
				cluster: "fixture",
				namespace: "work",
				image: "fixture:latest",
				replicas: 1,
				readinessProbe: { tcpSocket: { port: 5432 } },
				portForwards: [{ local: 18080, remote: 8080 }],
			},
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
			secretRefs: { U: "U", P: "P" },
		},
		"infrastructure",
	],
];
test.each(refusedPlans)(
	"schema inspection refuses %s",
	async (label, target, kind) => {
		void label;
		const { app, config } = await fixture(true, (config) => {
			fs.chmodSync(config.stateDir, 0o700);
			fs.mkdirSync(config.configDir, { mode: 0o700 });
		});
		const host = serve(app);
		try {
			const headers = {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
			const created = await (
				await fetch(new URL("/api/environments/drafts", host.url), {
					method: "POST",
					headers,
					body: JSON.stringify({
						requestId: "stored-unvalidated",
						content: JSON.stringify({
							version: 1,
							projects: [
								{
									id: "api",
									kind,
									repository: config.repositories[0] ?? "",
									targets: [target],
								},
							],
						}),
					}),
				})
			).json();
			const loaded = await (
				await fetch(
					new URL(`/api/environments/drafts?id=${created.id}`, host.url),
					{
						headers,
					},
				)
			).json();
			expect(loaded.schema.valid).toBe(false);
		} finally {
			host.stop();
			await app.close();
		}
	},
);
test("schema inspection admits a consistent compose declaration with query service", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	try {
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		};
		const created = await (
			await fetch(new URL("/api/environments/drafts", host.url), {
				method: "POST",
				headers,
				body: JSON.stringify({
					requestId: "consistent-compose",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "infrastructure",
								repository: config.repositories[0] ?? "",
								targets: [
									compose({
										endpoints: { api: "http://127.0.0.1:8080/v1" },
										endpointServices: { api: "web" },
										queryService: "db",
										queryConnection: {
											protocol: "postgres",
											host: "127.0.0.1",
											port: 5432,
											database: "db",
											usernameRef: "U",
											passwordRef: "P",
										},
										secretRefs: { U: "U", P: "P" },
									}),
								],
							},
						],
					}),
				}),
			})
		).json();
		const loaded = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{
					headers,
				},
			)
		).json();
		expect(loaded.schema.valid).toBe(true);
	} finally {
		host.stop();
		await app.close();
	}
});
test("schema inspection admits a healthy container declaration with a published endpoint", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	try {
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		};
		const created = await (
			await fetch(new URL("/api/environments/drafts", host.url), {
				method: "POST",
				headers,
				body: JSON.stringify({
					requestId: "consistent-container",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: config.repositories[0] ?? "",
								targets: [
									{
										id: "run",
										action: "run",
										runtime: "docker",
										container: {
											socket: "/var/run/docker.sock",
											image: "fixture:latest",
											readiness: "healthy",
											ports: [{ host: 18080, container: 8080 }],
										},
										endpoints: { api: "http://127.0.0.1:18080/v1" },
									},
								],
							},
						],
					}),
				}),
			})
		).json();
		const loaded = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{
					headers,
				},
			)
		).json();
		expect(loaded.schema.valid).toBe(true);
	} finally {
		host.stop();
		await app.close();
	}
});
test("schema inspection admits a pod declaration with a forward on every used port", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	try {
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		};
		const created = await (
			await fetch(new URL("/api/environments/drafts", host.url), {
				method: "POST",
				headers,
				body: JSON.stringify({
					requestId: "consistent-pod",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "infrastructure",
								repository: config.repositories[0] ?? "",
								targets: [
									{
										id: "run",
										action: "run",
										runtime: "kubernetes",
										kubernetes: {
											cluster: "fixture",
											namespace: "work",
											image: "fixture:latest",
											replicas: 1,
											readinessProbe: { tcpSocket: { port: 8080 } },
											portForwards: [
												{ local: 18080, remote: 8080 },
												{ local: 15432, remote: 5432 },
											],
										},
										endpoints: { api: "http://127.0.0.1:18080/v1" },
										queryConnection: {
											protocol: "postgres",
											host: "127.0.0.1",
											port: 15432,
											database: "db",
											usernameRef: "U",
											passwordRef: "P",
										},
										secretRefs: { U: "U", P: "P" },
									},
								],
							},
						],
					}),
				}),
			})
		).json();
		const loaded = await (
			await fetch(
				new URL(`/api/environments/drafts?id=${created.id}`, host.url),
				{
					headers,
				},
			)
		).json();
		expect(loaded.schema.valid).toBe(true);
	} finally {
		host.stop();
		await app.close();
	}
});
