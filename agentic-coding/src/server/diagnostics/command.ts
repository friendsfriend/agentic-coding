// `agentic-coding diagnostics` — the on-demand report for a TUI freeze.
//
// It reads only the bounded diagnostics log this application writes for itself
// (`<configDir>/diagnostics/tui.log`): no store, no configuration value, no
// workflow content. `--heap` is the one deliberate exception to "bounded": it
// asks this process for a heap snapshot and writes it beside the log, so the
// developer can hand the pair over.
import fs from "node:fs";
import path from "node:path";
import { diagnosticsLogFile } from "./instance.ts";

export interface DiagnosticsReport {
	readonly logPath: string;
	readonly logBytes: number;
	readonly rotatedBytes: number;
	readonly lagCount: number;
	readonly worstLagMs: number;
	readonly lastSpikeAt?: string;
	/** The most recent records, newest first, already bounded by `tail`. */
	readonly recent: readonly Record<string, unknown>[];
}

function readLines(file: string): string[] {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function sizeOf(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/** Summarize the diagnostics log. `tail` bounds how much of it is returned. */
export function readDiagnosticsReport(tail = 20): DiagnosticsReport {
	const logPath = diagnosticsLogFile();
	const lines = readLines(logPath);
	const records: Record<string, unknown>[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				records.push(parsed as Record<string, unknown>);
		} catch {
			// A torn last line (the process froze mid-write) is skipped, not fatal.
		}
	}
	const lags = records.filter((record) => record.kind === "lag");
	let worstLagMs = 0;
	for (const record of lags) {
		const lag = Number(record.lagMs);
		if (Number.isFinite(lag) && lag > worstLagMs) worstLagMs = Math.round(lag);
	}
	return {
		logPath,
		logBytes: sizeOf(logPath),
		rotatedBytes: sizeOf(`${logPath}.1`),
		lagCount: lags.length,
		worstLagMs,
		...(lags.at(-1)?.at !== undefined
			? { lastSpikeAt: String(lags.at(-1)?.at) }
			: {}),
		recent: records
			.slice(Math.max(0, records.length - Math.max(1, tail)))
			.reverse(),
	};
}

/** One line per record, for a terminal. */
export function formatDiagnosticsReport(report: DiagnosticsReport): string[] {
	const lines = [
		`diagnostics log: ${report.logPath}`,
		`  ${(report.logBytes / 1024).toFixed(1)} KiB current, ${(report.rotatedBytes / 1024).toFixed(1)} KiB rotated`,
		`  ${report.lagCount} lag spikes recorded, worst ${report.worstLagMs}ms` +
			(report.lastSpikeAt ? `, last at ${report.lastSpikeAt}` : ""),
	];
	for (const record of report.recent) {
		const kind = String(record.kind ?? "record");
		if (kind === "lag") {
			const sections = Array.isArray(record.sections) ? record.sections : [];
			const heaviest = sections
				.map((entry) => {
					const item = entry as { name?: unknown; ms?: unknown };
					return `${String(item.name)} ${String(item.ms)}ms`;
				})
				.join(", ");
			lines.push(
				`  ${String(record.at)} lag ${String(record.lagMs)}ms · rss ${String(record.rssMb)}MB · heap ${String(record.heapUsedMb)}MB` +
					(heaviest ? ` · ${heaviest}` : ""),
			);
			continue;
		}
		if (kind === "memory" || kind === "report") {
			const caches = Array.isArray(record.caches) ? record.caches : [];
			const counts = caches
				.map((entry) => {
					const item = entry as { name?: unknown; entries?: unknown };
					return `${String(item.name)}=${String(item.entries)}`;
				})
				.join(" ");
			lines.push(
				`  ${String(record.at)} ${kind} · rss ${String(record.rssMb)}MB · heap ${String(record.heapUsedMb)}MB` +
					(counts ? ` · ${counts}` : ""),
			);
			continue;
		}
		lines.push(`  ${String(record.at)} ${kind}`);
	}
	return lines;
}

/** Ask this process for the reason its heap is large; write the snapshot beside
 * the log and return its path. */
export function writeHeapSnapshot(
	directory = path.dirname(diagnosticsLogFile()),
): {
	readonly path: string;
	readonly bytes: number;
} {
	const generate = (
		Bun as unknown as { generateHeapSnapshot?: (format?: string) => string }
	).generateHeapSnapshot;
	if (typeof generate !== "function")
		throw new Error("this runtime cannot generate a heap snapshot");
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `heap-${Date.now()}.json`);
	const snapshot = generate.call(Bun, "v8");
	fs.writeFileSync(file, snapshot);
	return { path: file, bytes: Buffer.byteLength(snapshot) };
}

const usage = `Usage: agentic-coding diagnostics [options]
  Show the main-thread diagnostics this application wrote for itself
  (event-loop lag spikes, memory samples, cache counts).

Options:
  --tail N     how many recent records to print (default 20)
  --json       print the report as JSON
  --heap       also write a heap snapshot beside the log and print its path
  --help       this text

Signals: send SIGUSR2 to a running TUI (kill -USR2 <pid>) to make it write one
stats summary into the log without dumping a heap snapshot.`;

export async function diagnosticsCommand(
	argv: readonly string[],
): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(usage);
		return 0;
	}
	const tailIndex = argv.indexOf("--tail");
	const tail = tailIndex >= 0 ? Number(argv[tailIndex + 1]) : 20;
	if (!Number.isFinite(tail) || tail < 1) {
		console.error("diagnostics: --tail needs a positive number");
		return 2;
	}
	const report = readDiagnosticsReport(Math.min(Math.floor(tail), 500));
	if (argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		for (const line of formatDiagnosticsReport(report)) console.log(line);
	}
	if (argv.includes("--heap")) {
		try {
			const snapshot = writeHeapSnapshot();
			console.log(
				`heap snapshot: ${snapshot.path} (${(snapshot.bytes / 1_048_576).toFixed(1)} MiB)`,
			);
		} catch (error) {
			console.error(
				`diagnostics: could not write a heap snapshot: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
	}
	return 0;
}
