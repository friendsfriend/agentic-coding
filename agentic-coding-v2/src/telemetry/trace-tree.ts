import type { SpanData, TreeNode } from "./contracts.ts";
import { spanForest, spanIdentity } from "./span-forest.ts";

/** Telemetry event families the trace tree groups under one category node. The
 * family is the segment before the first dot of the event name; the engine,
 * adapter, and runtime bridges all follow `<family>.<event>`. `agent` and
 * `runtime` events are the agent's own execution telemetry, so they share the
 * `agent` category, whose children are grouped by role. Anything unmapped keeps
 * its family name. */
const CATEGORY_BY_FAMILY: Readonly<Record<string, string>> = {
	agent: "agent",
	runtime: "agent",
	workflow: "workflow",
	effect: "workflow",
	step: "workflow",
	developer: "developer",
	git: "git operation",
	research: "research",
	wiki: "wiki",
	openspec: "openspec",
	verification: "verification",
	routing: "classifier routing",
	migration: "migration",
};

/** Category of one telemetry event name (e.g. `runtime.tool` -> `agent`). */
export function telemetryCategory(event: string): string {
	const family = event.split(".")[0] ?? event;
	return CATEGORY_BY_FAMILY[family] ?? family;
}

/** Chronological order of tree nodes by the first span they cover. */
const byStart = (a: TreeNode, b: TreeNode): number =>
	Number(BigInt(a.span.startTimeUnixNano) - BigInt(b.span.startTimeUnixNano));

class TraceTree {
	private attribute(span: SpanData, key: string): string | undefined {
		const value = span.attributes.find(
			(attribute) => attribute.key === key,
		)?.value;
		return value === undefined ? undefined : String(value);
	}

