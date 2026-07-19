import { describe, it, expect } from 'bun:test';
import { normalizeDatadogSpans, normalizeDatadogSeries, normalizeDatadogLogs } from '../datadog';

describe('Datadog normalizer', () => {
  describe('traces', () => {
    it('normalizes a Datadog trace array', () => {
      const spans = normalizeDatadogSpans([[{
        trace_id: 12345,
        span_id: 67890,
        parent_id: 11111,
        name: 'redis.get',
        service: 'cache',
        start: 1000000,
        duration: 500,
        error: 0,
        meta: { 'db.instance': 'users' },
      }]]);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.traceId).toBe(BigInt(12345).toString(16).padStart(16, '0'));
      expect(spans[0]!.serviceName).toBe('cache');
      expect(spans[0]!.status.code).toBe(0);
    });

    it('marks error spans', () => {
      const spans = normalizeDatadogSpans([[{
        trace_id: 1, span_id: 2, name: 'err', service: 'srv',
        start: 1000, duration: 100, error: 1,
      }]]);
      expect(spans[0]!.status.code).toBe(2);
    });
  });

  describe('series metrics', () => {
    it('normalizes Datadog series', () => {
      const metrics = normalizeDatadogSeries({
        series: [{ metric: 'cpu.user', points: [[1000000, 42.5]], type: 'gauge', host: 'web-1' }],
      });
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.name).toBe('cpu.user');
      expect(metrics[0]!.type).toBe('gauge');
      expect(metrics[0]!.dataPoints[0]!.value).toBe(42.5);
    });

    it('throws on missing series', () => {
      expect(() => normalizeDatadogSeries({})).toThrow('expected series');
    });
  });

  describe('logs', () => {
    it('normalizes Datadog log entry', () => {
      const logs = normalizeDatadogLogs([{
        message: 'request completed',
        status: 'info',
        timestamp: '2024-01-15T10:00:00Z',
        service: 'web',
        dd: { trace_id: 'abc123' },
      }]);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.body).toBe('request completed');
      expect(logs[0]!.severity).toBe('INFO');
      expect(logs[0]!.traceId).toBe('abc123');
    });
  });
});
