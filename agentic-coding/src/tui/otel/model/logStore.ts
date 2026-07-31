import type { LogData } from './types';

export type LogSeverity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

const severityOrder: Record<string, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };

export class LogStore {
  private logs: LogData[] = [];
  private filtered: LogData[] = [];

  constructor(initial: LogData[] = []) {
    this.logs = initial;
    this.rebuild();
  }

  load(logs: LogData[]): void {
    this.logs = logs;
    this.rebuild();
  }

  pushBatch(batch: LogData[]): void {
    this.logs.push(...batch);
    this.rebuild();
  }

  setFilter(query: string): void {
    this.rebuild(query, this.minSeverity_);
  }

  setMinSeverity(severity: string | undefined): void {
    this.rebuild(this.query_, severity);
  }

  getLogs(): LogData[] {
    return this.filtered;
  }

  getByTraceId(traceId: string): LogData[] {
    return this.filtered.filter(l => l.traceId === traceId);
  }

  get traceIdIndex_(): Map<string, LogData[]> {
    const index = new Map<string, LogData[]>();
    for (const log of this.filtered) {
      if (log.traceId) {
        const entries = index.get(log.traceId) ?? [];
        entries.push(log);
        index.set(log.traceId, entries);
      }
    }
    return index;
  }

  get filterQuery_(): string { return this.query_; }
  get minSeverity_(): string | undefined { return undefined; }
  get logCount_(): number { return this.logs.length; }
  get filteredCount_(): number { return this.filtered.length; }

  private query_ = '';

  private rebuild(query?: string, minSeverity?: string): void {
    this.query_ = query ?? this.query_;
    const q = this.query_.toLowerCase().trim();
    const min = minSeverity ? severityOrder[minSeverity] ?? 0 : 0;
    this.filtered = this.logs
      .filter(log => {
        if (min > 0 && (severityOrder[log.severity] ?? 0) < min) return false;
        if (!q) return true;
        return log.body.toLowerCase().includes(q)
          || log.serviceName.toLowerCase().includes(q)
          || log.attributes.some(a => String(a.value).toLowerCase().includes(q));
      })
      .sort((a, b) => Number(BigInt(a.timeUnixNano) - BigInt(b.timeUnixNano)));
  }
}
