import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceDb } from './db';
import type { SpanData, MetricData, LogData } from './types';

function hex(size: number): string {
  let s = '';
  for (let i = 0; i < size; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function nanosAgo(seconds: number): string {
  return (BigInt(Date.now() - seconds * 1000) * 1_000_000n).toString();
}

function makeSpan(traceId: string, spanId: string, parentSpanId: string | undefined, name: string, svc: string, startSec: number, durMs: number, error: boolean): SpanData {
  const start = nanosAgo(startSec);
  const end = (BigInt(start) + BigInt(durMs) * 1_000_000n).toString();
  return {
    traceId, spanId, parentSpanId: parentSpanId ?? '',
    name, startTimeUnixNano: start, endTimeUnixNano: end,
    status: { code: error ? 2 : 0, message: error ? 'timeout' : undefined },
    attributes: [{ key: 'service.name', value: svc }, { key: 'demo', value: 'true' }],
    resource: { attributes: [{ key: 'service.name', value: svc }], droppedAttributesCount: 0 },
    scope: { name: 'demo', version: '1.0' },
    serviceName: svc, kind: 1,
  };
}

function seedSpans(): SpanData[] {
  const spans: SpanData[] = [];
  // Workspace "demo-api"
  const t1 = hex(32);
  const s1 = hex(16);
  spans.push(makeSpan(t1, s1, undefined, 'HTTP GET /users', 'api-gateway', 300, 120, false));
  const s2 = hex(16);
  spans.push(makeSpan(t1, s2, s1, 'UsersService.findAll', 'users-svc', 295, 85, false));
  const s3 = hex(16);
  spans.push(makeSpan(t1, s3, s2, 'Postgres.query', 'users-svc', 290, 45, false));
  const s4 = hex(16);
  spans.push(makeSpan(t1, s4, s1, 'Cache.get', 'cache-svc', 298, 5, false));

  // Errored trace
  const t2 = hex(32);
  const s5 = hex(16);
  spans.push(makeSpan(t2, s5, undefined, 'HTTP POST /order', 'api-gateway', 200, 5000, true));
  const s6 = hex(16);
  spans.push(makeSpan(t2, s6, s5, 'OrdersService.create', 'orders-svc', 195, 4800, true));
  const s7 = hex(16);
  spans.push(makeSpan(t2, s7, s6, 'PaymentGateway.charge', 'payment-svc', 190, 4500, true));

  // Workspace "demo-worker"
  const t3 = hex(32);
  const s8 = hex(16);
  spans.push(makeSpan(t3, s8, undefined, 'agent.operation', 'herdr-agent', 150, 2000, false));
  const s9 = hex(16);
  spans.push(makeSpan(t3, s9, s8, 'LLM.generate', 'herdr-agent', 145, 1800, false));
  const s10 = hex(16);
  spans.push(makeSpan(t3, s10, s8, 'tool.execute', 'herdr-agent', 148, 500, false));

  return spans;
}

function seedMetrics(): MetricData[] {
  const metrics: MetricData[] = [];
  const now = Date.now() * 1_000_000;

  // Gauge: CPU usage
  const cpuPoints = [];
  for (let i = 0; i < 20; i++) {
    cpuPoints.push({
      startTimeUnixNano: (now - (19 - i) * 30_000_000_000).toString(),
      timeUnixNano: (now - (19 - i) * 30_000_000_000).toString(),
      value: 30 + Math.random() * 60,
      attributes: [],
    });
  }
  metrics.push({
    resource: { attributes: [] }, scope: { name: 'demo', version: '1.0' },
    name: 'cpu.usage', description: 'CPU usage percentage', unit: '%',
    type: 'gauge', dataPoints: cpuPoints, serviceName: 'api-gateway',
  });

  // Sum: HTTP requests
  const reqPoints = [];
  for (let i = 0; i < 15; i++) {
    reqPoints.push({
      startTimeUnixNano: (now - (14 - i) * 60_000_000_000).toString(),
      timeUnixNano: (now - (14 - i) * 60_000_000_000).toString(),
      value: Math.floor(Math.random() * 100),
      attributes: [{ key: 'method', value: 'GET' }],
    });
  }
  metrics.push({
    resource: { attributes: [] }, scope: { name: 'demo', version: '1.0' },
    name: 'http.requests', description: 'HTTP request count', unit: 'req',
    type: 'sum', dataPoints: reqPoints, serviceName: 'api-gateway',
  });

  // Histogram: latency distribution
  metrics.push({
    resource: { attributes: [] }, scope: { name: 'demo', version: '1.0' },
    name: 'http.latency', description: 'HTTP latency distribution', unit: 'ms',
    type: 'histogram', dataPoints: [{
      startTimeUnixNano: (now - 300_000_000_000).toString(),
      timeUnixNano: now.toString(),
      value: 0,
      bucketCounts: [5, 15, 30, 20, 10],
      explicitBounds: [10, 50, 100, 500, 1000],
      attributes: [],
    }], serviceName: 'api-gateway',
  });

  // Gauge: memory
  const memPoints = [];
  for (let i = 0; i < 10; i++) {
    memPoints.push({
      startTimeUnixNano: (now - (9 - i) * 30_000_000_000).toString(),
      timeUnixNano: (now - (9 - i) * 30_000_000_000).toString(),
      value: 256 + Math.random() * 128,
      attributes: [{ key: 'host', value: 'node-1' }],
    });
  }
  metrics.push({
    resource: { attributes: [] }, scope: { name: 'demo', version: '1.0' },
    name: 'mem.usage', description: 'Memory usage', unit: 'MB',
    type: 'gauge', dataPoints: memPoints, serviceName: 'orders-svc',
  });

  return metrics;
}

function seedLogs(traceIds: string[]): LogData[] {
  const logs: LogData[] = [];
  const sevs = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  const msgs = [
    'Request received',
    'Connecting to database',
    'Query executed in 42ms',
    'Cache miss for key users:123',
    'Payment gateway returned 503',
    'Retry attempt 2/3',
    'Connection pool exhausted',
    'Response sent with status 200',
    'Authentication token validated',
    'Serialization completed',
  ];
  const svcs = ['api-gateway', 'users-svc', 'orders-svc', 'payment-svc', 'cache-svc'];

  for (let i = 0; i < 50; i++) {
    const sevIdx = Math.random() < 0.7 ? 2 : Math.floor(Math.random() * sevs.length); // bias INFO
    const traceId = Math.random() < 0.5 && traceIds.length ? traceIds[Math.floor(Math.random() * traceIds.length)] : undefined;
    logs.push({
      resource: { attributes: [] },
      scope: { name: 'demo', version: '1.0' },
      timeUnixNano: (BigInt(Date.now() - Math.floor(Math.random() * 600) * 1000) * 1_000_000n).toString(),
      severity: sevs[Math.min(sevIdx, sevs.length - 1)]!,
      body: msgs[Math.floor(Math.random() * msgs.length)]!,
      attributes: [{ key: 'demo', value: 'true' }],
      traceId,
      spanId: traceId ? hex(16) : undefined,
      serviceName: svcs[Math.floor(Math.random() * svcs.length)]!,
    });
  }
  return logs;
}

export function createDemoDb(): { db: TraceDb; spans: SpanData[]; metrics: MetricData[]; logs: LogData[] } {
  const dbPath = join(tmpdir(), 'otel-tui-demo.sqlite');
  const db = new TraceDb(dbPath);

  const spans = seedSpans();
  const metrics = seedMetrics();
  const traceIds = [...new Set(spans.map(s => s.traceId))];
  const logs = seedLogs(traceIds);

  // Ingest into DB using change_id 'demo'
  db.ingestMetrics('demo', metrics);
  db.ingestLogs('demo', logs);
  // Spans use ingestWorkspace pattern
  // Store spans directly via the DB's prepared statement pattern
  for (const span of spans) {
    (db as any).ingestStmt.run({ $change_id: 'demo', $span: JSON.stringify(span) });
  }

  return { db, spans, metrics, logs };
}
