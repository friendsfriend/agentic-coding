import {
	type SpanData,
	TRACE_PAGE_SIZE,
	type TraceSummary,
	type TraceSummaryPage,
	type TraceSummaryRow,
	type TreeNode,
} from "../../../contracts/telemetry.ts";
import { parseLine } from "../../../server/telemetry-parser";

export type SortField = "received" | "latency" | "name" | "service";
export type SortDir = "asc" | "desc";
export type SortMode = SortDir | "none";
export type SortCriterion = { field: SortField; mode: SortMode };
export type StatusFilter = "all" | "error" | "success";

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

/** Page bookkeeping of the list the store currently holds. */
interface PageState {
	page: number;
	perPage: number;
	total: number;
}

export class TraceStore {
	/** Spans of the trace the view has open (span tree and span detail). */
	private spans: SpanData[] = [];
	/** Trace-list entries: either one page read from the telemetry database or,
	 * in local/demo mode, the grouping of a loaded span file. */
	private summaries: TraceSummary[] = [];
	/** True while the list is derived from a locally loaded span file (demo and
	 * test shells): live pushes extend it. A paged list is owned by the database
	 * and is refreshed by re-reading the page. */
	private listIsLocal = false;
	private pageState: PageState = {
		page: 1,
		perPage: TRACE_PAGE_SIZE,
		total: 0,
	};
	private query = "";
	private sortCriteria: SortCriterion[] = [
		{ field: "received", mode: "desc" },
		{ field: "latency", mode: "none" },
		{ field: "service", mode: "none" },
		{ field: "name", mode: "none" },
	];
	private statusFilter: StatusFilter = "all";
	private readonly listeners = new Set<() => void>();

	constructor(initial: SpanData[] = []) {
		if (initial.length) this.loadFile(initial);
	}

	/** Subscribe to content changes (initial file load, live receiver pushes) so
	 * mounted views can refresh; returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	/** Local/demo mode: load a span file and derive the list from it. */
	loadFile(spans: SpanData[]): void {
		this.spans = spans;
		this.summaries = this.groupSummaries(spans);
		this.listIsLocal = true;
		this.pageState = {
			page: 1,
			perPage: TRACE_PAGE_SIZE,
			total: this.summaries.length,
		};
		this.notify();
	}

	/** Server mode: replace the list with one page of trace rows. The rows are
	 * the list's source of truth — nothing is derived from loaded spans. */
	setSummaryPage(next: TraceSummaryPage): void {
		this.summaries = next.items
			.map((row) => this.summaryFromRow(row))
			.filter((summary): summary is TraceSummary => summary !== undefined);
		this.listIsLocal = false;
		this.pageState = {
			page: next.page,
			perPage: next.perPage,
			total: next.total,
		};
		this.notify();
	}

	/** Spans of the trace now shown in the tree (fetched per trace). */
	setTraceSpans(spans: SpanData[]): void {
		this.spans = spans;
		this.notify();
	}

	get page_(): number {
		return this.pageState.page;
	}
	get totalPages_(): number {
		return Math.max(
			1,
			Math.ceil(this.pageState.total / this.pageState.perPage),
		);
	}
	get totalTraces_(): number {
		return this.pageState.total;
	}

	appendLine(line: string): boolean {
		const span = parseLine(line);
		if (!span) return false;
		this.pushBatch([span]);
		return true;
	}

	pushBatch(spans: SpanData[]): void {
		if (!spans.length) return;
		this.spans.push(...spans);
		// A locally loaded list is derived from the spans it holds; a paged list is
		// owned by the database and only the page read changes it.
		if (this.listIsLocal) this.summaries = this.groupSummaries(this.spans);
		this.notify();
	}

	/** Whether the list is derived from locally loaded spans (no page reads). */
	get listIsLocal_(): boolean {
		return this.listIsLocal;
	}

	getRootSpans(): SpanData[] {
		const parents = new Set(this.spans.map((s) => s.spanId));
		return this.spans.filter(
			(s) => !s.parentSpanId || !parents.has(s.parentSpanId),
		);
	}

	getTraceSpans(traceId: string): SpanData[] {
		return this.spans.filter((s) => s.traceId === traceId);
	}

