// The server-owned browser pool (`add-agent-browser-sessions`, design decision
// 2).
//
// One Chromium process serves every session; a session is one isolated
// `BrowserContext`, so two runs browsing the same app never share cookies or
// storage. The pool owns the four lifecycle rules the spec names:
//
// * **A cap with FIFO queueing.** At most `browser.max_sessions` sessions exist;
//   an open past the cap waits for the oldest release in arrival order, not by
//   polling. A run's *own* session is never counted against itself, so
//   reopening a session it already holds is immediate.
// * **An idle TTL.** A session silent for `browser.idle_ttl_minutes` is closed
//   on the next request, so an abandoned run cannot hold the cap forever.
// * **Close on run end.** `closeOwner` releases everything one workflow holds.
// * **Crash handling.** A browser that goes away marks its sessions
//   `browser-crashed` and is relaunched on the next open; a crashed session is
//   never counted against the cap or silently reused.
//
// Every one of those rules is a decision across `await` points, and the routes
// are served concurrently, so the pool serializes the three places where
// check-then-act would otherwise hold:
//
// * **Launching** is single-flight: concurrent opens share one launch.
// * **Capacity** is reserved under an acquire gate, so two opens cannot both see
//   a free slot and both take it — and a run that holds the whole cap still gets
//   the refusal rather than a deadlock.
// * **Recording** is one gate per session, so a start/stop pair (including the
//   length-limit auto-stop) can never interleave and orphan a context or a
//   recording.
//
// Recording lives here too, because it is the one operation that replaces a
// session's context: `record_start` snapshots `storageState` and the URL,
// creates a recording context and restores both, and `record_stop` takes the
// final frame as a poster, flushes the WebM, and returns the session to a
// non-recording context with the same cookies.
import fs from "node:fs";
import { BROWSER_MAX_IMAGE_WIDTH } from "../../workflow/effects.ts";
import { createStageGuard } from "../stages/guard.ts";
import { bannerRemovalScript } from "./banner.ts";
import { BrowserPoolError, tooManySessionsMessage } from "./errors.ts";
import {
	BrowserSession,
	type SessionBrowserSlot,
	type SessionRecording,
	type StageBearerScope,
	type StageSessionBinding,
} from "./session.ts";
import type {
	DriverAuthorizationProvider,
	DriverBrowser,
	DriverContext,
	DriverHttpCredentials,
	DriverLaunchOptions,
	DriverPage,
	DriverRequestGuard,
} from "./types.ts";

/** Default recording length before the pool stops it on its own. */
export const DEFAULT_RECORDING_MAX_MS = 10 * 60 * 1000;

export interface BrowserPoolOptions {
	readonly driver: import("./types.ts").BrowserDriver;
	/** Resolve how to launch, or throw `browser-unavailable`. Called again after
	 * a crash, so an install that finished since the last attempt is picked up.
	 * `headed` asks for the interactive browser, and refuses with
	 * `login-handoff-unavailable` when this machine cannot show a window. */
	readonly launch: (options?: {
		readonly headed?: boolean;
	}) => DriverLaunchOptions;
	/** Resolved per use, so a `browser.max_sessions` edit applies to the next
	 * open rather than the next server start. */
	readonly maxSessions: () => number;
	readonly idleTtlMs: () => number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
	/** Told whenever a session leaves the pool for a reason other than the
	 * caller's own `close`: run end, the idle sweep, a crash. The hand-off
	 * coordinator ends the hand-off it holds on that session. */
	readonly onSessionClosed?: (
		session: BrowserSession,
		cause: SessionCloseCause,
	) => void;
	/** The bearer token of one origin of one stage-bound session
	 * (`add-stage-oauth2-auth`, task 3.3). Supplied by the caller that owns the
	 * token store, so the pool stays catalog-free and never imports the OAuth 2.0
	 * module: a stage whose role declares no `bearerOrigins` never asks for one,
	 * and a failure answers `undefined` rather than aborting a page request. */
	readonly bearerToken?: (
		binding: StageSessionBinding,
		scope: StageBearerScope,
	) => Promise<string | undefined>;
}

/** Why a session left the pool. `closed` is the caller's own `browser_close`,
 * which the *route* has already turned into an abort with `by: "agent"`. */
export type SessionCloseCause = "closed" | "owner-closed" | "swept" | "crashed";

export interface OpenSessionRequest {
	readonly owner: string;
	readonly name: string;
	readonly viewport: { readonly width: number; readonly height: number };
	readonly url?: string;
	readonly app?: string;
	/** The stage this session is bound to for its whole life
	 * (`add-stage-testing-foundation`). */
	readonly stage?: StageSessionBinding;
	/** True when the caller saw the session in `find` and skipped the admission
	 * that creating one would have needed: only a *reuse* is then allowed, because
	 * a context created here would sit outside the stage's lease and session
	 * bound. */
	readonly reuseOnly?: boolean;
}

export interface SessionSummary {
	readonly owner: string;
	readonly name: string;
	readonly url: string;
	readonly app?: string;
	/** The stage ident of a stage-bound session. */
	readonly stage?: string;
	readonly createdAt: number;
	readonly lastUsed: number;
	readonly recording: boolean;
	/** True while a login hand-off holds this session. */
	readonly heldByUser?: boolean;
}

