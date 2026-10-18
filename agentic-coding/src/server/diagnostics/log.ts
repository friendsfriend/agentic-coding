// The diagnostics log: one bounded, rotating file under the application's own
// state directory.
//
// The process that freezes is the process that cannot report anything, so the
// writer is deliberately the smallest thing that outlives a freeze: one
// appendFileSync per record, a size check in memory, and a single rotation that
// keeps the previous file as `<name>.1`. Nothing here inspects, formats or
// filters the record: a caller writes one line that is already bounded, and no
// record may carry captured workflow content, credentials or file paths beyond
// the names of the sections this process runs.
import fs from "node:fs";
import path from "node:path";

/** Bytes one log file may reach before it rotates. */
export const DIAGNOSTICS_LOG_MAX_BYTES = 256 * 1024;

export interface DiagnosticsLog {
	/** The file records are appended to. */
	readonly path: string;
	/** Append one already-bounded line. */
	write(line: string): void;
	/** Bytes written to the current file. */
	size(): number;
	/** The most recent `limit` lines (newest last), for the on-demand report. */
	tail(limit: number): string[];
}

export interface DiagnosticsLogOptions {
	readonly path: string;
	readonly maxBytes?: number;
}

/** Create (or open) the diagnostics log at `path`. */
export function openDiagnosticsLog(
	options: DiagnosticsLogOptions,
): DiagnosticsLog {
	const maxBytes = options.maxBytes ?? DIAGNOSTICS_LOG_MAX_BYTES;
	const rotated = `${options.path}.1`;
	let size = 0;
	try {
		size = fs.statSync(options.path).size;
	} catch {
		size = 0;
	}
	fs.mkdirSync(path.dirname(options.path), { recursive: true });
	return {
		path: options.path,
		write(line: string): void {
			const record = line.endsWith("\n") ? line : `${line}\n`;
			const bytes = Buffer.byteLength(record);
			try {
				if (size > 0 && size + bytes > maxBytes) {
					// Exactly one previous file is kept: the freeze being diagnosed is
					// recent, and an unbounded history is its own disk problem.
					fs.rmSync(rotated, { force: true });
					fs.renameSync(options.path, rotated);
					size = 0;
				}
				fs.appendFileSync(options.path, record);
				size += bytes;
			} catch {
				// A log that cannot be written must never fail the process it observes.
				size = 0;
			}
		},
		size(): number {
			return size;
		},
		tail(limit: number): string[] {
			let text: string;
			try {
				text = fs.readFileSync(options.path, "utf8");
			} catch {
				return [];
			}
			const lines = text.split("\n").filter(Boolean);
			return lines.slice(Math.max(0, lines.length - Math.max(1, limit)));
		},
	};
}
