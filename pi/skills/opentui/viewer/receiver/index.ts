import type { SpanData, MetricData, LogData } from '../model/types';
import { decodeOtlpTraces, decodeOtlpMetrics, decodeOtlpLogs } from './otlp';
import { normalizeZipkinSpans } from './zipkin';
import { normalizeDatadogSpans, normalizeDatadogSeries, normalizeDatadogLogs } from './datadog';
import { scrapePrometheus } from './prometheus';
import { normalizeStatsDMetrics } from './statsd';

export interface SignalRouter {
  pushTraces: (spans: SpanData[]) => void;
  pushMetrics: (metrics: MetricData[]) => void;
  pushLogs: (logs: LogData[]) => void;
}

// ---- HTTP request router for receiver endpoints ----

export function routeReceiverRequest(request: Request, router: SignalRouter): Response | null {
  const url = new URL(request.url);
  const path = url.pathname;

  // OTLP HTTP — existing path
  if (path === '/v1/traces' && request.method === 'POST') return handleOtlpTraces(request, router);
  if (path === '/v1/metrics' && request.method === 'POST') return handleOtlpMetrics(request, router);
  if (path === '/v1/logs' && request.method === 'POST') return handleOtlpLogs(request, router);

  // Zipkin
  if (path === '/api/v2/spans' && request.method === 'POST') return handleZipkin(request, router);

  // Datadog traces (multi-version)
  if (['/v0.3/traces', '/v0.4/traces', '/v0.5/traces', '/api/v0.2/traces'].includes(path) && request.method === 'POST') return handleDatadogTraces(request, router);
  // Datadog metrics
  if (['/api/v1/series', '/api/v2/series'].includes(path) && request.method === 'POST') return handleDatadogSeries(request, router);
  // Datadog logs
  if (path === '/api/v2/logs' && request.method === 'POST') return handleDatadogLogs(request, router);

  return null; // not a receiver route
}

// ---- OTLP handlers ----

async function body(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: ArrayBuffer[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return new Blob(chunks).text();
    size += next.value.byteLength;
    if (size > 5_000_000) throw new RangeError('payload too large');
    chunks.push(next.value.buffer.slice(next.value.byteOffset, next.value.byteOffset + next.value.byteLength) as ArrayBuffer);
  }
}

function otlpResponse() {
  return Response.json({ partialSuccess: {} });
}

function errorResponse(status: number, message: string) {
  return new Response(message, { status });
}

async function handleOtlpTraces(request: Request, router: SignalRouter): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return errorResponse(415, 'OTLP HTTP JSON required');
  try {
    const spans = decodeOtlpTraces(JSON.parse(await body(request)));
    if (!spans.length) return errorResponse(400, 'no valid spans');
    router.pushTraces(spans);
    return otlpResponse();
  } catch (e) {
    return errorResponse(e instanceof RangeError ? 413 : 400, String(e));
  }
}

async function handleOtlpMetrics(request: Request, router: SignalRouter): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return errorResponse(415, 'OTLP HTTP JSON required');
  try {
    const metrics = decodeOtlpMetrics(JSON.parse(await body(request)));
    if (!metrics.length) return errorResponse(400, 'no valid metrics');
    router.pushMetrics(metrics);
    return otlpResponse();
  } catch (e) {
    return errorResponse(e instanceof RangeError ? 413 : 400, String(e));
  }
}

async function handleOtlpLogs(request: Request, router: SignalRouter): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return errorResponse(415, 'OTLP HTTP JSON required');
  try {
    const logs = decodeOtlpLogs(JSON.parse(await body(request)));
    if (!logs.length) return errorResponse(400, 'no valid logs');
    router.pushLogs(logs);
    return otlpResponse();
  } catch (e) {
    return errorResponse(e instanceof RangeError ? 413 : 400, String(e));
  }
}

// ---- Zipkin ----

async function handleZipkin(request: Request, router: SignalRouter): Promise<Response> {
  try {
    const spans = normalizeZipkinSpans(JSON.parse(await body(request)));
    router.pushTraces(spans);
    return Response.json({});
  } catch (e) {
    return errorResponse(400, String(e));
  }
}

// ---- Datadog ----

async function handleDatadogTraces(request: Request, router: SignalRouter): Promise<Response> {
  try {
    const spans = normalizeDatadogSpans(JSON.parse(await body(request)));
    router.pushTraces(spans);
    return Response.json({});
  } catch (e) {
    return errorResponse(400, String(e));
  }
}

async function handleDatadogSeries(request: Request, router: SignalRouter): Promise<Response> {
  try {
    const metrics = normalizeDatadogSeries(JSON.parse(await body(request)));
    router.pushMetrics(metrics);
    return Response.json({});
  } catch (e) {
    return errorResponse(400, String(e));
  }
}

async function handleDatadogLogs(request: Request, router: SignalRouter): Promise<Response> {
  try {
    const logs = normalizeDatadogLogs(JSON.parse(await body(request)));
    router.pushLogs(logs);
    return Response.json({});
  } catch (e) {
    return errorResponse(400, String(e));
  }
}

// ---- Prometheus scrape (timer-based, not HTTP-triggered) ----

export function startPrometheusScraper(targets: Array<{ host: string; port: number }>, intervalMs: number, router: SignalRouter): () => void {
  let running = true;
  async function scrape() {
    if (!running) return;
    for (const target of targets) {
      try {
        const metrics = await scrapePrometheus(target);
        router.pushMetrics(metrics);
      } catch { /* log and retry */ }
    }
  }
  scrape(); // immediate first scrape
  const timer = setInterval(scrape, intervalMs);
  return () => { running = false; clearInterval(timer); };
}

// ---- StatsD UDP listener (start/stop) ----

export function startStatsDListener(port: number, source: string, router: SignalRouter): { stop: () => void } {
  // Bun UDP listener
  const udp = Bun.udpSocket({
    hostname: '0.0.0.0',
    port,
    data: (socket, buffer) => {
      const text = new TextDecoder().decode(buffer);
      const lines = text.split('\n').filter(l => l.trim());
      const metrics = normalizeStatsDMetrics(lines, source);
      if (metrics.length) router.pushMetrics(metrics);
    },
  });
  return { stop: () => { try { udp.close(); } catch {} } };
}
