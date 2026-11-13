import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import type {
	LogData,
	MetricData,
	SpanData,
} from "../src/telemetry/contracts.ts";
import { createTraceServiceClient } from "../src/telemetry/receivers/otlp-grpc-proto.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("v1 telemetry receiver and SQLite reads use the authenticated v2 host and survive reopen", async () => {
	const initial = await fixture(true);
	let app = initial.app;
	let host = serve(app);
	const traceId = "12345678901234567890123456789012";
	const spanId = "1234567890123456";
	const payload = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{
							key: "service.name",
							value: { stringValue: "synthetic-service" },
						},
					],
				},
				scopeSpans: [
					{
						scope: { name: "fixture", version: "1" },
						spans: [
							{
								traceId,
								spanId,
								name: "GET /fixture",
								kind: 2,
								startTimeUnixNano: "1790000000000000000",
								endTimeUnixNano: "1790000000100000000",
								status: { code: 2, message: "synthetic failure\nsecond line" },
								events: [
									{
										name: "exception",
										timeUnixNano: "1790000000050000000",
										attributes: [
											{
												key: "exception.stacktrace",
												value: {
													stringValue: "SyntheticFailure\n  at synthetic.ts:1",
												},
											},
										],
									},
								],
								attributes: [],
							},
						],
					},
				],
			},
		],
	};
	const request = (path: string, method = "GET", body?: unknown, auth = true) =>
		fetch(new URL(path, host.url), {
			method,
			headers: {
				...(auth ? { authorization: `Bearer ${host.client.token}` } : {}),
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		expect((await request("/v1/traces", "POST", payload, false)).status).toBe(
			401,
		);
		expect(
			(await request("/api/telemetry/traces", "GET", undefined, false)).status,
		).toBe(401);
		expect((await request("/v1/traces", "POST", payload)).status).toBe(200);
		const page = await (await request("/api/telemetry/traces")).json();
		expect(page.total).toBe(1);
		expect(page.items[0]).toMatchObject({
			changeId: traceId,
			spanCount: 1,
			errorCount: 1,
		});
		const spans = await (
			await request(`/api/telemetry/spans?changeId=${traceId}`)
		).json();
		expect(spans[0]).toMatchObject({
			traceId,
			spanId,
			serviceName: "synthetic-service",
			scope: { name: "fixture", version: "1" },
			status: { code: 2, message: "synthetic failure\nsecond line" },
			events: [
				{
					name: "exception",
					timeUnixNano: "1790000000050000000",
					attributes: [
						{
							key: "exception.stacktrace",
							value: "SyntheticFailure\n  at synthetic.ts:1",
						},
					],
				},
			],
		});
		const original = payload.resourceSpans[0].scopeSpans[0].spans[0];
		const invalid = await request("/v1/traces", "POST", {
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{ ...original, spanId: "a".repeat(16) },
								{
									...original,
									spanId: "b".repeat(16),
									status: {
										code: 2,
										message: { bad: "private-context-marker" },
									},
								},
							],
						},
					],
				},
			],
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain("private-context-marker");
		expect(
			(await (await request("/api/telemetry/traces")).json()).items[0]
				.spanCount,
		).toBe(1);
		expect(
			(
				await request("/v1/traces", "POST", {
					resourceSpans: [
						{ scopeSpans: [{ scope: { name: {} }, spans: [original] }] },
					],
				})
			).status,
		).toBe(400);
		expect((await request("/api/telemetry/traces?perPage=100000")).status).toBe(
			400,
		);
		await host.stop();
		await app.close();
		app = await initial.open();
		host = serve(app);
		expect((await (await request("/api/telemetry/traces")).json()).total).toBe(
			1,
		);
		const tree = await (
			await request(`/api/telemetry/tree?changeId=${traceId}`)
		).json();
		expect(tree[0].children[0].span).toMatchObject({
			scope: { name: "fixture", version: "1" },
			events: [
				{
					name: "exception",
					attributes: [
						{
							key: "exception.stacktrace",
							value: "SyntheticFailure\n  at synthetic.ts:1",
						},
					],
				},
			],
		});
	} finally {
		await host.stop();
	}
});

test("native telemetry reads retain multi-signal data, publish changes and refuse oversized reads without disconnecting", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const post = (signal: string, value: unknown) =>
		fetch(new URL(`/v1/${signal}`, host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(value),
		});
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const revision = client.state?.telemetryRevision ?? 0;
		const resource = {
			attributes: [
				{ key: "service.name", value: { stringValue: "fixture-service" } },
			],
		};
		expect(
			(
				await post("metrics", {
					resourceMetrics: [
						{
							resource,
							scopeMetrics: [
								{
									metrics: [
										{
											name: "fixture.cpu",
											unit: "1",
											gauge: {
												dataPoints: [
													{
														timeUnixNano: "1790000000000000000",
														asDouble: 0.5,
													},
												],
											},
										},
									],
								},
							],
						},
					],
				})
			).status,
		).toBe(200);
		expect(
			(
				await post("logs", {
					resourceLogs: [
						{
							resource,
							scopeLogs: [
								{
									logRecords: [
										{
											timeUnixNano: "1790000000000000000",
											severityText: "ERROR",
											body: { stringValue: "fixture failure" },
										},
									],
								},
							],
						},
					],
				})
			).status,
		).toBe(200);
		await eventually(
			async () => client.state?.telemetryRevision ?? 0,
			(value) => value > revision,
		);
		const metrics = await client.call("telemetry.read", { signal: "metrics" });
		expect(metrics.value).toMatchObject([
			{
				name: "fixture.cpu",
				serviceName: "fixture-service",
				dataPoints: [{ value: 0.5 }],
			},
		]);
		const logs = await client.call("telemetry.read", { signal: "logs" });
		expect(logs.value).toMatchObject([
			{ body: "fixture failure", severity: "ERROR" },
		]);
		const invalid = await post("logs", {
			resourceLogs: [
				{
					resource,
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "private-invalid-timestamp",
									body: { stringValue: "not stored" },
								},
							],
						},
					],
				},
			],
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain("private-invalid-timestamp");
		expect(
			(await client.call("telemetry.read", { signal: "logs" })).value,
		).toMatchObject([{ body: "fixture failure" }]);
		expect(
			(
				await post("metrics", {
					resourceMetrics: [
						{
							resource,
							scopeMetrics: [
								{
									metrics: [
										{
											name: "invalid",
											gauge: {
												dataPoints: [
													{ timeUnixNano: "9223372036854775808", asDouble: 1 },
												],
											},
										},
									],
								},
							],
						},
					],
				})
			).status,
		).toBe(400);
		for (const query of ["?page=1&page=2", "?unrecognized=true", "?changeId="])
			expect(
				(
					await fetch(new URL(`/api/telemetry/traces${query}`, host.url), {
						headers: { authorization: `Bearer ${host.client.token}` },
					})
				).status,
			).toBe(400);
		expect(
			(
				await post("logs", {
					resourceLogs: [
						{
							resource,
							scopeLogs: [
								{
									logRecords: [{ body: { stringValue: "x".repeat(910_000) } }],
								},
							],
						},
					],
				})
			).status,
		).toBe(200);
		await expect(
			client.call("telemetry.read", { signal: "logs" }),
		).rejects.toThrow("client budget");
		expect(await client.call("state.read", {})).toHaveProperty("sessions");
		expect(client.status).toBe("connected");
		await expect(
			client.call("telemetry.manage", {
				operation: "watch",
				repository: "/tmp",
			}),
		).rejects.toThrow("not authorized");
		for (const operation of [
			"watch",
			"watch",
			"unwatch",
			"unwatch",
			"scan",
		] as const)
			expect(
				await client.call("telemetry.manage", {
					operation,
					repository: app.config.repositories[0],
				}),
			).toEqual({ count: 0 });
		await expect(
			client.call("telemetry.manage", { operation: "prune", days: 0 }),
		).rejects.toThrow("Retention");
		expect(
			await client.call("telemetry.manage", { operation: "prune", days: 1 }),
		).toHaveProperty("count");
		expect(
			(await client.call("telemetry.read", { signal: "logs" })).value,
		).toEqual([]);
	} finally {
		client.close();
		await host.stop();
	}
});

