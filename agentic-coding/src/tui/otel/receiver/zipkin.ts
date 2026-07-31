import type { SpanData } from '../model/types';

interface ZipkinSpan {
  traceId: string;
  id: string;
  parentId?: string;
  name: string;
  timestamp?: number;
  duration?: number;
  localEndpoint?: { serviceName?: string };
  tags?: Record<string, string>;
}

function hexToNanos(hexMicros: number | undefined): string {
  return BigInt(Math.floor((hexMicros ?? 0) * 1000)).toString();
}

export function normalizeZipkinSpans(body: unknown): SpanData[] {
  if (!Array.isArray(body)) throw new Error('expected array');
  return body.map(normalizeZipkinSpan);
}

export function normalizeZipkinSpan(raw: ZipkinSpan): SpanData {
  const serviceName = raw.localEndpoint?.serviceName ?? 'unknown';
  const startTimeNanos = hexToNanos(raw.timestamp);
  const endTimeNanos = BigInt(raw.timestamp ?? 0) * 1000n + BigInt(raw.duration ?? 0) * 1000n;
  const tags = raw.tags ?? {};
  const statusCode = tags.error ? 2 : 0;

  return {
    traceId: raw.traceId.toLowerCase(),
    spanId: raw.id.toLowerCase(),
    parentSpanId: raw.parentId?.toLowerCase() ?? '',
    name: raw.name,
    startTimeUnixNano: startTimeNanos,
    endTimeUnixNano: endTimeNanos.toString(),
    status: { code: statusCode, message: tags.error },
    attributes: Object.entries(tags).map(([key, value]) => ({ key, value })),
    resource: { attributes: [{ key: 'service.name', value: serviceName }], droppedAttributesCount: 0 },
    scope: { name: 'zipkin', version: '' },
    serviceName,
    kind: 2, // SPAN_KIND_SERVER
  };
}
