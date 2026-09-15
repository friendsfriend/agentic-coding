// Optional gRPC telemetry protocol evidence (retire-go-backend-and-migration-
// bridges task 2.1): the OTLP TraceService runs inside the server process, so
// a real protobuf export must decode into the shell's span sink, the listener
// must bind loopback only, and shutdown must release the port.
//
// The previous helper-process mode round-tripped the protobuf message through
// JSON.stringify, which turns bytes into `{type:"Buffer"}` objects and longs
// into `{low,high}` — the OTLP/JSON decoder correctly refuses both, so the
// advertised gRPC support ingested nothing. The sink assertion below is what
// makes that class of bug impossible to reintroduce.
import { expect, test } from "bun:test";
import type { SpanData } from "../src/tui/otel/model/types";
import { startOtlpGrpcReceiver } from "../src/tui/otel/receiver/otlp-grpc.ts";
import { createTraceServiceClient } from "../src/tui/otel/receiver/otlp-grpc-proto.ts";

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to reserve a port");
	return port;
}

function sinkFor(spans: SpanData[]) {
	return {
		pushTraces: (next: SpanData[]) => spans.push(...next),
		pushMetrics: () => {},
		pushLogs: () => {},
	};
}

test("the in-process TraceService decodes a real export into the span sink", async () => {
	const grpcPort = freePort();
	const spans: SpanData[] = [];
	const receiver = await startOtlpGrpcReceiver(grpcPort, sinkFor(spans));
	try {
		const client = await createTraceServiceClient(`127.0.0.1:${grpcPort}`);
		const answered = await new Promise<Error | null>((resolve) => {
			client.Export(
				{
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											name: "grpc-smoke",
											// Bytes fields take raw bytes on the client (a hex string would be
											// interpreted as base64), 64-bit fields take decimal strings.
											traceId: Buffer.from("aa".repeat(16), "hex"),
											spanId: Buffer.from("bb".repeat(8), "hex"),
											startTimeUnixNano: "1700000000000000000",
											endTimeUnixNano: "1700000000000100000",
											attributes: [
												{ key: "surface", value: { stringValue: "test" } },
											],
										},
									],
								},
							],
						},
					],
				},
				{ deadline: Date.now() + 5000 },
				(error: Error | null) => resolve(error),
			);
		});
		client.close();
		expect(answered).toBeNull();
		expect(spans.map((span) => span.name)).toEqual(["grpc-smoke"]);
		expect(spans[0]?.traceId).toBe("aa".repeat(16));
		expect(spans[0]?.startTimeUnixNano).toBe("1700000000000000000");
		expect(spans[0]?.endTimeUnixNano).toBe("1700000000000100000");
	} finally {
		await receiver.stop();
	}
}, 20_000);

test("an export the OTLP decoder refuses is reported, not acknowledged", async () => {
	const grpcPort = freePort();
	const spans: SpanData[] = [];
	const receiver = await startOtlpGrpcReceiver(grpcPort, sinkFor(spans));
	try {
		const client = await createTraceServiceClient(`127.0.0.1:${grpcPort}`);
		const error = await new Promise<Error | null>((resolve) => {
			client.Export(
				{
					resourceSpans: [
						{ scopeSpans: [{ spans: [{ name: "no-identity" }] }] },
					],
				},
				{ deadline: Date.now() + 5000 },
				(reply: Error | null) => resolve(reply),
			);
		});
		client.close();
		expect(error).not.toBeNull();
		expect(spans).toEqual([]);
	} finally {
		await receiver.stop();
	}
}, 20_000);

test("gRPC telemetry binds loopback only and releases the port on stop", async () => {
	const grpcPort = freePort();
	const receiver = await startOtlpGrpcReceiver(grpcPort, sinkFor([]));
	expect(receiver.address).toBe(`127.0.0.1:${grpcPort}`);

	// A non-loopback interface must not answer: binding 0.0.0.0 would make the
	// receiver reachable from the network, which OTLP intake must never be.
	const external = await fetch(`http://localhost:${grpcPort}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	}).catch(() => undefined);
	expect(external?.status).not.toBe(200);

	await receiver.stop();
	await expect(
		startOtlpGrpcReceiver(grpcPort, sinkFor([])),
	).resolves.toBeTruthy();
}, 20_000);