test("native gRPC receiver authenticates real protobuf exports, fences controls and joins shutdown", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const operator = new ClientConnection(host.client);
	const clients: Awaited<ReturnType<typeof createTraceServiceClient>>[] = [];
	const exportTo = (
		client: Awaited<ReturnType<typeof createTraceServiceClient>>,
		payload: unknown,
	) =>
		new Promise<void>((resolve, reject) =>
			client.Export(payload, { deadline: Date.now() + 2000 }, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	try {
		operator.connect();
		await eventually(async () => operator.stateFresh, Boolean);
		const stopped = await operator.call("telemetry.receiver.read", {});
		expect(stopped.status).toBe("stopped");
		const running = await operator.call("telemetry.receiver.start", {
			revision: stopped.revision,
			port: 0,
		});
		expect(running.status).toBe("running");
		expect(running.address).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
		if (!running.address || !running.credentialFile)
			throw new Error("Receiver did not publish its references");
		const file = running.credentialFile;
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		// Only a synthetic credential generated inside this isolated fixture is read.
		const token = fs.readFileSync(file, "utf8");
		const anonymous = await createTraceServiceClient(running.address);
		const authenticated = await createTraceServiceClient(
			running.address,
			token,
		);
		clients.push(anonymous, authenticated);
		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "grpc-fixture" } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: Buffer.from(
										"12345678901234567890123456789012",
										"hex",
									),
									spanId: Buffer.from("1234567890123456", "hex"),
									name: "protobuf fixture",
									kind: 2,
									startTimeUnixNano: "1790000000000000000",
									endTimeUnixNano: "1790000000100000000",
									status: { code: 1 },
								},
							],
						},
					],
				},
			],
		};
		await expect(exportTo(anonymous, payload)).rejects.toThrow("credential");
		expect(
			(await operator.call("telemetry.read", { signal: "traces" })).value,
		).toMatchObject({ total: 0 });
		await exportTo(authenticated, payload);
		expect(
			(
				await operator.call("telemetry.read", {
					signal: "spans",
					changeId: "12345678901234567890123456789012",
				})
			).value,
		).toMatchObject([
			{ name: "protobuf fixture", serviceName: "grpc-fixture" },
		]);
		await expect(
			operator.call("telemetry.receiver.stop", { revision: stopped.revision }),
		).rejects.toThrow("revision");
		await expect(
			operator.call("telemetry.receiver.start", {
				revision: running.revision,
				port: 0,
			}),
		).rejects.toThrow("already running");
		const after = await operator.call("telemetry.receiver.stop", {
			revision: running.revision,
		});
		expect(after.status).toBe("stopped");
		expect(fs.existsSync(file)).toBe(false);
		await expect(exportTo(authenticated, payload)).rejects.toThrow();
		const restarted = await operator.call("telemetry.receiver.start", {
			revision: after.revision,
			port: 0,
		});
		if (!restarted.credentialFile)
			throw new Error("Missing fixture credential reference");
		await host.stop();
		await app.close();
		expect(fs.existsSync(restarted.credentialFile)).toBe(false);
	} finally {
		for (const client of clients) client.close();
		operator.close();
		await host.stop();
	}
});

test("bundled gRPC receiver serves the embedded protobuf definition without a source-relative asset", async () => {
	const { app } = await fixture(false);
	const build = await Bun.build({
		entrypoints: [
			path.join(import.meta.dir, "../src/telemetry/receivers/otlp-grpc.ts"),
		],
		target: "bun",
	});
	expect(build.success).toBe(true);
	const output = build.outputs.find((item) => item.path.endsWith(".js"));
	if (!output) throw new Error("Missing bundled receiver");
	const file = path.join(app.config.stateDir, "bundled-grpc.js");
	await Bun.write(file, output);
	const compiled = (await import(
		file
	)) as typeof import("../src/telemetry/receivers/otlp-grpc.ts");
	const stored: SpanData[] = [];
	const receiver = await compiled.startOtlpGrpcReceiver(
		0,
		{
			pushTraces: (spans) => stored.push(...spans),
			pushMetrics: () => {},
			pushLogs: () => {},
		},
		(values) =>
			values.length === 1 && values[0] === "Bearer synthetic-bundle-credential",
	);
	const client = await createTraceServiceClient(
		receiver.address,
		"synthetic-bundle-credential",
	);
	try {
		await new Promise<void>((resolve, reject) =>
			client.Export(
				{
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											traceId: Buffer.from(
												"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
												"hex",
											),
											spanId: Buffer.from("bbbbbbbbbbbbbbbb", "hex"),
											name: "bundled wire export",
											startTimeUnixNano: "1790000000000000000",
											endTimeUnixNano: "1790000000100000000",
										},
									],
								},
							],
						},
					],
				},
				{ deadline: Date.now() + 2000 },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		expect(stored).toMatchObject([
			{
				traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				spanId: "bbbbbbbbbbbbbbbb",
				name: "bundled wire export",
			},
		]);
	} finally {
		client.close();
		await receiver.stop();
	}
});

