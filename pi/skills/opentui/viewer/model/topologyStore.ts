import type { ServiceNode, SpanData } from './types';

export interface Edge {
  source: string;
  target: string;
  spanCount: number;
}

export interface LayoutNode {
  id: string;
  layer: number;
  slot: number;
  node: ServiceNode;
}

export class TopologyStore {
  private spans: SpanData[] = [];

  load(spans: SpanData[]): void {
    this.spans = spans;
  }

  getServices(): ServiceNode[] {
    return this.buildGraph();
  }

  getEdges(): Edge[] {
    return this.buildEdges();
  }

  getLayout(layerSpacing = 6): LayoutNode[] {
    return this.layout(layerSpacing);
  }

  getAdjacencyList(): string[] {
    const services = this.buildGraph();
    const lines: string[] = [];
    for (const svc of services) {
      const deps = [...svc.parentIds, ...svc.childIds];
      const unique = [...new Set(deps)];
      lines.push(`${svc.id} → ${unique.join(', ') || '(no dependencies)'}`);
    }
    return lines;
  }

  private buildGraph(): ServiceNode[] {
    const nodeMap = new Map<string, ServiceNode>();
    const spanCountMap = new Map<string, number>();
    const errorCountMap = new Map<string, number>();
    const durationMap = new Map<string, number[]>();

    for (const span of this.spans) {
      const svc = span.serviceName;
      spanCountMap.set(svc, (spanCountMap.get(svc) ?? 0) + 1);
      if (span.status.code === 2) errorCountMap.set(svc, (errorCountMap.get(svc) ?? 0) + 1);
      const dur = Math.max(0, Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n));
      const durs = durationMap.get(svc) ?? [];
      durs.push(dur);
      durationMap.set(svc, durs);
      if (!nodeMap.has(svc)) {
        nodeMap.set(svc, { id: svc, parentIds: [], childIds: [], spanCount: 0, errorCount: 0, avgDurationMs: 0 });
      }
    }

    // Build edges from parent-child relationships
    const spanServices = new Map<string, string>();
    for (const span of this.spans) {
      spanServices.set(span.spanId, span.serviceName);
    }
    for (const span of this.spans) {
      if (!span.parentSpanId) continue;
      const parentSvc = spanServices.get(span.parentSpanId);
      if (!parentSvc || parentSvc === span.serviceName) continue;
      const parent = nodeMap.get(parentSvc);
      const child = nodeMap.get(span.serviceName);
      if (parent && child) {
        if (!parent.childIds.includes(span.serviceName)) parent.childIds.push(span.serviceName);
        if (!child.parentIds.includes(parentSvc)) child.parentIds.push(parentSvc);
      }
    }

    for (const [svc, count] of spanCountMap) {
      const node = nodeMap.get(svc)!;
      node.spanCount = count;
      node.errorCount = errorCountMap.get(svc) ?? 0;
      const durs = durationMap.get(svc) ?? [];
      node.avgDurationMs = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    }

    return [...nodeMap.values()];
  }

  private buildEdges(): Edge[] {
    const services = this.buildGraph();
    const edges: Edge[] = [];
    for (const svc of services) {
      for (const childId of svc.childIds) {
        edges.push({ source: svc.id, target: childId, spanCount: 1 });
      }
    }
    return edges;
  }

  private layout(_layerSpacing: number): LayoutNode[] {
    const services = this.buildGraph();
    if (!services.length) return [];

    // Simple layered layout: root-like nodes (no parents) = layer 0
    const layers = new Map<number, ServiceNode[]>();
    const assigned = new Map<string, number>();
    const queue: Array<{ id: string; layer: number }> = [];

    for (const svc of services) {
      if (svc.parentIds.length === 0) {
        queue.push({ id: svc.id, layer: 0 });
      }
    }

    let head = 0;
    while (head < queue.length) {
      const item = queue[head++];
      if (assigned.has(item.id)) continue;
      assigned.set(item.id, item.layer);
      const svc = services.find(s => s.id === item.id);
      if (!svc) continue;
      for (const childId of svc.childIds) {
        if (!assigned.has(childId)) {
          queue.push({ id: childId, layer: item.layer + 1 });
        }
      }
    }

    // Assign unassigned nodes (cycles) to layer 0
    for (const svc of services) {
      if (!assigned.has(svc.id)) assigned.set(svc.id, 0);
    }

    for (const [id, layer] of assigned) {
      const svc = services.find(s => s.id === id);
      if (!svc) continue;
      const list = layers.get(layer) ?? [];
      list.push(svc);
      layers.set(layer, list);
    }

    const result: LayoutNode[] = [];
    for (const [layer, nodes] of layers) {
      nodes.forEach((node, slot) => {
        result.push({ id: node.id, layer, slot, node });
      });
    }
    return result;
  }
}
