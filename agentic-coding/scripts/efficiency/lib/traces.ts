// The otel-tui span store: the widest source in the snapshot (495 workflows).
//
// Each row is a whole OTel span with the engine's attributes flattened into
// `herdr.*`/`pi.*` pairs. Rebuilding a record from those attributes and running
// it through the same normalizer as the JSONL files is what guarantees the two
// sources describe an event identically, so de-duplication compares like with
// like.

import { Database } from "bun:sqlite";
import {
	type NormalizedEvent,
	nanosToIso,
	normalizeRecord,
} from "./normalize.ts";
import type { ReadStats } from "./telemetry.ts";

export interface TracesReadResult {
	events: NormalizedEvent[];
	stats: ReadStats;
	workspaceFiles: number;
}

interface TraceRow {
	change_id: string;
	span: string;
	start_nanos: number | null;
}

function attributesToRecord(
	span: Record<string, unknown>,
): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	const attributes = span.attributes;
	if (Array.isArray(attributes)) {
		for (const entry of attributes) {
			if (!entry || typeof entry !== "object") continue;
			const pair = entry as { key?: unknown; value?: unknown };
			if (typeof pair.key === "string") record[pair.key] = pair.value;
		}
	}
	// The span's own name is the event name; it sits next to the attributes, not
	// inside them.
	if (typeof span.name === "string") record.event = span.name;
	if (typeof span.traceId === "string") record.traceId = span.traceId;
	return record;
}

/** Read every span, oldest first. The store is opened read-only. */
export function readTraces(filePath: string): TracesReadResult {
	const stats: ReadStats = { records: 0, parsed: 0, skipped: 0, notes: [] };
	const events: NormalizedEvent[] = [];
	let workspaceFiles = 0;
	let db: Database | undefined;
	try {
		db = new Database(filePath, { readonly: true });
		const rows = db
			.query<TraceRow, []>(
				"select change_id, span, start_nanos from traces order by start_nanos",
			)
			.all();
		for (const row of rows) {
			stats.records += 1;
			let span: unknown;
			try {
				span = JSON.parse(row.span);
			} catch {
				stats.skipped += 1;
				continue;
			}
			if (span === null || typeof span !== "object") {
				stats.skipped += 1;
				continue;
			}
			const normalized = normalizeRecord(
				attributesToRecord(span as Record<string, unknown>),
				{
					workflowId: row.change_id,
					at: nanosToIso(row.start_nanos),
				},
			);
			if (normalized === undefined) {
				stats.skipped += 1;
				continue;
			}
			events.push(normalized);
			stats.parsed += 1;
		}
		try {
			const counted = db
				.query<{ n: number }, []>("select count(*) as n from workspace_files")
				.get();
			workspaceFiles = counted?.n ?? 0;
		} catch {
			stats.notes.push("workspace_files table missing");
		}
	} catch (error) {
		stats.notes.push(`unreadable: ${(error as Error).message}`);
	} finally {
		db?.close();
	}
	return { events, stats, workspaceFiles };
}
