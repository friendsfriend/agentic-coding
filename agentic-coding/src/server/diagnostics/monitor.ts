// Main-thread diagnostics: event-loop lag, memory, and the heavy sections that
// ran in the window a lag was observed in.
//
// The TUI freezes the developer cannot explain are the reason this exists. A
// single process hosts the unified server, the dashboard, the receivers and the
// renderer, so "the UI stopped" can be a synchronous store read, a telemetry
// write or a render pass — and after the fact none of them is observable. This
// monitor is cheap enough to leave on: a drift ticker, a timestamp per wrapped
// section, and one bounded log line when something actually went wrong.
//
// What counts as a spike: a tick that ran late, or a wrapped section that held
// the loop for at least the threshold. The tick drift alone under-reports a
// block that lies between two ticks (a 320ms block with a 200ms tick shows as
// 120ms of drift), so the section timings are what make a freeze attributable.
//
// Two rules shape every record:
//
//  - **Bounded and content-free.** A record names numbers and the section names
//    this process chose (constants from the code), never workflow ids, task
//    text, file contents, paths or credentials. The log rotates at a fixed size.
//  - **Never in the way.** No section it wraps can fail because of it, no timer
//    keeps the process alive, and a write that fails is swallowed.
//
// Everything observable is injected (clock, timers, memory reader, cache
// counts, sink), so the whole monitor is testable with fake timers.

/** One wrapped section's measured duration. */
export interface DiagnosticsSectionTiming {
	/** A constant this process chose; never derived from user input. */
	readonly name: string;
	readonly ms: number;
}

/** One observed main-thread block. */
export interface DiagnosticsSpike {
	/** ISO instant the tick that observed it ran. */
	readonly at: string;
	/** How late the ticker ran: the synchronous stretch that blocked the loop. */
	readonly lagMs: number;
	readonly rssMb: number;
	readonly heapUsedMb: number;
	/** The slowest wrapped sections of the window, slowest first. */
	readonly sections: readonly DiagnosticsSectionTiming[];
}

/** Object counts of the long-lived caches, sampled with the memory line. */
export interface DiagnosticsCacheCount {
	readonly name: string;
	readonly entries: number;
}

export interface DiagnosticsStats {
	readonly at: string;
	readonly rssMb: number;
	readonly heapUsedMb: number;
	readonly heapTotalMb: number;
	readonly uptimeSeconds: number;
	readonly caches: readonly DiagnosticsCacheCount[];
	/** Recent spikes, newest first. */
	readonly spikes: readonly DiagnosticsSpike[];
}

export interface DiagnosticsMemorySample {
	readonly rss: number;
	readonly heapUsed: number;
	readonly heapTotal: number;
}

export interface DiagnosticsMonitorOptions {
	/** Where a record goes. One line per record, already bounded. */
	readonly write: (line: string) => void;
	readonly now?: () => number;
	readonly memory?: () => DiagnosticsMemorySample;
	readonly uptimeSeconds?: () => number;
	/** Object counts of the caches worth watching (empty when none is known). */
	readonly caches?: () => readonly DiagnosticsCacheCount[];
	/** Called after a spike or a memory sample, for a reactive surface. */
	readonly onChange?: () => void;
	/** Drift-tick interval. */
	readonly lagTickMs?: number;
	/** Lag at or above this is recorded as a spike. */
	readonly lagThresholdMs?: number;
	/** How often a memory line is written. */
	readonly memoryIntervalMs?: number;
	/** Spikes kept for the footer/CLI view. */
	readonly maxSpikes?: number;
	/** Section names reported per spike line. */
	readonly reportedSections?: number;
	/** Sections faster than this are not remembered (they cannot block a frame). */
	readonly minSectionMs?: number;
	readonly schedule?: (run: () => void, ms: number) => unknown;
	readonly cancel?: (handle: unknown) => void;
}

