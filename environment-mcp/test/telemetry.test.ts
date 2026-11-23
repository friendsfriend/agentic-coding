import { expect, test } from "bun:test";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createTelemetryReceiver } from "../src/telemetry/receiver.ts";

test("telemetry receiver bounds and redacts OTLP logs and traces", async () => {
	const receiver = createTelemetryReceiver({
		app: "web",
		scope: "11111111-1111-4111-8111-111111111111",
		redact: (value) => value.replaceAll("secret-value", "[REDACTED]"),
	});
	const authorization = decodeURIComponent(
		receiver.env.OTEL_EXPORTER_OTLP_HEADERS.split("=").slice(1).join("="),
	);
	const post = (path: string, body: unknown) =>
		fetch(`${receiver.env.OTEL_EXPORTER_OTLP_ENDPOINT}${path}`, {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	try {
		expect(
			(
				await fetch(`${receiver.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`, {
					method: "POST",
					body: "{}",
				})
			).status,
		).toBe(401);
		expect(
			(
				await post("/v1/logs", {
					resourceLogs: [
						{
							scopeLogs: [
								{
									logRecords: [
										{
											timeUnixNano: "1000000",
											severityText: "INFO",
											body: { stringValue: "secret-value log" },
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
				await post("/v1/traces", {
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											traceId: "a".repeat(32),
											spanId: "b".repeat(16),
											name: "secret-value span",
											startTimeUnixNano: "1000000",
											endTimeUnixNano: "2000000",
											status: { code: "2" },
											attributes: [
												{
													key: "token",
													value: { stringValue: "secret-value" },
												},
											],
										},
										{
											traceId: "a".repeat(32),
											spanId: "e".repeat(16),
											parentSpanId: "b".repeat(16),
											name: "child span",
											startTimeUnixNano: "1500000",
											endTimeUnixNano: "1800000",
										},
									],
								},
							],
						},
					],
				})
			).status,
		).toBe(200);
		const snapshot = receiver.snapshot();
		expect(JSON.stringify(snapshot)).not.toContain("secret-value");
		expect(snapshot.logs).toMatchObject([
			{ severity: "INFO", body: "[REDACTED] log" },
		]);
		expect(snapshot.traces).toMatchObject([
			{ traceId: "a".repeat(32), spanCount: 2, errors: 1 },
		]);
		const trace = receiver.trace("a".repeat(32));
		expect(trace?.spans[0]).toMatchObject({
			name: "[REDACTED] span",
			status: "2",
		});
		expect(trace?.tree).toMatchObject([
			{
				name: "[REDACTED] span",
				status: "2",
				children: [{ name: "child span", children: [] }],
			},
		]);
	} finally {
		receiver.close();
	}
});

test("container telemetry uses a TLS host-gateway receiver and injects collector config", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-telemetry-gateway-"));
	const receiver = createTelemetryReceiver({
		app: "api",
		scope: "22222222-2222-4222-8222-222222222222",
		redact: (value) => value,
		transport: "tls-host-gateway-v1",
		stateDir: root,
	});
	const collector = JSON.parse(
		receiver.collectorEnvironment().OTEL_COLLECTOR_CONFIG,
	) as {
		exporters: {
			otlp_http: {
				endpoint: string;
				headers: { Authorization: string };
			};
		};
	};
	const endpoint = new URL(collector.exporters.otlp_http.endpoint);
	const certificate = fs.readFileSync(receiver.collectorCertificatePath());
	expect(receiver.containerEnvironment()).toMatchObject({
		OTEL_EXPORTER_OTLP_ENDPOINT: expect.stringContaining(
			"https://host.docker.internal:",
		),
		OTEL_EXPORTER_OTLP_CERTIFICATE: "/environment-mcp-otel-ca.pem",
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
	});
	const post = (authorization: string) =>
		new Promise<number>((resolve, reject) => {
			const request = https.request(
				{
					hostname: "127.0.0.1",
					port: Number(endpoint.port),
					path: "/v1/traces",
					method: "POST",
					ca: certificate,
					servername: "host.docker.internal",
					headers: {
						authorization,
						"content-type": "application/json",
					},
				},
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode ?? 0));
				},
			);
			request.on("error", reject);
			request.end(
				JSON.stringify({
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											traceId: "c".repeat(32),
											spanId: "d".repeat(16),
											name: "gateway span",
											startTimeUnixNano: "1000000",
											endTimeUnixNano: "2000000",
										},
									],
								},
							],
						},
					],
				}),
			);
		});
	try {
		expect(await post("")).toBe(401);
		expect(
			await post(collector.exporters.otlp_http.headers.Authorization),
		).toBe(200);
		expect(receiver.snapshot()).toMatchObject({
			transport: "tls-host-gateway-v1",
			traces: [{ traceId: "c".repeat(32), spanCount: 1 }],
		});
	} finally {
		receiver.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
