import type { SpanObservation } from "./telemetry-data.ts";

/** A bounded retained graph, not a claim of complete distributed capture. Cycles
 * are cut for traversal only; original parent IDs remain in the span evidence. */
export function traceTree(spans: SpanObservation[]) {
	const byId = new Map(spans.map((span) => [span.spanId, span])),
		parents = new Map<string, string>(),
		missingParents: string[] = [],
		cycleCuts: string[] = [];
	for (const span of spans) {
		if (!span.parentSpanId) continue;
		if (byId.has(span.parentSpanId))
			parents.set(span.spanId, span.parentSpanId);
		else missingParents.push(span.spanId);
	}
	const complete = new Set<string>();
	for (const span of spans) {
		const path = new Set<string>();
		let id: string | undefined = span.spanId;
		while (id && !complete.has(id)) {
			if (path.has(id)) {
				parents.delete(id);
				cycleCuts.push(id);
				break;
			}
			path.add(id);
			id = parents.get(id);
		}
		for (const visited of path) complete.add(visited);
	}
	const children = new Map<string, string[]>();
	for (const [child, parent] of parents) {
		const list = children.get(parent) ?? [];
		list.push(child);
		children.set(parent, list);
	}
	const compare = (left: string, right: string) => {
		const a = byId.get(left),
			b = byId.get(right);
		if (!a || !b) return left.localeCompare(right);
		return a.startTime === b.startTime
			? left.localeCompare(right)
			: BigInt(a.startTime) < BigInt(b.startTime)
				? -1
				: 1;
	};
	for (const list of children.values()) list.sort(compare);
	const roots = spans
		.filter((span) => !parents.has(span.spanId))
		.map((span) => span.spanId)
		.sort(compare);
	const pending = roots.toReversed().map((id) => ({ id, depth: 0 })),
		ordered: (SpanObservation & {
			depth: number;
			children: string[];
			traversalParent: string | null;
		})[] = [];
	while (pending.length) {
		const next = pending.pop();
		if (!next) break;
		const span = byId.get(next.id);
		if (!span) continue;
		const descendants = children.get(next.id) ?? [];
		ordered.push({
			...span,
			depth: next.depth,
			children: descendants,
			traversalParent: parents.get(next.id) ?? null,
		});
		for (const id of descendants.toReversed())
			pending.push({ id, depth: next.depth + 1 });
	}
	return {
		ordered,
		structure: {
			roots,
			missingParents,
			cycleCuts,
			retainedSpans: spans.length,
			order: "parent-before-child-then-exporter-start-time",
			completeness:
				"Retained graph only. Missing parents may be unexported or evicted; cycles are cut only for traversal. Links are evidence, never permission to fetch another run or provider.",
		},
	};
}
