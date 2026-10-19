// The login hand-off coordinator (`add-stage-interactive-login`, tasks 3.1 and
// 4.2).
//
// Everything here runs against the fake driver, a fake clock and a fake timer:
// the point of this module is a *bounded* wait, so a test that slept for real
// seconds could not check a 900 s deadline at all. The scheduler seam hands the
// loop its turns, and every turn the test takes advances the clock by the delay
// the loop asked for — so "a deadline nobody answered" is one call, and the
// ordering of queue, activation and ending is asserted rather than hoped for.
//
// The attention record is a stub: the coordinator's contract with the workflow
// layer is three calls (open, answer, close), and the record itself is covered
// in `test/workflow-question.test.ts`.
import { describe, expect, test } from "bun:test";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import {
	HANDOFF_GRACE_MS,
	HANDOFF_OUTCOME_TTL_MS,
	type LoginHandoffAttention,
	LoginHandoffCoordinator,
	type LoginHandoffOutcome,
	type LoginHandoffRequest,
} from "../src/server/browser/handoff.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import type { BrowserSession } from "../src/server/browser/session.ts";
import type { StageLoginRecipe } from "../src/server/stages/schema.ts";

const VIEWPORT = { width: 1024, height: 768 };
const IDP_URL = "https://idp.local/login";
const APP_URL = "https://app.local/";
/** A recipe whose success condition holds once the browser is on the app. */
const SUCCESSFUL: StageLoginRecipe = {
	kind: "interactive",
	success: { notOrigin: IDP_URL },
};
/** A recipe that declares a condition which never holds: only *Done* ends it. */
const UNREACHABLE: StageLoginRecipe = {
	kind: "interactive",
	success: { url: "https://never.example.test/logged-in" },
};
/** A recipe with no declaration at all: *Done* is the only good ending. */
const UNDECLARED: StageLoginRecipe = { kind: "interactive" };

const credential = "handoff-pw-sentinel-9f2c";

interface Harness {
	readonly driver: ReturnType<typeof createFakeDriver>;
	readonly pool: BrowserPool;
	readonly coordinator: LoginHandoffCoordinator;
	readonly attention: {
		opened: Array<Record<string, unknown>>;
		closed: Array<Record<string, unknown>>;
		answered: Array<Record<string, unknown>>;
		/** The answer the developer's record reports while it waits. */
		next: "done" | "abort" | undefined;
	};
	readonly log: string[];
	/** Park `open`/`close` so a test can interleave a second call with a teardown
	 * that is in flight: the interleavings CONC-101/102/103 and QUALITY-103 are
	 * about are only reachable while one of these awaits. */
	holdOpen(): void;
	holdClose(): void;
	/** Release the `at`-th parked `open`/`close` (the first one by default). */
	releaseOpen(at?: number): void;
	releaseClose(at?: number): void;
	/** Advance the clock to the next delayed turn and run it. */
	turn(): Promise<void>;
	/** Run every turn the loop asks for until `until` holds (bounded). */
	until(until: () => boolean, limit?: number): Promise<void>;
	readonly clock: () => number;
	session(owner?: string, name?: string): Promise<BrowserSession>;
}

