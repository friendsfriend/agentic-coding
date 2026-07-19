import type { SpanData } from './types';

const id = (value: unknown, size: number) => typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length === size;
const nanos = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value);
const attrValue = (item: any): string | number | boolean | undefined =>
  item?.stringValue ?? item?.boolValue ?? (item?.intValue !== undefined ? Number(item.intValue) : item?.doubleValue);

function normalizeAttrs(attrs: unknown): Array<{ key: string; value: string | number | boolean }> {
  if (Array.isArray(attrs)) return attrs.map(a => ({ key: String(a.key ?? ''), value: attrValue(a.value) ?? '' }));
  if (attrs && typeof attrs === 'object') return Object.entries(attrs as Record<string, unknown>).map(([k, v]) => ({ key: k, value: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v) }));
  return [];
}

export function parseLine(line: string): SpanData | undefined {
  try {
    const raw = JSON.parse(line);
    if (!raw || !id(raw.traceId, 32) || !id(raw.spanId, 16) || typeof raw.name !== 'string' || !nanos(raw.startTimeUnixNano) || !nanos(raw.endTimeUnixNano)) return undefined;
    const status = typeof raw.status === 'object' && raw.status !== null
      ? { code: Number(raw.status.code ?? 0), message: raw.status.message ?? undefined }
      : { code: raw.status === 'ERROR' ? 2 : raw.status === 'OK' ? 0 : 0 };
    const attributes = normalizeAttrs(raw.attributes ?? []);
    const resourceAttributes = normalizeAttrs(raw.resource?.attributes ?? []);
    const serviceName = String(attributes.find(attribute => attribute.key === 'service.name')?.value
      ?? resourceAttributes.find(attribute => attribute.key === 'service.name')?.value
      ?? 'unknown');
    return {
      traceId: raw.traceId.toLowerCase(),
      spanId: raw.spanId.toLowerCase(),
      parentSpanId: id(raw.parentSpanId, 16) ? String(raw.parentSpanId).toLowerCase() : '',
      name: raw.name,
      startTimeUnixNano: raw.startTimeUnixNano,
      endTimeUnixNano: raw.endTimeUnixNano,
      status,
      attributes,
      resource: {
        attributes: resourceAttributes,
        droppedAttributesCount: Number(raw.resource?.droppedAttributesCount ?? 0),
      },
      scope: { name: raw.scope?.name ?? '', version: raw.scope?.version ?? '' },
      serviceName,
      kind: Number(raw.kind ?? 0),
    };
  } catch {
    return undefined;
  }
}

export function parseJsonl(text: string): SpanData[] {
  const spans: SpanData[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const span = parseLine(line);
    if (span) spans.push(span);
  }
  return spans;
}