test("operator-owned loopback StatsD and Prometheus ingest through real sockets, refuse redirects and join shutdown", async () => {
	const { createSocket } = await import("node:dgram");
	const { app } = await fixture(false);
	const host = serve(app),
		operator = new ClientConnection(host.client);
	const udp = createSocket("udp4");
	let requests = 0,
		escaped = 0;
	let mode: "ok" | "redirect" | "large" | "wait" = "ok";
	let release: ((response: Response) => void) | undefined;
	const foreign = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			escaped++;
			return new Response("secret_fixture 99\n");
		},
	});
	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			requests++;
			expect(new URL(request.url).pathname).toBe("/metrics");
			if (mode === "redirect") return Response.redirect(foreign.url);
			if (mode === "large")
				return new Response("too_large_fixture 1\n".repeat(20000));
			if (mode === "wait")
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			return new Response(
				'# HELP fixture_counter synthetic\n# TYPE fixture_counter counter\nfixture_counter{route="synthetic"} 7\n',
			);
		},
	});
	try {
		operator.connect();
		await eventually(async () => operator.stateFresh, Boolean);
		let states = await operator.call("telemetry.collector.read", {});
		expect(states.statsd.status).toBe("stopped");
		await expect(
			operator.call("telemetry.collector.start", {
				kind: "prometheus",
				revision: 0,
				port: 0,
			}),
		).rejects.toThrow("port");
		states = await operator.call("telemetry.collector.start", {
			kind: "statsd",
			revision: states.statsd.revision,
			port: 0,
		});
		let udpPort = Number(new URL(states.statsd.address ?? "").port);
		expect(udpPort).toBeGreaterThan(0);
		await new Promise<void>((resolve, reject) =>
			udp.send(
				"fixture_udp:42|g|#source:synthetic",
				udpPort,
				"127.0.0.1",
				(error) => (error ? reject(error) : resolve()),
			),
		);
		await eventually(
			async () =>
				JSON.stringify(
					(await operator.call("telemetry.read", { signal: "metrics" })).value,
				),
			(value) => value.includes("fixture_udp"),
		);
		await expect(
			operator.call("telemetry.collector.stop", {
				kind: "statsd",
				revision: 0,
			}),
		).rejects.toThrow("revision");
		await expect(
			operator.call("telemetry.collector.start", {
				kind: "statsd",
				revision: states.statsd.revision,
				port: 0,
			}),
		).rejects.toThrow("already running");
		const send = (text: string) =>
			new Promise<void>((resolve, reject) =>
				udp.send(text, udpPort, "127.0.0.1", (error) =>
					error ? reject(error) : resolve(),
				),
			);
		await send(`oversized_fixture:1|g\n${"x".repeat(8192)}`);
		await send("overflow_fixture:1e999|g");
		await send("sync_fixture:1|g");
		await eventually(
			async () =>
				JSON.stringify(
					(await operator.call("telemetry.read", { signal: "metrics" })).value,
				),
			(value) => value.includes("sync_fixture"),
		);
		const metricsAfter = JSON.stringify(
			(await operator.call("telemetry.read", { signal: "metrics" })).value,
		);
		expect(metricsAfter).not.toContain("oversized_fixture");
		expect(metricsAfter).not.toContain("overflow_fixture");
		states = await operator.call("telemetry.collector.stop", {
			kind: "statsd",
			revision: states.statsd.revision,
		});
		const occupiedPort = udp.address().port;
		await expect(
			operator.call("telemetry.collector.start", {
				kind: "statsd",
				revision: states.statsd.revision,
				port: occupiedPort,
			}),
		).rejects.toThrow("could not start");
		expect(udp.address().port).toBe(occupiedPort);
		states = await operator.call("telemetry.collector.read", {});
		expect(states.statsd.status).toBe("stopped");
		states = await operator.call("telemetry.collector.start", {
			kind: "statsd",
			revision: states.statsd.revision,
			port: 0,
		});
		udpPort = Number(new URL(states.statsd.address ?? "").port);
		states = await operator.call("telemetry.collector.start", {
			kind: "prometheus",
			revision: states.prometheus.revision,
			port: target.port ?? 0,
		});
		await eventually(
			async () =>
				JSON.stringify(
					(await operator.call("telemetry.read", { signal: "metrics" })).value,
				),
			(value) => value.includes("fixture_counter"),
		);
		for (const next of ["redirect", "large"] as const) {
			states = await operator.call("telemetry.collector.stop", {
				kind: "prometheus",
				revision: states.prometheus.revision,
			});
			mode = next;
			states = await operator.call("telemetry.collector.start", {
				kind: "prometheus",
				revision: states.prometheus.revision,
				port: target.port ?? 0,
			});
			await eventually(
				async () => operator.call("telemetry.collector.read", {}),
				(state) => state.prometheus.lastError !== null,
			);
			expect(escaped).toBe(0);
			expect(
				JSON.stringify(
					(await operator.call("telemetry.read", { signal: "metrics" })).value,
				),
			).not.toContain(
				next === "large" ? "too_large_fixture" : "secret_fixture",
			);
		}
		states = await operator.call("telemetry.collector.stop", {
			kind: "prometheus",
			revision: states.prometheus.revision,
		});
		mode = "wait";
		const before = requests;
		await operator.call("telemetry.collector.start", {
			kind: "prometheus",
			revision: states.prometheus.revision,
			port: target.port ?? 0,
		});
		await eventually(
			async () => requests,
			(count) => count > before,
		);
		await host.stop();
		await app.close();
		// Shutdown revokes only its own UDP listener; the original endpoint is free.
		const probe = createSocket("udp4");
		try {
			await new Promise<void>((resolve, reject) => {
				probe.once("error", reject);
				probe.bind(udpPort, "127.0.0.1", resolve);
			});
		} finally {
			probe.close();
		}
	} finally {
		release?.(new Response("late_fixture 1\n"));
		udp.close();
		operator.close();
		await host.stop();
		await target.stop(true);
		await foreign.stop(true);
	}
});

test("authorized workspace scans and watchers refuse linked sources but retain ordinary incremental telemetry", async () => {
	const { app } = await fixture(false);
	const outside = await fixture(false);
	const root = app.config.repositories[0],
		foreignRoot = outside.app.config.repositories[0];
	const workflowRoot = path.join(root, ".herdr-workflow");
	const foreignWorkflow = path.join(foreignRoot, ".herdr-workflow", "outside");
	fs.mkdirSync(foreignWorkflow, { recursive: true });
	const event = (name: string) =>
		`${JSON.stringify({ event: name, workflowId: "workspace-fixture", at: "2026-03-01T10:00:00Z", layer: "engine" })}\n`;
	const foreignFile = path.join(foreignWorkflow, "telemetry.jsonl");
	fs.writeFileSync(foreignFile, event("outside_marker"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	const manage = (operation: "scan" | "watch" | "unwatch") =>
		client.call("telemetry.manage", { operation, repository: root });
	const spans = async () =>
		JSON.stringify(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "workspace-fixture",
				})
			).value,
		);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		fs.symlinkSync(path.dirname(foreignWorkflow), workflowRoot, "dir");
		expect(await manage("scan")).toEqual({ count: 0 });
		fs.unlinkSync(workflowRoot);
		fs.mkdirSync(workflowRoot);
		fs.symlinkSync(
			foreignWorkflow,
			path.join(workflowRoot, "linked-directory"),
			"dir",
		);
		expect(await manage("scan")).toEqual({ count: 0 });
		const local = path.join(workflowRoot, "workspace-fixture");
		fs.mkdirSync(local);
		const localFile = path.join(local, "telemetry.jsonl");
		fs.symlinkSync(foreignFile, localFile);
		expect(await manage("scan")).toEqual({ count: 0 });
		fs.unlinkSync(localFile);
		fs.linkSync(foreignFile, localFile);
		expect(await manage("scan")).toEqual({ count: 0 });
		fs.unlinkSync(localFile);
		fs.writeFileSync(
			localFile,
			event("regular_first") +
				'{"event":"invalid_duration","workflowId":"workspace-fixture","at":"2026-03-01T10:00:00Z","durationMs":1e999}\n' +
				JSON.stringify({
					event: "invalid_date",
					workflowId: "workspace-fixture",
					at: "9999-03-01T10:00:00Z",
				}) +
				"\n",
		);
		expect(await manage("scan")).toEqual({ count: 1 });
		expect(await spans()).toContain("regular_first");
		expect(await spans()).not.toContain("invalid_");
		await manage("watch");
		await manage("watch");
		fs.appendFileSync(localFile, event("regular_append"));
		await eventually(spans, (value) => value.includes("regular_append"));
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "workspace-fixture",
				})
			).value,
		).toHaveLength(2);
		fs.unlinkSync(localFile);
		fs.symlinkSync(foreignFile, localFile);
		const barrier = path.join(workflowRoot, "watch-barrier");
		fs.mkdirSync(barrier);
		fs.writeFileSync(
			path.join(barrier, "telemetry.jsonl"),
			event("watch_barrier"),
		);
		await eventually(
			async () =>
				JSON.stringify(
					(
						await client.call("telemetry.read", {
							signal: "spans",
							changeId: "watch-barrier",
						})
					).value,
				),
			(value) => value.includes("watch_barrier"),
		);
		expect(await spans()).not.toContain("outside_marker");
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "linked-directory",
				})
			).value,
		).toEqual([]);
		expect(fs.readFileSync(foreignFile, "utf8")).toBe(event("outside_marker"));
		await manage("unwatch");
	} finally {
		client.close();
		await host.stop();
	}
}, 15000);

