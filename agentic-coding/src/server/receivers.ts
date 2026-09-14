// Server-owned telemetry receivers (expose-unified-bun-backend, task 2.3):
// OTLP/Zipkin/Datadog HTTP listeners, the optional gRPC helper, the Prometheus
// scraper and the StatsD listener start in the server composition root and
// route decoded signals to an injected sink. The shell owns the sink (its live
// view stores); the server owns the listeners and their bounded shutdown.
import type { SignalRouter } from "../tui/otel/receiver/index.ts";
import {
	routeReceiverRequest,
	startPrometheusScraper,
	startStatsDListener,
} from "../tui/otel/receiver/index.ts";
import { createTraceServiceClient } from "../tui/otel/receiver/otlp-grpc-proto.ts";

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

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The optional OTLP gRPC helper runs as an internal mode of this same
 * executable (`__grpc-sidecar`), never as a separately distributed binary.
 * Compiled binaries re-exec themselves; a source run re-execs the entry file.
 */
export function grpcSidecarArgv(grpcPort: number, httpPort: number): string[] {
	const entry = Bun.main.startsWith("$bunfs") ? undefined : Bun.main;
	return [
		process.execPath,
		...(entry ? [entry] : []),
		"__grpc-sidecar",
		"--port",
		String(grpcPort),
		"--forward",
		`http://127.0.0.1:${httpPort}`,
	];
}

function spawnGrpcSidecar(grpcPort: number, httpPort: number) {
	const [command, ...args] = grpcSidecarArgv(grpcPort, httpPort);
	return Bun.spawn([command, ...args], {
		stdio: ["ignore", "inherit", "inherit"],
	});
}

async function stopGrpcSidecar(
	sidecar: ReturnType<typeof Bun.spawn>,
	timeoutMs: number,
): Promise<void> {
	if (sidecar.exitCode !== null) return;
	sidecar.kill();
	await Promise.race([sidecar.exited, sleep(timeoutMs)]);
}

/**
 * Readiness gate for the gRPC helper: aim a real TraceService export at the
 * loopback address and require an answer, so a port that merely accepts a
 * connection is not mistaken for a working service.
 */
async function waitForGrpcReady(
	grpcPort: number,
	sidecar: ReturnType<typeof Bun.spawn>,
): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (sidecar.exitCode !== null) {
			console.warn(
				`gRPC helper exited before readiness (code ${sidecar.exitCode})`,
			);
			return;
		}
		const client = await createTraceServiceClient(`127.0.0.1:${grpcPort}`);
		const answered = await new Promise<boolean>((resolve) => {
			client.Export(
				{ resourceSpans: [] },
				{ deadline: Date.now() + 1000 },
				() => resolve(true),
			);
			setTimeout(() => resolve(false), 1200);
		});
		client.close();
		if (answered) return;
		await sleep(100);
	}
	console.warn(`gRPC helper did not answer on 127.0.0.1:${grpcPort}`);
}

/** Start every configured receiver; the returned handle stops all of them. */
export async function startTelemetryReceivers(
	config: TelemetryReceiverConfig,
	sink: SignalRouter,
): Promise<OwnedTelemetryReceivers> {
	const servers: Array<ReturnType<typeof Bun.serve>> = [];
	const stops: Array<() => void> = [];

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

	let sidecar: ReturnType<typeof Bun.spawn> | undefined;
	if (config.grpcPort && config.httpPort) {
		sidecar = spawnGrpcSidecar(config.grpcPort, config.httpPort);
		await waitForGrpcReady(config.grpcPort, sidecar);
	} else if (config.grpcPort) {
		console.warn("gRPC telemetry requires --http-port");
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
			for (const stop of stops) stop();
			for (const server of servers) server.stop(true);
			if (sidecar) await stopGrpcSidecar(sidecar, 2000);
		},
	};
}
