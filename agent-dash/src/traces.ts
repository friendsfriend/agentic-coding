export type TraceValue = string | number | boolean;
export interface TraceSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; status?: string; attributes: Record<string, TraceValue>; }
export interface Trace { id: string; spans: TraceSpan[]; }

const id = (value: unknown, size: number) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`, 'i').test(value);
const nanos = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n;
const value = (item: any): TraceValue | undefined => item?.stringValue ?? item?.boolValue ?? (item?.intValue !== undefined ? Number(item.intValue) : item?.doubleValue);
export function validSpan(span: any): span is TraceSpan { return !!span && id(span.traceId, 32) && id(span.spanId, 16) && typeof span.name === 'string' && nanos(span.startTimeUnixNano) && nanos(span.endTimeUnixNano); }
export function normalizeSpan(input: any): TraceSpan | undefined {
  if (!validSpan(input)) return undefined;
  const span: any = input;
  const status = typeof span.status === 'object' ? (span.status.message ?? (span.status.code === 2 ? 'ERROR' : undefined)) : span.status;
  const attributes = Array.isArray(span.attributes) ? span.attributes.map((entry: any) => [entry.key, value(entry.value)] as [string, TraceValue | undefined]).filter((entry: [string, TraceValue | undefined]) => entry[1] !== undefined) as Array<[string, TraceValue]> : Object.entries(span.attributes ?? {}) as Array<[string, TraceValue]>;
  return { traceId: span.traceId.toLowerCase(), spanId: span.spanId.toLowerCase(), ...(id(span.parentSpanId, 16) ? { parentSpanId: String(span.parentSpanId).toLowerCase() } : {}), name: span.name, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano, ...(typeof status === 'string' ? { status } : {}), attributes: Object.fromEntries(attributes) };
}
export function decodeOtlp(payload: any): TraceSpan[] {
  const spans: TraceSpan[] = [];
  for (const resource of payload?.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) {
    const normalized = normalizeSpan({ ...span, attributes: [...(Array.isArray(resource.resource?.attributes) ? resource.resource.attributes : []), ...(Array.isArray(span.attributes) ? span.attributes : [])] });
    if (normalized) spans.push(normalized);
  }
  return spans;
}
export function decodeJsonl(text: string): TraceSpan[] { return text.split(/\r?\n/).flatMap(line => { try { const parsed = JSON.parse(line); return validSpan(parsed) ? [normalizeSpan(parsed)!] : decodeOtlp(parsed); } catch { return []; } }); }
export function retain(spans: TraceSpan[], max = 10_000): TraceSpan[] { return [...spans].sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano))).slice(-max); }
export function traces(spans: TraceSpan[], filter = ''): Trace[] {
  const query = filter.toLowerCase();
  const matches = (span: TraceSpan) => !query || [span.traceId, span.name, ...Object.values(span.attributes).map(String)].some(item => item.toLowerCase().includes(query));
  const grouped = new Map<string, TraceSpan[]>();
  for (const span of spans) if (matches(span)) grouped.set(span.traceId, [...(grouped.get(span.traceId) ?? []), span]);
  return [...grouped].map(([id, items]) => ({ id, spans: items.sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano))) })).sort((a, b) => b.spans.length - a.spans.length);
}
export function tree(spans: TraceSpan[]): Array<{ span: TraceSpan; depth: number }> {
  const byParent = new Map<string | undefined, TraceSpan[]>(); const known = new Set(spans.map(span => span.spanId));
  for (const span of spans) { const parent = known.has(span.parentSpanId ?? '') ? span.parentSpanId : undefined; byParent.set(parent, [...(byParent.get(parent) ?? []), span]); }
  const visit = (parent: string | undefined, depth: number): Array<{ span: TraceSpan; depth: number }> => (byParent.get(parent) ?? []).flatMap(span => [{ span, depth }, ...visit(span.spanId, depth + 1)]);
  return visit(undefined, 0);
}
export function duration(span: TraceSpan) { return `${Math.max(0, Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n))}ms`; }