test("correlated log trace references resolve wire IDs without guessing workspace IDs or ambiguous matches", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const traceId = "a".repeat(32),
		firstSpan = "b".repeat(16),
		secondSpan = "c".repeat(16);
	const ingest = async (
		changeId: string,
		wireTrace: string,
		spanId: string,
	) => {
		const response = await fetch(new URL("/v1/traces", host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{ key: "herdr.change.id", value: { stringValue: changeId } },
							],
						},
						scopeSpans: [
							{
								spans: [
									{
										traceId: wireTrace,
										spanId,
										name: `operation-${changeId}`,
										startTimeUnixNano: "1790000000000000000",
										endTimeUnixNano: "1790000000100000000",
									},
								],
							},
						],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
	};
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		expect(
			await client.call("telemetry.trace.resolve", { traceId }),
		).toBeNull();
		await ingest("workspace-a", traceId, firstSpan);
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId: traceId.toUpperCase(),
			}),
		).toEqual({ changeId: "workspace-a", traceId, spanId: null });
		await ingest("workspace-b", traceId, secondSpan);
		// A workspace whose name happens to be a wire ID is not a wire match.
		await ingest(traceId, "d".repeat(32), "e".repeat(16));
		await expect(
			client.call("telemetry.trace.resolve", { traceId }),
		).rejects.toThrow("ambiguous");
		const reference = await client.call("telemetry.trace.resolve", {
			traceId,
			spanId: firstSpan.toUpperCase(),
		});
		expect(reference).toEqual({
			changeId: "workspace-a",
			traceId,
			spanId: firstSpan,
		});
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: reference?.changeId,
				})
			).value,
		).toMatchObject([
			{ traceId, spanId: firstSpan, name: "operation-workspace-a" },
		]);
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId,
				spanId: secondSpan,
			}),
		).toEqual({ changeId: "workspace-b", traceId, spanId: secondSpan });
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId,
				spanId: "f".repeat(16),
			}),
		).toBeNull();
		await ingest("workspace-b", traceId, firstSpan);
		await expect(
			client.call("telemetry.trace.resolve", { traceId, spanId: firstSpan }),
		).rejects.toThrow("ambiguous");
		await expect(
			client.call("telemetry.trace.resolve", { traceId: "not-a-wire-id" }),
		).rejects.toThrow("identity");
		expect(await client.call("state.read", {})).toHaveProperty("sessions");
		expect(client.status).toBe("connected");
	} finally {
		client.close();
		await host.stop();
	}
});

test("metric history merges compatible batches chronologically, replaces retransmitted samples and preserves stream identities across reopen", async () => {
	const initial = await fixture(true);
	let app = initial.app,
		host = serve(app),
		client = new ClientConnection(host.client);
	const earlier = "1790000000000000100",
		later = "1790000000000000200";
	const post = async (
		time: string,
		value: number,
		options: {
			unit?: string;
			instance?: string;
			service?: string;
			version?: string;
			type?: "gauge" | "sum";
			reverse?: boolean;
			route?: string;
			description?: string;
		} = {},
	) => {
		const resource = [
			{
				key: "service.name",
				value: { stringValue: options.service ?? "history-service" },
			},
			{ key: "instance", value: { stringValue: options.instance ?? "one" } },
		];
		const attributes = [
			{ key: "route", value: { stringValue: options.route ?? "first" } },
			{ key: "zone", value: { stringValue: "synthetic" } },
		];
		if (options.reverse) {
			resource.reverse();
			attributes.reverse();
		}
		const response = await fetch(new URL("/v1/metrics", host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				resourceMetrics: [
					{
						resource: { attributes: resource },
						scopeMetrics: [
							{
								scope: {
									name: "synthetic-scope",
									version: options.version ?? "1",
								},
								metrics: [
									{
										name: "history.value",
										unit: options.unit ?? "ms",
										description: options.description ?? "initial description",
										[options.type ?? "gauge"]: {
											dataPoints: [
												{
													startTimeUnixNano: "0",
													timeUnixNano: time,
													asDouble: value,
													attributes,
												},
											],
										},
									},
								],
							},
						],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
	};
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		await post(later, 20);
		await post(earlier, 10, { reverse: true });
		await post(later, 21, {
			reverse: true,
			description: "corrected description",
		});
		await post(later, 30, {
			route: "second",
			description: "latest description",
		});
		await post(later, 100, { unit: "s" });
		await post(later, 200, { instance: "two" });
		await post(later, 300, { version: "2" });
		await post(later, 400, { type: "sum" });
		await post(later, 500, { service: "other-service" });
		const read = async () =>
			(await client.call("telemetry.read", { signal: "metrics" }))
				.value as import("../src/telemetry/contracts.ts").MetricData[];
		const retained = await read();
		expect(retained).toHaveLength(6);
		const stream = retained.find(
			(metric) =>
				metric.serviceName === "history-service" &&
				metric.type === "gauge" &&
				metric.unit === "ms" &&
				metric.scope.version === "1" &&
				metric.resource.attributes.some(
					(attribute) =>
						attribute.key === "instance" && attribute.value === "one",
				),
		);
		expect(stream?.description).toBe("latest description");
		expect(stream?.dataPoints.map((point) => point.timeUnixNano)).toEqual([
			earlier,
			later,
			later,
		]);
		expect(stream?.dataPoints.map((point) => point.value)).toEqual([
			10, 21, 30,
		]);
		expect(stream?.dataPoints[2]?.attributes).toContainEqual({
			key: "route",
			value: "second",
		});
		// HTTP and native clients see the same coherent stream history.
		const response = await fetch(new URL("/api/telemetry/metrics", host.url), {
			headers: { authorization: `Bearer ${host.client.token}` },
		});
		expect(await response.json()).toEqual(retained);
		client.close();
		await host.stop();
		await app.close();
		app = await initial.open();
		host = serve(app);
		client = new ClientConnection(host.client);
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		expect(await read()).toEqual(retained);
	} finally {
		client.close();
		await host.stop();
	}
});

test("trace filter catalogs include receiver-only workspaces beyond a page and refuse incomplete oversized catalogs", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const source = (
		index: number,
		changeId = `workspace-${String(index).padStart(4, "0")}`,
		name = `type-${index}`,
	) => ({
		resource: {
			attributes: [
				{ key: "herdr.change.id", value: { stringValue: changeId } },
			],
		},
		scopeSpans: [
			{
				spans: [
					{
						traceId: (index + 1).toString(16).padStart(32, "0"),
						spanId: (index + 1).toString(16).padStart(16, "0"),
						name,
						startTimeUnixNano: "1000000000",
						endTimeUnixNano: "2000000000",
					},
				],
			},
		],
	});
	const post = async (resourceSpans: ReturnType<typeof source>[]) => {
		const response = await fetch(new URL("/v1/traces", host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ resourceSpans }),
		});
		expect(response.status).toBe(200);
	};
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		expect(await client.call("telemetry.filters.read", {})).toEqual({
			workspaces: [],
			spanTypes: [],
		});
		const first = Array.from({ length: 65 }, (_, index) => source(index));
		first[0] = source(0, undefined, "type,one\nnext");
		await post(first);
		await post([source(100, "workspace-0000", "type,one\nnext")]);
		const page = (await client.call("telemetry.read", { signal: "traces" }))
			.value;
		expect(page).toMatchObject({ total: 65, perPage: 50 });
		const catalog = await client.call("telemetry.filters.read", {});
		expect(catalog.workspaces).toHaveLength(65);
		expect(catalog.spanTypes).toHaveLength(65);
		expect(catalog.workspaces).toContainEqual({
			changeId: "workspace-0064",
			spanCount: 1,
		});
		expect(catalog.workspaces).toContainEqual({
			changeId: "workspace-0000",
			spanCount: 2,
		});
		expect(catalog.spanTypes).toContain("type,one\nnext");
		// None of these HTTP-ingested groups depend on a workspace_files row.
		expect(
			(await client.call("telemetry.read", { signal: "workspaces" })).value,
		).toEqual([]);
		await post(
			Array.from({ length: 936 }, (_, offset) =>
				source(65 + offset, undefined, "shared-type"),
			),
		);
		await expect(client.call("telemetry.filters.read", {})).rejects.toThrow(
			"1000 options",
		);
		expect(catalog.workspaces).toHaveLength(65);
		expect(
			(await client.call("telemetry.read", { signal: "traces", perPage: 1 }))
				.value,
		).toMatchObject({ total: 1001 });
		await client.call("telemetry.manage", { operation: "prune", days: 1 });
		expect(await client.call("telemetry.filters.read", {})).toEqual({
			workspaces: [],
			spanTypes: [],
		});
		await post(
			Array.from({ length: 1001 }, (_, index) =>
				source(index, "single-workspace"),
			),
		);
		await expect(client.call("telemetry.filters.read", {})).rejects.toThrow(
			"1000 options",
		);
		expect(await client.call("state.read", {})).toHaveProperty("sessions");
		expect(client.status).toBe("connected");
	} finally {
		client.close();
		await host.stop();
	}
});

