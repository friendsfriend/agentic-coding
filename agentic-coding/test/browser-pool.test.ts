// The browser pool and session (`add-agent-browser-sessions`, tasks 3.1-3.3,
// and the concurrency review's fixes).
//
// Everything here runs against the fake driver, so the pool's lifecycle rules —
// one shared browser, isolated contexts, a cap with FIFO queueing, an idle TTL,
// crash handling and recording — are checked without a Chromium download. The
// real driver is covered by `scripts/browser-spike.ts` and the opt-in smoke
// test.
//
// The concurrency cases are asserted through *interleaved* calls rather than
// sequential ones: the pool serves concurrent requests, so a check-then-act that
// only holds sequentially is not holding at all.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bannerScript } from "../src/server/browser/banner.ts";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import type { BrowserSession } from "../src/server/browser/session.ts";
import { snapshotRefs } from "../src/server/browser/snapshot.ts";

const VIEWPORT = { width: 1024, height: 768 };

function poolWith(
	driver: ReturnType<typeof createFakeDriver>,
	options: {
		maxSessions?: number;
		idleTtlMs?: number;
		now?: () => number;
	} = {},
): BrowserPool {
	return new BrowserPool({
		driver,
		launch: () => ({ headless: true, executablePath: "/fake/browser" }),
		maxSessions: () => options.maxSessions ?? 4,
		idleTtlMs: () => options.idleTtlMs ?? 15 * 60_000,
		...(options.now ? { now: options.now } : {}),
	});
}

const open = (pool: BrowserPool, owner: string, name = "default") =>
	pool.acquire({ owner, name, viewport: VIEWPORT, url: "http://app.local/" });

function scratchDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A pool whose launch options are recorded as given, so a headed launch is
 * observable, and whose session closes are recorded by cause. */
function interactivePool(
	driver: ReturnType<typeof createFakeDriver>,
	options: { readonly now?: () => number; readonly idleTtlMs?: number } = {},
) {
	const closes: Array<{ readonly name: string; readonly cause: string }> = [];
	const pool = new BrowserPool({
		driver,
		// What the installer does: a headed request becomes a real window launch.
		launch: (launchOptions) => ({ headless: launchOptions?.headed !== true }),
		maxSessions: () => 4,
		idleTtlMs: () => options.idleTtlMs ?? 15 * 60_000,
		...(options.now ? { now: options.now } : {}),
		onSessionClosed: (session, cause) => {
			closes.push({ name: session.name, cause });
		},
	});
	return { pool, closes };
}

const BANNER = {
	stage: "grid-int",
	app: "Grid web",
	role: "clerk",
	reason: "no-credentials" as const,
	deadline: "00:00 local (in about 15 minutes)",
	canConfirm: true,
};

const promotes = (driver: ReturnType<typeof createFakeDriver>) =>
	driver.launchOptions.filter((options) => options.headless === false).length;

