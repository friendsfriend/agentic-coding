import type {
	ServiceEdge,
	ServiceGraph,
	ServiceNode,
	SpanData,
} from "../../../../telemetry/contracts.ts";
import { serviceGraph } from "../../../../telemetry/service-graph.ts";

export type Edge = ServiceEdge;
export interface LayoutNode {
	id: string;
	layer: number;
	slot: number;
	node: ServiceNode;
}

/** v1 layout/interaction store; graph attribution is shared with the native
 * read boundary so the list, detail and graph cannot infer different edges. */
export class TopologyStore {
	private graph: ServiceGraph = { services: [], edges: [] };
	load(spans: SpanData[]): void {
		this.graph = serviceGraph(spans);
	}
	setGraph(graph: ServiceGraph): void {
		this.graph = graph;
	}
	getServices(): ServiceNode[] {
		return this.graph.services;
	}
	getEdges(): Edge[] {
		return this.graph.edges;
	}
	getLayout(layerSpacing = 6): LayoutNode[] {
		return this.layout(layerSpacing);
	}
	getAdjacencyList(): string[] {
		return this.graph.services.map((service) => {
			const dependencies = [
				...new Set([...service.parentIds, ...service.childIds]),
			];
			return `${service.id} → ${dependencies.join(", ") || "(no dependencies)"}`;
		});
	}
	private layout(_layerSpacing: number): LayoutNode[] {
		const services = this.graph.services;
		if (!services.length) return [];
		const byId = new Map(services.map((service) => [service.id, service]));
		const layers = new Map<number, ServiceNode[]>();
		const assigned = new Map<string, number>();
		const queue: Array<{ id: string; layer: number }> = [];
		for (const service of services)
			if (service.parentIds.length === 0)
				queue.push({ id: service.id, layer: 0 });
		let head = 0;
		while (head < queue.length) {
			const item = queue[head++];
			if (assigned.has(item.id)) continue;
			assigned.set(item.id, item.layer);
			const service = byId.get(item.id);
			if (!service) continue;
			for (const childId of service.childIds)
				if (!assigned.has(childId))
					queue.push({ id: childId, layer: item.layer + 1 });
		}
		// Pure cycles have no roots and remain visible, as in v1.
		for (const service of services)
			if (!assigned.has(service.id)) assigned.set(service.id, 0);
		for (const [id, layer] of assigned) {
			const service = byId.get(id);
			if (!service) continue;
			const nodes = layers.get(layer) ?? [];
			nodes.push(service);
			layers.set(layer, nodes);
		}
		const result: LayoutNode[] = [];
		for (const [layer, nodes] of layers)
			nodes.forEach((node, slot) => {
				result.push({ id: node.id, layer, slot, node });
			});
		return result;
	}
}
