import { describe, it, expect } from 'bun:test';
import { normalizeZipkinSpans } from '../zipkin';

describe('Zipkin normalizer', () => {
  it('normalizes a Zipkin v2 span', () => {
    const spans = normalizeZipkinSpans([{
      traceId: '0af7651916cd43dd8448eb211c80319c',
      id: 'b7ad6b7169203331',
      parentId: 'b7ad6b7169203330',
      name: 'GET /api',
      timestamp: 1000000,
      duration: 500,
      localEndpoint: { serviceName: 'web' },
      tags: { 'http.method': 'GET' },
    }]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(spans[0]!.serviceName).toBe('web');
    expect(spans[0]!.name).toBe('GET /api');
  });

  it('maps error tag to error status', () => {
    const spans = normalizeZipkinSpans([{
      traceId: '0af7651916cd43dd8448eb211c80319c',
      id: 'b7ad6b7169203331',
      name: 'failing',
      timestamp: 1000,
      duration: 100,
      tags: { error: 'timeout' },
    }]);
    expect(spans[0]!.status.code).toBe(2);
    expect(spans[0]!.status.message).toBe('timeout');
  });

  it('handles missing localEndpoint', () => {
    const spans = normalizeZipkinSpans([{
      traceId: '0af7651916cd43dd8448eb211c80319c',
      id: 'b7ad6b7169203331',
      name: 'anon',
      timestamp: 1000,
    }]);
    expect(spans[0]!.serviceName).toBe('unknown');
  });

  it('throws on non-array input', () => {
    expect(() => normalizeZipkinSpans({})).toThrow('expected array');
  });
});
