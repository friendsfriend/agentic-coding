/**
 * OTLP gRPC sidecar — spawned as child process when gRPC is enabled.
 * Runs with Node.js + @grpc/grpc-js. Decodes OTLP protobuf over gRPC
 * and forwards decoded signals as HTTP JSON to loopback receiver.
 *
 * Usage: node otlp-grpc-sidecar.js --port 4317 --forward http://127.0.0.1:4318
 *
 * Requires: npm install @grpc/grpc-js @grpc/proto-loader
 */
const grpcPort = Number(process.argv[process.argv.indexOf('--port') + 1] ?? 4317);
const forwardUrl = process.argv[process.argv.indexOf('--forward') + 1] ?? 'http://127.0.0.1:4318';

async function main() {
  const grpc = await import('@grpc/grpc-js');
  const protoLoader = await import('@grpc/proto-loader');

  const otlpProto = `
    syntax = "proto3";
    package opentelemetry.proto.collector.trace.v1;
    service TraceService {
      rpc Export(ExportTraceServiceRequest) returns (ExportTraceServiceResponse);
    }
    message ExportTraceServiceRequest {
      repeated ResourceSpans resourceSpans = 1;
    }
    message ExportTraceServiceResponse {
      PartialSuccess partialSuccess = 1;
    }
    message PartialSuccess {
      int64 rejectedSpans = 1;
      string errorMessage = 2;
    }
    message ResourceSpans {
      Resource resource = 1;
      repeated ScopeSpans scopeSpans = 2;
    }
    message Resource {
      repeated KeyValue attributes = 1;
    }
    message ScopeSpans {
      Scope scope = 1;
      repeated Span spans = 2;
    }
    message Scope { string name = 1; string version = 2; }
    message Span {
      bytes traceId = 1; bytes spanId = 2; bytes parentSpanId = 3;
      string name = 4; int32 kind = 5; fixed64 startTimeUnixNano = 6;
      fixed64 endTimeUnixNano = 7; repeated KeyValue attributes = 8;
      Status status = 9;
    }
    message Status { int32 code = 1; string message = 2; }
    message KeyValue { string key = 1; AnyValue value = 2; }
    message AnyValue { oneof value { string stringValue = 1; bool boolValue = 2; int64 intValue = 3; double doubleValue = 4; } }
  `;

  const packageDefinition = protoLoader.loadSync(otlpProto);
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;

  async function forward(path: string, body: any) {
    try {
      await fetch(`${forwardUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { /* loopback down, drop */ }
  }

  const server = new grpc.Server();
  server.addService(proto.opentelemetry.proto.collector.trace.v1.TraceService.service, {
    Export: (call: any, callback: any) => {
      forward('/v1/traces', call.request).catch(() => {});
      callback(null, { partialSuccess: {} });
    },
  });
  server.bindAsync(`0.0.0.0:${grpcPort}`, grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log(`[grpc-sidecar] OTLP gRPC on :${grpcPort} → ${forwardUrl}`);
  });

  process.on('SIGTERM', () => server.tryShutdown(() => process.exit(0)));
  process.on('SIGINT', () => server.tryShutdown(() => process.exit(0)));
}

main().catch(console.error);
