/**
 * OTLP gRPC helper — the `__grpc-sidecar` internal mode of the main
 * executable (never a separately distributed binary). Decodes OTLP protobuf
 * over gRPC and forwards decoded signals as HTTP JSON to the loopback
 * receiver. Binds to loopback only.
 *
 * Usage: agentic-coding __grpc-sidecar --port 4317 --forward http://127.0.0.1:4318
 */
const grpcPort = Number(
	process.argv[process.argv.indexOf("--port") + 1] ?? 4317,
);
const forwardUrl =
	process.argv[process.argv.indexOf("--forward") + 1] ??
	"http://127.0.0.1:4318";

async function main() {
	const grpc = await import("@grpc/grpc-js");
	const protoLoader = await import("@grpc/proto-loader");
	const { materializeTraceProto } = await import("./otlp-grpc-proto");

	const packageDefinition = protoLoader.loadSync(materializeTraceProto());
	// biome-ignore lint/suspicious/noExplicitAny: dynamically loaded protobuf definition
	const proto = grpc.loadPackageDefinition(packageDefinition) as any;

	// biome-ignore lint/suspicious/noExplicitAny: decoded OTLP JSON payload of arbitrary shape
	async function forward(path: string, body: any) {
		try {
			await fetch(`${forwardUrl}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			/* loopback down, drop */
		}
	}

	const server = new grpc.Server();
	server.addService(
		proto.opentelemetry.proto.collector.trace.v1.TraceService.service,
		{
			// biome-ignore lint/suspicious/noExplicitAny: untyped generated gRPC handler signature
			Export: (call: any, callback: any) => {
				forward("/v1/traces", call.request).catch(() => {});
				callback(null, { partialSuccess: {} });
			},
		},
	);
	server.bindAsync(
		`127.0.0.1:${grpcPort}`,
		grpc.ServerCredentials.createInsecure(),
		() => {
			server.start();
			console.log(`[grpc-sidecar] OTLP gRPC on :${grpcPort} → ${forwardUrl}`);
		},
	);

	process.on("SIGTERM", () => server.tryShutdown(() => process.exit(0)));
	process.on("SIGINT", () => server.tryShutdown(() => process.exit(0)));
}

main().catch(console.error);

export {};