	private virtualSpan(
		name: string,
		spans: SpanData[],
		workspace: string,
		role?: string,
	): SpanData {
		const sorted = [...spans].sort((a, b) =>
			Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)),
		);
		const first = sorted[0];
		const end = sorted.reduce(
			(latest, span) =>
				BigInt(span.endTimeUnixNano) > BigInt(latest)
					? span.endTimeUnixNano
					: latest,
			first?.endTimeUnixNano ?? "0",
		);
		return {
			traceId: workspace,
			// Groups are disjoint, so the first member's span id keeps every
			// phase/category/role node addressable even when two groups share a name.
			spanId: `virtual-${name}-${first ? spanIdentity(first) : (role ?? workspace)}`,
			parentSpanId: "",
			name,
			startTimeUnixNano: first?.startTimeUnixNano ?? "0",
			endTimeUnixNano: end,
			status: { code: spans.some((span) => span.status.code === 2) ? 2 : 0 },
			attributes: [
				{ key: "herdr.change.id", value: workspace },
				...(role ? [{ key: "herdr.role", value: role }] : []),
			],
			resource: { attributes: [], droppedAttributesCount: 0 },
			scope: { name: "viewer", version: "" },
			serviceName: "herdr-workflow",
			kind: 0,
		};
	}

	private tree(spans: SpanData[], depth: number): TreeNode[] {
		return spanForest(spans, depth);
	}

	/** Children of a phase (or of the root when a trace has no phases): one node
	 * per event category, in first-span order. The agent category nests the
	 * per-role groups; every other category nests its span tree. */
	private categoryNodes(
		spans: SpanData[],
		workspace: string,
		depth: number,
	): TreeNode[] {
		const byCategory = new Map<string, SpanData[]>();
		for (const span of spans) {
			const category = telemetryCategory(span.name);
			const bucket = byCategory.get(category) ?? [];
			bucket.push(span);
			byCategory.set(category, bucket);
		}
		return [...byCategory.entries()]
			.map(([category, categorySpans]) => ({
				span: this.virtualSpan(category, categorySpans, workspace),
				depth,
				expanded: true,
				children:
					category === "agent"
						? this.agentNodes(categorySpans, workspace, depth + 1)
						: this.tree(categorySpans, depth + 1),
			}))
			.sort(byStart);
	}

	/** Children of the agent category: one group per role the agent events
	 * report, plus any role-less agent events as their own tree. Roles come from
	 * every agent event, not only a legacy `agent.operation` span, so the
	 * grouping works for real engine, adapter, and runtime telemetry. */
	private agentNodes(
		spans: SpanData[],
		workspace: string,
		depth: number,
	): TreeNode[] {
		const roles = [
			...new Set(
				spans
					.map((span) => this.attribute(span, "herdr.role"))
					.filter((role): role is string => !!role),
			),
		];
		const claimed = new Set<string>();
		const groups: TreeNode[] = [];
		for (const role of roles) {
			const roleSpans = spans.filter(
				(span) => this.attribute(span, "herdr.role") === role,
			);
			roleSpans.forEach((span) => {
				claimed.add(spanIdentity(span));
			});
			groups.push({
				span: this.virtualSpan(role, roleSpans, workspace, role),
				depth,
				expanded: true,
				children: this.tree(roleSpans, depth + 1),
			});
		}
		const remaining = spans.filter((span) => !claimed.has(spanIdentity(span)));
		return [...groups, ...this.tree(remaining, depth)].sort(byStart);
	}

	/** One node per lifecycle phase (`herdr.step.id`), in first-span order and
	 * labelled with the raw step id. */
	private phaseNodes(
		spans: SpanData[],
		workspace: string,
		depth: number,
	): TreeNode[] {
		const byPhase = new Map<string, SpanData[]>();
		for (const span of spans) {
			const phase = this.attribute(span, "herdr.step.id");
			if (!phase) continue;
			const bucket = byPhase.get(phase) ?? [];
			bucket.push(span);
			byPhase.set(phase, bucket);
		}
		return [...byPhase.entries()]
			.map(([phase, phaseSpans]) => ({
				span: this.virtualSpan(phase, phaseSpans, workspace),
				depth,
				expanded: true,
				children: this.categoryNodes(phaseSpans, workspace, depth + 1),
			}))
			.sort(byStart);
	}

	/** Role groups discovered from legacy `agent.operation` spans plus the
	 * remaining span tree. Kept for demo and legacy traces that carry no
	 * `herdr.step.id`; phased telemetry uses the category grouping instead. */
	private legacyNodes(
		spans: SpanData[],
		workspace: string,
		depth: number,
	): TreeNode[] {
		const agentRoles = [
			...new Set(
				spans
					.filter((span) => span.name === "agent.operation")
					.map((span) => this.attribute(span, "herdr.role"))
					.filter((role): role is string => !!role),
			),
		];
		const claimed = new Set<string>();
		const groups: TreeNode[] = [];
		for (const role of agentRoles) {
			const agentSpans = spans.filter(
				(span) => this.attribute(span, "herdr.role") === role,
			);
			agentSpans.forEach((span) => {
				claimed.add(spanIdentity(span));
			});
			groups.push({
				span: this.virtualSpan(`${role} agent`, agentSpans, workspace, role),
				depth,
				expanded: true,
				children: this.tree(agentSpans, depth + 1),
			});
		}
		const workflowSpans = spans.filter(
			(span) => !claimed.has(spanIdentity(span)),
		);
		return [...this.tree(workflowSpans, depth), ...groups].sort(byStart);
	}

	/** Span tree for one workflow: the workflow root, one node per lifecycle
	 * phase (`herdr.step.id`), then the event categories inside each phase, with
	 * the agent category grouped by role. Events that report no phase stay
	 * directly under the root so they are never dropped; a trace with no phases
	 * at all keeps the legacy role-group shape. */
	getSpanTree(input: SpanData[], workspace: string): TreeNode[] {
		const retained = new Map(input.map((span) => [spanIdentity(span), span]));
		const spans = [...retained.values()];
		if (!spans.length) return [];
		const root = this.virtualSpan(`workflow: ${workspace}`, spans, workspace);
		const phased = spans.filter((span) =>
			this.attribute(span, "herdr.step.id"),
		);
		if (!phased.length)
			return [
				{
					span: root,
					depth: 0,
					expanded: true,
					children: this.legacyNodes(spans, workspace, 1),
				},
			];
		const unphased = spans.filter(
			(span) => !this.attribute(span, "herdr.step.id"),
		);
		return [
			{
				span: root,
				depth: 0,
				expanded: true,
				children: [
					...this.categoryNodes(unphased, workspace, 1),
					...this.phaseNodes(phased, workspace, 1),
				].sort(byStart),
			},
		];
	}
}
export const buildTraceTree = (
	spans: SpanData[],
	workspace: string,
): TreeNode[] => new TraceTree().getSpanTree(spans, workspace);
