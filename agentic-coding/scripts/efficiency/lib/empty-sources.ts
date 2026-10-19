// The dataset build's empty-source alarm.
//
// A source file whose parse yields zero rows is how a whole source disappears:
// nine `harness.*` stores reported `records = 0, parsed = 0` with the note
// "unreadable: unable to open database file" while holding 2,263 assistant turns
// and 2,804 tool calls, and every count built on the dataset was a lower bound
// because of it. The build therefore *fails* on such a file instead of recording
// a note, and `analyze.ts source-gaps` stays the query that lists the gaps.
//
// A file can also be empty for an honest reason — a store created before its
// first turn, a workflow whose telemetry file recorded nothing — so a small,
// documented allow-list names the shapes that are known to be empty.

import type { SourceFileRow, SourceId } from "./types.ts";

export interface EmptySourceAllowEntry {
	/** Glob over the file's path as the dataset records it, i.e. relative to the
	 * evidence root. `*` matches inside one path segment, `**` across segments. */
	path: string;
	/** Further narrowing to one discovered source, for a pattern that would
	 * otherwise cover several of them. */
	source?: SourceId;
	/** Why a file of this shape is expected to be empty. Free text for a reader. */
	reason: string;
}

/**
 * Sources the dataset build accepts as empty.
 *
 * Every entry carries a reason, and the list is meant to stay short: one entry
 * silences the alarm for a whole shape of file, so it is added only after the
 * empty file itself was looked at and found to be legitimately empty rather than
 * unreadable. The pinned snapshot needs no entry — once the harness reader
 * opens a snapshot copy of a WAL store, all 184 of its source files parse at
 * least one row.
 *
 * The shape an entry takes (no entry uses it today): an agent host writes its
 * harness store before the first turn, so a fresh store with no conversation at
 * all is a real empty source — `{ path, source, reason }`, where the path is a
 * glob over the snapshot-relative path (see `pathPatternToRegExp`).
 */
export const EMPTY_SOURCE_ALLOWLIST: readonly EmptySourceAllowEntry[] = [];

/** Turn a `*`/`**` glob into an anchored regular expression. */
export function pathPatternToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const body = escaped.replace(/\*\*|\*/g, (match) =>
		match === "**" ? ".*" : "[^/]*",
	);
	return new RegExp(`^${body}$`);
}

/** Whether one file is named by the allow-list. */
export function isEmptySourceAllowed(
	file: Pick<SourceFileRow, "source" | "path">,
	allowlist: readonly EmptySourceAllowEntry[],
): boolean {
	return allowlist.some(
		(entry) =>
			(entry.source === undefined || entry.source === file.source) &&
			pathPatternToRegExp(entry.path).test(file.path),
	);
}

/** Every source file whose parse produced zero rows and that is not allow-listed. */
export function findEmptySources(
	files: readonly SourceFileRow[],
	allowlist: readonly EmptySourceAllowEntry[] = EMPTY_SOURCE_ALLOWLIST,
): SourceFileRow[] {
	return files.filter(
		(file) => file.parsed === 0 && !isEmptySourceAllowed(file, allowlist),
	);
}

/** The `--allow-empty` value: a comma-separated list of path patterns. */
export function parseEmptySourcePatterns(
	value: string | undefined,
): EmptySourceAllowEntry[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)
		.map((path) => ({ path, reason: "named by --allow-empty" }));
}

/** The build's error message: what failed, where the query is, and how to allow it. */
export function describeEmptySources(
	failures: readonly SourceFileRow[],
): string {
	const lines = [
		`error: ${failures.length} source file${failures.length === 1 ? "" : "s"} parsed into zero rows — the dataset build stops here, because a source that is silently lost makes every count below it a lower bound.`,
		"",
		...failures.flatMap((file) => [
			`  ${file.path}  (${file.source}, kind=${file.kind})  records=${file.records} parsed=${file.parsed} skipped=${file.skipped}`,
			...(file.note === undefined ? [] : [`    note: ${file.note}`]),
		]),
		"",
		"`bun run scripts/efficiency/analyze.ts source-gaps --dataset <dir>` lists the remaining gaps in a dataset that was built before this check existed.",
		'If such a file is legitimately empty, name it in EMPTY_SOURCE_ALLOWLIST (scripts/efficiency/lib/empty-sources.ts) with a reason, or pass --allow-empty "<pattern>[,<pattern>]" to this build.',
	];
	return `${lines.join("\n")}\n`;
}
