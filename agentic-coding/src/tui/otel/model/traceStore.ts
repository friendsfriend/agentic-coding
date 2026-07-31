import type { SpanData, TreeNode, TraceSummary } from './types';
import { parseLine } from './parser';

export type SortField = 'received' | 'latency' | 'name' | 'service';
export type SortDir = 'asc' | 'desc';
export type SortMode = SortDir | 'none';
export type SortCriterion = { field: SortField; mode: SortMode };
export type StatusFilter = 'all' | 'error' | 'success';

export class TraceStore {
  private spans: SpanData[] = [];
  private filtered: SpanData[] = [];
  private query = '';
  private sortCriteria: SortCriterion[] = [
    { field: 'received', mode: 'desc' },
    { field: 'latency', mode: 'none' },
    { field: 'service', mode: 'none' },
    { field: 'name', mode: 'none' },
  ];
  private statusFilter: StatusFilter = 'all';

  constructor(initial: SpanData[] = []) {
    this.spans = initial;
    this.rebuild();
  }

  loadFile(spans: SpanData[]): void {
    this.spans = spans;
    this.rebuild();
  }

  appendLine(line: string): boolean {
    const span = parseLine(line);
    if (!span) return false;
    this.pushBatch([span]);
    return true;
  }

  pushBatch(spans: SpanData[]): void {
    this.spans.push(...spans);
    this.filtered.push(...spans.filter(span => this.matchesFilter(span)));
  }

  getRootSpans(): SpanData[] {
    const parents = new Set(this.filtered.map(s => s.spanId));
    return this.filtered.filter(s => !s.parentSpanId || !parents.has(s.parentSpanId));
  }

  getTraceSpans(traceId: string): SpanData[] {
    return this.filtered.filter(s => s.traceId === traceId);
  }

  private attribute(span: SpanData, key: string): string | undefined {
    const value = span.attributes.find(attribute => attribute.key === key)?.value;
    return value === undefined ? undefined : String(value);
  }

  private workspace(span: SpanData): string { return this.attribute(span, 'herdr.change.id') ?? span.traceId; }

  private virtualSpan(name: string, spans: SpanData[], workspace: string, role?: string): SpanData {
    const sorted = [...spans].sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
    const first = sorted[0]; const end = sorted.reduce((latest, span) => BigInt(span.endTimeUnixNano) > BigInt(latest) ? span.endTimeUnixNano : latest, first?.endTimeUnixNano ?? '0');
    return { traceId: workspace, spanId: `virtual-${name}-${role ?? workspace}`, parentSpanId: '', name, startTimeUnixNano: first?.startTimeUnixNano ?? '0', endTimeUnixNano: end, status: { code: spans.some(span => span.status.code === 2) ? 2 : 0 }, attributes: [{ key: 'herdr.change.id', value: workspace }, ...(role ? [{ key: 'herdr.role', value: role }] : [])], resource: { attributes: [], droppedAttributesCount: 0 }, scope: { name: 'viewer', version: '' }, serviceName: 'herdr-workflow', kind: 0 };
  }

