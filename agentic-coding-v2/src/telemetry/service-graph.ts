import type { ServiceGraph, ServiceNode, SpanData } from "./contracts.ts";

const identity = (traceId: string, spanId: string) =>
	JSON.stringify([traceId, spanId]);
/** Span IDs are trace-local, not global. A retransmitted/corrected span owns
 * one logical observation; later input wins for that exact wire identity. */
export function serviceGraph(spans: readonly SpanData[]): ServiceGraph {
	const retained = new Map<string, SpanData>();
	for (const span of spans)
		retained.set(identity(span.traceId, span.spanId), span);
	const nodes = new Map<string, ServiceNode>();
	const durations = new Map<string, number>();
	for (const span of retained.values()) {
		const node = nodes.get(span.serviceName) ?? {
			id: span.serviceName,
			parentIds: [],
			childIds: [],
			spanCount: 0,
			errorCount: 0,
			avgDurationMs: 0,
		};
		node.spanCount++;
		if (span.status.code === 2) node.errorCount++;
		const elapsed = Math.max(
			0,
			Number(
				(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) /
					1_000_000n,
			),
		);
		durations.set(node.id, (durations.get(node.id) ?? 0) + elapsed);
		nodes.set(node.id, node);
	}
	const edges = new Map<
		string,
		{ source: string; target: string; spanCount: number }
	>();
	for (const span of retained.values()) {
		if (!span.parentSpanId) continue;
		const parent = retained.get(identity(span.traceId, span.parentSpanId));
		if (!parent || parent.serviceName === span.serviceName) continue;
		const source = nodes.get(parent.serviceName),
			target = nodes.get(span.serviceName);
		if (!source || !target) continue;
		if (!source.childIds.includes(target.id)) source.childIds.push(target.id);
		if (!target.parentIds.includes(source.id)) target.parentIds.push(source.id);
		const key = JSON.stringify([source.id, target.id]);
		const edge = edges.get(key) ?? {
			source: source.id,
			target: target.id,
			spanCount: 0,
		};
		edge.spanCount++;
		edges.set(key, edge);
	}
	for (const node of nodes.values()) {
		node.avgDurationMs = (durations.get(node.id) ?? 0) / node.spanCount;
		node.parentIds.sort();
		node.childIds.sort();
	}
	return {
		services: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
		edges: [...edges.values()].sort(
			(a, b) =>
				a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
		),
	};
}