test("native topology scopes parent IDs to their trace, counts calls and replaces corrected span observations", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const span = (
		trace: string,
		id: number,
		service: string,
		parent = 0,
		duration = 10,
		error = false,
	) => ({
		resource: {
			attributes: [{ key: "service.name", value: { stringValue: service } }],
		},
		scopeSpans: [
			{
				spans: [
					{
						traceId: trace.repeat(32),
						spanId: id.toString(16).padStart(16, "0"),
						parentSpanId: parent ? parent.toString(16).padStart(16, "0") : "",
						name: `operation-${service}`,
						startTimeUnixNano: "1790000000000000000",
						endTimeUnixNano: (
							1790000000000000000n +
							BigInt(duration) * 1_000_000n
						).toString(),
						status: { code: error ? 2 : 0 },
					},
				],
			},
		],
	});
	const post = async (resourceSpans: ReturnType<typeof span>[]) => {
		const response = await fetch(new URL("/v1/traces", host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ resourceSpans }),
		});
		expect(response.status).toBe(200);
	};
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		expect(
			(await client.call("telemetry.read", { signal: "topology" })).value,
		).toEqual({ services: [], edges: [] });
		await post([
			span("a", 1, "frontend-a"),
			span("a", 2, "store-a", 1, 10, true),
			span("a", 3, "store-a", 1, 20),
			span("b", 1, "frontend-b"),
			span("b", 2, "store-b", 1),
			span("c", 2, "orphan", 1),
			span("d", 4, "cycle-x", 5),
			span("d", 5, "cycle-y", 4),
		]);
		const corrected = span("a", 2, "store-a", 1, 12);
		// A correction may also change its event time. Ingest order, not a
		// chronology sort, decides which observation owns the wire identity.
		corrected.scopeSpans[0].spans[0].startTimeUnixNano = "1780000000000000000";
		corrected.scopeSpans[0].spans[0].endTimeUnixNano = "1780000000012000000";
		await post([corrected]);
		const graph = (await client.call("telemetry.read", { signal: "topology" }))
			.value as import("../src/telemetry/contracts.ts").ServiceGraph;
		expect(graph.edges).toEqual([
			{ source: "cycle-x", target: "cycle-y", spanCount: 1 },
			{ source: "cycle-y", target: "cycle-x", spanCount: 1 },
			{ source: "frontend-a", target: "store-a", spanCount: 2 },
			{ source: "frontend-b", target: "store-b", spanCount: 1 },
		]);
		expect(
			graph.services.find((service) => service.id === "store-a"),
		).toMatchObject({
			parentIds: ["frontend-a"],
			childIds: [],
			spanCount: 2,
			errorCount: 0,
			avgDurationMs: 16,
		});
		expect(
			graph.services.find((service) => service.id === "orphan"),
		).toMatchObject({ parentIds: [], childIds: [], spanCount: 1 });
		const response = await fetch(new URL("/api/telemetry/topology", host.url), {
			headers: { authorization: `Bearer ${host.client.token}` },
		});
		expect(await response.json()).toEqual(graph);
		await expect(
			client.call("telemetry.read", { signal: "topology", limit: 1 }),
		).rejects.toThrow("query");
		expect(await client.call("state.read", {})).toHaveProperty("sessions");
		expect(client.status).toBe("connected");
	} finally {
		client.close();
		await host.stop();
	}
});

