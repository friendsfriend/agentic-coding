import { describe, it, expect } from 'bun:test';
import { MetricStore } from '../metricStore';
import type { MetricData } from '../types';

function makeMetric(name: string, svc: string, type: 'gauge' | 'sum' | 'histogram' = 'gauge'): MetricData {
  return {
    resource: { attributes: [] },
    scope: { name: 'test', version: '' },
    name,
    description: '',
    unit: '',
    type,
    dataPoints: [
      { startTimeUnixNano: '0', timeUnixNano: '1000', value: 42, attributes: [] },
      { startTimeUnixNano: '0', timeUnixNano: '2000', value: 55, attributes: [] },
    ],
    serviceName: svc,
  };
}

describe('MetricStore', () => {
  it('stores and retrieves metrics', () => {
    const store = new MetricStore([makeMetric('cpu', 'web')]);
    expect(store.metricCount_).toBe(1);
    expect(store.getStreams()).toHaveLength(1);
  });

  it('filters by name query', () => {
    const store = new MetricStore([makeMetric('cpu.usage', 'web'), makeMetric('mem.usage', 'web')]);
    store.setFilter('cpu');
    expect(store.filteredCount_).toBe(1);
  });

  it('filters by service name', () => {
    const store = new MetricStore([makeMetric('cpu', 'web'), makeMetric('cpu', 'db')]);
    store.setFilter('db');
    expect(store.filteredCount_).toBe(1);
  });

  it('sorts by type', () => {
    const store = new MetricStore([makeMetric('a', 'srv', 'histogram'), makeMetric('b', 'srv', 'gauge')]);
    store.setSort('type');
    expect(store.getStreams()[0]!.type).toBe('gauge');
    expect(store.getStreams()[1]!.type).toBe('histogram');
  });

  it('aggregates data points', () => {
    const store = new MetricStore([makeMetric('cpu', 'web')]);
    const agg = store.aggregate(store.getStreams()[0]!);
    expect(agg.avg).toBeCloseTo(48.5);
    expect(agg.min).toBe(42);
    expect(agg.max).toBe(55);
    expect(agg.count).toBe(2);
  });

  it('handles empty store', () => {
    const store = new MetricStore();
    expect(store.metricCount_).toBe(0);
    expect(store.getStreams()).toEqual([]);
  });

  it('returns empty agg for no data points', () => {
    const empty: MetricData = {
      resource: { attributes: [] }, scope: { name: '', version: '' },
      name: 'empty', description: '', unit: '', type: 'gauge', dataPoints: [], serviceName: 'test',
    };
    const store = new MetricStore([empty]);
    const agg = store.aggregate(empty);
    expect(agg.count).toBe(0);
  });
});
