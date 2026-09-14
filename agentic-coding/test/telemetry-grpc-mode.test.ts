// Optional gRPC telemetry protocol evidence (unify-application-lifecycle-and-
// binary task 2.6): the helper is an internal mode of the same executable, it
// binds loopback only, and readiness means the real TraceService answered.
// This test spawns that internal mode, exports a span through a real gRPC
// client and asserts the loopback HTTP receiver stored it.
import { expect, test } from "bun:test";
import path from "node:path";
import { createTraceServiceClient } from "../src/tui/otel/receiver/otlp-grpc-proto";

const entry = path.resolve(import.meta.dir, "..", "src/cli.ts");

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to reserve a port");
	return port;
}

test("the internal gRPC mode answers a real TraceService export on loopback", async () => {
	const grpcPort = freePort();
	const httpPort = freePort();
	const received: unknown[] = [];
	const receiver = Bun.serve({
		hostname: "127.0.0.1",
		port: httpPort,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/v1/traces") {
				received.push(await request.json());
				return new Response("{}", {
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});

	const helper = Bun.spawn(
		[
			process.execPath,
			entry,
			"__grpc-sidecar",
			"--port",
			String(grpcPort),
			"--forward",
			`http://127.0.0.1:${httpPort}`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);

	try {
		// Bounded settle for helper startup before the first protocol probe.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const client = await createTraceServiceClient(`127.0.0.1:${grpcPort}`);
		let answered = false;
		for (let attempt = 0; attempt < 40 && !answered; attempt++) {
			answered = await new Promise<boolean>((resolve) => {
				client.Export(
					{
						resourceSpans: [
							{
								scopeSpans: [
									{
										spans: [
											{ name: "lifecycle-smoke", traceId: "a".repeat(32) },
										],
									},
								],
							},
						],
					},
					{ deadline: Date.now() + 1000 },
					() => resolve(true),
				);
				setTimeout(() => resolve(false), 1200);
			});
		}
		client.close();
		expect(answered).toBe(true);

		// The decoded payload reached the loopback HTTP receiver.
		for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(received.length).toBeGreaterThan(0);
	} finally {
		helper.kill();
		await helper.exited;
		receiver.stop(true);
	}
}, 20_000);
