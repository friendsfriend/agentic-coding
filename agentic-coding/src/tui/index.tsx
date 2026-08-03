/** @jsxImportSource @opentui/solid */
// `agentic-coding` TUI entry — one process, one renderer. Modes:
//   --home / manager   long-lived launcher: receiver on 4318 + workflow list + observability
//   --repo P --change C  per-workflow dashboard pane: no receiver (manager owns it), file-based traces
//   --profile test     interactive dummy data
//   --json             dump dashboard JSON and exit (headless/CI)
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider } from '@opentui/keymap/solid';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { routeReceiverRequest, startPrometheusScraper, startStatsDListener } from './otel/receiver/index';
import { TraceDb, discoverProjectRepos } from './otel/model/db';
import { TraceStore } from './otel/model/traceStore';
import { MetricStore } from './otel/model/metricStore';
import { LogStore } from './otel/model/logStore';
import { TopologyStore } from './otel/model/topologyStore';
import type { SpanData, MetricData, LogData } from './otel/model/types';

import { applyTheme as applyDashTheme, loadThemeName as loadDashThemeName } from './dash/theme-settings';
import { setupKeymap } from './dash/keymap-setup';
import { setGlobalSelectionMouseUpHandler } from './dash/selectionCopy';
import { copyToClipboard } from './dash/clipboard';
import { notify } from './dash/notifications';
import { listWorkflows, loadDashboard, testDashboard } from './dash/data';
import { App as OtelApp } from './otel/app/App';

const usage = `Usage: agentic-coding dash|home|manager [options]
  --repo PATH              Repository root (default: cwd)
  --change ID              Change id (dash mode)
  --home / manager         Workflow list + observability (long-lived)
  --profile test           Interactive dummy data
  --json                   Dump dashboard JSON and exit
  --http-port N            OTLP HTTP JSON port (default 4318 in home/manager mode)
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

export async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }

  const profile = arg('--profile');
  const home = process.argv.includes('--home') || process.argv.includes('manager');
  const isTest = profile === 'test';
  const repoArg = arg('--repo');
  const change = arg('--change');
  if (!home && !isTest && (!repoArg || !change)) {
    console.error('usage: agentic-coding home|manager\n       agentic-coding dash --repo PATH --change ID [--json]\n       agentic-coding dash --profile test [--json]');
    process.exit(2);
  }
  const repo = repoArg ? resolve(repoArg) : '/demo';
  const resolvedChange = change ?? 'demo-optional-realisation-date';
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(home ? listWorkflows() : isTest ? testDashboard() : loadDashboard(repo, resolvedChange), null, 2));
    process.exit(0);
  }

  // ---- observability bootstrap (stores + receiver at shell level) ----
  const useDemoDb = process.argv.includes('--demo-db');
  const explicitHttp = process.argv.includes('--http-port');
  const httpPort = explicitHttp ? portArg('--http-port') : (home && !useDemoDb ? 4318 : undefined);
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
  const repos = Array.from(new Set([repo, ...discoverProjectRepos()]));
  if (useDemoDb) {
    const { db: demoDb, spans, metrics, logs } = await import('./otel/model/demoDb').then(m => m.createDemoDb());
    db = demoDb;
    demoSpans = spans;
    traceStore.loadFile(spans);
    metricStore.load(metrics);
    logStore.load(logs);
  } else {
    db = new TraceDb();
    for (const r of repos) db.scanAllWorkspaces(r);
    db.cleanupOlderThan();
    traceStore.loadFile(db.loadSpans());
  }

  // ---- Spawn gRPC sidecar ----
  let grpcSidecar: ReturnType<typeof spawn> | undefined;
  if (grpcPort && httpPort) {
    // Compiled binaries embed no source files; the sidecar is a second executable
    // built next to this one. Source runs spawn the script via bun.
    const compiled = import.meta.url.includes('/$bunfs/') || import.meta.url.includes('B:/~BUN/');
    const sidecarScript = compiled
      ? join(dirname(process.execPath), 'agentic-coding-grpc-sidecar')
      : new URL('./otel/receiver/otlp-grpc-sidecar.ts', import.meta.url).pathname;
    grpcSidecar = spawn(compiled ? sidecarScript : 'bun', [sidecarScript, '--port', String(grpcPort), '--forward', `http://127.0.0.1:${httpPort}`], {
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
  applyDashTheme(loadDashThemeName());
  process.env.FORCE_COLOR = '3';
  const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: false, useKittyKeyboard: {}, exitSignals: [] });
  (globalThis as any).__renderer = renderer;

  // Always catch async exceptions: an uncaught throw inside the input/render
  // loops would otherwise kill key and mouse handling entirely. Log to stderr;
  // AGENTIC_CODING_TRACE additionally captures them to a file.
  const traceFile = process.env.AGENTIC_CODING_TRACE;
  const append = (msg: string) => {
    if (traceFile) {
      try { require('node:fs').appendFileSync(traceFile, `${Date.now()} ${msg}\n`); } catch { /* noop */ }
    } else {
      console.error(`[agentic-coding] ${msg}`);
    }
  };
  process.on('uncaughtException', (error) => append(`UNCAUGHT: ${error?.stack ?? String(error)}`));
  process.on('unhandledRejection', (reason) => append(`UNHANDLED_REJECTION: ${String(reason)}`));
  // Registered before the keymap: empirically, an extra early keypress listener
  // changes input dispatch on some terminals (Ghostty+herdr). Kept while the
  // interaction is investigated; harmless either way.
  renderer.keyInput.on('keypress', () => { /* noop */ });
  if (traceFile) {
    append('startup: renderer created');
    const heartbeat = setInterval(() => append('alive'), 2000);
    const cleanupTrace = () => { clearInterval(heartbeat); };
    process.on('exit', cleanupTrace);
  }

  const cleanup = () => {
    grpcSidecar?.kill();
    stopPrometheus?.();
    stopStatsD?.();
    db.close();
    renderer.destroy();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  const clearSelectionCopy = setGlobalSelectionMouseUpHandler(() => {
    const text = renderer.getSelection()?.getSelectedText();
    if (text) {
      if (copyToClipboard(text)) notify('Copied', 'success');
      else notify('Copy failed', 'error');
      renderer.clearSelection();
    }
  });
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const disposeKeymap = setupKeymap(keymap);
  keymap.setData('app.view', home ? 'home' : 'detail');
  keymap.setData('modal.active', 'none');

  await render(() => (
    <KeymapProvider keymap={keymap}>
      <OtelApp
        repos={repos}
        db={db}
        traceStore={traceStore}
        metricStore={metricStore}
        logStore={logStore}
        topologyStore={topologyStore}
        tracesOnly={tracesOnly}
        dashboard={{
          mode: home ? 'home' : 'dash',
          repo: home ? undefined : repo,
          change: home ? undefined : resolvedChange,
          profile: isTest ? 'test' : undefined,
          keymap,
        }}
      />
    </KeymapProvider>
  ), renderer);
  await new Promise<void>(done => renderer.once('destroy', done));
  clearSelectionCopy();
  disposeKeymap();
}

if (import.meta.main) {
  await main();
}