export class BrowserPool {
	private readonly driver: import("./types.ts").BrowserDriver;
	private readonly launchOptions: (options?: {
		readonly headed?: boolean;
	}) => DriverLaunchOptions;
	private readonly maxSessions: () => number;
	private readonly idleTtlMs: () => number;
	private readonly clock: () => number;
	private readonly log: (message: string) => void;
	private readonly onSessionClosed:
		| ((session: BrowserSession, cause: SessionCloseCause) => void)
		| undefined;
	/** The caller's bearer-token source, or `undefined` when this process has
	 * none. */
	private readonly bearerToken:
		| ((
				binding: StageSessionBinding,
				scope: StageBearerScope,
		  ) => Promise<string | undefined>)
		| undefined;
	private browser: DriverBrowser | undefined;
	/** The second, lazily launched headed browser. It exists only while a
	 * promoted session lives in it (task 1.3). */
	private interactive: DriverBrowser | undefined;
	/** The one in-flight launch of each slot, shared by every caller that wants
	 * it. */
	private launching: Promise<DriverBrowser> | undefined;
	private interactiveLaunching: Promise<DriverBrowser> | undefined;
	/** Sessions whose promotion into the interactive browser is in flight, so a
	 * concurrent close of the last interactive session does not take the browser
	 * down while a context is being created in it. */
	private readonly promoting = new Set<string>();
	/** Contexts that already carry the banner-removal init script. Keyed by the
	 * context object itself, so a swapped context is collected with the session. */
	private readonly bannerRemovalInstalled = new WeakSet<object>();
	/** The acquire critical section: the capacity check and the reservation of
	 * the slot it grants, with no await between them. */
	private acquireGate: Promise<void> = Promise.resolve();
	/** One recording critical section *per session*, so a start/stop on one page
	 * cannot serialize every other session's tool calls. */
	private readonly recordingGates = new Map<string, Promise<void>>();
	/** Slots reserved for a caller whose context is still being created. A token
	 * travels with the reservation, so a slot handed to the oldest waiter cannot
	 * be taken by a newer open first. */
	private readonly pending: Array<{ owner: string; token: symbol }> = [];
	private readonly sessions = new Map<string, BrowserSession>();
	/** One open at a time per session key, so two concurrent opens of the same
	 * `(owner, name)` join one session instead of racing to create two. */
	private readonly keyGates = new Map<string, Promise<void>>();
	private waiters: Array<{ owner: string; resolve: (token?: symbol) => void }> =
		[];

	constructor(options: BrowserPoolOptions) {
		this.driver = options.driver;
		this.launchOptions = options.launch;
		this.maxSessions = options.maxSessions;
		this.idleTtlMs = options.idleTtlMs;
		this.clock = options.now ?? (() => Date.now());
		this.log = options.log ?? (() => {});
		this.onSessionClosed = options.onSessionClosed;
		this.bearerToken = options.bearerToken;
	}

	/** Every open session, for a status read. */
	summaries(): SessionSummary[] {
		return [...this.sessions.values()].map((session) => ({
			owner: session.owner,
			name: session.name,
			// A held session's URL is reported as its origin alone: what the developer
			// typed into the login page is not the agent's to read.
			url: session.heldByUser ? originOf(session.url) : session.url,
			...(session.app ? { app: session.app } : {}),
			...(session.stage ? { stage: session.stage.ident } : {}),
			createdAt: session.createdAt,
			lastUsed: session.lastUsed,
			recording: session.recording !== undefined,
			...(session.heldByUser ? { heldByUser: true } : {}),
		}));
	}

	/**
	 * Live sessions of one workflow on one stage.
	 *
	 * The stage usage registry derives both the `maxSessions` bound and the
	 * exclusive lease from this, so a closed session, an idle session swept away,
	 * a crashed context and run end all release them together.
	 */
	stageSessions(owner: string, stage: string): number {
		return [...this.sessions.values()].filter(
			(session) =>
				session.owner === owner &&
				session.stage?.ident === stage &&
				!session.crashed,
		).length;
	}

	/** Whether any workflow holds a live session on one stage. */
	stageHeld(stage: string): boolean {
		return [...this.sessions.values()].some(
			(session) => session.stage?.ident === stage && !session.crashed,
		);
	}

	/** The sessions one owner holds. */
	ownedBy(owner: string): SessionSummary[] {
		return this.summaries().filter((session) => session.owner === owner);
	}

	/**
	 * The owner's named session, refusing a crashed one with `browser-crashed`
	 * rather than handing back a context the browser already discarded.
	 */
	session(owner: string, name: string): BrowserSession {
		const session = this.sessions.get(sessionKey(owner, name));
		if (!session)
			throw new BrowserPoolError(
				"session-not-open",
				`this run has no browser session ${JSON.stringify(name)}; call browser_open first`,
				409,
			);
		if (session.crashed || !this.browser?.isConnected())
			throw new BrowserPoolError(
				"browser-crashed",
				"the browser process went away; call browser_open again to relaunch it",
				409,
			);
		return session;
	}

	/** The owner's session, or `undefined` when it does not hold one. */
	find(owner: string, name: string): BrowserSession | undefined {
		const session = this.sessions.get(sessionKey(owner, name));
		return session && !session.crashed ? session : undefined;
	}

