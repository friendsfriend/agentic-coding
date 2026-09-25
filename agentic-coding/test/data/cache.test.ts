import { describe, expect, test } from "bun:test";
import { DataCache } from "../../src/tui/data/index.ts";

/**
 * Dashboard data cache (establish-opencode-boundaries, task 4.4): keyed reads
 * with cancellation, revision-aware invalidation, targeted event invalidation
 * and an authoritative refresh after an event gap. A late result must never
 * overwrite a newer selection.
 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("data cache", () => {
	test("a read is cached until the key is invalidated", async () => {
		const cache = new DataCache();
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return `value-${calls}`;
		};
		expect(await cache.load("workflow:/repo:wf-1", loader)).toBe("value-1");
		expect(await cache.load("workflow:/repo:wf-1", loader)).toBe("value-1");
		expect(calls).toBe(1);
		cache.invalidate("workflow:/repo:wf-1");
		expect(await cache.load("workflow:/repo:wf-1", loader)).toBe("value-2");
	});

	test("a refresh read bypasses a fresh cached value", async () => {
		const cache = new DataCache();
		let calls = 0;
		const loader = async () => `value-${++calls}`;
		expect(await cache.load("dashboard:/repo:wf-1", loader)).toBe("value-1");
		expect(await cache.load("dashboard:/repo:wf-1", loader)).toBe("value-1");
		expect(
			await cache.load("dashboard:/repo:wf-1", loader, { refresh: true }),
		).toBe("value-2");
	});

	test("a read at a new revision replaces the cached value", async () => {
		const cache = new DataCache();
		const loader = async () => "v";
		await cache.load("k", loader, { revision: 3 });
		expect(cache.read("k")?.revision).toBe(3);
		// same revision: served from cache; new revision: read again
		let calls = 0;
		const counting = async () => {
			calls += 1;
			return "v";
		};
		await cache.load("k", counting, { revision: 3 });
		expect(calls).toBe(0);
		await cache.load("k", counting, { revision: 4 });
		expect(calls).toBe(1);
		expect(cache.read("k")?.revision).toBe(4);
	});

	test("a late result after a newer selection is discarded", async () => {
		const cache = new DataCache();
		const slow = deferred<string>();
		const first = cache.load("workflow:/repo:wf-1", () => slow.promise);
		// the user selects another workflow while the first read is in flight
		cache.invalidate("workflow:/repo:wf-1");
		const second = await cache.load("workflow:/repo:wf-1", async () => "newer");
		expect(second).toBe("newer");
		slow.resolve("stale");
		expect(await first).toBeUndefined();
		expect(cache.read("workflow:/repo:wf-1")?.value).toBe("newer");
	});

	test("aborting the caller's signal cancels the in-flight read", async () => {
		const cache = new DataCache();
		const controller = new AbortController();
		let sawAbort = false;
		const pending = cache.load(
			"k",
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						sawAbort = true;
						reject(new DOMException("cancelled", "AbortError"));
					});
				}),
			{ signal: controller.signal },
		);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(sawAbort).toBe(true);
		expect(cache.read("k")).toBeUndefined();
	});

	test("a workflow event invalidates only the resources it names", async () => {
		const cache = new DataCache();
		const loader = async () => "v";
		for (const key of [
			"workflow:/repo:wf-1",
			"views:/repo",
			"dashboard:/repo:wf-1",
			"artifacts:/repo:wf-1",
			"wiki:/repo:wf-1",
			"git:/repo:wf-1",
			"workflow:/other:wf-2",
			"telemetry:traces:*:1",
		])
			await cache.load(key, loader);
		cache.applyEvent({
			instance: "server",
			sequence: 1,
			domain: "workflow",
			kind: "workflow.updated",
			resource: "/repo",
			at: new Date(0).toISOString(),
			payload: null,
		});
		for (const key of [
			"workflow:/repo:wf-1",
			"views:/repo",
			"dashboard:/repo:wf-1",
			"artifacts:/repo:wf-1",
			"wiki:/repo:wf-1",
			"git:/repo:wf-1",
		])
			expect(cache.has(key)).toBe(false);
		// another repository and the telemetry reads are untouched
		expect(cache.has("workflow:/other:wf-2")).toBe(true);
		expect(cache.has("telemetry:traces:*:1")).toBe(true);
	});

	test("a telemetry event invalidates telemetry reads only", async () => {
		const cache = new DataCache();
		const loader = async () => "v";
		await cache.load("telemetry:traces:*:1", loader);
		await cache.load("workflow:/repo:wf-1", loader);
		cache.applyEvent({
			instance: "server",
			sequence: 2,
			domain: "telemetry",
			kind: "telemetry.spans",
			at: new Date(0).toISOString(),
			payload: null,
		});
		expect(cache.has("telemetry:traces:*:1")).toBe(false);
		expect(cache.has("workflow:/repo:wf-1")).toBe(true);
	});

	test("an event gap marks every cached value stale", async () => {
		const cache = new DataCache();
		const loader = async () => "v";
		await cache.load("workflow:/repo:wf-1", loader);
		await cache.load("telemetry:traces:*:1", loader);
		const epoch = cache.staleEpoch;
		cache.markStale();
		expect(cache.staleEpoch).toBe(epoch + 1);
		expect(cache.has("workflow:/repo:wf-1")).toBe(false);
		expect(cache.has("telemetry:traces:*:1")).toBe(false);
		// the next read is authoritative rather than served from the cache
		let calls = 0;
		await cache.load("workflow:/repo:wf-1", async () => {
			calls += 1;
			return "fresh";
		});
		expect(calls).toBe(1);
	});

	test("subscribers hear about invalidated keys", async () => {
		const cache = new DataCache();
		const seen: string[] = [];
		const unsubscribe = cache.subscribe((key) => seen.push(key));
		await cache.load("k", async () => "v");
		cache.invalidate("k");
		unsubscribe();
		cache.invalidate("k");
		expect(seen).toEqual(["k", "k"]);
	});
});
