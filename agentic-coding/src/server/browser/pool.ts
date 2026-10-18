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
import { BrowserPoolError, tooManySessionsMessage } from "./errors.ts";
import {
	BrowserSession,
	type SessionRecording,
	type StageSessionBinding,
} from "./session.ts";
import type {
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
	 * a crash, so an install that finished since the last attempt is picked up. */
	readonly launch: () => DriverLaunchOptions;
	/** Resolved per use, so a `browser.max_sessions` edit applies to the next
	 * open rather than the next server start. */
	readonly maxSessions: () => number;
	readonly idleTtlMs: () => number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

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
}

export class BrowserPool {
	private readonly driver: import("./types.ts").BrowserDriver;
	private readonly launchOptions: () => DriverLaunchOptions;
	private readonly maxSessions: () => number;
	private readonly idleTtlMs: () => number;
	private readonly clock: () => number;
	private readonly log: (message: string) => void;
	private browser: DriverBrowser | undefined;
	/** The one in-flight launch, shared by every caller that wants it. */
	private launching: Promise<DriverBrowser> | undefined;
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
	}

	/** Every open session, for a status read. */
	summaries(): SessionSummary[] {
		return [...this.sessions.values()].map((session) => ({
			owner: session.owner,
			name: session.name,
			url: session.url,
			...(session.app ? { app: session.app } : {}),
			...(session.stage ? { stage: session.stage.ident } : {}),
			createdAt: session.createdAt,
			lastUsed: session.lastUsed,
			recording: session.recording !== undefined,
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
		const session = this.sessions.get(key(owner, name));
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
		const session = this.sessions.get(key(owner, name));
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
		const id = key(request.owner, request.name);
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
			const context = await browser.newContext({
				viewport: request.viewport,
				...(guard ? { guard } : {}),
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
		const session = this.sessions.get(key(owner, name));
		if (!session) return false;
		if (session.busy) {
			throw new BrowserPoolError(
				"session-busy",
				"this session is still handling a request; wait for it to finish before closing it",
				409,
			);
		}
		await this.drop(session);
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
		for (const session of owned) await this.drop(session);
		return owned.length;
	}

	/**
	 * Close every session that has been silent past the idle TTL.
	 *
	 * A session with a request in flight is never swept: `browser_run_script` may
	 * legitimately hold a page for minutes, and closing the context under it would
	 * fail the script and strand the run's session.
	 */
	async sweepIdle(): Promise<number> {
		const idle = [...this.sessions.values()].filter(
			(session) =>
				!session.busy && session.idleFor(Math.max(1, this.idleTtlMs())),
		);
		for (const session of idle) await this.drop(session);
		return idle.length;
	}

	/** Close everything and the browser with it. */
	async closeAll(): Promise<void> {
		for (const session of [...this.sessions.values()]) await this.drop(session);
		const browser = this.browser;
		this.browser = undefined;
		if (browser)
			await browser.close().catch(() => {
				/* the process is going away anyway */
			});
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
			const browser = await this.ensureBrowser();
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
				// The guard and the HTTP credentials survive the swap: a recording is
				// strictly more observable, never less restricted.
				...(this.guardFor(session)
					? { guard: this.guardFor(session) as DriverRequestGuard }
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
			browser = await this.ensureBrowser();
			context = await browser.newContext({
				viewport: session.viewport,
				...(state === undefined ? {} : { storageState: state }),
				...(this.guardFor(session)
					? { guard: this.guardFor(session) as DriverRequestGuard }
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

	/** One launch for the whole pool, however many callers want it. */
	private async ensureBrowser(): Promise<DriverBrowser> {
		if (this.browser?.isConnected()) return this.browser;
		if (this.launching) return await this.launching;
		const launched = (async (): Promise<DriverBrowser> => {
			if (this.browser) this.markCrashed(this.browser);
			const options = this.launchOptions();
			let browser: DriverBrowser;
			try {
				browser = await this.driver.launch(options);
			} catch (error) {
				throw new BrowserPoolError(
					"browser-unavailable",
					`the browser could not be launched: ${message(error)}`,
					503,
				);
			}
			browser.onDisconnected(() => {
				// A listener of a browser this pool no longer serves is stale: it must
				// not mark the sessions of its replacement crashed.
				if (this.browser !== browser) return;
				this.log("browser process disconnected; every session is now crashed");
				this.markCrashed(browser);
			});
			this.browser = browser;
			return browser;
		})();
		this.launching = launched;
		try {
			return await launched;
		} finally {
			if (this.launching === launched) this.launching = undefined;
		}
	}

	/** Mark every session of the browser that went away. The entries stay so a
	 * later call answers `browser-crashed` (with its relaunch hint) instead of
	 * pretending the session never existed. */
	private markCrashed(browser: DriverBrowser): void {
		if (this.browser !== browser) return;
		this.browser = undefined;
		for (const session of this.sessions.values()) session.crashed = true;
		this.wakeAll();
	}

	private async drop(session: BrowserSession): Promise<void> {
		// Whether a slot was freed follows the *map*, not the session's own flag: a
		// second drop of a session that is no longer registered must not wake a
		// second waiter for the one slot that left. A crashed session never counted
		// against the cap, so removing it frees nothing.
		const registered = this.sessions.delete(session.id);
		const freed = registered && !session.crashed;
		session.beginContextSwap();
		// The slot is handed to the queue *before* the close is awaited, so it never
		// becomes visible as free while the waiters are still parked.
		if (freed) this.wakeNext();
		await session.context.close().catch(() => {});
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
		if (this.browser !== browser || !browser.isConnected()) {
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

function key(owner: string, name: string): string {
	return `${owner}\u0000${name}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
