import type { MetricData, MetricDataPoint } from './types';

export type MetricSortKey = 'name' | 'type' | 'service' | 'unit';

export class MetricStore {
  private metrics: MetricData[] = [];
  private filtered: MetricData[] = [];
  private query = '';
  private sortKey: MetricSortKey = 'name';
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBatch: MetricData[] = [];

  constructor(initial: MetricData[] = []) {
    this.metrics = initial;
    this.rebuild();
  }

  load(metrics: MetricData[]): void {
    this.metrics = metrics;
    this.rebuild();
  }

  pushBatch(batch: MetricData[]): void {
    this.pendingBatch.push(...batch);
    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.metrics.push(...this.pendingBatch);
        this.pendingBatch = [];
        this.rebuild();
      }, 500);
    }
  }

  setFilter(query: string): void {
    this.query = query.toLowerCase().trim();
    this.rebuild();
  }

  setSort(key: MetricSortKey): void {
    this.sortKey = key;
    this.rebuild();
  }

  getStreams(): MetricData[] {
    return this.filtered;
  }

  getStream(name: string, serviceName: string): MetricData | undefined {
    return this.filtered.find(m => m.name === name && m.serviceName === serviceName);
  }

  aggregate(stream: MetricData): { avg: number; min: number; max: number; count: number } {
    const values = stream.dataPoints.map(dp => dp.value);
    if (!values.length) return { avg: 0, min: 0, max: 0, count: 0 };
    return {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }

  get filterQuery_(): string { return this.query; }
  get metricCount_(): number { return this.metrics.length; }
  get filteredCount_(): number { return this.filtered.length; }
  get sortKey_(): MetricSortKey { return this.sortKey; }

  private rebuild(): void {
    const q = this.query;
    this.filtered = this.metrics
      .filter(m => !q || m.name.toLowerCase().includes(q) || m.serviceName.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
      .sort((a, b) => {
        const cmp = this.sortKey === 'name' ? a.name.localeCompare(b.name)
          : this.sortKey === 'type' ? a.type.localeCompare(b.type)
          : this.sortKey === 'service' ? a.serviceName.localeCompare(b.serviceName)
          : a.unit.localeCompare(b.unit);
        return cmp || a.name.localeCompare(b.name);
      });
  }
}
