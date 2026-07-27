// Pure traceparent/span math. No I/O, no clock, no network.
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: string;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: string;
  attributes: Record<string, unknown>;
}

export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value || '');
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), flags: flags.toLowerCase() };
}

export function traceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags ?? '01'}`;
}

export function childContext(parent?: TraceContext | null): TraceContext {
  return {
    traceId: parent ? parent.traceId : randomUUID().replace(/-/g, ''),
    spanId: randomUUID().replace(/-/g, '').slice(0, 16),
    flags: parent ? parent.flags ?? '01' : '01',
  };
}

export function spanRecord(
  context: TraceContext,
  name: string,
  startNanos: string,
  endNanos: string,
  attributes: Record<string, unknown>,
  parentSpanId: string | null = null,
  status = 'OK',
): SpanRecord {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId,
    name,
    startTimeUnixNano: startNanos,
    endTimeUnixNano: endNanos,
    status,
    attributes,
  };
}