  private tree(spans: SpanData[], depth: number): TreeNode[] {
    const byParent = new Map<string, SpanData[]>(); const known = new Set(spans.map(span => span.spanId));
    for (const span of spans) { const parent = known.has(span.parentSpanId) ? span.parentSpanId : ''; const children = byParent.get(parent) ?? []; children.push(span); byParent.set(parent, children); }
    const build = (parent: string, level: number): TreeNode[] => (byParent.get(parent) ?? []).sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano))).map(span => ({ span, depth: level, expanded: level < 2, children: build(span.spanId, level + 1) }));
    return build('', depth);
  }

  getSpanTree(workspace: string): TreeNode[] {
    const spans = this.filtered.filter(span => this.workspace(span) === workspace);
    if (!spans.length) return [];
    const agentRoles = [...new Set(spans.filter(span => span.name === 'agent.operation').map(span => this.attribute(span, 'herdr.role')).filter((role): role is string => !!role))];
    const groups: TreeNode[] = [];
    const claimed = new Set<string>();
    for (const role of agentRoles) {
      const agentSpans = spans.filter(span => this.attribute(span, 'herdr.role') === role);
      agentSpans.forEach(span => claimed.add(span.spanId));
      groups.push({ span: this.virtualSpan(`${role} agent`, agentSpans, workspace, role), depth: 1, expanded: true, children: this.tree(agentSpans, 2) });
    }
    const workflowSpans = spans.filter(span => !claimed.has(span.spanId));
    const root = this.virtualSpan(`workflow: ${workspace}`, spans, workspace);
    return [{ span: root, depth: 0, expanded: true, children: [...this.tree(workflowSpans, 1), ...groups].sort((a, b) => Number(BigInt(a.span.startTimeUnixNano) - BigInt(b.span.startTimeUnixNano))) }];
  }

  getTraceSummaries(): TraceSummary[] {
    const grouped = new Map<string, SpanData[]>();
    for (const span of this.filtered) { const workspace = this.workspace(span); const entries = grouped.get(workspace) ?? []; entries.push(span); grouped.set(workspace, entries); }
    const summaries: TraceSummary[] = [];
    for (const [traceId, spans] of grouped) {
      const sorted = [...spans].sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
      const rootSpans = [this.virtualSpan(`workflow: ${traceId}`, sorted, traceId)];
      summaries.push({
        traceId,
        rootSpans,
        startTime: BigInt(sorted[0]!.startTimeUnixNano),
        endTime: BigInt(sorted.at(-1)!.endTimeUnixNano),
        durationMs: Math.max(0, Number((BigInt(sorted.at(-1)!.endTimeUnixNano) - BigInt(sorted[0]!.startTimeUnixNano)) / 1_000_000n)),
        errorCount: sorted.filter(span => span.status.code === 2).length,
        spanCount: sorted.length,
        agents: [...new Set(sorted.map(span => this.attribute(span, 'herdr.role')).filter((role): role is string => !!role))],
      });
    }
    return summaries.sort((a, b) => {
      for (const criterion of this.sortCriteria) {
        if (criterion.mode === 'none') continue;
        const cmp = criterion.field === 'latency' ? a.durationMs - b.durationMs
          : criterion.field === 'name' ? a.rootSpans[0]?.name.localeCompare(b.rootSpans[0]?.name ?? '') ?? 0
          : criterion.field === 'service' ? (a.rootSpans[0]?.serviceName ?? '').localeCompare(b.rootSpans[0]?.serviceName ?? '')
          : Number(a.startTime - b.startTime);
        if (cmp) return criterion.mode === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  applyFilter(query: string): void {
    this.query = query.toLowerCase().trim();
    this.rebuild();
  }

  setStatusFilter(status: StatusFilter): void {
    this.statusFilter = status;
    this.rebuild();
  }

  setSort(field: SortField): void {
    const criterion = this.sortCriteria.find(item => item.field === field)!;
    criterion.mode = criterion.mode === 'asc' ? 'desc' : 'asc';
  }

  setSortCriteria(criteria: SortCriterion[]): void {
    this.sortCriteria = criteria.map(item => ({ ...item }));
  }

  get sortCriteria_(): SortCriterion[] { return this.sortCriteria.map(item => ({ ...item })); }
  get sortField_(): SortField { return this.sortCriteria.find(item => item.mode !== 'none')?.field ?? 'received'; }
  get statusFilter_(): StatusFilter { return this.statusFilter; }
  get sortDir_(): SortDir { return this.sortCriteria.find(item => item.mode !== 'none')?.mode as SortDir ?? 'desc'; }
  get filterQuery_(): string { return this.query; }
  get spanCount_(): number { return this.spans.length; }
  get filteredCount_(): number { return this.filtered.length; }

  private matchesFilter(span: SpanData): boolean {
    const q = this.query;
    const textMatches = !q || span.traceId.includes(q) || span.name.toLowerCase().includes(q) || span.serviceName.toLowerCase().includes(q) || span.attributes.some(a => String(a.value).toLowerCase().includes(q));
    const statusMatches = this.statusFilter === 'all' || (this.statusFilter === 'success' ? span.status.code === 0 : span.status.code !== 0);
    return textMatches && statusMatches;
  }

  private rebuild(): void {
    this.filtered = this.spans.filter(span => this.matchesFilter(span));
  }
}