	/**
	 * Open (or reuse) one session for `owner`.
	 *
	 * Reuse is by owner *and* name, so the default session is the run's own
	 * scratch page and a named session is a second, deliberately separate page.
	 * When the cap is reached the call waits for the oldest release, in arrival
	 * order; when the cap is entirely this run's own, waiting would wait for
	 * itself and the call is refused instead.
	 */
	async acquire(request: OpenSessionRequest): Promise<BrowserSession> {
		await this.sweepIdle();
		const id = sessionKey(request.owner, request.name);
		// Serialized per key: without this, two concurrent opens of one key each
		// find no session, each takes a slot, and each registers a context under
		// the same id — one of them then unreachable and never closed.
		return await this.withKeyGate(id, async () => {
			return await this.acquireLocked(request, id);
		});
	}

	private async acquireLocked(
		request: OpenSessionRequest,
		id: string,
	): Promise<BrowserSession> {
		let reservation: symbol | undefined;
		for (;;) {
			const existing = this.sessions.get(id);
			// A reuse-only open cannot navigate the window away: creating a session
			// here is exactly the bypass (no lease, no session bound) the caller's
			// admission would have caught, so it is refused instead.
			if (request.reuseOnly && !existing)
				throw new BrowserPoolError(
					"session-not-open",
					`session ${JSON.stringify(request.name)} was closed while this open was being prepared; call browser_open again`,
					409,
				);
			if (request.reuseOnly && existing?.crashed)
				throw new BrowserPoolError(
					"browser-crashed",
					"the browser process went away; call browser_open again to relaunch it",
					409,
				);
			if (existing && !existing.crashed) {
				// The binding check belongs *here*, where the reuse decision is actually
				// taken: a route-level pre-check cannot see a session a concurrent open
				// registered in between.
				if (request.stage && existing.stage?.ident !== request.stage.ident)
					throw new BrowserPoolError(
						"stage-mismatch",
						existing.stage
							? `session ${JSON.stringify(request.name)} is bound to stage ${existing.stage.ident}; a session cannot be re-bound to ${request.stage.ident}`
							: `session ${JSON.stringify(request.name)} is not stage-bound; close it first, or open the stage under a fresh session name`,
						409,
					);
				existing.touch();
				this.releaseReservation(reservation);
				return existing;
			}
			if (existing) await this.drop(existing);
			if (reservation === undefined) {
				const decision = await this.withGate(async () => {
					if (this.inUse() < this.maxSessions()) {
						const token = Symbol("browser-slot");
						this.pending.push({ owner: request.owner, token });
						return token;
					}
					if (this.inUse() === this.ownedInUse(request.owner))
						throw new BrowserPoolError(
							"session-limit",
							tooManySessionsMessage(this.maxSessions()),
							429,
						);
					return undefined;
				});
				if (decision !== undefined) reservation = decision;
			}
			if (reservation !== undefined) break;
			// A released slot is handed to this waiter as a reservation, so a
			// brand-new open cannot overtake a queued one.
			reservation = await this.waitForSlot(request.owner);
		}
		let registered: BrowserSession | undefined;
		/** Whether this open's failure already handed its slot to the queue. */
		let slotReleased = false;
		try {
			const browser = await this.ensureBrowser();
			// The guard is built from the session it reports to, so every refusal lands
			// in the buffer the session's next tool call drains — including the ones the
			// replacement context of a recording produces.
			let session: BrowserSession | undefined;
			const guard = request.stage
				? createStageGuard(request.stage, (refusal) => {
						session?.recordRefusal(refusal);
					})
				: undefined;
			const authorization = this.authorizationForBinding(request.stage);
			const context = await browser.newContext({
				viewport: request.viewport,
				...(guard ? { guard } : {}),
				...(authorization ? { authorization } : {}),
			});
			const page = await context.page();
			session = new BrowserSession({
				owner: request.owner,
				name: request.name,
				context,
				page,
				viewport: request.viewport,
				...(request.url ? { baseUrl: request.url } : {}),
				...(request.app ? { app: request.app } : {}),
				...(request.stage ? { stage: request.stage } : {}),
				now: this.clock,
			});
			this.sessions.set(session.id, session);
			registered = session;
			if (request.url) {
				// The first navigation is work in flight: without this the session
				// looks idle to `close` (and to the sweep) for as long as the
				// navigation takes, and a concurrent `browser_close` could close the
				// page this open is still loading.
				session.beginUse();
				try {
					await session.goto(request.url, 30_000);
				} catch (error) {
					// A first navigation that failed must not leave a half-open session
					// behind: a retry would "reuse" it and never reach the URL.
					await this.drop(session);
					registered = undefined;
					slotReleased = true;
					throw error;
				} finally {
					session.endUse();
				}
			}
			return session;
		} finally {
			this.releaseReservation(reservation);
			// A reservation that produced no session frees its slot for the next
			// waiter — exactly once: `drop` already woke the queue when it removed
			// the session it had registered.
			if (!registered && !slotReleased) this.wakeNext();
		}
	}

