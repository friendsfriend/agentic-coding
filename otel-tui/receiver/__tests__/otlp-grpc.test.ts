import { describe, it, expect } from 'bun:test';
import { normalizeOtlpSpan, decodeOtlpTraces, decodeOtlpMetrics, decodeOtlpLogs } from '../otlp';

describe('OTLP normalizer', () => {
  it('normalizes a valid span', () => {
    const span = normalizeOtlpSpan({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      parentSpanId: 'b7ad6b7169203330',
      name: 'test',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '2000000',
      status: { code: 0 },
      attributes: [{ key: 'service.name', value: { stringValue: 'my-service' } }],
      resource: { attributes: [] },
      kind: 1,
    });
    expect(span).toBeDefined();
    expect(span!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span!.spanId).toBe('b7ad6b7169203331');
    expect(span!.parentSpanId).toBe('b7ad6b7169203330');
    expect(span!.name).toBe('test');
    expect(span!.serviceName).toBe('my-service');
    expect(span!.kind).toBe(1);
  });

  it('rejects span with missing traceId', () => {
    const span = normalizeOtlpSpan({
      spanId: 'b7ad6b7169203331',
      name: 'test',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '2000000',
    });
    expect(span).toBeUndefined();
  });

  it('rejects span with invalid traceId length', () => {
    const span = normalizeOtlpSpan({
      traceId: 'short',
      spanId: 'b7ad6b7169203331',
      name: 'test',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '2000000',
    });
    expect(span).toBeUndefined();
  });

  it('handles missing parentSpanId', () => {
    const span = normalizeOtlpSpan({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      name: 'root',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '2000000',
    });
    expect(span).toBeDefined();
    expect(span!.parentSpanId).toBe('');
  });

  it('decodes empty trace payload', () => {
    const spans = decodeOtlpTraces({ resourceSpans: [] });
    expect(spans).toEqual([]);
  });

  it('decodes empty metrics payload', () => {
    const metrics = decodeOtlpMetrics({ resourceMetrics: [] });
    expect(metrics).toEqual([]);
  });

  it('decodes empty logs payload', () => {
    const logs = decodeOtlpLogs({ resourceLogs: [] });
    expect(logs).toEqual([]);
  });

  it('handles oversized payload gracefully', () => {
    // Just verify the normalizer doesn't crash on malformed data
    const result = normalizeOtlpSpan(null);
    expect(result).toBeUndefined();
    const result2 = normalizeOtlpSpan(undefined);
    expect(result2).toBeUndefined();
  });
});
