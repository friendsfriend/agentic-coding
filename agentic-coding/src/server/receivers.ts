// Server-owned telemetry receivers (expose-unified-bun-backend, task 2.3):
// OTLP/Zipkin/Datadog HTTP listeners, the optional OTLP gRPC TraceService, the
// Prometheus scraper and the StatsD listener start in the server composition
// root and route decoded signals to an injected sink. The shell owns the sink
// (its live view stores); the server owns the listeners and their bounded
// shutdown. Every listener, gRPC included, runs in this one process.
import type { SignalRouter } from "./receivers/index";
import {
	routeReceiverRequest,
	startPrometheusScraper,
	startStatsDListener,
} from "./receivers/index";
import { startOtlpGrpcReceiver } from "./receivers/otlp-grpc";

export interface TelemetryReceiverConfig {
	readonly httpPort?: number;
	readonly zipkinPort?: number;
	readonly datadogPort?: number;
	readonly grpcPort?: number;
	readonly promTargets?: ReadonlyArray<{ host: string; port: number }>;
	readonly promIntervalMs?: number;
	readonly statsdPort?: number;
}

export interface OwnedTelemetryReceivers {
	stop(): Promise<void>;
}

/** Start every configured receiver; the returned handle stops all of them. */
export async function startTelemetryReceivers(
	config: TelemetryReceiverConfig,
	sink: SignalRouter,
): Promise<OwnedTelemetryReceivers> {
	const servers: Array<ReturnType<typeof Bun.serve>> = [];
	const stops: Array<() => void | Promise<void>> = [];

	const httpPorts = new Set<number>();
	if (config.httpPort) httpPorts.add(config.httpPort);
	if (config.zipkinPort) httpPorts.add(config.zipkinPort);
	if (config.datadogPort) httpPorts.add(config.datadogPort);
	for (const port of httpPorts)
		servers.push(
			Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: (request) =>
					routeReceiverRequest(request, sink) ??
					new Response("not found", { status: 404 }),
			}),
		);

	// The OTLP gRPC TraceService is an in-process listener like the HTTP ones: a
	// bind failure is a startup failure, never a silently missing receiver.
	if (config.grpcPort) {
		const grpc = await startOtlpGrpcReceiver(config.grpcPort, sink);
		stops.push(() => grpc.stop());
	}

	if (config.promTargets?.length)
		stops.push(
			startPrometheusScraper(
				[...config.promTargets],
				config.promIntervalMs ?? 15_000,
				sink,
			),
		);
	if (config.statsdPort) {
		const statsd = startStatsDListener(
			config.statsdPort,
			`statsd-${config.statsdPort}`,
			sink,
		);
		stops.push(() => statsd.stop());
	}

	return {
		stop: async () => {
			for (const stop of stops) await stop();
			for (const server of servers) server.stop(true);
		},
	};
}
