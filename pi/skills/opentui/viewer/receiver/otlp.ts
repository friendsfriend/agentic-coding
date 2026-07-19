import type { SpanData, MetricData, MetricDataPoint, LogData } from '../model/types';

function id(value: unknown, size: number): boolean {
  return typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length === size;
}

function nanos(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value.toString();
  return undefined;
}

function attrValue(item: any): string | number | boolean | undefined {
  return item?.stringValue ?? item?.boolValue ?? (item?.intValue !== undefined ? Number(item.intValue) : item?.doubleValue);
}

function normAttrs(attrs: unknown): Array<{ key: string; value: string | number | boolean }> {
  if (Array.isArray(attrs)) return attrs.map(a => ({ key: String(a.key ?? ''), value: attrValue(a.value) ?? '' }));
  if (attrs && typeof attrs === 'object') return Object.entries(attrs as Record<string, unknown>).map(([k, v]) => ({ key: k, value: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v) }));
  return [];
}

function strAttrs(attrs: unknown): Array<{ key: string; value: string }> {
  if (Array.isArray(attrs)) return attrs.map(a => ({ key: String(a.key ?? ''), value: String(attrValue(a.value) ?? '') }));
  if (attrs && typeof attrs === 'object') return Object.entries(attrs as Record<string, unknown>).map(([k, v]) => ({ key: k, value: String(v) }));
  return [];
}

// ---- Spans ----

export function normalizeOtlpSpan(raw: any): SpanData | undefined {
  if (!raw || !id(raw.traceId, 32) || !id(raw.spanId, 16) || typeof raw.name !== 'string' || !nanos(raw.startTimeUnixNano) || !nanos(raw.endTimeUnixNano)) return undefined;
  const status = typeof raw.status === 'object' && raw.status !== null
    ? { code: Number(raw.status.code ?? 0), message: raw.status.message ?? undefined }
    : { code: raw.status === 'ERROR' ? 2 : 0 };
  const attributes = normAttrs(raw.attributes ?? []);
  const resourceAttributes = normAttrs(raw.resource?.attributes ?? []);
  const serviceName = String(attributes.find((a: any) => a.key === 'service.name')?.value
    ?? resourceAttributes.find((a: any) => a.key === 'service.name')?.value
    ?? 'unknown');
  return {
    traceId: String(raw.traceId).toLowerCase(),
    spanId: String(raw.spanId).toLowerCase(),
    parentSpanId: id(raw.parentSpanId, 16) ? String(raw.parentSpanId).toLowerCase() : '',
    name: raw.name,
    startTimeUnixNano: nanos(raw.startTimeUnixNano)!,
    endTimeUnixNano: nanos(raw.endTimeUnixNano)!,
    status,
    attributes,
    resource: { attributes: resourceAttributes, droppedAttributesCount: Number(raw.resource?.droppedAttributesCount ?? 0) },
    scope: { name: raw.scope?.name ?? '', version: raw.scope?.version ?? '' },
    serviceName,
    kind: Number(raw.kind ?? 0),
  };
}

export function decodeOtlpTraces(payload: any): SpanData[] {
  const spans: SpanData[] = [];
  for (const resource of payload?.resourceSpans ?? []) {
    const resAttrs = strAttrs(resource.resource?.attributes ?? []);
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const normalized = normalizeOtlpSpan({ ...span, attributes: [...resAttrs, ...strAttrs(span.attributes ?? [])], resource: { attributes: resAttrs, droppedAttributesCount: 0 } });
        if (normalized) spans.push(normalized);
      }
    }
  }
  return spans;
}

// ---- Metrics ----

export function decodeOtlpMetrics(payload: any): MetricData[] {
  const metrics: MetricData[] = [];
  for (const resource of payload?.resourceMetrics ?? []) {
    const resAttrs = strAttrs(resource.resource?.attributes ?? []);
    const serviceName = resAttrs.find(a => a.key === 'service.name')?.value ?? 'unknown';
    for (const scope of resource.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        const pts = metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? [];
        const type = metric.gauge ? 'gauge' : metric.sum ? 'sum' : metric.histogram ? 'histogram' : 'gauge';
        const dataPoints: MetricDataPoint[] = pts.map((dp: any) => ({
          startTimeUnixNano: dp.startTimeUnixNano ?? dp.timeUnixNano ?? '0',
          timeUnixNano: dp.timeUnixNano ?? '0',
          value: Number(dp.asDouble ?? dp.asInt ?? dp.count ?? 0),
          bucketCounts: dp.bucketCounts?.map(Number),
          explicitBounds: dp.explicitBounds?.map(Number),
          attributes: strAttrs(dp.attributes ?? []),
        }));
        metrics.push({
          resource: { attributes: resAttrs },
          scope: { name: scope.scope?.name ?? '', version: scope.scope?.version ?? '' },
          name: metric.name ?? '',
          description: metric.description ?? '',
          unit: metric.unit ?? '',
          type: type as 'gauge' | 'sum' | 'histogram',
          dataPoints,
          serviceName,
        });
      }
    }
  }
  return metrics;
}

// ---- Logs ----

export function decodeOtlpLogs(payload: any): LogData[] {
  const logs: LogData[] = [];
  for (const resource of payload?.resourceLogs ?? []) {
    const resAttrs = strAttrs(resource.resource?.attributes ?? []);
    const serviceName = resAttrs.find(a => a.key === 'service.name')?.value ?? 'unknown';
    for (const scope of resource.scopeLogs ?? []) {
      for (const log of scope.logRecords ?? []) {
        logs.push({
          resource: { attributes: resAttrs },
          scope: { name: scope.scope?.name ?? '', version: scope.scope?.version ?? '' },
          timeUnixNano: log.timeUnixNano ?? '0',
          severity: log.severityText ?? 'INFO',
          body: typeof log.body?.stringValue === 'string' ? log.body.stringValue : JSON.stringify(log.body ?? ''),
          attributes: strAttrs(log.attributes ?? []),
          traceId: log.traceId ? String(log.traceId).toLowerCase() : undefined,
          spanId: log.spanId ? String(log.spanId).toLowerCase() : undefined,
          serviceName,
        });
      }
    }
  }
  return logs;
}
