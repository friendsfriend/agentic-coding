// Reading a JSONL telemetry file: tolerant, bounded, and never fatal.
//
// The snapshot holds ~150 legacy files plus per-worktree files, and some of
// them are the *only* record of a workflow. A truncated last line, a blank
// line, or a record that is valid JSON but not an object must therefore cost
// one skipped record, never the file — the counts are reported so a later step
// can tell "no data" from "unreadable data".

import fs from "node:fs";
import { type NormalizedEvent, normalizeRecord } from "./normalize.ts";

export interface ReadStats {
	records: number;
	parsed: number;
	skipped: number;
	notes: string[];
}

export interface JsonlReadResult {
	events: NormalizedEvent[];
	stats: ReadStats;
}

/**
 * Read one JSONL file into normalized events.
 *
 * `workflowId` is the fallback identity for the whole file: the legacy
 * generation records have no `workflowId` field, and the file name is the
 * authoritative workflow id for them.
 */
export function readTelemetryJsonl(
	filePath: string,
	workflowId?: string,
): JsonlReadResult {
	const stats: ReadStats = { records: 0, parsed: 0, skipped: 0, notes: [] };
	const events: NormalizedEvent[] = [];
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		stats.notes.push(`unreadable: ${(error as Error).message}`);
		return { events, stats };
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		stats.records += 1;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			stats.skipped += 1;
			continue;
		}
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			stats.skipped += 1;
			continue;
		}
		const normalized = normalizeRecord(value as Record<string, unknown>, {
			workflowId,
		});
		if (normalized === undefined) {
			stats.skipped += 1;
			continue;
		}
		events.push(normalized);
		stats.parsed += 1;
	}
	return { events, stats };
}
