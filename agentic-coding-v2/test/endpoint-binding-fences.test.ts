import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Endpoints, credentials, query connections and telemetry admit loopback-only,
// declared, referenced bindings. Draft creation stores content unvalidated;
// schema inspection refuses anything else before approval, reservation or any
// connection. Details stay withheld by design, so this proves the boundary.
const target = (override: Record<string, unknown>) => ({
	id: "run",
	action: "run",
	runtime: "shell",
	command: "serve --port 8080",
	readyText: "ready",
	...override,
});
const refusedTargets: Array<
	[string, Record<string, unknown>, ("app" | "infrastructure")?]
> = [
	[
		"non-loopback endpoint",
		{ endpoints: { api: "http://example.com:8080/v1" } },
	],
	["hostname endpoint", { endpoints: { api: "http://localhost:8080/v1" } }],
	[
		"endpoint with credentials",
		{ endpoints: { api: "http://user@127.0.0.1:8080/v1" } },
	],
	[
		"endpoint with query",
		{ endpoints: { api: "http://127.0.0.1:8080/v1?a=b" } },
	],
	[
		"endpoint with fragment",
		{ endpoints: { api: "http://127.0.0.1:8080/v1#x" } },
	],
	["invalid endpoint name", { endpoints: { API: "http://127.0.0.1:8080/v1" } }],
	[
		"endpoints on a test action",
		{ action: "test", endpoints: { api: "http://127.0.0.1:8080/v1" } },
	],
	[
		"authentication on plain HTTP",
		{
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			secretRefs: { TOKEN: "TOKEN" },
			endpointAuthRefs: { api: { type: "bearer", variable: "TOKEN" } },
		},
	],
	[
		"unknown authentication type",
		{
			endpoints: { api: "https://127.0.0.1:8443/v1" },
			secretRefs: { TOKEN: "TOKEN" },
			endpointAuthRefs: { api: { type: "digest", variable: "TOKEN" } },
		},
	],
	[
		"undeclared authentication variable",
		{
			endpoints: { api: "https://127.0.0.1:8443/v1" },
			secretRefs: { TOKEN: "TOKEN" },
			endpointAuthRefs: { api: { type: "bearer", variable: "MISSING" } },
		},
	],
	[
		"authentication for an undeclared endpoint",
		{
			endpoints: { api: "https://127.0.0.1:8443/v1" },
			secretRefs: { TOKEN: "TOKEN" },
			endpointAuthRefs: { ghost: { type: "bearer", variable: "TOKEN" } },
		},
	],
	[
		"CA reference on plain HTTP",
		{
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointCaRefs: { api: "ca.pem" },
		},
	],
	[
		"absolute CA reference",
		{
			endpoints: { api: "https://127.0.0.1:8443/v1" },
			endpointCaRefs: { api: "/ca.pem" },
		},
	],
	[
		"literal colliding with a secret reference",
		{ environment: { TOKEN: "plain" }, secretRefs: { TOKEN: "TOKEN" } },
	],
	["invalid secret reference value", { secretRefs: { TOKEN: "not-a-var" } }],
	["reserved variable name", { environment: { WORKSPACE: "x" } }],
	[
		"telemetry on a non-loopback listener",
		{ telemetry: { protocol: "otlp-http-json", listen: "0.0.0.0:0" } },
	],
	[
		"telemetry exporter override",
		{
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
			environment: { AC_OTEL_HOST: "x" },
		},
	],
	[
		"non-postgres query connection",
		{
			queryConnection: {
				protocol: "mysql",
				host: "127.0.0.1",
				port: 3306,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
		},
		"infrastructure",
	],
	[
		"non-loopback query host",
		{
			queryConnection: {
				protocol: "postgres",
				host: "example.com",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
		},
		"infrastructure",
	],
	[
		"literal query credentials",
		{
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
		},
		"infrastructure",
	],
	[
		"absolute query CA reference",
		{
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
				caRef: "/ca.pem",
			},
			secretRefs: { U: "U", P: "P" },
		},
		"infrastructure",
	],
];
test.each(refusedTargets)(
	"schema inspection refuses a draft with %s",
	async (label, override, kind = "app") => {
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
									targets: [target(override)],
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
test("schema inspection still admits declared loopback bindings with referenced secrets", async () => {
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
					requestId: "loopback-bindings",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "infrastructure",
								repository: config.repositories[0] ?? "",
								targets: [
									target({
										endpoints: {
											api: "http://127.0.0.1:8080/v1",
											secure: "https://127.0.0.1:8443/v1",
										},
										environment: { MODE: "inline" },
										secretRefs: {
											DB_USER: "DB_USER",
											DB_PASS: "DB_PASS",
											TOKEN: "TOKEN",
										},
										endpointAuthRefs: {
											secure: { type: "bearer", variable: "TOKEN" },
										},
										endpointCaRefs: { secure: "ca.pem" },
										queryConnection: {
											protocol: "postgres",
											host: "127.0.0.1",
											port: 5432,
											database: "db",
											usernameRef: "DB_USER",
											passwordRef: "DB_PASS",
											caRef: "ca.pem",
										},
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