export interface DiagnosticsMonitor {
	/** Time one section that cannot throw differently because it is timed. */
	measure<T>(name: string, run: () => T): T;
	/** Remember one observed section duration. */
	record(name: string, ms: number): void;
	/** Begin an async section; the returned function records it. */
	startSection(name: string): () => number;
	/** Recent spikes, newest first. */
	spikes(): readonly DiagnosticsSpike[];
	/** Live memory, cache counts and the recent spikes. */
	stats(): DiagnosticsStats;
	/** Write one stats summary line now (SIGUSR2, the CLI report). */
	report(note?: string): void;
	stop(): void;
}

/** Drift-tick interval: five ticks a second is enough to catch a freeze and
 * costs nothing when nothing is happening. */
export const DIAGNOSTICS_LAG_TICK_MS = 200;
/** A tick this late means the main thread was blocked for that long. */
export const DIAGNOSTICS_LAG_THRESHOLD_MS = 150;
/** One memory line a minute: a leak needs a trend, not a stream. */
export const DIAGNOSTICS_MEMORY_INTERVAL_MS = 60_000;
/** Spikes the footer and the CLI report read. */
export const DIAGNOSTICS_MAX_SPIKES = 16;
/** Section names one spike line names. */
export const DIAGNOSTICS_REPORTED_SECTIONS = 5;
/** Sections below this are not remembered. */
export const DIAGNOSTICS_MIN_SECTION_MS = 5;

function mb(bytes: number): number {
	return Number((bytes / 1_048_576).toFixed(1));
}

/** A section name is a code constant; the log must stay free of anything else,
 * so a name that is not a short identifier is replaced rather than written. */
function safeSectionName(name: string): string {
	return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : "unnamed";
}

