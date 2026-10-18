// The process-wide diagnostics monitor, and the no-op section helper every
// heavy call site wraps itself in.
//
// `startProcessDiagnostics` is called once by the unified shell, which is the
// process that hosts the server, the receivers, the store reads and the
// renderer. Everything else — the event bus wiring, the telemetry sinks, the
// dashboard refresh — asks `diagnosticsSection`/`recordDiagnosticsSection`,
// which are no-ops when no monitor was installed (tests, the headless server,
// the CLI). That is what makes the instrumentation additive: a call site is
// wrapped unconditionally and costs one function call when diagnostics are off.
import path from "node:path";
import { resolveConfigDir } from "../../backend/home.ts";
import { type DiagnosticsLog, openDiagnosticsLog } from "./log.ts";
import {
	createDiagnosticsMonitor,
	type DiagnosticsCacheCount,
	type DiagnosticsMonitor,
} from "./monitor.ts";

/** The log file every process reads: `<configDir>/diagnostics/tui.log`. */
export function diagnosticsLogFile(): string {
	return path.join(resolveConfigDir(), "diagnostics", "tui.log");
}

let monitor: DiagnosticsMonitor | undefined;
let log: DiagnosticsLog | undefined;
let signalInstalled = false;

export interface StartDiagnosticsOptions {
	/** Object counts of the long-lived caches, sampled with the memory line. */
	readonly caches?: () => readonly DiagnosticsCacheCount[];
	/** Called after every spike and memory sample, for a reactive surface (the
	 * shell footer's diagnostics segment). */
	readonly onChange?: () => void;
	/** Path override (tests). */
	readonly path?: string;
	/** Install the on-demand signal handler (default true). */
	readonly signal?: boolean;
}

/** Start the diagnostics monitor for this process. Idempotent: the shell calls
 * it once at startup and a second call returns the running monitor. */
export function startProcessDiagnostics(
	options: StartDiagnosticsOptions = {},
): DiagnosticsMonitor {
	if (monitor) return monitor;
	log = openDiagnosticsLog({ path: options.path ?? diagnosticsLogFile() });
	const started = createDiagnosticsMonitor({
		write: (line) => log?.write(line),
		...(options.caches ? { caches: options.caches } : {}),
		...(options.onChange ? { onChange: options.onChange } : {}),
	});
	monitor = started;
	// SIGUSR2 asks the *running* process for a summary: it writes one report
	// line into the log (memory, cache counts, the recent spikes) without
	// dumping a heap snapshot nobody asked for. `agentic-coding diagnostics
	// --heap` is the deliberate snapshot path.
	if ((options.signal ?? true) && !signalInstalled) {
		signalInstalled = true;
		try {
			process.on("SIGUSR2", () => {
				try {
					monitor?.report("signal");
				} catch {
					// A signal handler must never throw into the process.
				}
			});
		} catch {
			signalInstalled = false;
		}
	}
	return started;
}

export function diagnosticsMonitor(): DiagnosticsMonitor | undefined {
	return monitor;
}

/** The diagnostics log this process writes, when one was opened. */
export function diagnosticsLog(): DiagnosticsLog | undefined {
	return log;
}

/** Time one section when diagnostics are running; otherwise just run it. */
export function diagnosticsSection<T>(name: string, run: () => T): T {
	const active = monitor;
	return active ? active.measure(name, run) : run();
}

/** Time one async section when diagnostics are running; otherwise just await
 * it. The duration covers the awaited work, which is what a caller experiences
 * as a stall even when the loop was free in between. */
export async function diagnosticsAsyncSection<T>(
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	const active = monitor;
	if (!active) return run();
	const stop = active.startSection(name);
	try {
		return await run();
	} finally {
		stop();
	}
}

/** Remember one measured section duration (no-op without a monitor). */
export function recordDiagnosticsSection(name: string, ms: number): void {
	monitor?.record(name, ms);
}

/** Stop the monitor and forget it, so a test can start another. */
export function stopProcessDiagnostics(): void {
	monitor?.stop();
	monitor = undefined;
	log = undefined;
}
