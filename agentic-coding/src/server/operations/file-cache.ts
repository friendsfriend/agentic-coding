// Repository file reads a bounded poll repeats (server side).
//
// The sidebar re-reads every listed workflow's `openspec/changes/<id>/tasks.md`
// on a 5 s poll, and each read previously cost a read of the whole file plus a
// regex over its body — for a list the panel shows as a progress count. Those
// files change only when a step commits an update, so the text is cached under
// (mtime, size) and an unchanged file costs one stat.
//
// The key is deliberately the file's own metadata rather than a TTL: a step
// commit advances the mtime and a rewrite inside one mtime tick changes the
// size, so both are re-read, while a poll over files nothing touched does no
// I/O at all.
import { readFileSync, statSync } from "node:fs";

interface CachedText {
	readonly mtime: number;
	readonly size: number;
	readonly text: string;
}

/** One entry per file read, so a long-lived server cannot grow this without
 * bound: the least recently used entry is evicted first. */
const MAX_ENTRIES = 512;

const texts = new Map<string, CachedText>();

/** True for the only read failure a caller should read as "no file": callers
 * treat a missing file as empty and must still see a real I/O error. */
function isMissing(error: unknown): boolean {
	return (error as { code?: string } | undefined)?.code === "ENOENT";
}

/** The text of a file, re-read only when its mtime or size changed. A missing
 * file reads as empty, the value callers guarded with their own `existsSync`. */
export function cachedText(path: string): string {
	let mtime = 0;
	let size = 0;
	try {
		const stat = statSync(path);
		mtime = stat.mtimeMs;
		size = stat.size;
	} catch (error) {
		if (!isMissing(error)) throw error;
		texts.delete(path);
		return "";
	}
	const cached = texts.get(path);
	if (cached && cached.mtime === mtime && cached.size === size) {
		// Read again from the back so eviction drops the coldest entry.
		texts.delete(path);
		texts.set(path, cached);
		return cached.text;
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!isMissing(error)) throw error;
		texts.delete(path);
		return "";
	}
	texts.set(path, { mtime, size, text });
	while (texts.size > MAX_ENTRIES) {
		const oldest = texts.keys().next().value;
		if (oldest === undefined) break;
		texts.delete(oldest);
	}
	return text;
}

/** How many files the cache currently holds (test/observability seam). */
export function cachedTextEntryCount(): number {
	return texts.size;
}
