/**
 * A content-addressed cache for classifier judgments.
 *
 * The sweep's candidate set is cumulative: `changedFilesInAsync` reports every
 * file changed since the base commit, so round two asks the same question about
 * the same bytes that round one already asked. On a local sidecar that is about a
 * second per 2k tokens of state, spent to compute an answer no input has changed
 * to invalidate. This cache removes that repetition across rounds, panes, and
 * engine processes.
 *
 * Safety rests on one property: **the key is the exact bytes judged**, never a
 * path, an mtime, or a command. The key covers the provider, the model, the
 * question, and the rendered state, so a changed file, a changed question, or a
 * changed model is a different key — invalidation is not a policy that can be
 * wrong, it is a mismatch. A hit therefore cannot answer a question the
 * classifier was not asked about exactly this state.
 *
 * A cache entry is an optimization and nothing else: a lost, unreadable, or
 * corrupt entry is a miss, and a miss is what the sweep did before this module
 * existed. Nothing here may fail a sweep, so nothing here throws.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigRoot } from "../config-root.ts";

/** Everything that can change an answer. Nothing else may enter the key: an
 * input that changes an answer but not the key would serve a stale verdict. */
export interface JudgmentCacheKey {
	readonly provider: string;
	readonly model: string;
	readonly question: string;
	readonly state: string;
}

/** Digest one judgment request. `JSON.stringify` on a tuple rather than string
 * concatenation: a separator that appears inside a field can otherwise make two
 * different requests collide. */
export function judgmentCacheKey(key: JudgmentCacheKey): string {
	return createHash("sha256")
		.update(JSON.stringify([key.provider, key.model, key.question, key.state]))
		.digest("hex");
}

export interface JudgmentCache {
	/** The remembered probability, or undefined for a miss. */
	read(key: string): number | undefined;
	/** Remember a usable answer. Called only after one arrived. */
	write(key: string, noul: number): void;
}

/** A cache that remembers nothing, for a sweep that must ask again. */
export const NO_JUDGMENT_CACHE: JudgmentCache = {
	read: () => undefined,
	write: () => undefined,
};

/** Entries kept before the oldest are dropped. An entry is ~200 bytes, so this
 * bounds the directory at a few megabytes. */
export const JUDGMENT_CACHE_MAX_ENTRIES = 5_000;
/** Pruning costs a readdir, so it runs every N writes rather than on every one.
 * The cap is therefore soft by up to this many entries. */
export const JUDGMENT_CACHE_PRUNE_EVERY_WRITES = 128;

export interface JudgmentCacheOptions {
	readonly maxEntries?: number;
	readonly pruneEveryWrites?: number;
}

export function classifierCacheDir(root: string = resolveConfigRoot()): string {
	return path.join(root, "classifier-cache");
}

/** Off switch for an operator debugging classifier behaviour: a cache can hide
 * that a call happened, and hiding that on purpose is a different thing from
 * being unable to see it. */
export function judgmentCacheEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env.AGENTIC_CLASSIFIER_CACHE?.trim().toLowerCase();
	return !(
		value === "off" ||
		value === "0" ||
		value === "false" ||
		value === "no"
	);
}

export function diskJudgmentCache(
	dir: string = classifierCacheDir(),
	options: JudgmentCacheOptions = {},
): JudgmentCache {
	if (!judgmentCacheEnabled()) return NO_JUDGMENT_CACHE;
	const maxEntries = options.maxEntries ?? JUDGMENT_CACHE_MAX_ENTRIES;
	const pruneEveryWrites =
		options.pruneEveryWrites ?? JUDGMENT_CACHE_PRUNE_EVERY_WRITES;
	let writesSincePrune = 0;
	return {
		read(key) {
			try {
				const entry = JSON.parse(
					fs.readFileSync(path.join(dir, `${key}.json`), "utf8"),
				) as { noul?: unknown };
				if (typeof entry.noul !== "number" || !Number.isFinite(entry.noul))
					return undefined;
				const noul = entry.noul;
				// A probability outside 0..1 is not one this sweep can band, so it is a
				// miss rather than a verdict.
				return noul >= 0 && noul <= 1 ? noul : undefined;
			} catch {
				// Absent, unreadable, or malformed is a miss: the entry is an
				// optimization, so its absence may never be an error.
				return undefined;
			}
		},
		write(key, noul) {
			if (!Number.isFinite(noul) || noul < 0 || noul > 1) return;
			try {
				fs.mkdirSync(dir, { recursive: true });
				// Write then rename: a reader never sees half an entry, whatever
				// happens to the process in between.
				const temporary = path.join(
					dir,
					`.${key}.${process.pid}.${Date.now()}.tmp`,
				);
				fs.writeFileSync(
					temporary,
					JSON.stringify({ v: 1, noul, at: Date.now() }),
					"utf8",
				);
				fs.renameSync(temporary, path.join(dir, `${key}.json`));
			} catch {
				/* a cache that cannot be written is still a working cache */
			}
			writesSincePrune += 1;
			if (writesSincePrune % pruneEveryWrites === 0)
				pruneJudgmentCache(dir, maxEntries);
		},
	};
}

/** Keep the newest entries. Races with another process lose entries, which is
 * the safe direction for a cache: a lost entry is a miss, never a wrong answer. */
export function pruneJudgmentCache(
	dir: string,
	maxEntries: number = JUDGMENT_CACHE_MAX_ENTRIES,
): number {
	try {
		const entries = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const file = path.join(dir, name);
				return { file, mtimeMs: fs.statSync(file).mtimeMs };
			});
		if (entries.length <= maxEntries) return 0;
		const doomed = entries
			.sort((a, b) => a.mtimeMs - b.mtimeMs)
			.slice(0, entries.length - maxEntries);
		for (const entry of doomed) {
			try {
				fs.unlinkSync(entry.file);
			} catch {
				/* another process may have pruned it first */
			}
		}
		return doomed.length;
	} catch {
		return 0;
	}
}