function harness(
	options: {
		readonly availability?: () => { ok: true } | { ok: false; reason: string };
		readonly headedLaunchFails?: boolean;
		/** The run refuses the attention record, as a terminal workflow or a full
		 * dialogue does. */
		readonly openFails?: boolean;
	} = {},
): Harness {
	const driver = createFakeDriver();
	const pool = new BrowserPool({
		driver,
		launch: (launchOptions) => {
			if (launchOptions?.headed === true && options.headedLaunchFails)
				throw new Error("no window here");
			return { headless: launchOptions?.headed !== true };
		},
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
		now: () => clock,
	});
	let clock = 1_000_000;
	const pending: Array<{ run: () => void; ms: number }> = [];
	const attention = {
		opened: [] as Array<Record<string, unknown>>,
		closed: [] as Array<Record<string, unknown>>,
		answered: [] as Array<Record<string, unknown>>,
		next: undefined as "done" | "abort" | undefined,
	};
	const record: LoginHandoffAttention = {
		open: async (input) => {
			attention.opened.push({ ...input });
			if (options.openFails) throw new Error("the workflow refused the record");
			await gate(holdingOpen, openGates);
		},
		answer: async (input) => {
			attention.answered.push({ ...input });
			return attention.next;
		},
		close: async (input) => {
			attention.closed.push({ ...input });
			await gate(holdingClose, closeGates);
		},
	};
	const log: string[] = [];
	let holdingOpen = false;
	let holdingClose = false;
	const openGates: Array<() => void> = [];
	const closeGates: Array<() => void> = [];
	const gate = (holding: boolean, gates: Array<() => void>): Promise<void> =>
		holding
			? new Promise<void>((resolve) => {
					gates.push(resolve);
				})
			: Promise.resolve();
	const coordinator = new LoginHandoffCoordinator({
		pool,
		attention: record,
		availability:
			(options.availability as () => { ok: true }) ?? (() => ({ ok: true })),
		now: () => clock,
		schedule: (run, ms) => {
			const entry = { run, ms };
			pending.push(entry);
			return () => {
				const at = pending.indexOf(entry);
				if (at >= 0) pending.splice(at, 1);
			};
		},
		log: (line) => log.push(line),
	});
	/** Let every pending promise settle, so an activation that was started in the
	 * background has finished before the next assertion. */
	const quiesce = async () => {
		for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
	};
	const turn = async () => {
		await quiesce();
		const next = pending.shift();
		if (!next) return await quiesce();
		clock += next.ms;
		next.run();
		await quiesce();
	};
	return {
		driver,
		pool,
		coordinator,
		attention,
		log,
		holdOpen: () => {
			holdingOpen = true;
		},
		holdClose: () => {
			holdingClose = true;
		},
		releaseOpen: (at = 0) => {
			for (const resolve of openGates.splice(at, 1)) resolve();
		},
		releaseClose: (at = 0) => {
			for (const resolve of closeGates.splice(at, 1)) resolve();
		},
		clock: () => clock,
		turn,
		until: async (until, limit = 40) => {
			for (let i = 0; i < limit; i++) {
				if (until()) return;
				await turn();
			}
			throw new Error("the hand-off never reached the expected state");
		},
		session: async (owner = "workflow:a", name = "default") =>
			await pool.acquire({
				owner,
				name,
				viewport: VIEWPORT,
				url: IDP_URL,
			}),
	};
}

function request(
	session: BrowserSession,
	overrides: Partial<LoginHandoffRequest> = {},
): LoginHandoffRequest {
	return {
		session,
		stage: "grid-int",
		stageLabel: "Grid integration",
		app: "web",
		appLabel: "Grid web",
		role: "clerk",
		reason: "no-credentials",
		loginUrl: IDP_URL,
		recipe: SUCCESSFUL,
		maxSeconds: 900,
		description: "Grid web · log in as clerk",
		context: "stage grid-int, app web, role clerk",
		...overrides,
	};
}

/** Drive the loop's turns until the hand-off has ended, then read the outcome.
 * The loop is what ends a hand-off (success, deadline, grace), so a test that
 * waited before driving it would wait for something no one is producing. */
async function endOf(
	t: Harness,
	session: BrowserSession,
): Promise<LoginHandoffOutcome> {
	await t.until(() => t.coordinator.pending(session) === undefined);
	return await settle(t.coordinator, session, 1);
}

async function settle(
	coordinator: LoginHandoffCoordinator,
	session: BrowserSession,
	ms = 600_000,
): Promise<LoginHandoffOutcome> {
	const answer = await coordinator.wait(session, ms);
	if (!answer.outcome) throw new Error("the wait answered a pending status");
	return answer.outcome;
}