export function createDiagnosticsMonitor(
	options: DiagnosticsMonitorOptions,
): DiagnosticsMonitor {
	const now = options.now ?? (() => Date.now());
	const memory =
		options.memory ??
		(() => {
			const usage = process.memoryUsage();
			return {
				rss: usage.rss,
				heapUsed: usage.heapUsed,
				heapTotal: usage.heapTotal,
			};
		});
	const caches = options.caches ?? (() => []);
	const uptimeSeconds =
		options.uptimeSeconds ?? (() => Math.round(process.uptime()));
	const lagTickMs = options.lagTickMs ?? DIAGNOSTICS_LAG_TICK_MS;
	const lagThresholdMs = options.lagThresholdMs ?? DIAGNOSTICS_LAG_THRESHOLD_MS;
	const memoryIntervalMs =
		options.memoryIntervalMs ?? DIAGNOSTICS_MEMORY_INTERVAL_MS;
	const maxSpikes = options.maxSpikes ?? DIAGNOSTICS_MAX_SPIKES;
	const reportedSections =
		options.reportedSections ?? DIAGNOSTICS_REPORTED_SECTIONS;
	const minSectionMs = options.minSectionMs ?? DIAGNOSTICS_MIN_SECTION_MS;
	const schedule =
		options.schedule ??
		((run: () => void, ms: number) => {
			const handle = setTimeout(run, ms);
			// A diagnostics timer must never be the reason the process stays up.
			(handle as { unref?: () => void }).unref?.();
			return handle;
		});
	const cancel =
		options.cancel ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));

	const spikeRing: DiagnosticsSpike[] = [];
	/** Section timings observed since the previous tick. */
	let window: DiagnosticsSectionTiming[] = [];
	let timer: unknown;
	let expected = now() + lagTickMs;
	let lastMemoryAt = now();
	let stopped = false;

	const publish = (record: Record<string, unknown>): void => {
		try {
			options.write(JSON.stringify(record));
		} catch {
			// A sink that throws is not allowed to break the observed process.
		}
	};

	const tick = (): void => {
		if (stopped) return;
		const at = now();
		// The drift is measured against the cadence the ticker promised, not
		// against its own previous run: a block that starts just after a tick is
		// then still visible as lateness instead of being absorbed by the next
		// tick's own (later) schedule.
		const lagMs = Math.round(at - expected);
		expected += lagTickMs;
		if (expected < at) expected = at + lagTickMs;
		// A spike is a late tick *or* a wrapped section that blocked the loop for
		// at least the threshold: the drift alone under-reports a block that lies
		// between two ticks, while the section timing measures it exactly.
		const slowestSectionMs = window.reduce(
			(max, section) => (section.ms > max ? section.ms : max),
			0,
		);
		if (lagMs >= lagThresholdMs || slowestSectionMs >= lagThresholdMs) {
			const usage = memory();
			const spike: DiagnosticsSpike = {
				at: new Date(at).toISOString(),
				lagMs,
				rssMb: mb(usage.rss),
				heapUsedMb: mb(usage.heapUsed),
				sections: [...window]
					.sort((a, b) => b.ms - a.ms)
					.slice(0, reportedSections),
			};
			spikeRing.unshift(spike);
			if (spikeRing.length > maxSpikes) spikeRing.length = maxSpikes;
			publish({
				kind: "lag",
				at: spike.at,
				lagMs: spike.lagMs,
				rssMb: spike.rssMb,
				heapUsedMb: spike.heapUsedMb,
				sections: spike.sections,
			});
			options.onChange?.();
		}
		window = [];
		if (at - lastMemoryAt >= memoryIntervalMs) {
			lastMemoryAt = at;
			writeMemorySample(at);
		}
		timer = schedule(tick, lagTickMs);
	};

	/** Remember one section duration in the current window. */
	const rememberSection = (name: string, ms: number): void => {
		if (ms < minSectionMs) return;
		window.push({ name: safeSectionName(name), ms: Math.round(ms) });
		// A pathological section cannot grow this window without bound; the
		// slowest entries are what a report names anyway.
		if (window.length > 64) window.shift();
	};

	const writeMemorySample = (at: number): void => {
		const usage = memory();
		publish({
			kind: "memory",
			at: new Date(at).toISOString(),
			rssMb: mb(usage.rss),
			heapUsedMb: mb(usage.heapUsed),
			heapTotalMb: mb(usage.heapTotal),
			uptimeSeconds: uptimeSeconds(),
			caches: caches(),
		});
	};

	timer = schedule(tick, lagTickMs);

	return {
		measure<T>(name: string, run: () => T): T {
			const started = now();
			try {
				return run();
			} finally {
				rememberSection(name, now() - started);
			}
		},
		record(name: string, ms: number): void {
			rememberSection(name, ms);
		},
		startSection(name: string): () => number {
			const started = now();
			let recorded = false;
			return () => {
				const elapsed = now() - started;
				if (!recorded) {
					recorded = true;
					rememberSection(name, elapsed);
				}
				return Math.round(elapsed);
			};
		},
		spikes(): readonly DiagnosticsSpike[] {
			return [...spikeRing];
		},
		stats(): DiagnosticsStats {
			const usage = memory();
			return {
				at: new Date(now()).toISOString(),
				rssMb: mb(usage.rss),
				heapUsedMb: mb(usage.heapUsed),
				heapTotalMb: mb(usage.heapTotal),
				uptimeSeconds: uptimeSeconds(),
				caches: caches(),
				spikes: [...spikeRing],
			};
		},
		report(note?: string): void {
			// The note is a code constant as well: a caller may not smuggle content
			// into the log through it.
			const stats = this.stats();
			writeMemorySample(now());
			publish({
				kind: "report",
				at: stats.at,
				...(note ? { note: safeSectionName(note) } : {}),
				rssMb: stats.rssMb,
				heapUsedMb: stats.heapUsedMb,
				spikes: stats.spikes.slice(0, reportedSections),
			});
			lastMemoryAt = now();
		},
		stop(): void {
			stopped = true;
			if (timer !== undefined) cancel(timer);
			timer = undefined;
		},
	};
}
