import { describe, it, expect } from 'bun:test';
import { TraceStore } from '../../model/traceStore';
import { MetricStore } from '../../model/metricStore';
import { LogStore } from '../../model/logStore';
import { TopologyStore } from '../../model/topologyStore';

describe('Tab shell', () => {
  it('TraceStore starts empty', () => {
    const store = new TraceStore();
    expect(store.spanCount_).toBe(0);
    expect(store.filteredCount_).toBe(0);
  });

  it('MetricStore starts empty', () => {
    const store = new MetricStore();
    expect(store.metricCount_).toBe(0);
  });

  it('LogStore starts empty', () => {
    const store = new LogStore();
    expect(store.logCount_).toBe(0);
  });

  it('TopologyStore starts empty', () => {
    const store = new TopologyStore();
    expect(store.getServices()).toEqual([]);
  });

  it('stores are independent (no cross-contamination)', () => {
    const traceStore = new TraceStore();
    const metricStore = new MetricStore([{
      resource: { attributes: [] },
      scope: { name: '', version: '' },
      name: 'cpu',
      description: '',
      unit: '',
      type: 'gauge',
      dataPoints: [],
      serviceName: 'web',
    }]);

    expect(traceStore.spanCount_).toBe(0);
    expect(metricStore.metricCount_).toBe(1);
  });

  it('TraceStore backward-compatible with existing API', () => {
    const store = new TraceStore();
    expect(typeof store.loadFile).toBe('function');
    expect(typeof store.getTraceSummaries).toBe('function');
    expect(typeof store.applyFilter).toBe('function');
    expect(typeof store.setSort).toBe('function');
  });
});
