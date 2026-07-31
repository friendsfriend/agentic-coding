import type { SpanData, MetricData, MetricDataPoint, LogData } from '../model/types';

// ---- Datadog Trace -> SpanData ----

interface DDTraceSpan {
  trace_id: number | string;
  span_id: number | string;
  parent_id?: number | string;
  name: string;
  service: string;
  resource?: string;
  start: number;
  duration?: number;
  error?: number;
  meta?: Record<string, string>;
}

function idToString(id: number | string): string {
  return typeof id === 'number' ? BigInt(id).toString(16).padStart(16, '0') : id;
}

function nanos(us: number): string {
  return BigInt(Math.floor(us * 1000)).toString();
}

export function normalizeDatadogSpans(body: unknown): SpanData[] {
  // DD trace payload: [[{...}, ...], ...] — array of trace arrays
  if (!Array.isArray(body)) throw new Error('expected array of trace arrays');
  const spans: SpanData[] = [];
  for (const trace of body) {
    if (!Array.isArray(trace)) continue;
    for (const raw of trace) {
      spans.push(normalizeDatadogSpan(raw));
    }
  }
  return spans;
}

function normalizeDatadogSpan(raw: DDTraceSpan): SpanData {
  const start = nanos(raw.start);
  const end = nanos(raw.start + (raw.duration ?? 0));
  const error = raw.error ?? 0;
  const meta = raw.meta ?? {};

  return {
    traceId: idToString(raw.trace_id),
    spanId: idToString(raw.span_id),
    parentSpanId: raw.parent_id != null ? idToString(raw.parent_id) : '',
    name: raw.name,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    status: { code: error ? 2 : 0, message: error ? meta.error ?? 'error' : undefined },
    attributes: Object.entries(meta).map(([key, value]) => ({ key, value })),
    resource: { attributes: [{ key: 'service.name', value: raw.service }], droppedAttributesCount: 0 },
    scope: { name: 'datadog', version: '' },
    serviceName: raw.service,
    kind: 2,
  };
}

// ---- Datadog Series Metrics -> MetricData ----

interface DDSeriesPayload {
  series?: Array<{
    metric: string;
    type?: string;
    points?: Array<[number, number]>;
    tags?: string[];
    host?: string;
    source_type_name?: string;
  }>;
}

export function normalizeDatadogSeries(body: unknown): MetricData[] {
  const payload = body as DDSeriesPayload;
  if (!payload?.series) throw new Error('expected series array');
  return payload.series.map(s => {
    const points: MetricDataPoint[] = (s.points ?? []).map(([ts, val]) => ({
      startTimeUnixNano: BigInt(ts * 1_000_000_000).toString(),
      timeUnixNano: BigInt(ts * 1_000_000_000).toString(),
      value: val,
      attributes: (s.tags ?? []).map(t => {
        const [k, v] = t.split('=', 2);
        return { key: k ?? t, value: v ?? 'true' };
      }),
    }));
    return {
      resource: { attributes: [] },
      scope: { name: 'datadog', version: '' },
      name: s.metric,
      description: '',
      unit: '',
      type: (s.type === 'rate' || s.type === 'count') ? 'sum' : 'gauge',
      dataPoints: points,
      serviceName: s.host ?? 'datadog',
    };
  });
}

// ---- Datadog Logs -> LogData ----

interface DDLogEntry {
  message: string;
  status?: string;
  timestamp?: string;
  service?: string;
  dd?: { trace_id?: string; span_id?: string };
  [key: string]: unknown;
}

export function normalizeDatadogLogs(body: unknown): LogData[] {
  if (!Array.isArray(body)) throw new Error('expected array of log entries');
  return body.map(normalizeDatadogLog);
}

function normalizeDatadogLog(raw: DDLogEntry): LogData {
  const ts = raw.timestamp
    ? BigInt(new Date(raw.timestamp).getTime() * 1_000_000).toString()
    : BigInt(Date.now() * 1_000_000).toString();
  const severityMap: Record<string, string> = { emerg: 'FATAL', alert: 'ERROR', crit: 'ERROR', err: 'ERROR', warning: 'WARN', warn: 'WARN', notice: 'INFO', info: 'INFO', debug: 'DEBUG', trace: 'TRACE' };
  const severity = severityMap[raw.status?.toLowerCase() ?? ''] ?? 'INFO';
  const attrs = Object.entries(raw)
    .filter(([k]) => !['message', 'status', 'timestamp', 'service', 'dd'].includes(k))
    .map(([k, v]) => ({ key: k, value: String(v) }));

  return {
    resource: { attributes: [{ key: 'service.name', value: raw.service ?? 'datadog' }] },
    scope: { name: 'datadog', version: '' },
    timeUnixNano: ts,
    severity,
    body: raw.message ?? '',
    attributes: attrs,
    traceId: raw.dd?.trace_id,
    spanId: raw.dd?.span_id,
    serviceName: raw.service ?? 'datadog',
  };
}
