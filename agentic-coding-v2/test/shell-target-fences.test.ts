import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Shell targets admit one bounded command string, a relative workspace,
// explicit readiness for queries, and telemetry only on ready shell runs.
// Draft creation stores content unvalidated; schema inspection refuses the rest
// before approval. Details stay withheld by design, so this proves the
// boundary, not the messages.
const refusedTargets: Array<
	[string, Record<string, unknown>, ("app" | "library" | "infrastructure")?]
> = [
	[
		"shell mixed with container configuration",
		{ command: "serve", container: { socket: "/s", image: "i" } },
	],
	[
		"shell run query without readiness text",
		{
			command: "serve",
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
	["empty command", { command: "   ", readyText: "ready" }],
	[
		"oversized command",
		{ command: `run ${"x".repeat(16000)}`, readyText: "ready" },
	],
	[
		"oversized readiness text",
		{ command: "serve", readyText: `r${"e".repeat(512)}` },
	],
	["absolute cwd", { command: "serve", readyText: "ready", cwd: "/tmp" }],
	[
		"telemetry on a container run",
		{
			runtime: "docker",
			container: { socket: "/s", image: "i" },
			command: undefined,
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
		},
	],
	[
		"telemetry without readiness text",
		{
			command: "serve",
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
		},
	],
	[
		"telemetry with a literal exporter variable",
		{
			command: "serve",
			readyText: "ready",
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
			environment: { OTEL_METRICS_EXPORTER: "x" },
		},
	],
	[
		"compose with container overrides",
		{
			runtime: "compose",
			command: undefined,
			container: { socket: "/s", image: "i" },
			compose: { file: "c.yml", provider: "docker", socket: "/s" },
		},
	],
	[
		"run target in a library",
		{ command: "serve", readyText: "ready", action: "run" },
		"library",
	],
	[
		"non-run target in infrastructure",
		{ command: "serve", readyText: "ready", action: "test" },
		"infrastructure",
	],
	["duplicate target IDs", { command: "serve", readyText: "ready" }],
];
test.each(refusedTargets)(
	"schema inspection refuses %s",
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
			const targets: Array<Record<string, unknown>> = [
				{
					id: "run",
					action: "run",
					runtime: "shell",
					...override,
				},
			];
			if (label === "duplicate target IDs")
				targets.push({
					id: "run",
					action: "run",
					runtime: "shell",
					command: "serve",
					readyText: "ready",
				});
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
									targets,
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
test("schema inspection admits a ready shell run with loopback telemetry", async () => {
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
					requestId: "ready-shell",
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
										runtime: "shell",
										command: "serve --port 8080",
										readyText: "listening",
										cwd: "work",
										telemetry: {
											protocol: "otlp-http-json",
											listen: "127.0.0.1:0",
										},
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