test("native trace trees preserve v1 grouping and all logical spans while breaking cycles and bounded-depth parent chains", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const span = (
		trace: string,
		id: number,
		parent = 0,
		name = "operation",
		role = "",
	) => ({
		traceId: trace.repeat(32),
		spanId: id.toString(16).padStart(16, "0"),
		parentSpanId: parent ? parent.toString(16).padStart(16, "0") : "",
		name,
		startTimeUnixNano: "1790000000000000000",
		endTimeUnixNano: "1790000000100000000",
		status: { code: 2 },
		attributes: role
			? [{ key: "herdr.role", value: { stringValue: role } }]
			: [],
	});
	const post = async (changeId: string, spans: ReturnType<typeof span>[]) => {
		const response = await fetch(new URL("/v1/traces", host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{ key: "herdr.change.id", value: { stringValue: changeId } },
							],
						},
						scopeSpans: [{ spans }],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
	};
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const input = [
			...Array.from({ length: 200 }, (_, index) => span("a", index + 1, index)),
			span("b", 1),
			span("b", 2, 1),
			span("b", 3),
			span("c", 1, 2),
			span("c", 2, 1),
			span("d", 1, 1),
			span("e", 1, 999),
			span("f", 1, 0, "agent.operation", "reader"),
			span("9", 1),
		];
		await post("tree-fixture", input);
		const corrected = span("b", 3, 3, "corrected");
		corrected.status.code = 0;
		await post("tree-fixture", [corrected]);
		const roots = (
			await client.call("telemetry.read", {
				signal: "tree",
				changeId: "tree-fixture",
			})
		).value as import("../src/telemetry/contracts.ts").TreeNode[];
		const nodes = [...roots];
		for (let index = 0; index < nodes.length; index++)
			nodes.push(...nodes[index].children);
		const actual = nodes.filter(
			(node) => !node.span.spanId.startsWith("virtual-"),
		);
		expect(actual).toHaveLength(209);
		expect(
			new Set(
				actual.map((node) =>
					JSON.stringify([node.span.traceId, node.span.spanId]),
				),
			).size,
		).toBe(209);
		expect(Math.max(...nodes.map((node) => node.depth))).toBeLessThanOrEqual(
			70,
		);
		expect(
			actual.filter((node) => node.relation === "depth-limit"),
		).toHaveLength(3);
		expect(actual.filter((node) => node.relation === "cycle")).toHaveLength(3);
		for (const node of actual)
			for (const child of node.children)
				expect(child.span.traceId).toBe(node.span.traceId);
		const replacement = actual.find(
			(node) =>
				node.span.traceId === "b".repeat(32) && node.span.name === "corrected",
		);
		expect(replacement).toMatchObject({
			relation: "cycle",
			span: { parentSpanId: "0000000000000003", status: { code: 0 } },
		});
		expect(
			actual.find(
				(node) =>
					node.span.traceId === "b".repeat(32) &&
					node.span.spanId === "0000000000000001",
			)?.children,
		).toMatchObject([
			{ span: { traceId: "b".repeat(32), spanId: "0000000000000002" } },
		]);
		expect(actual.some((node) => node.span.traceId === "9".repeat(32))).toBe(
			true,
		);
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "tree-fixture",
				})
			).value,
		).toHaveLength(210);
		const response = await fetch(
			new URL("/api/telemetry/tree?changeId=tree-fixture", host.url),
			{ headers: { authorization: `Bearer ${host.client.token}` } },
		);
		expect(await response.json()).toEqual(roots);
		const phased = [
			span("8", 1, 0, "runtime.tool", "reader"),
			span("8", 2, 1, "git.status"),
			span("8", 3, 0, "runtime.usage"),
		];
		phased.forEach((item, index) => {
			item.attributes.push({
				key: "herdr.step.id",
				value: { stringValue: index === 2 ? "phase-two" : "phase-one" },
			});
		});
		await post("phased-fixture", phased);
		const grouped = (
			await client.call("telemetry.read", {
				signal: "tree",
				changeId: "phased-fixture",
			})
		).value as import("../src/telemetry/contracts.ts").TreeNode[];
		const groups = [...grouped];
		for (let index = 0; index < groups.length; index++)
			groups.push(...groups[index].children);
		const labels = groups.map((node) => node.span.name);
		for (const label of [
			"phase-one",
			"phase-two",
			"agent",
			"git operation",
			"reader",
		])
			expect(labels).toContain(label);
		expect(
			groups.filter((node) => !node.span.spanId.startsWith("virtual-")),
		).toHaveLength(3);
		expect(
			(
				await client.call("telemetry.read", {
					signal: "tree",
					changeId: "not-retained",
				})
			).value,
		).toEqual([]);
		await expect(
			client.call("telemetry.read", { signal: "tree" }),
		).rejects.toThrow("query");
		expect(await client.call("state.read", {})).toHaveProperty("sessions");
		expect(client.status).toBe("connected");
	} finally {
		client.close();
		await host.stop();
	}
});

test("standard OTLP protobuf bytes preserve failure status, parent, scope and exception events without using the receiver schema to encode", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const grpc = await import("@grpc/grpc-js");
	let wire: InstanceType<typeof grpc.Client> | undefined;
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const running = await client.call("telemetry.receiver.start", {
			revision: 0,
			port: 0,
		});
		if (!running.address || !running.credentialFile)
			throw new Error("Missing synthetic receiver references");
		wire = new grpc.Client(running.address, grpc.credentials.createInsecure());
		const metadata = new grpc.Metadata();
		metadata.set(
			"authorization",
			`Bearer ${fs.readFileSync(running.credentialFile, "utf8")}`,
		);
		// Independently encoded golden bytes, not createTraceServiceClient or a
		// serializer generated from our .proto. Tags follow the official v1.9.0:
		// https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/trace/v1/trace.proto
		const bytes = Buffer.from(
			fs
				.readFileSync(
					path.join(
						import.meta.dir,
						"fixtures/telemetry/otlp-standard-export.hex",
					),
					"utf8",
				)
				.trim(),
			"hex",
		);
		const connection = wire;
		await new Promise<void>((resolve, reject) =>
			connection.makeUnaryRequest(
				"/opentelemetry.proto.collector.trace.v1.TraceService/Export",
				(value: Buffer) => value,
				(value: Buffer) => value,
				bytes,
				metadata,
				{ deadline: Date.now() + 2000 },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		const expected = {
			traceId: "11".repeat(16),
			spanId: "22".repeat(8),
			parentSpanId: "33".repeat(8),
			name: "standard OTLP export",
			kind: 2,
			scope: { name: "independent-otlp", version: "1.9.0" },
			startTimeUnixNano: "1790000000000000000",
			endTimeUnixNano: "1790000000100000000",
			status: { code: 2, message: "synthetic status\nsecond line" },
			attributes: [
				{ key: "service.name", value: "wire-fixture" },
				{ key: "herdr.change.id", value: "standard-wire" },
				{ key: "attempt", value: 2 },
			],
			events: [
				{
					name: "exception",
					timeUnixNano: "1790000000050000000",
					attributes: [
						{ key: "exception.type", value: "SyntheticFailure" },
						{
							key: "exception.message",
							value: "synthetic failure\nsecond line",
						},
						{
							key: "exception.stacktrace",
							value: "SyntheticFailure\n  at synthetic.ts:1",
						},
						{ key: "exception.escaped", value: "true" },
					],
				},
			],
		};
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "standard-wire",
				})
			).value,
		).toMatchObject([expected]);
		expect(
			(
				await client.call("telemetry.read", {
					signal: "tree",
					changeId: "standard-wire",
				})
			).value,
		).toMatchObject([{ children: [{ span: expected }] }]);
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId: expected.traceId,
				spanId: expected.spanId,
			}),
		).toMatchObject({ changeId: "standard-wire" });
		await client.call("telemetry.receiver.stop", {
			revision: running.revision,
		});
	} finally {
		wire?.close();
		client.close();
		await host.stop();
	}
});

