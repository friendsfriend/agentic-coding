import type { LogData } from "../../../contracts/telemetry.ts";

export type LogSeverity =
	| "TRACE"
	| "DEBUG"
	| "INFO"
	| "WARN"
	| "ERROR"
	| "FATAL";

const severityOrder: Record<string, number> = {
	TRACE: 0,
	DEBUG: 1,
	INFO: 2,
	WARN: 3,
	ERROR: 4,
	FATAL: 5,
};

/** Logs retained after the newest ones. A receiver pushing thousands of log
 * records per second used to grow this store for the life of the process, and
 * every batch re-filtered and re-sorted everything retained. The cap bounds
 * both: the newest records are kept, the oldest are dropped. */
export const MAX_LOGS = 5_000;

/** How long live pushes may accumulate before one append-and-refilter. A read
 * flushes what is pending first, so a reader never sees a staler list than the
 * one the pushes already delivered. */
export const LOG_FLUSH_MS = 250;

export interface LogStoreOptions {
	/** Flush coalescing window; `0` applies every batch synchronously (tests). */
	readonly flushIntervalMs?: number;
}

export class LogStore {
	private logs: LogData[] = [];
	private filtered: LogData[] = [];
	private pending: LogData[] = [];
	private readonly flushIntervalMs: number;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(initial: LogData[] = [], options: LogStoreOptions = {}) {
		this.flushIntervalMs = options.flushIntervalMs ?? LOG_FLUSH_MS;
		this.logs = initial;
		this.rebuild();
	}

	load(logs: LogData[]): void {
		this.pending = [];
		this.logs = logs;
		this.rebuild();
	}

	pushBatch(batch: LogData[]): void {
		if (!batch.length) return;
		this.pending.push(...batch);
		if (this.flushIntervalMs <= 0) {
			this.flush();
			return;
		}
		if (this.flushTimer !== undefined) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, this.flushIntervalMs);
		// A pending flush must never keep the process alive on its own.
		this.flushTimer.unref?.();
	}

	/** Append what is pending, drop past the retention cap, and refilter once. */
	private flush(): void {
		if (this.pending.length) {
			this.logs.push(...this.pending);
			this.pending = [];
			if (this.logs.length > MAX_LOGS)
				this.logs = this.logs.slice(this.logs.length - MAX_LOGS);
		}
		this.rebuild();
	}

	setFilter(query: string): void {
		this.rebuild(query, this.minSeverity_);
	}

	setMinSeverity(severity: string | undefined): void {
		this.rebuild(this.query_, severity);
	}

	/** A read sees everything the pushes already delivered: what is pending is
	 * applied before the list is handed out. */
	private read(): void {
		if (this.pending.length) this.flush();
	}

	getLogs(): LogData[] {
		this.read();
		return this.filtered;
	}

	getByTraceId(traceId: string): LogData[] {
		this.read();
		return this.filtered.filter((l) => l.traceId === traceId);
	}

	get traceIdIndex_(): Map<string, LogData[]> {
		this.read();
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

	get filterQuery_(): string {
		return this.query_;
	}
	get minSeverity_(): string | undefined {
		return undefined;
	}
	get logCount_(): number {
		this.read();
		return this.logs.length;
	}
	get filteredCount_(): number {
		this.read();
		return this.filtered.length;
	}

	private query_ = "";

	private rebuild(query?: string, minSeverity?: string): void {
		this.query_ = query ?? this.query_;
		const q = this.query_.toLowerCase().trim();
		const min = minSeverity ? (severityOrder[minSeverity] ?? 0) : 0;
		this.filtered = this.logs
			.filter((log) => {
				if (min > 0 && (severityOrder[log.severity] ?? 0) < min) return false;
				if (!q) return true;
				return (
					log.body.toLowerCase().includes(q) ||
					log.serviceName.toLowerCase().includes(q) ||
					log.attributes.some((a) => String(a.value).toLowerCase().includes(q))
				);
			})
			.sort((a, b) => Number(BigInt(a.timeUnixNano) - BigInt(b.timeUnixNano)));
	}
}
