import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	classifierCacheDir,
	diskJudgmentCache,
	type JudgmentCache,
	judgmentCacheEnabled,
	judgmentCacheKey,
	NO_JUDGMENT_CACHE,
	pruneJudgmentCache,
} from "../src/workflow/classifier-cache.ts";
import {
	invokeFileJudgment,
	renderFileJudgmentState,
} from "../src/workflow/classifier-runner.ts";
import {
	FILE_JUDGMENT_QUESTION,
	FILE_JUDGMENT_QUESTION_ID,
	pruneFileJudgments,
} from "../src/workflow/classifiers.ts";

const KEY = {
	provider: "laya-local",
	model: "laya-system-one",
	question: "Does the file leak a credential?",
	state: "file: a.ts\n--- file content ---\nconst x = 1\n",
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("judgment cache keys", () => {
	test("the same request keeps one key across processes and calls", () => {
		expect(judgmentCacheKey({ ...KEY })).toBe(judgmentCacheKey({ ...KEY }));
	});

	test("every input that can change an answer changes the key", () => {
		const base = judgmentCacheKey(KEY);
		expect(judgmentCacheKey({ ...KEY, provider: "opencode-zen" })).not.toBe(
			base,
		);
		expect(judgmentCacheKey({ ...KEY, model: "other" })).not.toBe(base);
		expect(judgmentCacheKey({ ...KEY, question: "Does it leak?" })).not.toBe(
			base,
		);
		// The exact bytes judged, so one changed character is a different question.
		expect(judgmentCacheKey({ ...KEY, state: `${KEY.state} ` })).not.toBe(base);
	});

	test("a separator inside a field cannot make two requests collide", () => {
		// Concatenating the parts would make these two inputs the same string.
		const left = judgmentCacheKey({ ...KEY, question: "a", state: "b\u0000c" });
		const right = judgmentCacheKey({
			...KEY,
			question: "a\u0000b",
			state: "c",
		});
		expect(left).not.toBe(right);
	});
});

describe("disk judgment cache", () => {
	test("a written answer is read back and nothing else is", () => {
		const cache = diskJudgmentCache(dir);
		const key = judgmentCacheKey(KEY);
		expect(cache.read(key)).toBeUndefined();
		cache.write(key, 0.83);
		expect(cache.read(key)).toBe(0.83);
		expect(
			cache.read(judgmentCacheKey({ ...KEY, model: "other" })),
		).toBeUndefined();
	});

	test("a corrupt or out-of-range entry is a miss, never an error", () => {
		const cache = diskJudgmentCache(dir);
		const key = judgmentCacheKey(KEY);
		writeFileSync(join(dir, `${key}.json`), "not json at all");
		expect(cache.read(key)).toBeUndefined();
		writeFileSync(join(dir, `${key}.json`), JSON.stringify({ noul: "0.9" }));
		expect(cache.read(key)).toBeUndefined();
		writeFileSync(join(dir, `${key}.json`), JSON.stringify({ noul: 4 }));
		expect(cache.read(key)).toBeUndefined();
		// And an unwritable directory is a working cache that remembers nothing.
		const unwritable = diskJudgmentCache("/dev/null/nope");
		expect(() => unwritable.write(key, 0.5)).not.toThrow();
		expect(unwritable.read(key)).toBeUndefined();
	});

	test("an unusable probability is not stored", () => {
		const cache = diskJudgmentCache(dir);
		cache.write(judgmentCacheKey(KEY), Number.NaN);
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual(
			[],
		);
	});

	test("the write path prunes on its cadence, and the newest write survives", () => {
		const cache = diskJudgmentCache(dir, {
			maxEntries: 5,
			pruneEveryWrites: 4,
		});
		for (let index = 0; index < 12; index += 1)
			cache.write(judgmentCacheKey({ ...KEY, state: `state ${index}` }), 0.5);
		const remaining = readdirSync(dir).filter((name) => name.endsWith(".json"));
		// The cap is soft by up to one prune interval.
		expect(remaining.length).toBeLessThanOrEqual(5 + 3);
		expect(cache.read(judgmentCacheKey({ ...KEY, state: "state 11" }))).toBe(
			0.5,
		);
	});

	test("pruning keeps the newest entries and reports what it dropped", () => {
		// Explicit mtimes, so "oldest" is unaffected by the filesystem clock's
		// resolution within one test run.
		for (let index = 0; index < 30; index += 1) {
			const file = join(dir, `entry-${index}.json`);
			writeFileSync(file, JSON.stringify({ v: 1, noul: 0.5 }));
			const at = new Date(1_700_000_000_000 + index * 1_000);
			utimesSync(file, at, at);
		}
		expect(pruneJudgmentCache(dir, 10)).toBe(20);
		const remaining = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort();
		expect(remaining.length).toBe(10);
		expect(remaining).toContain("entry-29.json");
		expect(remaining).not.toContain("entry-0.json");
		// A directory that cannot be read is not an error either.
		expect(pruneJudgmentCache("/dev/null/nope", 10)).toBe(0);
	});

	test("the kill switch turns the cache off without changing its callers", () => {
		expect(judgmentCacheEnabled({})).toBe(true);
		expect(judgmentCacheEnabled({ AGENTIC_CLASSIFIER_CACHE: "on" })).toBe(true);
		for (const off of ["off", "0", "false", "NO", " off "])
			expect(judgmentCacheEnabled({ AGENTIC_CLASSIFIER_CACHE: off })).toBe(
				false,
			);
		expect(NO_JUDGMENT_CACHE.read("anything")).toBeUndefined();
		expect(() => NO_JUDGMENT_CACHE.write("anything", 1)).not.toThrow();
	});

	test("the cache lives under the config root, never in the worktree", () => {
		// A cache written inside the worktree would enter the next round's
		// changed-file set and the sweep would judge its own output.
		expect(classifierCacheDir("/tmp/config")).toBe(
			join("/tmp/config", "classifier-cache"),
		);
	});
});

describe("a sweep that repeats an earlier round", () => {
	// The hosted provider is the seam a test can drive: it has no start hook (so no
	// sidecar boots) and its transport is `fetch`, which the test owns. The candidate
	// set is cumulative across rounds, which is what makes this the common case.
	const BINDING = { provider: "opencode-zen", model: "opencode/jev-1.13-free" };
	const CANDIDATES = [
		{ path: "a.ts", content: "const a = 1\n" },
		{ path: "b.ts", content: "const b = 2\n" },
	];

	function memoryCache(): { cache: JudgmentCache; writes: string[] } {
		const entries = new Map<string, number>();
		const writes: string[] = [];
		return {
			writes,
			cache: {
				read: (key) => entries.get(key),
				write: (key, noul) => {
					entries.set(key, noul);
					writes.push(key);
				},
			},
		};
	}

	function stubClassifier(noul: number): { calls: () => number } {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					answers: { [FILE_JUDGMENT_QUESTION_ID]: { type: "noul", noul } },
					usage: { total_tokens: 12 },
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		return { calls: () => calls };
	}

	beforeEach(() => {
		process.env.OPENCODE_API_KEY = "test-key";
	});

	afterEach(() => {
		delete process.env.OPENCODE_API_KEY;
	});

	test("the first round judges, the second is answered without a call", async () => {
		const classifier = stubClassifier(0.91);
		const { cache, writes } = memoryCache();
		const first = await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache }),
		);
		expect(classifier.calls()).toBe(2);
		expect(first.cached).toBe(0);
		expect(first.judged).toBe(2);
		expect(writes.length).toBe(2);

		// Same bytes, same question, same model: two rounds, two calls in total.
		const second = await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache }),
		);
		expect(classifier.calls()).toBe(2);
		expect(second.cached).toBe(2);
		expect(second.judged).toBe(2);
		expect(second.flagged.length).toBe(2);
	});

	test("a fully cached sweep never reaches a transport", async () => {
		const { cache } = memoryCache();
		// Seed the exact key the sweep looks up, for every candidate.
		for (const candidate of CANDIDATES)
			cache.write(
				judgmentCacheKey({
					provider: BINDING.provider,
					model: BINDING.model,
					question: FILE_JUDGMENT_QUESTION,
					state: renderFileJudgmentState("", candidate),
				}),
				0.93,
			);
		globalThis.fetch = (async () => {
			throw new Error("a cached sweep must not call anyone");
		}) as unknown as typeof fetch;
		const outcome = await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache }),
		);
		expect(outcome.cached).toBe(2);
		expect(outcome.flagged.length).toBe(2);
	});

	test("a changed file is judged again, an untouched one is not", async () => {
		const classifier = stubClassifier(0.91);
		const { cache } = memoryCache();
		await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache }),
		);
		expect(classifier.calls()).toBe(2);
		const edited = [
			{ path: "a.ts", content: "const a = 1 // touched\n" },
			CANDIDATES[1],
		];
		const afterEdit = await Effect.runPromise(
			invokeFileJudgment(BINDING, edited, [], { cache }),
		);
		expect(classifier.calls()).toBe(3);
		expect(afterEdit.cached).toBe(1);
		expect(afterEdit.judged).toBe(2);
	});

	test("a failed call is not remembered as a verdict", async () => {
		const { cache, writes } = memoryCache();
		globalThis.fetch = (async () =>
			new Response("upstream is down", {
				status: 503,
			})) as unknown as typeof fetch;
		const outcome = await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES.slice(0, 1), [], { cache }),
		);
		expect(outcome.judged).toBe(0);
		expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
			"no usable answer",
		]);
		expect(writes).toEqual([]);
	});

	test("cache: false asks again every round and remembers nothing", async () => {
		const classifier = stubClassifier(0.91);
		await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache: false }),
		);
		const again = await Effect.runPromise(
			invokeFileJudgment(BINDING, CANDIDATES, [], { cache: false }),
		);
		expect(classifier.calls()).toBe(4);
		expect(again.cached).toBe(0);
	});
});

describe("cached judgments in the sweep outcome", () => {
	test("the cached count is carried into the bands it was judged in", () => {
		const outcome = pruneFileJudgments(
			[
				{ path: "a.ts", noul: 0.95, cached: true },
				{ path: "b.ts", noul: 0.1 },
				{ path: "c.ts", noul: 0.1, cached: true },
			],
			[],
		);
		expect(outcome.judged).toBe(3);
		expect(outcome.cached).toBe(2);
		expect(outcome.flagged.map((entry) => entry.path)).toEqual(["a.ts"]);
		expect(outcome.cleared).toBe(2);
	});

	test("an unanswered candidate is not counted as cached", () => {
		const outcome = pruneFileJudgments([{ path: "a.ts", noul: undefined }], []);
		expect(outcome.cached).toBe(0);
		expect(outcome.judged).toBe(0);
	});
});