test("Datadog uint64 JSON and Zipkin 64-bit traces retain exact timing, native parents and correlated failure logs", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const post = (route: string, payload: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers: {
				authorization: `Bearer ${host.client.token}`,
				"content-type": "application/json",
			},
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const meta = {
			"herdr.change.id": "datadog-fixture",
			"_dd.p.tid": "0123456789ABCDEF",
		};
		const ddRoot = {
			trace_id: "18446744073709551615",
			span_id: "18446744073709551614",
			parent_id: 0,
			name: "dd root",
			service: "dd-front",
			start: "1790000000000000123",
			duration: 100,
			meta,
		};
		const ddChild = {
			...ddRoot,
			span_id: "18446744073709551613",
			parent_id: "18446744073709551614",
			name: "dd child",
			service: "dd-worker",
			duration: 987654321,
			error: 1,
			meta: {
				...meta,
				"error.type": "SyntheticFailure",
				"error.msg": "trace operation failed\nextra",
				"error.stack": "SyntheticFailure\n  at synthetic.ts:2",
			},
		};
		// Actual uint64 JSON integer literals, not already-rounded JS numbers.
		const wire = JSON.stringify([[ddRoot, ddChild]]).replace(
			/"(1844674407370955161[345]|1790000000000000123)"/g,
			"$1",
		);
		expect((await post("/v0.4/traces", wire)).status).toBe(200);
		const ddTraceId = "0123456789abcdefffffffffffffffff";
		const ddExpected = {
			traceId: ddTraceId,
			spanId: "fffffffffffffffd",
			parentSpanId: "fffffffffffffffe",
			startTimeUnixNano: "1790000000000000123",
			endTimeUnixNano: "1790000000987654444",
			status: { code: 2, message: "trace operation failed\nextra" },
			attributes: [
				{ key: "herdr.change.id", value: "datadog-fixture" },
				{ key: "_dd.p.tid", value: "0123456789ABCDEF" },
				{ key: "error.type", value: "SyntheticFailure" },
				{ key: "error.msg", value: "trace operation failed\nextra" },
				{ key: "error.stack", value: "SyntheticFailure\n  at synthetic.ts:2" },
			],
		};
		const ddSpans = (
			await client.call("telemetry.read", {
				signal: "spans",
				changeId: "datadog-fixture",
			})
		).value;
		expect(ddSpans).toHaveLength(2);
		expect(ddSpans).toContainEqual(expect.objectContaining(ddExpected));
		// Datadog error metadata has no event timestamp: do not invent one.
		expect(
			(ddSpans as SpanData[]).find((span) => span.spanId === ddExpected.spanId)
				?.events,
		).toBeUndefined();
		expect(
			(
				await client.call("telemetry.read", {
					signal: "tree",
					changeId: "datadog-fixture",
				})
			).value,
		).toMatchObject([
			{
				children: [
					{
						span: { spanId: "fffffffffffffffe" },
						children: [{ span: ddExpected }],
					},
				],
			},
		]);
		expect(
			(
				await post(
					"/api/v2/logs",
					JSON.stringify([
						{
							message: "dd failure",
							status: "error",
							timestamp: 1790000000123,
							dd: { trace_id: ddTraceId, span_id: ddChild.span_id },
						},
					]).replace(`"${ddChild.span_id}"`, ddChild.span_id),
				)
			).status,
		).toBe(200);
		expect(
			(
				await post("/v0.3/traces", [
					[
						{
							...ddRoot,
							trace_id: 42,
							span_id: 43,
							parent_id: 0,
							start: 1790000000000,
							duration: 1,
							meta: { "herdr.change.id": "dd-decimal" },
						},
					],
				])
			).status,
		).toBe(200);
		expect(
			(
				await post("/api/v2/logs", [
					{
						message: "decimal correlation",
						timestamp: 0,
						"dd.trace_id": "42",
						"dd.span_id": "43",
					},
					{
						message: "unlinked numeric",
						timestamp: 0,
						dd: { trace_id: 0, span_id: "0000000000000000" },
					},
					{
						message: "unlinked hex",
						timestamp: 0,
						dd: { trace_id: "0".repeat(32), span_id: null },
					},
				])
			).status,
		).toBe(200);
		const logs = (await client.call("telemetry.read", { signal: "logs" }))
			.value as LogData[];
		for (const body of ["unlinked numeric", "unlinked hex"]) {
			const record = logs.find((item) => item.body === body);
			expect(record).toMatchObject({ body, timeUnixNano: "0" });
			expect(record?.traceId).toBeUndefined();
			expect(record?.spanId).toBeUndefined();
		}
		expect(logs).toContainEqual(
			expect.objectContaining({
				body: "dd failure",
				severity: "ERROR",
				timeUnixNano: "1790000000123000000",
				traceId: ddTraceId,
				spanId: "fffffffffffffffd",
			}),
		);
		expect(logs).toContainEqual(
			expect.objectContaining({
				body: "decimal correlation",
				timeUnixNano: "0",
				traceId: "0000000000000000000000000000002a",
				spanId: "000000000000002b",
			}),
		);
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId: ddTraceId,
				spanId: "fffffffffffffffd",
			}),
		).toMatchObject({ changeId: "datadog-fixture" });
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId: "0000000000000000000000000000002a",
				spanId: "000000000000002b",
			}),
		).toMatchObject({ changeId: "dd-decimal" });
		const refused = await post("/v0.4/traces", [
			[
				{ ...ddRoot, span_id: 44 },
				{
					...ddRoot,
					trace_id: "18446744073709551616",
					name: "private-rejected-marker",
				},
			],
		]);
		expect(refused.status).toBe(400);
		expect(await refused.text()).not.toContain("private-rejected-marker");
		expect(
			(
				await post("/v0.4/traces", [
					[{ ...ddRoot, span_id: 45 }],
					{ unexpected: true },
				])
			).status,
		).toBe(400);
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "datadog-fixture",
				})
			).value,
		).toHaveLength(2);
		expect(
			(
				await post(
					"/v0.4/traces",
					`[[{"trace_id":9e30,"span_id":1,"start":1,"name":"bad","service":"synthetic"}]]`,
				)
			).status,
		).toBe(400);
		const zipRoot = {
			traceId: "ABCDEF0123456789",
			id: "0123456789ABCDEF",
			name: "zip root",
			kind: "CLIENT",
			timestamp: 1790000000000000,
			duration: 123,
			localEndpoint: { serviceName: "zip-front" },
			tags: { "herdr.change.id": "zipkin-fixture" },
		};
		const zipChild = {
			...zipRoot,
			id: "fedcba9876543210",
			parentId: zipRoot.id,
			name: "zip child",
			kind: "SERVER",
			duration: 321,
			localEndpoint: { serviceName: "zip-worker" },
			tags: { ...zipRoot.tags, error: "zipkin failure" },
			annotations: [{ timestamp: 1790000000000100, value: "request.error" }],
		};
		expect((await post("/api/v2/spans", [zipRoot, zipChild])).status).toBe(200);
		const zipTraceId = "0000000000000000abcdef0123456789";
		expect(
			(
				await client.call("telemetry.read", {
					signal: "tree",
					changeId: "zipkin-fixture",
				})
			).value,
		).toMatchObject([
			{
				children: [
					{
						span: {
							traceId: zipTraceId,
							spanId: "0123456789abcdef",
							kind: 3,
							startTimeUnixNano: "1790000000000000000",
							endTimeUnixNano: "1790000000000123000",
						},
						children: [
							{
								span: {
									traceId: zipTraceId,
									parentSpanId: "0123456789abcdef",
									kind: 2,
									endTimeUnixNano: "1790000000000321000",
									status: { code: 2, message: "zipkin failure" },
									events: [
										{
											name: "request.error",
											timeUnixNano: "1790000000000100000",
											attributes: [],
										},
									],
								},
							},
						],
					},
				],
			},
		]);
		expect(
			await client.call("telemetry.trace.resolve", {
				traceId: zipTraceId,
				spanId: zipChild.id,
			}),
		).toMatchObject({ changeId: "zipkin-fixture" });
		expect(
			(
				await post("/api/v2/spans", [
					{ ...zipRoot, id: "a".repeat(16) },
					{ ...zipChild, traceId: "bad" },
				])
			).status,
		).toBe(400);
		expect(
			(
				await client.call("telemetry.read", {
					signal: "spans",
					changeId: "zipkin-fixture",
				})
			).value,
		).toHaveLength(2);
		const graph = (await client.call("telemetry.read", { signal: "topology" }))
			.value;
		expect(graph).toMatchObject({
			edges: [
				{ source: "dd-front", target: "dd-worker", spanCount: 1 },
				{ source: "zip-front", target: "zip-worker", spanCount: 1 },
			],
		});
	} finally {
		client.close();
		await host.stop();
	}
});

