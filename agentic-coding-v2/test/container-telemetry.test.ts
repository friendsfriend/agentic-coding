import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Config, object } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import {
	readEngineFile,
	serveContainerFixture,
} from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";
import { certificate } from "./fixtures/tls.ts";

const { fixture, cleanup } = createFixtures(),
	engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
const secret = "prefix-longer-disposable-service-secret",
	traceId = "12345678901234567890123456789012";
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function definition(config: Config) {
	fs.mkdirSync(config.configDir);
	fs.chmodSync(config.stateDir, 0o700);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "docker"),
		`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		`ROOT_SECRET=prefix\nSERVICE_SECRET=${secret}\n`,
		{ mode: 0o600 },
	);
	const state = path.join(config.configDir, "engine.json");
	fs.writeFileSync(
		state,
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const engine = serveContainerFixture(state);
	engines.push(engine);
	return {
		version: 1,
		projects: [
			{
				id: "api",
				kind: "app",
				repository: config.repositories[0],
				targets: [
					{
						id: "serve",
						action: "run",
						runtime: "compose",
						timeoutMs: 12000,
						environment: {
							PATH: `${bin}:${process.env.PATH ?? ""}`,
							FIXTURE_ENGINE_SOCKET: engine.socket,
							FIXTURE_TELEMETRY_RECEIPT: path.join(
								config.configDir,
								"telemetry.json",
							),
						},
						secretRefs: { ROOT_TOKEN: "ROOT_SECRET" },
						telemetry: {
							protocol: "otlp-http-json",
							listen: "0.0.0.0:0",
							collectorService: "collector",
							transport: "tls-host-gateway-v1",
						},
						compose: {
							provider: "docker",
							socket: engine.socket,
							file: "compose.captured.yaml",
							source: Bun.YAML.stringify({
								services: {
									backend: {
										image: "fixture:latest",
										depends_on: ["collector"],
										"x-secret-refs": { SERVICE_TOKEN: "SERVICE_SECRET" },
										healthcheck: {
											test: ["CMD", "true"],
											interval: "1s",
											timeout: "1s",
											retries: 1,
										},
									},
									collector: {
										image: "otel/opentelemetry-collector-contrib:0.162.0",
										command: ["--config=env:OTEL_COLLECTOR_CONFIG"],
										extra_hosts: ["host.docker.internal:host-gateway"],
									},
								},
							}),
						},
					},
				],
			},
		],
	};
}
async function start() {
	const runtime = await fixture(false, (config) => {
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(definition(config)),
		);
	});
	runtime.fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { title: "Hold native TLS telemetry", path: "." }),
	]);
	const task = await runtime.app.startTask(runtime.invocation),
		review = await pendingReview(runtime.app, task);
	expect(JSON.parse(review.snapshot).telemetryScope).toContain("0.0.0.0 HTTPS");
	expect(
		readEngineFile(path.join(runtime.config.configDir, "engine.json")).history,
	).toHaveLength(0);
	expect(
		fs
			.readdirSync(runtime.config.stateDir)
			.filter((name) => name.startsWith("environment-telemetry-")),
	).toHaveLength(0);
	await approve(runtime.app, task);
	await pendingReview(runtime.app, task, "Hold native TLS telemetry");
	const receipt = JSON.parse(
		fs.readFileSync(
			path.join(runtime.config.configDir, "telemetry.json"),
			"utf8",
		),
	);
	const exporter = receipt.configuration.exporters.otlp_http,
		caFile = String(
			receipt.mounts.find((mount: string) =>
				mount.includes("/acv2-otel-ca.pem"),
			),
		)
			.split(",")
			.find((part) => part.startsWith("src="))
			?.slice(4);
	if (!caFile) throw new Error("Missing native CA mount");
	const url = `https://127.0.0.1:${new URL(exporter.endpoint).port}`,
		ca = fs.readFileSync(caFile, "utf8");
	return {
		...runtime,
		task,
		receipt,
		exporter,
		caFile,
		ca,
		url,
		state: path.join(runtime.config.configDir, "engine.json"),
	};
}
function traces() {
	const start = BigInt(Date.now()) * 1000000n;
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{
							key: "service.name",
							value: { stringValue: "disposable-bridge" },
						},
						{ key: "ac.owner", value: { stringValue: "forged-owner" } },
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: "1234567890123456",
								name: "GET /bridge",
								kind: 2,
								startTimeUnixNano: String(start),
								endTimeUnixNano: String(start + 1000000n),
								attributes: [{ key: "secret", value: { stringValue: secret } }],
							},
						],
					},
				],
			},
		],
	};
}
test("approved Compose TLS telemetry pins its CA and bearer, redacts sibling/overlapping secrets, refreshes ownership and closes before releasing its run", async () => {
	const { app, config, task, exporter, receipt, url, ca, caFile } =
		await start();
	expect(exporter.encoding).toBe("json");
	expect(exporter.compression).toBe("none");
	expect(exporter.tls).toEqual({ ca_file: "/acv2-otel-ca.pem" });
	expect(exporter.tls.insecure).toBeUndefined();
	expect(fs.readdirSync(path.dirname(caFile))).toEqual(["ca.pem"]);
	const headers = {
			authorization: exporter.headers.Authorization,
			"Content-Type": "application/json",
		},
		body = JSON.stringify(traces());
	expect(
		(
			await fetch(`${url}/v1/traces`, {
				method: "POST",
				tls: { ca },
				headers: { "Content-Type": "application/json" },
				body,
			})
		).status,
	).toBe(401);
	expect(
		(
			await fetch(`${url}/v1/traces`, {
				method: "POST",
				tls: { ca },
				headers: { ...headers, authorization: "Bearer incorrect" },
				body,
			})
		).status,
	).toBe(401);
	certificate(config.configDir, "untrusted");
	await expect(
		fetch(`${url}/v1/traces`, {
			method: "POST",
			tls: {
				ca: fs.readFileSync(
					path.join(config.configDir, "untrusted.pem"),
					"utf8",
				),
			},
			headers,
			body,
		}),
	).rejects.toThrow();
	expect(
		(
			await fetch(`${url}/v1/traces`, {
				method: "POST",
				tls: { ca },
				headers,
				body,
			})
		).status,
	).toBe(200);
	expect(
		(
			await fetch(`${url}/v1/logs`, {
				method: "POST",
				tls: { ca },
				headers,
				body: JSON.stringify({
					resourceLogs: [
						{
							scopeLogs: [
								{
									logRecords: [
										{
											severityText: "WARN",
											body: {
												stringValue: `${secret} ${exporter.headers.Authorization}`,
											},
										},
									],
								},
							],
						},
					],
				}),
			})
		).status,
	).toBe(200);
	const run = (await app.environments.snapshot("api")).runs.find(
		(run) => run.state === "running",
	);
	if (!run) throw new Error("Missing owned run");
	const host = serve(app);
	try {
		const target = new URL("/api/environments/telemetry", host.url);
		target.search = new URLSearchParams({
			app: "api",
			run: run.id,
			traceId,
		}).toString();
		expect((await fetch(target)).status).toBe(401);
		const response = await fetch(target, {
			headers: {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
			},
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.scope).toMatchObject({
			app: "api",
			owner: task,
			run: run.id,
		});
		expect(result.records).toHaveLength(1);
		expect(result.records[0].attributes.secret).toBe("[REDACTED]");
		const logs = await app.environments.queryTelemetry("api", task, {
			mode: "logs",
		});
		expect(JSON.stringify(logs)).not.toContain(secret);
		expect(JSON.stringify(logs)).not.toContain(exporter.headers.Authorization);
		expect(JSON.stringify(logs)).not.toContain(
			"longer-disposable-service-secret",
		);
		await expect(
			app.environments.queryTelemetry("api", 999999, {}),
		).rejects.toThrow();
		const nativeLogs = await eventually(
			async () => JSON.stringify(await app.environments.logs("api", task)),
			(logs) => logs.includes("collector configuration"),
		);
		expect(nativeLogs).not.toContain(exporter.headers.Authorization);
		expect(nativeLogs).toContain("[REDACTED]");
		expect(JSON.stringify(await app.snapshot())).not.toContain(
			exporter.headers.Authorization,
		);
		expect(
			receipt.mounts.filter((mount: string) =>
				mount.includes("/acv2-otel-ca.pem"),
			),
		).toHaveLength(1);
	} finally {
		host.stop();
	}
	await app.cancel(task);
	await eventually(
		async () => (await app.environments.snapshot("api")).runs,
		(runs) => runs.every((run) => run.state === "exited"),
	);
	expect(fs.existsSync(path.dirname(caFile))).toBe(false);
	expect(
		fs
			.readdirSync(config.stateDir)
			.some((name) => name.startsWith("environment-telemetry-")),
	).toBe(false);
	await expect(
		fetch(`${url}/v1/traces`, { method: "POST", tls: { ca }, headers, body }),
	).rejects.toThrow();
	await expect(
		app.environments.queryTelemetry("api", task, {}),
	).rejects.toThrow();
}, 20000);

test("a replaced TLS CA is never mounted, removed or adopted during owner cleanup; original listener admission closes and slot is quarantined", async () => {
	const { app, task, caFile, url, ca, exporter } = await start();
	fs.renameSync(caFile, `${caFile}.original`);
	fs.writeFileSync(caFile, "replacement-public-certificate-marker", {
		mode: 0o444,
	});
	await expect(
		app.environments.queryTelemetry("api", task, {}),
	).rejects.toThrow();
	await app.cancel(task);
	await eventually(
		async () => (await app.environments.snapshot("api")).runs,
		(runs) => runs.some((run) => run.state === "interrupted"),
	);
	expect(fs.readFileSync(caFile, "utf8")).toBe(
		"replacement-public-certificate-marker",
	);
	expect(fs.existsSync(`${caFile}.original`)).toBe(true);
	await expect(
		fetch(`${url}/v1/traces`, {
			method: "POST",
			tls: { ca },
			headers: {
				authorization: exporter.headers.Authorization,
				"Content-Type": "application/json",
			},
			body: "{}",
		}),
	).rejects.toThrow();
	await expect(
		app.environments.queryTelemetry("api", task, {}),
	).rejects.toThrow();
}, 20000);

test("copied-label replacement of the exporter never grants telemetry query or container control authority", async () => {
	const { app, task, state } = await start();
	const current = readEngineFile(state),
		original = Object.values(current.containers).find((container) =>
			container.Aliases?.includes("collector"),
		);
	if (!original) throw new Error("Missing fixture exporter");
	original.Id = "f".repeat(64);
	fs.writeFileSync(state, JSON.stringify(current));
	await expect(
		app.environments.queryTelemetry("api", task, {}),
	).rejects.toThrow();
	await app.cancel(task);
	expect(
		Object.values(readEngineFile(state).containers).find(
			(container) => container.Id === original.Id,
		)?.State.Running,
	).toBe(true);
}, 20000);

for (const mode of [
	"selector",
	"image",
	"command",
	"gateway",
	"published",
	"literal",
	"reference",
	"mount",
	"isolated",
	"rootLiteral",
] as const)
	test(`native staged telemetry refuses ${mode} before any listener or engine effects`, async () => {
		let content = "";
		const { app, config } = await fixture(false, (config) => {
			const doc = definition(config),
				target = doc.projects[0]?.targets[0];
			if (!target) throw new Error("Missing fixture target");
			const source = object(Bun.YAML.parse(target.compose.source));
			const collector = object(object(source.services).collector);
			if (mode === "selector") target.telemetry.collectorService = "unknown";
			if (mode === "image") collector.image = "unreviewed:latest";
			if (mode === "command") collector.command = ["--config=env:other"];
			if (mode === "gateway") delete collector.extra_hosts;
			if (mode === "published") collector.ports = ["127.0.0.1:14318:4318"];
			if (mode === "rootLiteral")
				Object.assign(target.environment, {
					OTEL_COLLECTOR_CONFIG: "private-override-marker",
				});
			if (mode === "literal")
				collector.environment = {
					OTEL_COLLECTOR_CONFIG: "private-override-marker",
				};
			if (mode === "reference")
				collector["x-secret-refs"] = {
					OTEL_COLLECTOR_CONFIG: "SERVICE_SECRET",
				};
			if (mode === "mount") collector.volumes = [".:/acv2-otel-ca.pem:ro"];
			if (mode === "isolated")
				Object.assign(target.compose, { network: "isolated" });
			target.compose.source = Bun.YAML.stringify(source);
			content = JSON.stringify(doc);
		});
		const host = serve(app);
		try {
			const post = (route: string, body: unknown) =>
				fetch(new URL(route, host.url), {
					method: "POST",
					headers: {
						Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
			const draft = await (
				await post("/api/environments/drafts", {
					requestId: "invalid-create",
					content,
				})
			).json();
			const checked = await (
				await post("/api/environments/drafts/preflight", {
					requestId: "invalid-check",
					id: draft.id,
					revision: draft.revision,
					digest: draft.digest,
					validateStagedCandidate: true,
				})
			).json();
			expect(checked.accepted).toBe(false);
			expect(JSON.stringify(checked)).not.toContain("private-override-marker");
			expect(
				readEngineFile(path.join(config.configDir, "engine.json")).history,
			).toHaveLength(0);
			expect(
				fs
					.readdirSync(config.stateDir)
					.some((name) => name.startsWith("environment-telemetry-")),
			).toBe(false);
		} finally {
			host.stop();
		}
	});