describe("login hand-off coordination", () => {
	test("a request answers immediately, activates in a window, and ends as ok when the declared condition holds", async () => {
		const t = harness();
		const session = await t.session();
		const status = await t.coordinator.request(request(session));
		// The tool result is the *queued* status, not the window: a launch must
		// never be on the path of the tool's answer.
		expect(status.state).toBe("active");
		expect(status.reason).toBe("no-credentials");
		expect(status.stage).toBe("grid-int");
		expect(typeof status.deadlineAt).toBe("string");
		expect(session.heldByUser).toBe(true);
		// The record was opened with names and the deadline only.
		expect(t.attention.opened).toHaveLength(1);
		expect(JSON.stringify(t.attention.opened[0])).not.toContain(credential);
		// The promotion is a headed launch, the banner is installed before the
		// first navigation, and the window is raised exactly once.
		await t.until(() => session.browserSlot === "interactive");
		expect(t.driver.launchOptions).toContainEqual({ headless: false });
		expect(t.driver.initScripts.at(-1)?.[0]).toContain(
			"data-ac-handoff-banner",
		);
		const focusCalls = t.driver.pages.reduce(
			(total, page) => total + page.focusCalls,
			0,
		);
		expect(focusCalls).toBe(1);
		// Navigating to the login page leaves the identity provider's origin, so
		// the declared condition does not hold yet; the developer logs in, and the
		// same condition does hold.
		expect(t.coordinator.pending(session)?.state).toBe("active");
		// The developer logs in, and the page comes back on the application.
		await session.goto(APP_URL, 30_000);
		const outcome = await endOf(t, session);
		expect(outcome).toMatchObject({
			outcome: "ok",
			via: "handoff",
			verified: true,
			url: APP_URL,
		});
		await t.pool.closeAll();
	});

	test("one hand-off is active and the second waits in FIFO order", async () => {
		const t = harness();
		const first = await t.session("workflow:a", "one");
		const second = await t.session("workflow:b", "two");
		const active = await t.coordinator.request(request(first));
		expect(active.state).toBe("active");
		const queued = await t.coordinator.request(request(second));
		expect(queued.state).toBe("queued");
		expect(queued.queuePosition).toBe(1);
		// The queued session is held from the moment it is queued: the developer
		// will own it, so no agent action may touch it meanwhile.
		expect(second.heldByUser).toBe(true);
		expect(t.log.join("\n")).toContain("queuePosition=1");
		await t.pool.closeAll();
	});

	test("a deadline nobody answered ends as a timeout and closes the hand-off window", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(
			request(session, { recipe: UNREACHABLE, maxSeconds: 1 }),
		);
		const outcome = await endOf(t, session);
		expect(outcome).toEqual({
			outcome: "timeout",
			deadlineAt: new Date(1_000_000 + 1_000).toISOString(),
		});
		expect(session.heldByUser).toBe(false);
		// The deadline closes the window (spec): the session keeps its entry, marked
		// unusable, and the run's next call is told to open it again.
		expect(session.crashed).toBe(true);
		expect(() => t.pool.session("workflow:a", "default")).toThrow(/relaunch/);
		// The record is resolved, and never in a way that resumes a run.
		expect(t.attention.closed).toHaveLength(1);
		expect(t.attention.closed[0]?.answer).toBe("abort");
		expect(t.attention.closed[0]?.by).toBe("system");
		expect(t.attention.closed[0]?.outcome).toBe("login-handoff-timeout");
		await t.pool.closeAll();
	});

	test("the second hand-off's window opens only after the first one ends", async () => {
		const t = harness();
		const first = await t.session("workflow:a", "one");
		const second = await t.session("workflow:b", "two");
		await t.coordinator.request(
			request(first, { recipe: UNREACHABLE, maxSeconds: 900 }),
		);
		await t.until(() => first.browserSlot === "interactive");
		const launches = t.driver.launchOptions.length;
		const queued = await t.coordinator.request(
			request(second, { recipe: UNREACHABLE, maxSeconds: 900 }),
		);
		expect(queued.state).toBe("queued");
		// Nothing of the second hand-off exists yet: no window, no focus, and the
		// session it will use is still the headless one.
		expect(second.browserSlot).toBe("headless");
		expect(t.driver.launchOptions.length).toBe(launches);
		await t.coordinator.abort(first, "developer");
		await t.until(() => second.browserSlot === "interactive");
		// The queue decides *when*; the headed browser itself is shared, so the
		// second hand-off opens its window in the one already running.
		expect(t.coordinator.pending(second)?.state).toBe("active");
		expect(t.driver.pages.length).toBeGreaterThan(1);
		await t.coordinator.abort(second, "developer");
		await t.pool.closeAll();
	});

	test("a queued hand-off whose deadline passes opens no window at all", async () => {
		const t = harness();
		const first = await t.session("workflow:a", "one");
		const second = await t.session("workflow:b", "two");
		await t.coordinator.request(
			request(first, { recipe: UNREACHABLE, maxSeconds: 900 }),
		);
		await t.until(() => first.browserSlot === "interactive");
		const launches = t.driver.launchOptions.length;
		const queued = await t.coordinator.request(
			request(second, { recipe: UNREACHABLE, maxSeconds: 2 }),
		);
		expect(queued.state).toBe("queued");
		// The queue is a wait, and the wait counts against the deadline: while the
		// first hand-off is still open, the second one's two seconds run out.
		await t.until(() => t.clock() > 1_000_000 + 2_000);
		await t.coordinator.abort(first, "developer");
		expect(await settle(t.coordinator, second, 1)).toEqual({
			outcome: "timeout",
			// The deadline was fixed when the hand-off was *requested*, so queue time
			// is what ran it out.
			deadlineAt: queued.deadlineAt,
		});
		// It never became active, so it never had a window to open or to close.
		expect(second.browserSlot).toBe("headless");
		expect(second.crashed).toBe(false);
		expect(t.driver.launchOptions.length).toBe(launches);
		// Both records are closed: the first as the abort that freed the queue, the
		// queued one as the timeout that ended it while it waited.
		await t.until(() => t.attention.closed.length === 2);
		expect(t.attention.closed.map((record) => record.outcome)).toContain(
			"login-handoff-timeout",
		);
		await t.pool.closeAll();
	});

	test("nothing the developer's session produced reaches a buffer, a record or a log line", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(
			request(session, { recipe: UNREACHABLE, maxSeconds: 900 }),
		);
		await t.until(() => session.browserSlot === "interactive");
		// What a real login page produces while the developer types: a console line
		// and a request that quote the value, and both land on the *promoted* page.
		const page = t.driver.lastPage();
		page?.emitConsole({ type: "log", text: `MSAL token=${credential}` });
		page?.emitNetwork({
			kind: "request",
			id: "dev-1",
			method: "GET",
			url: `https://idp.local/cb?code=${credential}`,
			resourceType: "document",
		});
		// The hold suspends the buffers: what the developer typed is not history.
		expect(session.consoleEntries({ limit: 50 })).toEqual([]);
		expect(session.networkEntries({ limit: 50 })).toEqual([]);
		await t.coordinator.abort(session, "developer");
		expect(session.consoleEntries({ limit: 50 })).toEqual([]);
		expect(session.networkEntries({ limit: 50 })).toEqual([]);
		// Nothing the record or a log line holds carries it either. Only the
		// teardown of *this* hand-off runs here, so its own words are the record.
		expect(JSON.stringify(t.attention.opened)).not.toContain(credential);
		expect(JSON.stringify(t.attention.closed)).not.toContain(credential);
		expect(JSON.stringify(t.attention.answered)).not.toContain(credential);
		expect(t.log.join("\n")).not.toContain(credential);
		await t.pool.closeAll();
	});

	test("Abort ends it as the developer's abort, Done without a condition is an unverified ok", async () => {
		const aborted = harness();
		const first = await aborted.session();
		await aborted.coordinator.request(request(first, { recipe: UNREACHABLE }));
		aborted.attention.next = "abort";
		const abort = await endOf(aborted, first);
		expect(abort).toEqual({ outcome: "aborted", by: "developer" });
		expect(aborted.attention.closed[0]?.answer).toBe("abort");
		await aborted.pool.closeAll();

		const done = harness();
		const second = await done.session();
		await done.coordinator.request(request(second, { recipe: UNDECLARED }));
		done.attention.next = "done";
		const ok = await endOf(done, second);
		expect(ok).toMatchObject({
			outcome: "ok",
			via: "handoff",
			verified: false,
		});
		// Nothing beyond origin and path ever leaves: the landing URL is sanitized.
		expect(JSON.stringify(ok)).not.toContain(credential);
		await done.pool.closeAll();
	});

	test("Done with a condition that never holds waits out its grace, then says unverified", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(request(session, { recipe: UNREACHABLE }));
		t.attention.next = "done";
		// The first tick sees *Done* and starts the grace, which then runs out.
		const outcome = await endOf(t, session);
		expect(outcome).toEqual({
			outcome: "unverified",
			url: "https://idp.local/login",
		});
		expect(t.clock()).toBeGreaterThanOrEqual(1_000_000 + HANDOFF_GRACE_MS);
		await t.pool.closeAll();
	});

	test("a window the developer closed ends the hand-off, and the session is left to the agent", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(
			request(session, { recipe: UNREACHABLE, maxSeconds: 900 }),
		);
		await t.until(() => session.browserSlot === "interactive");
		// The developer closes the window: the fake page reports what a real close
		// decides, and nothing re-opens it behind their back.
		const pages = t.driver.pages.length;
		const page = t.driver.lastPage();
		page?.close("user");
		await t.until(() => !session.heldByUser);
		const outcome = await settle(t.coordinator, session, 1);
		expect(outcome).toEqual({ outcome: "aborted", by: "window-closed" });
		expect(session.windowClosed).toBe(true);
		expect(session.crashed).toBe(true);
		// The next call is answered `browser-crashed`, and the agent decides whether a
		// login is worth another window.
		expect(() => t.pool.session("workflow:a", "default")).toThrow(/relaunch/);
		// No new page was created after the close: nothing re-opened the window.
		expect(t.driver.pages.length).toBe(pages);
		await t.pool.closeAll();
	});

	test("the agent and the run ending are told apart, and both end the hand-off", async () => {
		const t = harness();
		const agent = await t.session("workflow:a", "one");
		await t.coordinator.request(request(agent, { recipe: UNREACHABLE }));
		expect(await t.coordinator.abort(agent, "agent")).toBe(true);
		expect(await settle(t.coordinator, agent, 1)).toEqual({
			outcome: "aborted",
			by: "agent",
		});

		const ending = await t.session("workflow:b", "two");
		await t.coordinator.request(request(ending, { recipe: UNREACHABLE }));
		// The pool reports the close cause; the coordinator maps the owner's close
		// to "run-ended", never to the developer's own window.
		await t.coordinator.sessionClosed(ending, "owner-closed");
		expect(await settle(t.coordinator, ending, 1)).toEqual({
			outcome: "aborted",
			by: "run-ended",
		});
		await t.pool.closeAll();
	});

	test("a launch that fails is an outcome, not an exception on the tool path", async () => {
		const t = harness({ headedLaunchFails: true });
		const session = await t.session();
		const status = await t.coordinator.request(request(session));
		expect(status.state).toBe("active");
		expect(await settle(t.coordinator, session)).toEqual({
			outcome: "unavailable",
			reason: "launch-failed",
		});
		expect(session.heldByUser).toBe(false);
		await t.pool.closeAll();
	});

	test("a machine that cannot show a window is refused before anything is queued", async () => {
		const t = harness({
			availability: () => ({ ok: false, reason: "headless-only-browser" }),
		});
		expect(t.coordinator.available()).toEqual({
			ok: false,
			reason: "headless-only-browser",
		});
		// Nothing was launched and no record was created: the routes answer
		// `login-handoff-unavailable` from this same check.
		expect(t.driver.launchOptions).toEqual([]);
		expect(t.attention.opened).toEqual([]);
		await t.pool.closeAll();
	});

	test("a terminal outcome is readable for a while, then the wait has nothing to answer", async () => {
		let clock = 1_000_000;
		const driver = createFakeDriver();
		const pool = new BrowserPool({
			driver,
			launch: (launchOptions) => ({ headless: launchOptions?.headed !== true }),
			maxSessions: () => 4,
			idleTtlMs: () => 900_000,
			now: () => clock,
		});
		const coordinator = new LoginHandoffCoordinator({
			pool,
			availability: () => ({ ok: true }),
			now: () => clock,
			schedule: () => () => {},
		});
		const session = await pool.acquire({
			owner: "workflow:a",
			name: "default",
			viewport: VIEWPORT,
			url: IDP_URL,
		});
		await coordinator.request(
			request(session, { recipe: UNDECLARED, maxSeconds: 900 }),
		);
		await coordinator.abort(session, "developer");
		expect(await settle(coordinator, session, 1)).toEqual({
			outcome: "aborted",
			by: "developer",
		});
		// Shortly after, the same wait still answers the outcome it ended with.
		clock += 30_000;
		expect(await settle(coordinator, session, 1)).toEqual({
			outcome: "aborted",
			by: "developer",
		});
		// After the TTL it is history, and the tool is told to start over rather
		// than inventing a result.
		clock += HANDOFF_OUTCOME_TTL_MS + 1;
		await expect(coordinator.wait(session, 1)).rejects.toThrow(
			/no login hand-off is pending/,
		);
		await pool.closeAll();
	});

	test("the banner names the stage, the application, the role, the wait and the deadline in words", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(request(session));
		await t.until(() => session.browserSlot === "interactive");
		const script = t.driver.initScripts.at(-1)?.[0] ?? "";
		expect(script).toContain("Grid integration");
		expect(script).toContain("Grid web");
		expect(script).toContain("clerk");
		expect(script).toContain("The agent is waiting for this login");
		expect(script).toContain("choose Done in the dashboard");
		expect(script).toContain("closing this window aborts the hand-off");
		// The deadline a person reads is a local wall-clock time with its
		// remainder; the ISO instant stays in the tool result (USAB-103).
		expect(script).toContain("local (in about");
		expect(script).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
		await t.pool.closeAll();
	});

	test("the record names this hand-off's queue state and deadline, and no key", async () => {
		const t = harness();
		const first = await t.session("workflow:a");
		const second = await t.session("workflow:b", "second");
		await t.coordinator.request(request(first));
		const queued = await t.coordinator.request(request(second));
		expect(queued).toMatchObject({ state: "queued", queuePosition: 1 });
		const activeContext = String(t.attention.opened[0]?.context);
		const queuedContext = String(t.attention.opened[1]?.context);
		expect(activeContext).toContain("Its window is opening now.");
		expect(activeContext).toContain("The hand-off expires at");
		expect(activeContext).toContain("local (in about");
		expect(queuedContext).toContain("this hand-off is next (position 1)");
		// Keys belong to the modal footer, which owns keybinds (USAB-104).
		expect(activeContext).not.toContain("Escape");
		expect(queuedContext).not.toContain("Escape");
		await t.pool.closeAll();
	});

	test("a refused record is logged, and no banner promises a Done that is not there", async () => {
		const t = harness({ openFails: true });
		const session = await t.session();
		await t.coordinator.request(request(session, { maxSeconds: 1 }));
		await t.until(() => session.browserSlot === "interactive");
		expect(t.log.join("\n")).toContain(
			"login hand-off attention record could not be created",
		);
		expect(t.log.join("\n")).toContain("the workflow refused the record");
		const script = t.driver.initScripts.at(-1)?.[0] ?? "";
		expect(script).toContain("the hand-off ends when the login is detected");
		expect(script).not.toContain("choose Done in the dashboard");
		// The hand-off still ends, by its own deadline.
		expect(await endOf(t, session)).toMatchObject({ outcome: "timeout" });
		await t.pool.closeAll();
	});

	test("a deadline that lands while the window is still being launched closes the window it opens", async () => {
		const t = harness();
		const session = await t.session();
		// The promotion is held inside `newContext`, so the hand-off's deadline
		// passes while its window is still on the way (QUALITY-101).
		t.driver.holdNewContext = true;
		await t.coordinator.request(request(session, { maxSeconds: 1 }));
		const waited = t.coordinator.wait(session, 600_000);
		await t.turn();
		t.driver.holdNewContext = false;
		t.driver.releaseNewContext();
		expect((await waited).outcome).toMatchObject({ outcome: "timeout" });
		await t.until(() => session.crashed === true);
		// The window the promotion opened is closed again rather than left on the
		// developer's screen for a hand-off that is already over.
		expect(t.driver.pages.at(-1)?.closeReasons).toContain("server");
		expect(() => t.pool.session("workflow:a", "default")).toThrow(/relaunch/);
		await t.pool.closeAll();
	});

	test("the FIFO is arrival order, whatever order the records resolve in", async () => {
		const t = harness();
		const first = await t.session("workflow:a");
		const second = await t.session("workflow:b", "second");
		t.holdOpen();
		const one = t.coordinator.request(request(first));
		const two = t.coordinator.request(request(second));
		await t.turn();
		// The second request's record resolves first; the first request still owns
		// the active slot, because the slot was claimed before either dispatch.
		t.releaseOpen(1);
		await t.turn();
		t.releaseOpen(0);
		await t.turn();
		expect((await one).state).toBe("active");
		expect(await two).toMatchObject({ state: "queued", queuePosition: 1 });
		await t.pool.closeAll();
	});

	test("a drain never drops a live queued hand-off when a request arrives mid-teardown", async () => {
		const t = harness();
		const first = await t.session("workflow:a");
		const queued = await t.session("workflow:b", "second");
		const late = await t.session("workflow:c", "third");
		const newcomer = await t.session("workflow:d", "fourth");
		t.holdClose();
		// The first hand-off expires, the one behind it is already expired, and the
		// third still has time (CONC-101, QUALITY-102).
		await t.coordinator.request(request(first, { maxSeconds: 1 }));
		await t.coordinator.request(request(queued, { maxSeconds: 1 }));
		await t.coordinator.request(request(late, { maxSeconds: 900 }));
		await t.until(() => t.attention.closed.length === 1);
		t.releaseClose(0);
		await t.until(() => t.attention.closed.length === 2);
		// A hand-off arrives while the drain is tearing the expired one down.
		expect(
			await t.coordinator.request(request(newcomer, { maxSeconds: 900 })),
		).toMatchObject({ state: "queued" });
		t.releaseClose(0);
		await t.turn();
		expect(t.coordinator.pending(late)?.state).toBe("active");
		expect(t.coordinator.pending(newcomer)?.state).toBe("queued");
		expect(t.coordinator.recordedOutcome("workflow:b", "second")).toMatchObject(
			{
				outcome: "timeout",
			},
		);
		await t.until(() => late.browserSlot === "interactive");
		await t.pool.closeAll();
	});

	test("a teardown never hands a session back that a newer hand-off holds", async () => {
		const t = harness();
		const session = await t.session();
		t.holdClose();
		await t.coordinator.request(request(session, { recipe: UNDECLARED }));
		await t.until(() => session.browserSlot === "interactive");
		const aborting = t.coordinator.abort(session, "agent");
		await t.until(() => t.attention.closed.length === 1);
		// The first hand-off is over as far as the coordinator is concerned, so a
		// second one on the same session registers while its teardown runs.
		expect(
			await t.coordinator.request(request(session, { recipe: UNDECLARED })),
		).toMatchObject({ state: "queued" });
		expect(session.heldByUser).toBe(true);
		t.releaseClose(0);
		await aborting;
		await t.turn();
		expect(session.heldByUser).toBe(true);
		await t.pool.closeAll();
	});

	test("an older hand-off's outcome never overwrites a newer one for the same session", async () => {
		const t = harness();
		const session = await t.session();
		t.holdClose();
		await t.coordinator.request(request(session, { recipe: UNDECLARED }));
		await t.until(() => session.browserSlot === "interactive");
		const older = t.coordinator.abort(session, "agent");
		await t.until(() => t.attention.closed.length === 1);
		await t.coordinator.request(request(session, { recipe: UNDECLARED }));
		// The newer hand-off ends first: its outcome is the session's.
		const newer = t.coordinator.abort(session, "developer");
		await t.until(() => t.attention.closed.length === 2);
		t.releaseClose(1);
		await newer;
		await t.turn();
		expect(
			t.coordinator.recordedOutcome("workflow:a", "default"),
		).toMatchObject({ outcome: "aborted", by: "developer" });
		// The older teardown resumes and must not publish over it.
		t.releaseClose(0);
		await older;
		await t.turn();
		expect(
			t.coordinator.recordedOutcome("workflow:a", "default"),
		).toMatchObject({ outcome: "aborted", by: "developer" });
		await t.pool.closeAll();
	});

	test("the log line carries coordination fields only, never a typed value", async () => {
		const t = harness();
		const session = await t.session();
		await t.coordinator.request(request(session));
		await t.until(() => t.log.some((entry) => entry.includes("phase=active")));
		const line = t.log.find((entry) => entry.includes("phase=active"));
		expect(line).toBeDefined();
		expect(line).toContain("stage=grid-int");
		expect(line).toContain("app=web");
		expect(line).toContain("role=clerk");
		expect(line).toContain("reason=no-credentials");
		expect(line).toContain("deadlineAt=");
		expect(line).not.toContain(credential);
		expect(line).not.toContain("https://");
		await t.pool.closeAll();
	});
});