describe("browser pool lifecycle", () => {
	test("one browser serves isolated contexts per run", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const first = await open(pool, "workflow:a");
		const second = await open(pool, "workflow:b");
		expect(driver.launches).toBe(1);
		expect(driver.contexts).toBe(2);
		expect(first.context).not.toBe(second.context);
		expect(first.url).toBe("http://app.local/");
		await pool.closeAll();
	});

	test("a run's own session is reused by name, never opened twice", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const first = await open(pool, "workflow:a", "default");
		const again = await open(pool, "workflow:a", "default");
		expect(again).toBe(first);
		expect(driver.contexts).toBe(1);
		await pool.closeAll();
	});

	test("concurrent opens share one launch and one context each, never two browsers", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 4 });
		// Every open evaluates the idle state before any of them has a browser:
		// a second launch here would mean two Chromium processes for one server.
		const opened = await Promise.all([
			open(pool, "workflow:a"),
			open(pool, "workflow:b"),
			open(pool, "workflow:c"),
			open(pool, "workflow:d"),
		]);
		expect(driver.launches).toBe(1);
		expect(new Set(opened.map((session) => session.owner)).size).toBe(4);
		expect(pool.summaries()).toHaveLength(4);
		await pool.closeAll();
	});

	test("concurrent opens cannot exceed the cap", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 2 });
		// Three opens evaluated before any of them registered a session: without a
		// reservation, all three would see a free slot and all three would take it.
		const pending = [
			open(pool, "workflow:a"),
			open(pool, "workflow:b"),
			open(pool, "workflow:c"),
		];
		await Bun.sleep(5);
		expect(pool.summaries()).toHaveLength(2);
		// The third is queued, not granted and not failed; releasing a slot grants it.
		await pool.close("workflow:a", "default");
		const owners = (await Promise.all(pending)).map((session) => session.owner);
		expect(owners).toContain("workflow:c");
		expect(pool.summaries()).toHaveLength(2);
		await pool.closeAll();
	});

	test("concurrent opens of one key share one context, never two", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		// Two opens of the same (owner, name) — the agent host issues tool calls
		// concurrently — must resolve to one session, not two contexts under one id.
		const [first, second] = await Promise.all([
			open(pool, "workflow:a", "default"),
			open(pool, "workflow:a", "default"),
		]);
		expect(second).toBe(first);
		expect(driver.contexts).toBe(1);
		expect(pool.summaries()).toHaveLength(1);
		await pool.closeAll();
	});

	test("a slot released by a close goes to the queued waiter, not to a new open", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 1 });
		await open(pool, "workflow:a");
		const waiter = open(pool, "workflow:b").then((session) => session.owner);
		await Bun.sleep(5);
		// The release hands the slot to the already-queued waiter before the slot is
		// visible as free, so a later open cannot overtake it.
		await pool.close("workflow:a", "default");
		const later = open(pool, "workflow:c");
		expect(await waiter).toBe("workflow:b");
		await pool.close("workflow:b", "default");
		expect((await later).owner).toBe("workflow:c");
		await pool.closeAll();
	});

	test("a session with a request in flight is refused a close, not closed under it", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		session.beginUse();
		await expect(pool.close("workflow:a", "default")).rejects.toThrow(
			/is still handling a request/,
		);
		expect(pool.summaries()).toHaveLength(1);
		session.endUse();
		expect(await pool.close("workflow:a", "default")).toBe(true);
		await pool.closeAll();
	});

	test("the first navigation counts as work in flight", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		driver.holdGoto = true;
		const opening = open(pool, "workflow:a");
		await Bun.sleep(5);
		const session = pool.session("workflow:a", "default");
		expect(session.busy).toBe(true);
		// A concurrent close is refused rather than closing the page the open is
		// still loading, and the sweep leaves it alone.
		await expect(pool.close("workflow:a", "default")).rejects.toThrow(
			/is still handling a request/,
		);
		expect(await pool.sweepIdle()).toBe(0);
		driver.releaseGoto();
		expect((await opening).url).toBe("http://app.local/");
		expect(session.busy).toBe(false);
		await pool.closeAll();
	});

	test("a failed first navigation frees exactly one slot", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 1 });
		// The only slot goes to an open whose navigation fails, while two other
		// runs wait for it. The failure frees that one slot — not two.
		driver.failNextGoto = true;
		const failing = open(pool, "workflow:a");
		const waiting = [open(pool, "workflow:b"), open(pool, "workflow:c")];
		await expect(failing).rejects.toThrow(/CONNECTION_REFUSED/);
		await Bun.sleep(5);
		// Exactly one waiter took the freed slot: with a second wake for the same
		// release both would have created a session under a cap of one.
		const granted = await waiting[0];
		expect(granted.owner).toBe("workflow:b");
		expect(pool.summaries()).toHaveLength(1);
		await Bun.sleep(5);
		expect(pool.summaries()).toHaveLength(1);
		// The other is still queued, and the next release grants it.
		await pool.close("workflow:b", "default");
		expect((await waiting[1]).owner).toBe("workflow:c");
		await pool.closeAll();
	});

	test("the cap queues opens FIFO and releases on close", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 1 });
		await open(pool, "workflow:a");
		let second: BrowserSession | undefined;
		const pending = open(pool, "workflow:b").then((session) => {
			second = session;
			return session;
		});
		// Still queued: nothing has been released yet.
		await Bun.sleep(5);
		expect(second).toBeUndefined();
		expect(await pool.close("workflow:a", "default")).toBe(true);
		const granted = await pending;
		expect(granted.owner).toBe("workflow:b");
		expect(second).toBe(granted);
		await pool.closeAll();
	});

	test("a run that holds the whole cap is refused rather than deadlocked", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver, { maxSessions: 1 });
		await open(pool, "workflow:a", "default");
		await expect(open(pool, "workflow:a", "second")).rejects.toThrow(
			/browser\.max_sessions/,
		);
		// Concurrently as well: the refusal is not an artifact of running them one
		// after another.
		const raced = await Promise.allSettled([
			open(pool, "workflow:a", "second"),
			open(pool, "workflow:a", "third"),
		]);
		expect(raced.every((entry) => entry.status === "rejected")).toBe(true);
		expect(pool.summaries()).toHaveLength(1);
		await pool.closeAll();
	});

	test("a failed first navigation does not leave a half-open session", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		// The app is not up yet: the navigation fails after the context exists.
		driver.failGoto = true;
		await expect(open(pool, "workflow:a")).rejects.toThrow(
			/CONNECTION_REFUSED/,
		);
		// Nothing was registered, so the retry opens a fresh context and reaches the
		// URL instead of "reusing" a page still sitting on about:blank.
		expect(pool.summaries()).toEqual([]);
		driver.failGoto = false;
		const session = await open(pool, "workflow:a");
		expect(session.url).toBe("http://app.local/");
		expect(pool.summaries()).toHaveLength(1);
		await pool.closeAll();
	});

	test("an idle session is closed on the next request, not by a timer", async () => {
		let now = 1_000_000;
		const driver = createFakeDriver();
		const pool = poolWith(driver, { now: () => now, idleTtlMs: 1_000 });
		await open(pool, "workflow:a");
		now += 2_000;
		expect(await pool.sweepIdle()).toBe(1);
		expect(pool.summaries()).toEqual([]);
		await pool.closeAll();
	});

	test("a session with work in flight is never swept", async () => {
		let now = 1_000_000;
		const driver = createFakeDriver();
		const pool = poolWith(driver, { now: () => now, idleTtlMs: 1_000 });
		const session = await open(pool, "workflow:a");
		session.beginUse();
		now += 10_000_000;
		expect(await pool.sweepIdle()).toBe(0);
		expect(pool.summaries()).toHaveLength(1);
		session.endUse();
		expect(await pool.sweepIdle()).toBe(1);
		await pool.closeAll();
	});

	test("a crashed browser marks its sessions and relaunches on the next open", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		driver.crash();
		expect(() => pool.session("workflow:a", "default")).toThrow(/went away/);
		expect(session.crashed).toBe(true);
		const reopened = await open(pool, "workflow:a");
		expect(reopened.crashed).toBe(false);
		expect(driver.launches).toBe(2);
		await pool.closeAll();
	});

	test("closing an owner releases everything that owner held", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		await open(pool, "workflow:a", "default");
		await open(pool, "workflow:a", "second");
		await open(pool, "workflow:b");
		expect(await pool.closeOwner("workflow:a")).toBe(2);
		expect(pool.summaries().map((entry) => entry.owner)).toEqual([
			"workflow:b",
		]);
		await pool.closeAll();
	});
});