	/** Run `fn` as the only holder of one session key's gate. */
	private async withKeyGate<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const current = this.keyGates.get(id) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.keyGates.set(id, next);
		await current;
		try {
			return await fn();
		} finally {
			release();
			if (this.keyGates.get(id) === next) this.keyGates.delete(id);
		}
	}

	/**
	 * Close one session, releasing its slot to whoever waits next.
	 *
	 * A session with a request in flight is refused with `session-busy` rather
	 * than closed under it: `browser_close` can be issued while a script is still
	 * driving the same page, and closing the context would fail that call for a
	 * reason that has nothing to do with it.
	 */
	async close(owner: string, name: string): Promise<boolean> {
		const session = this.sessions.get(sessionKey(owner, name));
		if (!session) return false;
		if (session.busy) {
			throw new BrowserPoolError(
				"session-busy",
				"this session is still handling a request; wait for it to finish before closing it",
				409,
			);
		}
		await this.drop(session, "closed");
		return true;
	}

	/**
	 * Every session one workflow holds, closed when its run ends. A run that has
	 * ended takes precedence over its own in-flight work: the run is over, so
	 * releasing the slot is the only useful outcome.
	 */
	async closeOwner(owner: string): Promise<number> {
		const owned = [...this.sessions.values()].filter(
			(session) => session.owner === owner,
		);
		for (const session of owned) await this.drop(session, "owner-closed");
		return owned.length;
	}

	/**
	 * Close every session that has been silent past the idle TTL.
	 *
	 * A session with a request in flight is never swept: `browser_run_script` may
	 * legitimately hold a page for minutes, and closing the context under it would
	 * fail the script and strand the run's session. A session *held* by a login
	 * hand-off is never swept either: the developer may be typing into it, and the
	 * hand-off's own deadline is what ends it (task 1.3).
	 */
	async sweepIdle(): Promise<number> {
		const idle = [...this.sessions.values()].filter(
			(session) =>
				!session.busy &&
				!session.heldByUser &&
				session.idleFor(Math.max(1, this.idleTtlMs())),
		);
		for (const session of idle) await this.drop(session, "swept");
		return idle.length;
	}

	/** Close everything and the browser with it. */
	async closeAll(): Promise<void> {
		for (const session of [...this.sessions.values()])
			await this.drop(session, "closed");
		const browser = this.browser;
		this.browser = undefined;
		const interactive = this.interactive;
		this.interactive = undefined;
		await browser?.close().catch(() => {
			/* the process is going away anyway */
		});
		await interactive?.close().catch(() => {
			/* the process is going away anyway */
		});
	}

	// -- interactive browser (login hand-off) --------------------------------

	/**
	 * Promote a session into the interactive browser, or keep it in the one it
	 * already lives in (`add-stage-interactive-login`, tasks 1.3 and 1.4).
	 *
	 * A fresh context is created there with the stage's guard attached *before*
	 * the first navigation, `prepare` runs on that context (the hand-off banner's
	 * init script), the session's headless context is closed, and the session
	 * keeps its id, name, owner and pool slot. Nothing is copied over: no cookie,
	 * no storage, no URL of the headless page. The HTTP credentials of a
	 * `http-basic` session are deliberately *not* installed, so the browser shows
	 * its own authentication dialog to the developer.
	 */
	async openInteractive(
		session: BrowserSession,
		url: string,
		prepare?: (context: DriverContext) => Promise<void>,
	): Promise<void> {
		await this.withKeyGate(session.id, async () => {
			if (this.sessions.get(session.id) !== session)
				throw new BrowserPoolError(
					"session-not-open",
					"the session was closed while its hand-off was being prepared; call browser_open again",
					409,
				);
			// A session that already lives in the interactive browser navigates in
			// its own context: its login state, and the whole point of the hand-off,
			// stays where it is (D1).
			if (session.browserSlot === "interactive" && !session.crashed) {
				session.windowClosed = false;
				if (prepare) await prepare(session.context).catch(() => {});
				await session.goto(url, 30_000).catch(() => null);
				return;
			}
			// The interactive browser is in use from here on, before any session
			// claims it: a concurrent close of the last interactive session must not
			// take the browser down mid-launch.
			this.promoting.add(session.id);
			try {
				const browser = await this.ensureBrowser("interactive");
				const guard = this.guardFor(session);
				const authorization = this.authorizationFor(session);
				const context = await browser.newContext({
					viewport: session.viewport,
					...(guard ? { guard } : {}),
					...(authorization ? { authorization } : {}),
				});
				session.browserSlot = "interactive";
				if (prepare) await prepare(context).catch(() => {});
				const previous = session.context;
				session.beginContextSwap();
				await previous.close().catch(() => {});
				await this.finishSwap(session, browser, context, url);
			} finally {
				this.promoting.delete(session.id);
				// A promotion that failed before the session claimed the interactive
				// browser still launched it. The launch itself was the only "user" it
				// had, so the second Chromium is closed again rather than left running
				// for a session that never arrived (PERF-002).
				if (session.browserSlot !== "interactive" || session.crashed)
					await this.closeInteractiveIfEmpty().catch(() => {});
			}
		});
	}

	/**
	 * Close the hand-off window of a session whose hand-off ran out of time
	 * (`add-stage-interactive-login`: a deadline closes the window).
	 *
	 * The session keeps its entry and is marked unusable, so the run's next tool
	 * call is answered `browser-crashed` with the relaunch hint and the agent
	 * decides whether the login is worth another window.
	 */
	async closeWindow(session: BrowserSession): Promise<void> {
		await this.withKeyGate(session.id, async () => {
			if (session.browserSlot !== "interactive" || session.crashed) return;
			this.markSessionCrashed(session);
			session.beginContextSwap();
			await session.context.close().catch(() => {});
			await this.closeInteractiveIfEmpty();
		});
	}

	/** Remove the banner again, from every document this session still has open
	 * and from every document it opens later: an installed init script cannot be
	 * uninstalled (Playwright has no `removeInitScript`), so a removal script
	 * registered after it takes the banner off each new document, and the live
	 * pages are told explicitly. */
	async removeBanner(session: BrowserSession): Promise<void> {
		// Playwright cannot remove an init script, so the removal script is
		// installed once per context: a second hand-off on the same session reuses
		// it instead of stacking another copy on every page load.
		if (!this.bannerRemovalInstalled.has(session.context)) {
			this.bannerRemovalInstalled.add(session.context);
			await session.context.addInitScript(bannerRemovalScript()).catch(() => {
				/* a banner is cosmetic: a context that refuses it must not fail the
				   hand-off it exists to announce */
			});
		}
		for (const page of session.context.pages()) await page.removeBanner();
	}

	/** Raise the hand-off window once, when it becomes active. `focus` is passed
	 * only for that single call: no agent action ever raises a window. */
	async focusWindow(session: BrowserSession): Promise<void> {
		await session.page.bringToFront().catch(() => {});
	}

	/** Close the interactive browser when it holds no session any more, so a
	 * machine that once handed a login off does not keep a second Chromium
	 * running. */
	private async closeInteractiveIfEmpty(): Promise<void> {
		// A promotion that has not finished claiming its session still counts: the
		// browser it launched is in use.
		if (this.promoting.size > 0) return;
		const holds = [...this.sessions.values()].some(
			(session) => session.browserSlot === "interactive" && !session.crashed,
		);
		if (holds) return;
		const browser = this.interactive;
		this.interactive = undefined;
		await browser?.close().catch(() => {});
	}

	// -- recording ---------------------------------------------------------

	/**
	 * Begin recording this session. The recording context inherits the live page
	 * exactly: the cookies and storage are carried over as `storageState`, and the
	 * current URL is re-opened in the new context, so the recording starts on the
	 * page the agent was looking at. The previous context is closed, so nothing
	 * keeps writing into the session's history and nothing keeps a dead context
	 * alive in the shared browser.
	 */
	async startRecording(
		session: BrowserSession,
		options: { readonly dir: string; readonly maxMs?: number },
	): Promise<{ startedAt: number; url: string }> {
		return await this.withRecordingGate(session, async () => {
			if (session.recording)
				throw new BrowserPoolError(
					"recording-active",
					"this session is already recording; stop it before starting another",
					409,
				);
			const browser = await this.ensureBrowser(session.browserSlot);
			const state = await session.context.storageState().catch(() => undefined);
			const url = session.url;
			const previous = session.context;
			// The replacement is created *before* the swap is announced, so a failure
			// here leaves the session with the page it had rather than with a swap
			// guard that nothing will unwind.
			const context = await browser.newContext({
				viewport: session.viewport,
				recordVideo: { dir: options.dir, size: { ...session.viewport } },
				...(state === undefined ? {} : { storageState: state }),
				// The guard, the bearer authorization and the HTTP credentials survive the
				// swap: a recording is strictly more observable, never less restricted,
				// and a re-recorded page that suddenly lost its credential would be a
				// different session than the one the agent recorded.
				...(this.guardFor(session)
					? { guard: this.guardFor(session) as DriverRequestGuard }
					: {}),
				...(this.authorizationFor(session)
					? {
							authorization: this.authorizationFor(
								session,
							) as DriverAuthorizationProvider,
						}
					: {}),
				...(session.httpCredentials
					? { httpCredentials: session.httpCredentials }
					: {}),
			});
			// The close that follows is this swap, not a crash.
			session.beginContextSwap();
			await previous.close().catch(() => {});
			await this.finishSwap(session, browser, context, url);
			// A dropper that does not wait for in-flight work (run end, shutdown) may
			// have removed the session while the swap was in flight: the recording
			// would then be attached to a session nobody holds, and the caller's
			// cleanup would never remove the directory it owns.
			if (this.sessions.get(session.id) !== session)
				throw new BrowserPoolError(
					"session-not-open",
					"the session was closed while its recording context was being created; call browser_open again",
					409,
				);
			const recording: SessionRecording = {
				startedAt: this.clock(),
				startedUrl: url,
				maxMs: options.maxMs ?? DEFAULT_RECORDING_MAX_MS,
				dir: options.dir,
				autoStopped: false,
			};
			session.attachRecording(recording);
			return { startedAt: recording.startedAt, url };
		});
	}

	/**
	 * Stop a recording that outlived its bound, discarding it, before the session
	 * is used again: the length cap is enforced on the next request rather than by
	 * a timer nobody owns. Idempotent and serialized with `stopRecording`, so two
	 * concurrent requests cannot both stop the same recording.
	 */
	async autoStopIfExpired(session: BrowserSession): Promise<boolean> {
		// The overwhelmingly common case is "not recording at all", and this runs on
		// the hot path of every session-using request: answer it without taking the
		// gate, and re-check inside the gate before stopping anything.
		const open = session.recording;
		if (!open) return false;
		if (this.clock() - open.startedAt <= open.maxMs) return false;
		return await this.withRecordingGate(session, async () => {
			const recording = session.recording;
			if (!recording) return false;
			if (this.clock() - recording.startedAt <= recording.maxMs) return false;
			recording.autoStopped = true;
			this.log(
				`browser recording of ${session.owner} exceeded ${recording.maxMs} ms and was stopped without keeping it`,
			);
			await this.stopRecordingLocked(session, undefined);
			return true;
		});
	}

	/**
	 * Stop recording. The poster is taken *before* the context closes, so it is
	 * the final frame; the video is then flushed and, when `keep` is absent, the
	 * whole recording directory is removed and nothing is attached. Either way the
	 * session returns to a plain context with its cookies intact.
	 */
	async stopRecording(
		session: BrowserSession,
		/** Where to keep the poster and the video. `undefined` discards the
		 * recording: no poster is taken, no video is saved, and the directory
		 * Playwright wrote into is removed. */
		keep:
			| { readonly posterPath: string; readonly videoPath: string }
			| undefined,
	): Promise<{
		readonly videoSaved: boolean;
		readonly posterSaved: boolean;
		readonly autoStopped: boolean;
		readonly url: string;
	}> {
		return await this.withRecordingGate(
			session,
			async () => await this.stopRecordingLocked(session, keep),
		);
	}

	private async stopRecordingLocked(
		session: BrowserSession,
		keep:
			| { readonly posterPath: string; readonly videoPath: string }
			| undefined,
	): Promise<{
		readonly videoSaved: boolean;
		readonly posterSaved: boolean;
		readonly autoStopped: boolean;
		readonly url: string;
	}> {
		const recording = session.detachRecording();
		if (!recording)
			throw new BrowserPoolError(
				"recording-not-active",
				"this session is not recording",
				409,
			);
		const url = session.url;
		let posterSaved = false;
		if (keep) {
			try {
				const poster = await session.screenshot(
					{ type: "jpeg", quality: 70, fullPage: false },
					BROWSER_MAX_IMAGE_WIDTH,
				);
				await Bun.write(keep.posterPath, poster);
				posterSaved = true;
			} catch {
				// A poster is best-effort: a page that cannot be captured must not stop
				// the recording from being flushed.
			}
		}
		const recordingContext = session.context;
		const state = await recordingContext.storageState().catch(() => undefined);
		// Grabbed before the close: Playwright finalizes the WebM when the context
		// closes, so saving it first would wait for a file that does not exist yet.
		const video = keep ? recordingContext.video() : undefined;
		// Everything that can fail is done before the recording context is closed, so
		// a failure here leaves a recording that can still be stopped.
		let browser: DriverBrowser;
		let context: DriverContext;
		try {
			browser = await this.ensureBrowser(session.browserSlot);
			context = await browser.newContext({
				viewport: session.viewport,
				...(state === undefined ? {} : { storageState: state }),
				...(this.guardFor(session)
					? { guard: this.guardFor(session) as DriverRequestGuard }
					: {}),
				...(this.authorizationFor(session)
					? {
							authorization: this.authorizationFor(
								session,
							) as DriverAuthorizationProvider,
						}
					: {}),
				...(session.httpCredentials
					? { httpCredentials: session.httpCredentials }
					: {}),
			});
		} catch (error) {
			session.attachRecording(recording);
			throw error;
		}
		session.beginContextSwap();
		await recordingContext.close().catch(() => {});
		const videoSaved =
			video && keep
				? await video
						.saveAs(keep.videoPath)
						.then(() => true)
						.catch(() => false)
				: false;
		if (!keep) {
			// Best effort: a cleanup that fails must not leave the swap half-applied.
			await fs.promises
				.rm(recording.dir, { recursive: true, force: true })
				.catch((error) => {
					this.log(`could not remove ${recording.dir}: ${message(error)}`);
				});
		}
		await this.finishSwap(session, browser, context, url);
		return { videoSaved, posterSaved, autoStopped: recording.autoStopped, url };
	}

	// -- internals ---------------------------------------------------------

	/** The guard of a stage-bound session, or `undefined` for a plain one. Built
	 * per context so a recording's replacement carries the same rules. */
	private guardFor(session: BrowserSession): DriverRequestGuard | undefined {
		const binding = session.stage;
		if (!binding) return undefined;
		return createStageGuard(binding, (refusal) =>
			session.recordRefusal(refusal),
		);
	}

	/**
	 * The bearer provider of a stage-bound session, or `undefined` when the
	 * session's role declares no `bearerOrigins` or this pool has no token source
	 * (`add-stage-oauth2-auth`, task 3.3).
	 *
	 * The origin match is exact and happens here, in the driver's call path: a
	 * request to any other origin — including one a redirect moved it to — is
	 * answered `undefined`, which leaves it exactly as the page built it. A
	 * failure of the token source is swallowed for the same reason: an
	 * unauthenticated request is a page that still works, and an aborted one is a
	 * page that looks broken.
	 */
	private authorizationFor(
		session: BrowserSession,
	): DriverAuthorizationProvider | undefined {
		return this.authorizationForBinding(session.stage);
	}

	/** The same provider, for the open that has a binding and no session yet. */
	private authorizationForBinding(
		binding: StageSessionBinding | undefined,
	): DriverAuthorizationProvider | undefined {
		const scopes = binding?.bearer ?? [];
		const source = this.bearerToken;
		if (!binding || scopes.length === 0 || !source) return undefined;
		return async (request) => {
			const origin = originOf(request.url);
			if (origin === undefined) return undefined;
			const scope = scopes.find((candidate) => candidate.origin === origin);
			if (!scope) return undefined;
			try {
				return await source(binding, scope);
			} catch {
				return undefined;
			}
		};
	}

	/** Install HTTP basic credentials on a live session, and remember them so a
	 * recording's replacement context keeps them. */
	async setHttpCredentials(
		session: BrowserSession,
		credentials: DriverHttpCredentials,
	): Promise<void> {
		// The same gate a recording swap takes, and the session's field first: a swap
		// reads `session.httpCredentials` when it builds the replacement context, so
		// credentials installed while one is in flight travel into it instead of
		// being installed on the context the swap is about to close.
		await this.withRecordingGate(session, async () => {
			session.httpCredentials = credentials;
			await session.context.setHttpCredentials(credentials);
		});
	}

	/** Sessions that count against the cap: live ones plus reservations whose
	 * context is still being created. */
	private inUse(): number {
		return this.liveCount() + this.pending.length;
	}

	private liveCount(): number {
		return [...this.sessions.values()].filter((session) => !session.crashed)
			.length;
	}

	private ownedInUse(owner: string): number {
		return (
			this.sessionsOwnedCount(owner) +
			this.pending.filter((entry) => entry.owner === owner).length
		);
	}

	private sessionsOwnedCount(owner: string): number {
		return [...this.sessions.values()].filter(
			(session) => session.owner === owner && !session.crashed,
		).length;
	}

	private releaseReservation(token: symbol | undefined): void {
		if (token === undefined) return;
		const index = this.pending.findIndex((entry) => entry.token === token);
		if (index >= 0) this.pending.splice(index, 1);
	}

	/** Run `fn` as the only holder of the pool-wide acquire gate. */
	private async withGate<T>(fn: () => Promise<T>): Promise<T> {
		const current = this.acquireGate;
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.acquireGate = next;
		await current;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * Run `fn` as the only recording transition of *one session*.
	 *
	 * The gate is per session on purpose: `autoStopIfExpired` runs on the hot path
	 * of every session-using request, and a pool-wide gate would let one session's
	 * video flush block every other run's snapshots and clicks.
	 */
	private async withRecordingGate<T>(
		session: BrowserSession,
		fn: () => Promise<T>,
	): Promise<T> {
		const id = session.id;
		const current = this.recordingGates.get(id) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.recordingGates.set(id, next);
		await current;
		try {
			return await fn();
		} finally {
			release();
			if (this.recordingGates.get(id) === next) this.recordingGates.delete(id);
		}
	}

	/** One launch per slot, however many callers want it. The interactive slot
	 * asks `resolveLaunch({ headed: true })`, which refuses with
	 * `login-handoff-unavailable` when this machine cannot show a window. */
	private async ensureBrowser(
		slot: SessionBrowserSlot = "headless",
	): Promise<DriverBrowser> {
		const current = slot === "interactive" ? this.interactive : this.browser;
		if (current?.isConnected()) return current;
		const inFlight =
			slot === "interactive" ? this.interactiveLaunching : this.launching;
		if (inFlight) return await inFlight;
		const launched = (async (): Promise<DriverBrowser> => {
			// A browser that is present but disconnected is the one this launch
			// replaces: its own sessions are marked before a new one is handed out.
			if (current) this.markCrashed(current);
			const options =
				slot === "interactive"
					? this.launchOptions({ headed: true })
					: this.launchOptions();
			let browser: DriverBrowser;
			try {
				browser = await this.driver.launch(options);
			} catch (error) {
				// A headed refusal is its own answer: it names the fix (install a full
				// build, or run where a display exists) instead of a generic failure.
				if (error instanceof BrowserPoolError) throw error;
				throw new BrowserPoolError(
					"browser-unavailable",
					`the browser could not be launched: ${message(error)}`,
					503,
				);
			}
			browser.onDisconnected(() => {
				// A listener of a browser this pool no longer serves is stale: it must
				// not mark the sessions of its replacement crashed.
				if (this.browserFor(slot) !== browser) return;
				this.log(
					slot === "interactive"
						? "interactive browser disconnected; its sessions are now crashed"
						: "browser process disconnected; every session is now crashed",
				);
				this.markCrashed(browser);
			});
			if (slot === "interactive") this.interactive = browser;
			else this.browser = browser;
			return browser;
		})();
		if (slot === "interactive") this.interactiveLaunching = launched;
		else this.launching = launched;
		try {
			return await launched;
		} finally {
			if (slot === "interactive") {
				if (this.interactiveLaunching === launched)
					this.interactiveLaunching = undefined;
			} else if (this.launching === launched) this.launching = undefined;
		}
	}

	/** The browser one slot currently serves, whoever is asking. */
	private browserFor(slot: SessionBrowserSlot): DriverBrowser | undefined {
		return slot === "interactive" ? this.interactive : this.browser;
	}

	/** Mark the sessions of the browser that went away (`add-stage-interactive-
	 * login`: *only* that browser's sessions, so one process dying never takes
	 * the other's sessions with it). The entries stay so a later call answers
	 * `browser-crashed` (with its relaunch hint) instead of pretending the
	 * session never existed. */
	private markCrashed(browser: DriverBrowser): void {
		const slot: SessionBrowserSlot =
			this.interactive === browser ? "interactive" : "headless";
		if (this.browserFor(slot) !== browser) return;
		if (slot === "interactive") this.interactive = undefined;
		else this.browser = undefined;
		for (const session of this.sessions.values()) {
			if (session.browserSlot !== slot) continue;
			session.crashed = true;
			this.onSessionClosed?.(session, "crashed");
		}
		if (slot === "headless") this.wakeAll();
		else void this.closeInteractiveIfEmpty();
	}

	private async drop(
		session: BrowserSession,
		cause: SessionCloseCause = "closed",
	): Promise<void> {
		// Whether a slot was freed follows the *map*, not the session's own flag: a
		// second drop of a session that is no longer registered must not wake a
		// second waiter for the one slot that left. A crashed session never counted
		// against the cap, so removing it frees nothing.
		const registered = this.sessions.delete(session.id);
		const freed = registered && !session.crashed;
		if (registered) this.onSessionClosed?.(session, cause);
		session.beginContextSwap();
		// The slot is handed to the queue *before* the close is awaited, so it never
		// becomes visible as free while the waiters are still parked.
		if (freed) this.wakeNext();
		await session.context.close().catch(() => {});
		if (session.browserSlot === "interactive")
			await this.closeInteractiveIfEmpty();
		// A recording the run never stopped goes with the session: Playwright
		// finalizes the WebM when the context closes, and nothing else would ever
		// remove the directory it wrote into.
		const abandoned = session.detachRecording();
		if (!abandoned) return;
		// Asynchronous, like every other filesystem call on this path: a dropped
		// session is dropped from the middle of a request, and a synchronous
		// recursive remove of a video directory would block the whole server's event
		// loop for as long as the filesystem takes.
		await fs.promises
			.rm(abandoned.dir, { recursive: true, force: true })
			.catch((error) => {
				this.log(`could not remove ${abandoned.dir}: ${message(error)}`);
			});
	}

	/**
	 * Complete a context swap: replace the session's context and page, keeping its
	 * buffers, refs and owner.
	 *
	 * Three rules here, all of them learned the hard way:
	 *
	 * * The new context counts only if it came from the browser this pool still
	 *   serves. A browser that died during the swap must not be "revived" by the
	 *   fresh context — the session is marked crashed and the caller is told.
	 * * The swap guard is one-shot: every failure path unwinds it, and the session
	 *   is marked crashed rather than left holding a context that was already
	 *   closed.
	 * * The navigation back to the session's URL is part of the swap, so a caller
	 *   never resumes on `about:blank`.
	 */
	private async finishSwap(
		session: BrowserSession,
		browser: DriverBrowser,
		context: DriverContext,
		url: string,
	): Promise<void> {
		let page: DriverPage;
		try {
			page = await context.page();
		} catch (error) {
			session.endContextSwap();
			await context.close().catch(() => {});
			this.markSessionCrashed(session);
			throw error;
		}
		if (
			this.browserFor(session.browserSlot) !== browser ||
			!browser.isConnected()
		) {
			session.endContextSwap();
			await context.close().catch(() => {});
			this.markSessionCrashed(session);
			throw new BrowserPoolError(
				"browser-crashed",
				"the browser went away while the session's context was being replaced; call browser_open again to relaunch it",
				409,
			);
		}
		// A dropper that does not wait for in-flight work (run end, shutdown) may
		// have removed the session while this swap was in flight: attaching to a
		// session nobody holds would leave an open context outside `sessions`.
		if (this.sessions.get(session.id) !== session) {
			session.endContextSwap();
			await context.close().catch(() => {});
			throw new BrowserPoolError(
				"session-not-open",
				"the session was closed while its context was being replaced; call browser_open again",
				409,
			);
		}
		session.context = context;
		session.attachPage(page);
		if (url) await session.goto(url, 30_000).catch(() => null);
	}

	/** Mark one session unusable, keeping its entry so the next call answers
	 * `browser-crashed` with the relaunch hint. */
	private markSessionCrashed(session: BrowserSession): void {
		const freed = !session.crashed;
		session.markCrashed();
		this.onSessionClosed?.(session, "crashed");
		if (freed) this.wakeNext();
	}

	/**
	 * Wait for a slot, resolving to the reservation it was handed.
	 *
	 * A token is only ever handed out by a wake that accompanied exactly one
	 * accounting decrease (`drop` of a counted session, `markSessionCrashed` of a
	 * live one, or the `finally` of an open that registered nothing), so a waiter
	 * that receives one can spend it without re-checking the cap.
	 */
	private async waitForSlot(owner: string): Promise<symbol | undefined> {
		return await new Promise<symbol | undefined>((resolve) => {
			this.waiters.push({ owner, resolve });
		});
	}

	/**
	 * Hand a freed slot to the oldest waiter, *before* the slot becomes visible as
	 * free again: the reservation travels with the wake-up, so a stream of fresh
	 * opens cannot overtake the queue. A waiter woken without a reservation (a
	 * crash, a shutdown) simply re-checks.
	 */
	private wakeNext(): void {
		const next = this.waiters.shift();
		if (!next) return;
		const token = Symbol("browser-slot");
		this.pending.push({ owner: next.owner, token });
		next.resolve(token);
	}

	private wakeAll(): void {
		const waiting = this.waiters;
		this.waiters = [];
		for (const waiter of waiting) waiter.resolve(undefined);
	}
}

/** The one key a session is stored under: its owner and its name. Exported so
 * a hand-off can address the outcome it recorded for a session it can no longer
 * read from the pool (SEC-002). */
export function sessionKey(owner: string, name: string): string {
	return `${owner}\u0000${name}`;
}

/** A held session reports only where it is, never what is on it or what was
 * typed into it. An unparseable URL reports nothing at all. */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
