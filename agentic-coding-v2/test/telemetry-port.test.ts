import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
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
						scope: { name: "fixture" },
						spans: [
							{
								traceId,
								spanId,
								name: "GET /fixture",
								kind: 2,
								startTimeUnixNano: "1790000000000000000",
								endTimeUnixNano: "1790000000100000000",
								status: { code: 2, message: "synthetic failure" },
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
		});
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