test("Datadog v1/v2 metric series preserve decimal timestamps, colon labels and distinct source/type identities", async () => {
	const { app } = await fixture(false);
	const host = serve(app);
	const client = new ClientConnection(host.client);
	const headers = {
		authorization: `Bearer ${host.client.token}`,
		"content-type": "application/json",
	};
	const post = (route: string, payload: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers,
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const base = {
			metric: "synthetic.requests",
			host: "source-a",
			type: "rate",
			unit: "request",
			interval: 10,
			source_type_name: "synthetic",
			tags: [
				"service:checkout",
				"env:test",
				"endpoint:https://example.invalid:8443/path",
				"flag",
				"empty:",
				"literal=a=b",
			],
		};
		const v1 = {
			series: [
				{
					...base,
					points: [
						["precise-seconds", 2.5],
						["epoch-nanosecond", 3],
						[1790000001, 4],
					],
				},
				{ ...base, type: "gauge", points: [[1790000001, 99]] },
				{ ...base, type: "count", points: [[1790000001, 7]] },
			],
		};
		const wire = JSON.stringify(v1)
			.replace('"precise-seconds"', "1790000000.123456789")
			.replace('"epoch-nanosecond"', "1e-9");
		expect((await post("/api/v1/series", wire)).status).toBe(200);
		const common = {
			metric: base.metric,
			unit: base.unit,
			interval: 10,
			source_type_name: base.source_type_name,
			tags: [...base.tags].reverse(),
			resources: [{ type: "host", name: "source-a" }],
		};
		const rate = {
			...common,
			type: 2,
			points: [
				{ timestamp: 1790000001, value: 5 },
				{ timestamp: 1790000002, value: 6 },
			],
		};
		expect(
			(
				await post("/api/v2/series", {
					series: [
						rate,
						{
							...common,
							type: 1,
							points: [{ timestamp: 1790000001, value: 8 }],
						},
						{
							...common,
							type: 3,
							resources: [
								{ type: "host", name: "source-b" },
								{ type: "container", name: "synthetic-container" },
							],
							points: [{ timestamp: 1790000001, value: 88 }],
						},
						{
							metric: "synthetic.untyped",
							type: 0,
							interval: 0,
							points: [{ timestamp: 0, value: 0 }],
						},
					],
				})
			).status,
		).toBe(200);
		const metrics = (await client.call("telemetry.read", { signal: "metrics" }))
			.value as MetricData[];
		expect(metrics).toHaveLength(5);
		const observedRate = metrics.find((metric) =>
			metric.resource.attributes.some(
				(attr) => attr.key === "datadog.metric.type" && attr.value === "rate",
			),
		);
		expect(observedRate).toMatchObject({
			name: base.metric,
			unit: "request",
			type: "gauge",
			serviceName: "checkout",
			scope: { name: "datadog", version: "" },
		});
		expect(observedRate?.resource.attributes).toEqual(
			expect.arrayContaining([
				{ key: "host.name", value: "source-a" },
				{ key: "datadog.metric.type", value: "rate" },
				{ key: "datadog.interval", value: "10" },
				{ key: "datadog.source_type_name", value: "synthetic" },
			]),
		);
		expect(
			observedRate?.dataPoints.map((point) => [
				point.timeUnixNano,
				point.value,
			]),
		).toEqual([
			["1", 3],
			["1790000000123456789", 2.5],
			["1790000001000000000", 5],
			["1790000002000000000", 6],
		]);
		for (const point of observedRate?.dataPoints ?? [])
			expect(point.attributes).toEqual(
				expect.arrayContaining([
					{ key: "service", value: "checkout" },
					{ key: "env", value: "test" },
					{ key: "endpoint", value: "https://example.invalid:8443/path" },
					{ key: "flag", value: "true" },
					{ key: "empty", value: "" },
					{ key: "literal=a=b", value: "true" },
				]),
			);
		const count = metrics.find((metric) => metric.type === "sum");
		expect(count).toMatchObject({
			unit: "request",
			dataPoints: [{ value: 8 }],
		});
		expect(count?.resource.attributes).toEqual(
			expect.arrayContaining([{ key: "datadog.metric.type", value: "count" }]),
		);
		expect(
			metrics
				.filter((metric) =>
					metric.resource.attributes.some(
						(attr) =>
							attr.key === "datadog.metric.type" && attr.value === "gauge",
					),
				)
				.map((metric) => metric.dataPoints[0]?.value)
				.sort((a, b) => (a ?? 0) - (b ?? 0)),
		).toEqual([88, 99]);
		const otherHost = metrics.find(
			(metric) => metric.dataPoints[0]?.value === 88,
		);
		expect(otherHost?.serviceName).toBe("checkout");
		expect(otherHost?.resource.attributes).toEqual(
			expect.arrayContaining([
				{ key: "host.name", value: "source-b" },
				{ key: "datadog.resource.container", value: "synthetic-container" },
			]),
		);
		const untyped = metrics.find(
			(metric) => metric.name === "synthetic.untyped",
		);
		expect(untyped).toMatchObject({
			type: "gauge",
			unit: "",
			serviceName: "datadog",
			dataPoints: [{ timeUnixNano: "0", value: 0 }],
		});
		expect(untyped?.resource.attributes).toEqual(
			expect.arrayContaining([
				{ key: "datadog.metric.type", value: "unspecified" },
				{ key: "datadog.interval", value: "0" },
			]),
		);
		const refused = await post("/api/v2/series", {
			series: [
				{ ...rate, points: [{ timestamp: 1790000003, value: 10 }] },
				{
					...rate,
					points: [{ timestamp: 1790000004, value: "private-rejected-marker" }],
				},
			],
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).not.toContain("private-rejected-marker");
		expect((await post("/api/v1/series", { series: [rate] })).status).toBe(400);
		expect(
			(
				await post("/api/v2/series", {
					series: [{ ...common, type: 3, points: [[1790000001, 1]] }],
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/v1/series", {
					series: [{ ...base, points: [[1e-10, 1]] }],
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/v2/series", {
					series: [{ ...rate, points: [{ timestamp: 1.5, value: 1 }] }],
				})
			).status,
		).toBe(400);
		expect(
			(await post("/api/v2/series", { series: [{ ...rate, type: 4 }] })).status,
		).toBe(400);
		expect(
			(
				await post("/api/v1/series", {
					series: [{ ...base, tags: [123, 456], points: [[1790000001, 1]] }],
				})
			).status,
		).toBe(400);
		expect(
			(await client.call("telemetry.read", { signal: "metrics" })).value,
		).toEqual(metrics);
		expect(
			await (
				await fetch(new URL("/api/telemetry/metrics", host.url), { headers })
			).json(),
		).toEqual(metrics);
	} finally {
		client.close();
		await host.stop();
	}
});
