// OTLP gRPC receiver that runs *inside* the server process (single-Bun-
// application): the TraceService is registered on a loopback-only gRPC server
// and every decoded export is handed to the same receiver router the OTLP HTTP
// listener uses. There is exactly one span decoder and no helper process, so a
// real protobuf export is what proves the receiver works.
//
// Only traces are supported: the bundled definition is the TraceService, and
// nothing here advertises the metrics or logs services.
import type { SignalRouter } from "./index.ts";
import { routeReceiverRequest } from "./index.ts";
import { materializeTraceProto } from "./otlp-grpc-proto.ts";

export interface OwnedGrpcReceiver {
	readonly address: string;
	stop(): Promise<void>;
}

/**
 * Convert one protobuf message tree into the OTLP/JSON shape the shared
 * decoder accepts: protobuf `bytes` become lowercase hex ids and 64-bit
 * integers become decimal strings. Without this conversion a real export
 * carries `{type:"Buffer",data:[…]}` ids and `{low,high}` timestamps, which
 * the OTLP/JSON decoder correctly rejects — i.e. gRPC traces would be
 * advertised but silently dropped.
 */
export function toOtlpJson(value: unknown): unknown {
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
	if (Array.isArray(value)) return value.map(toOtlpJson);
	if (value && typeof value === "object") {
		const long = value as {
			low?: unknown;
			high?: unknown;
			unsigned?: unknown;
		};
		if (typeof long.low === "number" && typeof long.high === "number") {
			const high =
				long.unsigned === true
					? BigInt(long.high >>> 0)
					: BigInt(long.high | 0);
			const combined = (high << 32n) | BigInt(long.low >>> 0);
			return combined.toString();
		}
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value))
			out[key] = toOtlpJson(entry);
		return out;
	}
	return value;
}

/** v1's in-process TraceService, restricted to loopback and authenticated
 * before decoding. A started receiver owns one listener; port zero is useful
 * for isolated tests and explicit ephemeral operator starts. */
export async function startOtlpGrpcReceiver(
	port: number,
	sink: SignalRouter,
	authenticate: (values: unknown[]) => boolean,
): Promise<OwnedGrpcReceiver> {
	const hostname = "127.0.0.1";
	const grpc = await import("@grpc/grpc-js");
	const protoLoader = await import("@grpc/proto-loader");
	const packageDefinition = protoLoader.loadSync(materializeTraceProto());
	// biome-ignore lint/suspicious/noExplicitAny: runtime-loaded protobuf definition
	const proto = grpc.loadPackageDefinition(packageDefinition) as any;

	const server = new grpc.Server({
		"grpc.max_receive_message_length": 1_000_000,
		"grpc.max_send_message_length": 1_000_000,
	});
	server.addService(
		proto.opentelemetry.proto.collector.trace.v1.TraceService.service,
		{
			// biome-ignore lint/suspicious/noExplicitAny: untyped generated gRPC handler signature
			Export: (call: any, callback: any) => {
				if (!authenticate(call.metadata.get("authorization"))) {
					callback({
						code: grpc.status.UNAUTHENTICATED,
						message: "Telemetry credential required",
					});
					return;
				}
				const request = new Request(`http://${hostname}/v1/traces`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(toOtlpJson(call.request)),
				});
				// The shared router owns decoding and rejection: an export the OTLP
				// decoder refuses is reported as INVALID_ARGUMENT instead of being
				// acknowledged as stored.
				Promise.resolve(routeReceiverRequest(request, sink))
					.then(async (response) => {
						if (response && response.status !== 200) {
							callback({
								code: grpc.status.INVALID_ARGUMENT,
								message: "Invalid OTLP payload",
							});
							return;
						}
						callback(null, { partialSuccess: {} });
					})
					.catch(() => {
						callback({
							code: grpc.status.INTERNAL,
							message: "Telemetry ingestion unavailable",
						});
					});
			},
		},
	);

	const boundPort = await new Promise<number>((resolve, reject) => {
		server.bindAsync(
			`${hostname}:${port}`,
			grpc.ServerCredentials.createInsecure(),
			(error, bound) => {
				if (error) {
					server.forceShutdown();
					reject(new Error("gRPC telemetry port unavailable"));
				} else resolve(bound);
			},
		);
	});
	let stopping: Promise<void> | undefined;

	return {
		address: `${hostname}:${boundPort}`,
		stop: () =>
			(stopping ??= new Promise<void>((resolve) => {
				// Bounded graceful shutdown: an in-flight export gets 2s, then the
				// listener is forced down so teardown cannot hang.
				const timer = setTimeout(() => {
					server.forceShutdown();
					resolve();
				}, 2000);
				server.tryShutdown(() => {
					clearTimeout(timer);
					resolve();
				});
			})),
	};
}
