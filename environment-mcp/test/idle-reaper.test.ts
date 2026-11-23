import { expect, test } from "bun:test";
import {
	createIdleReaper,
	type IdleClient,
} from "../src/services/idle-reaper.ts";

function client(overrides: Partial<IdleClient> & { at: number }) {
	let at = overrides.at;
	const stopped: string[] = [];
	const value: IdleClient & { stopped: string[]; readonly at: number } = {
		lastActivity: () => at,
		touch: (now) => {
			at = now;
		},
		isBusy: () => false,
		ownedApps: () => ["api"],
		stopApp: async (app) => {
			stopped.push(app);
		},
		...overrides,
		get at() {
			return at;
		},
		stopped,
	};
	return value;
}

test("idle reaper stops only stale, non-busy owned apps and never borrowed state", async () => {
	const stale = client({ at: 0 });
	const fresh = client({ at: 900 });
	const busy = client({ at: 0, isBusy: () => true });
	const empty = client({ at: 0, ownedApps: () => [] });
	const reaper = createIdleReaper([stale, fresh, busy, empty], 1_000, {
		now: () => 1_000,
		signal: new AbortController().signal,
	});
	await reaper.tick();
	expect(stale.stopped).toEqual(["api"]);
	expect(fresh.stopped).toEqual([]);
	expect(busy.stopped).toEqual([]);
	expect(empty.stopped).toEqual([]);
	expect(stale.at).toBe(1_000);
	expect(fresh.at).toBe(900);
	expect(busy.at).toBe(1_000);
	expect(empty.at).toBe(1_000);
});

test("idle reaper keeps an owned record when cleanup fails and retries next tick", async () => {
	let attempts = 0;
	const failing = client({
		at: 0,
		stopApp: async () => {
			attempts++;
			throw new Error("cleanup failed");
		},
	});
	const reaper = createIdleReaper([failing], 100, {
		now: () => 100,
		signal: new AbortController().signal,
	});
	await reaper.tick();
	expect(attempts).toBe(1);
	expect(failing.at).toBe(100);
});

test("an idle client closes its clean scope after stopping owned apps", async () => {
	let closes = 0;
	const stale = client({
		at: 0,
		close: async () => {
			closes++;
		},
	});
	const fresh = client({ at: 900 });
	const reaper = createIdleReaper([stale, fresh], 1_000, {
		now: () => 1_000,
		signal: new AbortController().signal,
	});
	await reaper.tick();
	expect(closes).toBe(1);
	expect(stale.stopped).toEqual(["api"]);
	expect(fresh.stopped).toEqual([]);
});