describe("the interactive browser a login hand-off needs", () => {
	test("nothing headed is launched until a login actually needs one", async () => {
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver);
		const session = await open(pool, "workflow:a");
		// Only a hand-off asks for a window.
		expect(driver.launchOptions).toEqual([{ headless: true }]);
		expect(session.browserSlot).toBe("headless");
		// A second, ordinary session still uses the one headless browser.
		await open(pool, "workflow:b");
		expect(promotes(driver)).toBe(0);
		await pool.closeAll();
	});

	test("promotion keeps the session's identity and moves it into the headed browser", async () => {
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver);
		const session = await open(pool, "workflow:a", "stage-clerk");
		const id = session.id;
		const headlessPage = driver.pages[0];
		await pool.openInteractive(
			session,
			"https://idp.local/login",
			async (context) => {
				await context.addInitScript(bannerScript(BANNER));
			},
		);
		// One headed launch, and it is the interactive browser.
		expect(driver.launchOptions).toHaveLength(2);
		expect(driver.launchOptions[1]).toEqual({ headless: false });
		// The session keeps its id, name, owner and slot, and it is still the
		// pool's session under the same key.
		expect(session.id).toBe(id);
		expect(pool.session("workflow:a", "stage-clerk")).toBe(session);
		expect(session.owner).toBe("workflow:a");
		expect(session.browserSlot).toBe("interactive");
		expect(session.url).toBe("https://idp.local/login");
		// The banner is installed *before* the first navigation, and the headless
		// context is gone rather than left behind.
		expect(driver.initScripts.at(-1)?.[0]).toContain("data-ac-handoff-banner");
		expect(headlessPage?.closeReasons).toEqual(["server"]);
		expect(session.crashed).toBe(false);
		await pool.closeAll();
	});

	test("two promoted sessions share the headed browser and nothing else", async () => {
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver);
		const first = await open(pool, "workflow:a", "one");
		const second = await open(pool, "workflow:b", "two");
		await pool.openInteractive(first, "https://idp.local/one");
		await pool.openInteractive(second, "https://idp.local/two");
		expect(promotes(driver)).toBe(1);
		expect(first.context).not.toBe(second.context);
		expect(first.browserSlot).toBe("interactive");
		expect(second.browserSlot).toBe("interactive");
		// A third promotion of an already promoted session stays in its own
		// context: its login state is the point of the hand-off.
		const context = first.context;
		await pool.openInteractive(first, "https://idp.local/again");
		expect(first.context).toBe(context);
		expect(promotes(driver)).toBe(1);
		await pool.closeAll();
	});

	test("a crash in one browser never marks the other browser's sessions", async () => {
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver);
		const promoted = await open(pool, "workflow:a", "promoted");
		const plain = await open(pool, "workflow:b", "plain");
		await pool.openInteractive(promoted, "https://idp.local/login");
		expect(promoted.browserSlot).toBe("interactive");
		// The headless browser goes away: the promoted session is untouched,
		// because it no longer lives there.
		driver.crash("headless");
		expect(promoted.crashed).toBe(false);
		expect(plain.crashed).toBe(true);
		// And the interactive browser's own crash marks only what it holds.
		const other = await open(pool, "workflow:c", "other");
		driver.crash("interactive");
		expect(promoted.crashed).toBe(true);
		expect(other.crashed).toBe(false);
		await pool.closeAll();
	});

	test("the headed browser is closed once it holds no session", async () => {
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver);
		const session = await open(pool, "workflow:a");
		await pool.openInteractive(session, "https://idp.local/login");
		expect(promotes(driver)).toBe(1);
		await pool.close("workflow:a", "default");
		// The next promotion is a fresh process, not the one that was kept alive
		// after its last session left.
		const next = await open(pool, "workflow:b");
		await pool.openInteractive(next, "https://idp.local/login");
		expect(promotes(driver)).toBe(2);
		await pool.closeAll();
	});

	test("a held session is never swept out from under the developer", async () => {
		let clock = 1_000_000;
		const driver = createFakeDriver();
		const { pool } = interactivePool(driver, { now: () => clock });
		const session = await open(pool, "workflow:a");
		await pool.openInteractive(session, "https://idp.local/login");
		session.holdForUser({
			handoffId: "handoff-1",
			deadlineAt: clock + 900_000,
		});
		// Well past the idle TTL, and the hand-off's own deadline is what ends it.
		clock += 20 * 60_000;
		expect(await pool.sweepIdle()).toBe(0);
		expect(pool.session("workflow:a", "default")).toBe(session);
		// Once the hold is released the idle sweep applies again.
		session.releaseHold("handoff-1");
		clock += 20 * 60_000;
		expect(await pool.sweepIdle()).toBe(1);
		await pool.closeAll();
	});

	test("a run ending during a hand-off closes the session and says why", async () => {
		const driver = createFakeDriver();
		const { pool, closes } = interactivePool(driver);
		const session = await open(pool, "workflow:a", "stage-clerk");
		await pool.openInteractive(session, "https://idp.local/login");
		session.holdForUser({
			handoffId: "handoff-1",
			deadlineAt: 1_000_000 + 1_000,
		});
		expect(await pool.closeOwner("workflow:a")).toBe(1);
		// The cause is what tells the hand-off coordinator that this was the run
		// ending, not the developer closing the window.
		expect(closes).toEqual([{ name: "stage-clerk", cause: "owner-closed" }]);
		expect(session.hold).toBeDefined();
		await pool.closeAll();
	});

	test("a recording of a promoted session swaps into the headed browser", async () => {
		const driver = createFakeDriver({ video: "webm-bytes" });
		const { pool } = interactivePool(driver);
		const session = await open(pool, "workflow:a");
		await pool.openInteractive(session, "https://idp.local/login");
		const dir = scratchDir("browser-rec-handed-");
		await pool.startRecording(session, { dir });
		// The recording context is built in the browser the window lives in: a
		// second window would replace the one the developer just used.
		expect(session.browserSlot).toBe("interactive");
		expect(promotes(driver)).toBe(1);
		expect(session.recording).toBeDefined();
		await pool.stopRecording(session, undefined);
		await pool.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("session refs, buffers and recording", () => {
	test("a ref from the snapshot is actionable and a stale one is refused", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const snapshot = await session.snapshot();
		const ref = snapshotRefs(snapshot.text)[0] as string;
		await session.click({ ref });
		expect(driver.performed).toEqual([`click:[data-ac-ref="${ref}"]`]);
		expect(() => session.selectorFor({ ref: "e99" })).toThrow(
			/not a ref from the current snapshot/,
		);
		await pool.closeAll();
	});

	test("a selector is passed through untouched", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		await session.fill({ selector: "#name" }, "ada");
		expect(driver.performed).toEqual(["fill:#name=ada"]);
		await pool.closeAll();
	});

	test("console and network history is bounded and filterable", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const page = driver.lastPage();
		if (!page) throw new Error("no fake page");
		for (let index = 0; index < 700; index++)
			page.emitConsole({ type: "log", text: `line ${index}` });
		page.emitConsole({ type: "error", text: "boom" });
		expect(session.console.size).toBe(500);
		expect(session.consoleEntries({ limit: 1 })).toEqual([
			expect.objectContaining({ level: "error", text: "boom" }),
		]);
		page.emitNetwork({
			kind: "request",
			id: "manual-1",
			method: "GET",
			url: "http://app.local/api/items",
			resourceType: "fetch",
		});
		page.emitNetwork({
			kind: "response",
			id: "manual-1",
			status: 500,
			ok: false,
		});
		const failed = session.networkEntries({ limit: 10, status: 500 });
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			status: 500,
			ok: false,
			method: "GET",
			url: "http://app.local/api/items",
		});
		expect(session.networkEntries({ limit: 10, status: 404 })).toEqual([]);
		expect(session.networkEntries({ limit: 10, url: "/api/" })).toHaveLength(1);
		await pool.closeAll();
	});

	test("the in-flight request index does not grow with the page's history", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const page = driver.lastPage();
		if (!page) throw new Error("no fake page");
		// Every request answers immediately, so nothing stays in flight: the index
		// must not retain the 3000 requests the ring has long since dropped.
		for (let index = 0; index < 3000; index++) {
			const id = `many-${index}`;
			page.emitNetwork({
				kind: "request",
				id,
				method: "GET",
				url: `http://app.local/${index}`,
				resourceType: "fetch",
			});
			page.emitNetwork({ kind: "response", id, status: 200, ok: true });
		}
		expect(session.network.size).toBe(500);
		// The index that matches requests to their answers is bounded by the ring, so
		// it cannot retain the requests the ring has already dropped.
		expect(session.inFlightSize).toBe(0);
		expect(session.networkEntries({ limit: 1 })).toHaveLength(1);
		// A response for an evicted request is a no-op rather than a resurrection.
		page.emitNetwork({
			kind: "response",
			id: "many-0",
			status: 200,
			ok: true,
		});
		expect(session.network.size).toBe(500);
		// Unanswered requests are the case the index exists for: a burst larger than
		// the ring keeps exactly the ring's worth in flight.
		for (let index = 0; index < 3000; index++)
			page.emitNetwork({
				kind: "request",
				id: `open-${index}`,
				method: "GET",
				url: `http://app.local/slow/${index}`,
				resourceType: "fetch",
			});
		expect(session.inFlightSize).toBeLessThanOrEqual(500);
		await pool.closeAll();
	});

	test("a discarded recording leaves no video file and no evidence", async () => {
		const driver = createFakeDriver({ video: "webm-bytes" });
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const dir = scratchDir("browser-rec-");
		await pool.startRecording(session, { dir });
		expect(session.recording).toBeDefined();
		const result = await pool.stopRecording(session, undefined);
		expect(result.videoSaved).toBe(false);
		expect(fs.existsSync(dir)).toBe(false);
		expect(session.recording).toBeUndefined();
		await pool.closeAll();
	});

	test("a kept recording writes the video and the final-frame poster", async () => {
		const driver = createFakeDriver({ video: "webm-bytes" });
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const dir = scratchDir("browser-rec-");
		const scratch = scratchDir("browser-out-");
		await pool.startRecording(session, { dir });
		const result = await pool.stopRecording(session, {
			posterPath: path.join(scratch, "poster.jpg"),
			videoPath: path.join(scratch, "video.webm"),
		});
		expect(result.videoSaved).toBe(true);
		expect(result.posterSaved).toBe(true);
		expect(fs.readFileSync(path.join(scratch, "video.webm"), "utf8")).toBe(
			"webm-bytes",
		);
		expect(fs.statSync(path.join(scratch, "poster.jpg")).size).toBeGreaterThan(
			0,
		);
		// The session survives the swap: a page this pool deliberately replaced is
		// not a crash, even though the fake closes the old pages with the context.
		expect(session.recording).toBeUndefined();
		expect(session.crashed).toBe(false);
		expect(pool.session("workflow:a", "default")).toBe(session);
		const snapshot = await session.snapshot();
		expect(snapshotRefs(snapshot.text).length).toBeGreaterThan(0);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
		await pool.closeAll();
	});

	test("two recordings of one workflow keep their directories apart", async () => {
		const driver = createFakeDriver({ video: "webm-bytes" });
		const pool = poolWith(driver);
		const first = await open(pool, "workflow:a", "one");
		const second = await open(pool, "workflow:a", "two");
		const firstDir = scratchDir("browser-rec-");
		const secondDir = scratchDir("browser-rec-");
		await pool.startRecording(first, { dir: firstDir });
		await pool.startRecording(second, { dir: secondDir });
		// Discarding one recording removes exactly its own directory.
		await pool.stopRecording(first, undefined);
		expect(fs.existsSync(firstDir)).toBe(false);
		expect(fs.existsSync(secondDir)).toBe(true);
		const scratch = scratchDir("browser-out-");
		const kept = await pool.stopRecording(second, {
			posterPath: path.join(scratch, "poster.jpg"),
			videoPath: path.join(scratch, "video.webm"),
		});
		expect(kept.videoSaved).toBe(true);
		fs.rmSync(secondDir, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
		await pool.closeAll();
	});

	test("a second concurrent recording start is refused, not orphaned", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const firstDir = scratchDir("browser-rec-");
		const secondDir = scratchDir("browser-rec-");
		const [first, second] = await Promise.allSettled([
			pool.startRecording(session, { dir: firstDir }),
			pool.startRecording(session, { dir: secondDir }),
		]);
		const outcomes = [first, second];
		expect(
			outcomes.filter((entry) => entry.status === "fulfilled"),
		).toHaveLength(1);
		const refused = outcomes.find((entry) => entry.status === "rejected");
		expect(
			refused?.status === "rejected" ? String(refused.reason) : "",
		).toContain("already recording");
		expect(session.recording).toBeDefined();
		await pool.stopRecording(session, undefined);
		fs.rmSync(firstDir, { recursive: true, force: true });
		fs.rmSync(secondDir, { recursive: true, force: true });
		await pool.closeAll();
	});

	test("one session's recording transition does not block another session", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const first = await open(pool, "workflow:a", "one");
		const second = await open(pool, "workflow:a", "two");
		const dir = scratchDir("browser-rec-");
		// The first session's recording swap parks inside `newContext`.
		driver.holdNewContext = true;
		const starting = pool.startRecording(first, { dir });
		await Bun.sleep(5);
		// A read on the *other* session is answered while that swap is still in
		// flight: the recording gate is per session, not pool-wide.
		const other = await Promise.race([
			pool.autoStopIfExpired(second).then(() => "answered"),
			Bun.sleep(200).then(() => "blocked"),
		]);
		expect(other).toBe("answered");
		driver.releaseNewContext();
		await starting;
		await pool.stopRecording(first, undefined);
		fs.rmSync(dir, { recursive: true, force: true });
		await pool.closeAll();
	});

	test("a swap that fails leaves no half-swapped session", async () => {
		const driver = createFakeDriver();
		const pool = poolWith(driver);
		const session = await open(pool, "workflow:a");
		const dir = scratchDir("browser-rec-");
		await pool.startRecording(session, { dir });
		// The replacement context cannot be created: the stop must not leave the
		// session attached to the recording context it already closed, and the
		// recording must still be stoppable afterwards.
		driver.holdNewContext = true;
		const stopping = pool.stopRecording(session, undefined);
		await Bun.sleep(5);
		expect(session.recording).toBeUndefined();
		driver.releaseNewContext();
		await stopping;
		expect(session.crashed).toBe(false);
		expect(pool.session("workflow:a", "default")).toBe(session);
		fs.rmSync(dir, { recursive: true, force: true });
		await pool.closeAll();
	});

	test("the length limit auto-stops a recording once, discarding it", async () => {
		let now = 1_000_000;
		const driver = createFakeDriver();
		const pool = poolWith(driver, { now: () => now });
		const session = await open(pool, "workflow:a");
		const dir = scratchDir("browser-rec-");
		await pool.startRecording(session, { dir, maxMs: 1_000 });
		now += 5_000;
		// Concurrent requests that all notice the expiry: exactly one stops it.
		const results = await Promise.all([
			pool.autoStopIfExpired(session),
			pool.autoStopIfExpired(session),
			pool.autoStopIfExpired(session),
		]);
		expect(results.filter((stopped) => stopped)).toHaveLength(1);
		expect(session.recording).toBeUndefined();
		expect(fs.existsSync(dir)).toBe(false);
		await pool.closeAll();
	});
});
