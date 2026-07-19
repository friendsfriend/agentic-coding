/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { resolve } from 'node:path';
import { App } from './app/App';
import { spawn } from 'node:child_process';
import { routeReceiverRequest, startPrometheusScraper, startStatsDListener } from './receiver/index';
import { TraceDb } from './model/db';
import { TraceStore } from './model/traceStore';
import { MetricStore } from './model/metricStore';
import { LogStore } from './model/logStore';
import { TopologyStore } from './model/topologyStore';
import type { SpanData, MetricData, LogData } from './model/types';

const usage = `Usage: bun index.tsx --repo PATH [options]
Options:
  --repo PATH              Repository root (default: cwd)
  --http-port N            OTLP HTTP JSON port (default: 4318)
  --grpc-port N            OTLP gRPC port (sidecar)
  --zipkin-port N          Zipkin HTTP port
  --datadog-port N         Datadog HTTP port
  --prom-target HOST:PORT  Prometheus scrape target(s)
  --prom-interval N        Prometheus scrape interval seconds (default: 15)
  --statsd-port N          StatsD UDP port
  --demo-db                Use separate demo database with sample data
  --traces-only            Hide metrics/logs/topology tabs
  --help                   Show this help`;

function arg(name: string) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function portArg(name: string): number | undefined {
  if (!process.argv.includes(name)) return undefined;
  const port = Number(arg(name));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name} requires a port from 1 to 65535`);
    process.exit(1);
  }
  return port;
}

function intervalArg(name: string, fallback: number): number {
  const value = arg(name);
  if (value === undefined) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`${name} requires a positive number of seconds`);
    process.exit(1);
  }
  return seconds * 1000;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const repoPath = arg('--repo') ?? resolve('.');
const repo = resolve(repoPath);
const useDemoDb = process.argv.includes('--demo-db');
const explicitHttp = process.argv.includes('--http-port');
const httpPort = explicitHttp ? portArg('--http-port') : (useDemoDb ? undefined : 4318);
const grpcPort = portArg('--grpc-port');
const zipkinPort = portArg('--zipkin-port');
const datadogPort = portArg('--datadog-port');
const promTargets = (arg('--prom-target') ?? '').split(',').filter(Boolean).map(target => {
  const [host, rawPort] = target.split(':');
  const port = rawPort === undefined ? 9090 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--prom-target has invalid port: ${target}`);
    process.exit(1);
  }
  return { host: host || '127.0.0.1', port };
});
const promInterval = intervalArg('--prom-interval', 15_000);
const statsdPort = portArg('--statsd-port');
const tracesOnly = process.argv.includes('--traces-only');

const traceStore = new TraceStore();
const metricStore = new MetricStore();
const logStore = new LogStore();
const topologyStore = new TopologyStore();
let db: TraceDb;

const signalRouter = {
  pushTraces: (spans: SpanData[]) => traceStore.pushBatch(spans),
  pushMetrics: (metrics: MetricData[]) => metricStore.pushBatch(metrics),
  pushLogs: (logs: LogData[]) => logStore.pushBatch(logs),
};

// ---- Scan existing data or load demo ----
let demoSpans: SpanData[] = [];
if (useDemoDb) {
  const { db: demoDb, spans, metrics, logs } = await import('./model/demoDb').then(m => m.createDemoDb());
  db = demoDb;
  demoSpans = spans;
  traceStore.loadFile(spans);
  metricStore.load(metrics);
  logStore.load(logs);
} else {
  db = new TraceDb();
  db.scanAllWorkspaces(repo);
  db.cleanupOlderThan();
  traceStore.loadFile(db.loadSpans());
}

// ---- Spawn gRPC sidecar ----
let grpcSidecar: ReturnType<typeof spawn> | undefined;
if (grpcPort && httpPort) {
  const sidecarScript = new URL('./receiver/otlp-grpc-sidecar.ts', import.meta.url).pathname;
  grpcSidecar = spawn('bun', [sidecarScript, '--port', String(grpcPort), '--forward', `http://127.0.0.1:${httpPort}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  grpcSidecar.on('error', error => console.warn(`gRPC sidecar unavailable: ${error.message}`));
} else if (grpcPort) {
  console.warn('gRPC sidecar requires --http-port');
}

// ---- Start HTTP server for receivers ----
if (httpPort || zipkinPort || datadogPort) {
  const hostname = '127.0.0.1';
  const ports: number[] = [];
  if (httpPort) ports.push(httpPort);
  if (zipkinPort && zipkinPort !== httpPort) ports.push(zipkinPort);
  if (datadogPort && datadogPort !== httpPort && datadogPort !== zipkinPort) ports.push(datadogPort);

  const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
  try {
    for (const port of ports) {
      servers.push(Bun.serve({
        hostname,
        port,
        fetch: (request) => routeReceiverRequest(request, signalRouter) ?? new Response('not found', { status: 404 }),
      }));
    }
  } catch (error) {
    servers.forEach(server => server.stop(true));
    console.error(`Cannot start receiver: ${String(error)}`);
    process.exit(1);
  }
}

// ---- Start Prometheus scraper ----
let stopPrometheus: (() => void) | undefined;
if (promTargets.length) {
  stopPrometheus = startPrometheusScraper(promTargets, promInterval, signalRouter);
}

// ---- Start StatsD listener ----
let stopStatsD: (() => void) | undefined;
if (statsdPort) {
  const statsd = startStatsDListener(statsdPort, `statsd-${statsdPort}`, signalRouter);
  stopStatsD = statsd.stop;
}

// ---- Build topology from loaded spans ----
const spansForTopology = useDemoDb ? demoSpans : (traceStore.spanCount_ > 0 ? db.loadSpans() : []);
topologyStore.load(spansForTopology);

// ---- Render app ----
const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: false, useKittyKeyboard: {}, exitSignals: [] });
(globalThis as any).__renderer = renderer;

const cleanup = () => {
  grpcSidecar?.kill();
  stopPrometheus?.();
  stopStatsD?.();
  renderer.destroy();
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);

await render(() => <App
  repo={repo}
  db={db}
  traceStore={traceStore}
  metricStore={metricStore}
  logStore={logStore}
  topologyStore={topologyStore}
  tracesOnly={tracesOnly}
/>, renderer);
await new Promise<void>(done => renderer.once('destroy', done));
