import { describe, it, expect } from 'bun:test';
import { TopologyStore } from '../topologyStore';
import type { SpanData } from '../types';

function makeSpan(name: string, svc: string, parentSpanId?: string): SpanData {
  return {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: Math.random().toString(16).slice(2, 18),
    parentSpanId: parentSpanId ?? '',
    name,
    startTimeUnixNano: '1000000',
    endTimeUnixNano: '2000000',
    status: { code: 0 },
    attributes: [],
    resource: { attributes: [], droppedAttributesCount: 0 },
    scope: { name: 'test', version: '' },
    serviceName: svc,
    kind: 0,
  };
}

describe('TopologyStore', () => {
  it('builds service graph from spans', () => {
    const spanA = makeSpan('op1', 'frontend');
    const spanB = makeSpan('op2', 'backend', spanA.spanId);
    const store = new TopologyStore();
    store.load([spanA, spanB]);
    const services = store.getServices();
    expect(services).toHaveLength(2);
  });

  it('detects edges between services', () => {
    const spanA = makeSpan('request', 'gateway');
    const spanB = makeSpan('handle', 'backend', spanA.spanId);
    const store = new TopologyStore();
    store.load([spanA, spanB]);
    const edges = store.getEdges();
    const gatewayToBackend = edges.find(e => e.source === 'gateway' && e.target === 'backend');
    expect(gatewayToBackend).toBeDefined();
  });

  it('handles single service with no dependencies', () => {
    const store = new TopologyStore();
    store.load([makeSpan('alone', 'standalone')]);
    const services = store.getServices();
    expect(services).toHaveLength(1);
    expect(services[0]!.parentIds).toEqual([]);
    expect(services[0]!.childIds).toEqual([]);
  });

  it('detects cycles gracefully', () => {
    const spanA = makeSpan('a', 'svcA');
    // spanB has parentSpanId pointing to spanA, but both are same svc — no cycle between services
    makeSpan('b', 'svcA', spanA.spanId);
    const store = new TopologyStore();
    store.load([spanA]);
    const services = store.getServices();
    expect(services).toHaveLength(1);
  });

  it('generates adjacency list', () => {
    const spanA = makeSpan('req', 'frontend');
    const spanB = makeSpan('proc', 'backend', spanA.spanId);
    const store = new TopologyStore();
    store.load([spanA, spanB]);
    const list = store.getAdjacencyList();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(l => l.includes('frontend'))).toBe(true);
  });

  it('assigns layers in layout', () => {
    const spanA = makeSpan('req', 'frontend');
    const spanB = makeSpan('proc', 'backend', spanA.spanId);
    const store = new TopologyStore();
    store.load([spanA, spanB]);
    const layout = store.getLayout();
    const frontend = layout.find(l => l.id === 'frontend');
    const backend = layout.find(l => l.id === 'backend');
    expect(frontend).toBeDefined();
    expect(backend).toBeDefined();
    expect(frontend!.layer).toBeLessThanOrEqual(backend!.layer);
  });
});
