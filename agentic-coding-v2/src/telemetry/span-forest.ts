import type { SpanData, TreeNode } from "./contracts.ts";
export const spanIdentity = (
	span: Pick<SpanData, "traceId" | "spanId">,
): string => JSON.stringify([span.traceId, span.spanId]);
const order = (a: SpanData, b: SpanData) => {
	const left = BigInt(a.startTimeUnixNano),
		right = BigInt(b.startTimeUnixNano);
	return left < right
		? -1
		: left > right
			? 1
			: spanIdentity(a).localeCompare(spanIdentity(b));
};
/** Iterative forest construction. Wire IDs are trace-scoped, corrections win,
 * and no untrusted parent chain gets to control the process call stack. */
export function spanForest(input: SpanData[], depth: number): TreeNode[] {
	const spans = new Map(input.map((span) => [spanIdentity(span), span]));
	const parents = new Map<string, string>();
	const warnings = new Map<string, TreeNode["relation"]>();
	for (const [key, span] of spans) {
		const parent = spanIdentity({
			traceId: span.traceId,
			spanId: span.parentSpanId,
		});
		if (span.parentSpanId && spans.has(parent)) parents.set(key, parent);
	}
	// A functional parent graph needs at most one edge cut per cycle. Keep the
	// original parentSpanId intact and mark the promoted node visibly.
	const done = new Set<string>();
	for (const key of spans.keys()) {
		const path = new Set<string>();
		let current: string | undefined = key;
		while (current && !done.has(current)) {
			if (path.has(current)) {
				parents.delete(current);
				warnings.set(current, "cycle");
				break;
			}
			path.add(current);
			current = parents.get(current);
		}
		for (const visited of path) done.add(visited);
	}
	const children = new Map<string | undefined, string[]>();
	for (const key of spans.keys()) {
		const parent = parents.get(key);
		const list = children.get(parent) ?? [];
		list.push(key);
		children.set(parent, list);
	}
	for (const list of children.values())
		list.sort((a, b) => {
			const left = spans.get(a),
				right = spans.get(b);
			return left && right ? order(left, right) : 0;
		});
	const roots: TreeNode[] = [];
	const tasks: Array<{ key: string; level: number; parent?: TreeNode }> = [];
	for (const key of [...(children.get(undefined) ?? [])].reverse())
		tasks.push({ key, level: depth });
	while (tasks.length) {
		const task = tasks.pop();
		if (!task) break;
		const span = spans.get(task.key);
		if (!span) continue;
		// Promote, never discard, a deeper segment. Every original span remains
		// inspectable and each serialized/rendered subtree stays safely bounded.
		const limited = task.level >= depth + 64;
		const level = limited ? depth : task.level;
		const relation = limited ? "depth-limit" : warnings.get(task.key);
		const node: TreeNode = {
			span,
			depth: level,
			expanded: level < 2,
			children: [],
			...(relation ? { relation } : {}),
		};
		if (task.parent && !limited) task.parent.children.push(node);
		else roots.push(node);
		for (const key of [...(children.get(task.key) ?? [])].reverse())
			tasks.push({ key, level: level + 1, parent: node });
	}
	return roots.sort((a, b) => order(a.span, b.span));
}
