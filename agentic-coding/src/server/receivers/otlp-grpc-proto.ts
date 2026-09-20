// One definition of the OTLP trace service, used by both the internal gRPC
// helper mode and the parent's readiness probe, so "ready" means the real
// TraceService answered — not merely that a port accepted a TCP connection.
//
// The definition lives as a bundled `.proto` asset rather than a source-path
// dependency: it is imported as text (so it is embedded in the executable) and
// materialized into a private per-process directory before `@grpc/proto-loader`
// loads it by path. `proto-loader` resolves a source string as a filename, so
// the intermediate file is what makes the same asset work in a compiled binary
// and in a source run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OTLP_TRACE_PROTO_SOURCE from "./otlp-trace.proto" with { type: "text" };

export const OTLP_TRACE_PROTO = OTLP_TRACE_PROTO_SOURCE;

let materialized: string | undefined;

/** Write the bundled protocol asset to a private 0700 directory and return its
 * path (memoized per process, removed on exit). */
export function materializeTraceProto(): string {
	if (materialized) return materialized;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-coding-otlp-"));
	fs.chmodSync(dir, 0o700);
	const file = path.join(dir, "otlp-trace.proto");
	fs.writeFileSync(file, OTLP_TRACE_PROTO);
	materialized = file;
	process.once("exit", () => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return file;
}

/** TraceService client for `address` (host:port). */
export async function createTraceServiceClient(address: string): Promise<{
	Export: (
		request: unknown,
		metadata: { deadline: number },
		callback: (error: Error | null) => void,
	) => void;
	close: () => void;
}> {
	const grpc = await import("@grpc/grpc-js");
	const protoLoader = await import("@grpc/proto-loader");
	const packageDefinition = protoLoader.loadSync(materializeTraceProto());
	// biome-ignore lint/suspicious/noExplicitAny: runtime-loaded protobuf definition
	const proto = grpc.loadPackageDefinition(packageDefinition) as any;
	const Client = proto.opentelemetry.proto.collector.trace.v1.TraceService;
	return new Client(address, grpc.credentials.createInsecure());
}
