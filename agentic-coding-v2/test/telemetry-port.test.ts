import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

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