	private attribute(span: SpanData, key: string): string | undefined {
		const value = span.attributes.find(
			(attribute) => attribute.key === key,
		)?.value;
		return value === undefined ? undefined : String(value);
	}

	private workspace(span: SpanData): string {
		return this.attribute(span, "herdr.change.id") ?? span.traceId;
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
			spanId: `virtual-${name}-${first?.spanId ?? role ?? workspace}`,
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
		const byParent = new Map<string, SpanData[]>();
		const known = new Set(spans.map((span) => span.spanId));
		for (const span of spans) {
			const parent = known.has(span.parentSpanId) ? span.parentSpanId : "";
			const children = byParent.get(parent) ?? [];
			children.push(span);
			byParent.set(parent, children);
		}
		const build = (parent: string, level: number): TreeNode[] =>
			(byParent.get(parent) ?? [])
				.sort((a, b) =>
					Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)),
				)
				.map((span) => ({
					span,
					depth: level,
					expanded: level < 2,
					children: build(span.spanId, level + 1),
				}));
		return build("", depth);
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
				claimed.add(span.spanId);
			});
			groups.push({
				span: this.virtualSpan(role, roleSpans, workspace, role),
				depth,
				expanded: true,
				children: this.tree(roleSpans, depth + 1),
			});
		}
		const remaining = spans.filter((span) => !claimed.has(span.spanId));
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
				claimed.add(span.spanId);
			});
			groups.push({
				span: this.virtualSpan(`${role} agent`, agentSpans, workspace, role),
				depth,
				expanded: true,
				children: this.tree(agentSpans, depth + 1),
			});
		}
		const workflowSpans = spans.filter((span) => !claimed.has(span.spanId));
		return [...this.tree(workflowSpans, depth), ...groups].sort(byStart);
	}

	/** Span tree for one workflow: the workflow root, one node per lifecycle
	 * phase (`herdr.step.id`), then the event categories inside each phase, with
	 * the agent category grouped by role. Events that report no phase stay
	 * directly under the root so they are never dropped; a trace with no phases
	 * at all keeps the legacy role-group shape. */
	getSpanTree(workspace: string): TreeNode[] {
		const spans = this.spans.filter(
			(span) => this.workspace(span) === workspace,
		);
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

	/** The list's rows: the loaded page filtered and sorted in memory. */
	getTraceSummaries(): TraceSummary[] {
		return this.sortSummaries(this.filteredSummaries());
	}

	/** One trace-list entry from a database row. Every number comes from the
	 * aggregation; the span-shaped root exists for the list's label and
	 * attributes (change id and agent roles). */
	private summaryFromRow(row: TraceSummaryRow): TraceSummary | undefined {
		const startTime = BigInt(row.startNanos);
		const endTime = BigInt(row.endNanos);
		const root = this.virtualSpan(
			`workflow: ${row.changeId}`,
			[],
			row.changeId,
			row.agents[0],
		);
		root.startTimeUnixNano = row.startNanos;
		root.endTimeUnixNano = row.endNanos;
		root.status = { code: row.errorCount > 0 ? 2 : 0 };
		return {
			traceId: row.changeId,
			rootSpans: [root],
			startTime,
			endTime,
			durationMs: Math.max(0, Number((endTime - startTime) / 1_000_000n)),
			errorCount: row.errorCount,
			spanCount: row.spanCount,
			agents: row.agents,
		};
	}

	/** Local/demo mode: group a loaded span file into trace-list entries. */
	private groupSummaries(spans: readonly SpanData[]): TraceSummary[] {
		const grouped = new Map<string, SpanData[]>();
		for (const span of spans) {
			const workspace = this.workspace(span);
			const entries = grouped.get(workspace) ?? [];
			entries.push(span);
			grouped.set(workspace, entries);
		}
		const summaries: TraceSummary[] = [];
		for (const [traceId, spans] of grouped) {
			const sorted = [...spans].sort((a, b) =>
				Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)),
			);
			const rootSpans = [
				this.virtualSpan(`workflow: ${traceId}`, sorted, traceId),
			];
			const first = sorted[0];
			const last = sorted.at(-1);
			if (!first || !last) continue;
			summaries.push({
				traceId,
				rootSpans,
				startTime: BigInt(first.startTimeUnixNano),
				endTime: BigInt(last.endTimeUnixNano),
				durationMs: Math.max(
					0,
					Number(
						(BigInt(last.endTimeUnixNano) - BigInt(first.startTimeUnixNano)) /
							1_000_000n,
					),
				),
				errorCount: sorted.filter((span) => span.status.code === 2).length,
				spanCount: sorted.length,
				agents: [
					...new Set(
						sorted
							.map((span) => this.attribute(span, "herdr.role"))
							.filter((role): role is string => !!role),
					),
				],
			});
		}
		return summaries;
	}

	/** The page rows matching the query and the status filter. */
	private filteredSummaries(): TraceSummary[] {
		return this.summaries.filter((summary) => this.matchesFilter(summary));
	}

	private sortSummaries(summaries: TraceSummary[]): TraceSummary[] {
		return [...summaries].sort((a, b) => {
			for (const criterion of this.sortCriteria) {
				if (criterion.mode === "none") continue;
				const cmp =
					criterion.field === "latency"
						? a.durationMs - b.durationMs
						: criterion.field === "name"
							? (a.rootSpans[0]?.name.localeCompare(
									b.rootSpans[0]?.name ?? "",
								) ?? 0)
							: criterion.field === "service"
								? (a.rootSpans[0]?.serviceName ?? "").localeCompare(
										b.rootSpans[0]?.serviceName ?? "",
									)
								: Number(a.startTime - b.startTime);
				if (cmp) return criterion.mode === "desc" ? -cmp : cmp;
			}
			return 0;
		});
	}

	applyFilter(query: string): void {
		this.query = query.toLowerCase().trim();
		this.notify();
	}

	setStatusFilter(status: StatusFilter): void {
		this.statusFilter = status;
		this.notify();
	}

	setSort(field: SortField): void {
		const criterion = this.sortCriteria.find((item) => item.field === field);
		if (!criterion) throw new Error(`unknown sort field: ${field}`);
		criterion.mode = criterion.mode === "asc" ? "desc" : "asc";
	}

	setSortCriteria(criteria: SortCriterion[]): void {
		this.sortCriteria = criteria.map((item) => ({ ...item }));
	}

	get sortCriteria_(): SortCriterion[] {
		return this.sortCriteria.map((item) => ({ ...item }));
	}
	get sortField_(): SortField {
		return (
			this.sortCriteria.find((item) => item.mode !== "none")?.field ??
			"received"
		);
	}
	get statusFilter_(): StatusFilter {
		return this.statusFilter;
	}
	get sortDir_(): SortDir {
		return (
			(this.sortCriteria.find((item) => item.mode !== "none")
				?.mode as SortDir) ?? "desc"
		);
	}
	get filterQuery_(): string {
		return this.query;
	}
	/** Spans of the trace the view has open. */
	get spanCount_(): number {
		return this.spans.length;
	}
	/** Trace entries the filter matches on the loaded page. */
	get filteredCount_(): number {
		return this.filteredSummaries().length;
	}

	/** A trace-list entry matches on what the list shows: the workflow id, its
	 * service, its agents and the status the aggregation counted. */
	private matchesFilter(summary: TraceSummary): boolean {
		const q = this.query;
		const root = summary.rootSpans[0];
		const textMatches =
			!q ||
			summary.traceId.toLowerCase().includes(q) ||
			summary.agents.some((agent) => agent.toLowerCase().includes(q)) ||
			(root?.name.toLowerCase().includes(q) ?? false) ||
			(root?.serviceName.toLowerCase().includes(q) ?? false) ||
			(root?.attributes.some(
				(attribute) =>
					attribute.key.toLowerCase().includes(q) ||
					String(attribute.value).toLowerCase().includes(q),
			) ??
				false);
		const statusMatches =
			this.statusFilter === "all" ||
			(this.statusFilter === "success"
				? summary.errorCount === 0
				: summary.errorCount > 0);
		return textMatches && statusMatches;
	}
}
