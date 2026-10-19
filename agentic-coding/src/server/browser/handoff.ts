// Login hand-off coordinator (`add-stage-interactive-login`, task 3.1).
//
// One developer has one screen, so at most one hand-off is *active* per server
// and further ones wait in FIFO order (D6). A hand-off's deadline is fixed when
// it is requested — queue time counts toward it — and it is the only thing that
// bounds a hand-off nobody answers.
//
// What crosses this module's boundary is coordination data and nothing else:
// the success detector answers a boolean, the only URL that leaves is the
// sanitized landing URL (origin plus path), and a hand-off's console, network
// and page content never reach a result (the session's buffers are suspended by
// the hold itself).
//
// The workflow record a hand-off raises is created, read and resolved through
// the injected `attention` adapter, so this module never imports the workflow
// engine and can be unit-tested with fake clocks and the fake driver.

import { formatHandoffDeadline } from "../../contracts/handoff-deadline.ts";
import { sanitizeStageUrl } from "../stages/guard.ts";
import type { StageLoginRecipe } from "../stages/schema.ts";
import { bannerScript, type HandoffBannerText } from "./banner.ts";
import { declaredSuccessHolds } from "./login.ts";
import { type BrowserPool, sessionKey } from "./pool.ts";
import { type BrowserSession, BrowserSessionError } from "./session.ts";

/** How often the success condition and the deadline are re-checked. */
export const HANDOFF_TICK_MS = 1_000;
/** The grace a *Done* gets while the declared success condition is re-checked. */
export const HANDOFF_GRACE_MS = 10_000;
/** The longest one `stage_login_wait` call blocks the server. */
export const HANDOFF_MAX_WAIT_MS = 600_000;
/** How long a terminal outcome stays readable by a later `stage_login_wait`. */
export const HANDOFF_OUTCOME_TTL_MS = 300_000;

export type LoginHandoffReason =
	| "no-credentials"
	| "unautomatable-step"
	/** A role that is designed to be signed in by the person running the agent:
	 * the authorization code grant. Nothing is missing and nothing failed — the
	 * identity at the provider is the developer's own (`add-stage-oauth2-code-pkce`,
	 * USAB-202). */
	| "user-identity";
export type LoginHandoffState = "queued" | "active";
export type LoginHandoffAbortBy =
	| "developer"
	| "agent"
	| "window-closed"
	| "run-ended";

/** Whether this server can show a window at all, and why not when it cannot. */
export type LoginHandoffAvailability =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "no-display" | "headless-only-browser";
	  };

/** The non-terminal answer `stage_login` and `stage_login_wait` return while a
 * hand-off is queued or active. */
export interface LoginHandoffStatus {
	readonly handoffId: string;
	readonly stage: string;
	readonly app: string;
	readonly role: string;
	readonly reason: LoginHandoffReason;
	readonly state: LoginHandoffState;
	readonly queuePosition?: number;
	readonly deadlineAt: string;
}

export type LoginHandoffOutcome =
	| {
			readonly outcome: "ok";
			readonly via: "handoff" | "existing-session" | "token";
			readonly verified: boolean;
			readonly url: string;
	  }
	| { readonly outcome: "unverified"; readonly url: string }
	| { readonly outcome: "timeout"; readonly deadlineAt: string }
	| { readonly outcome: "aborted"; readonly by: LoginHandoffAbortBy }
	/** The login ended by itself and without a token: a code-grant exchange the
	 * provider refused, or a callback whose `state` did not match
	 * (`add-stage-oauth2-code-pkce`). The error is the server's own value-free
	 * refusal, never a value. */
	| { readonly outcome: "failed"; readonly error: unknown }
	| { readonly outcome: "unavailable"; readonly reason: "launch-failed" };

/** What one `stage_login_wait` call answered: the pending hand-off, or the
 * outcome it ended with. */
export type LoginHandoffWait =
	| { readonly status: LoginHandoffStatus; readonly outcome?: undefined }
	| { readonly status?: undefined; readonly outcome: LoginHandoffOutcome };

/** How a hand-off that runs no page login has done so far
 * (`add-stage-oauth2-code-pkce`): pending while the developer is still in the
 * provider's window, `ok` once the token is held, `failed` with the server's own
 * value-free refusal when the exchange ended without one. */
export type LoginHandoffCompletion =
	| { readonly state: "pending" }
	| { readonly state: "ok" }
	| { readonly state: "failed"; readonly error: unknown };

/** The login a hand-off drives when the page it opened is not what completes it.
 *
 * A code-grant login ends on the loopback receiver behind the provider's
 * redirect, not on a success condition a page can be asked about. This is the
 * seam that lets the same hand-off own the window, the lock and the deadline
 * without growing a second mechanism. */
export interface LoginHandoffCompletionSource {
	poll(): LoginHandoffCompletion;
	/** The URL the terminal `ok` reports: the stage application, never the
	 * loopback callback the window last landed on. */
	readonly url?: string;
	/** Release what the login itself owns (its single-use receiver). Called
	 * exactly once, on every ending path, and never allowed to fail the ending. */
	close(): Promise<void> | void;
	/** Bring the window back to the application once the token is held, so the
	 * session is usable instead of sitting on a callback page that no longer
	 * answers. Called only for the `ok` outcome, and never allowed to fail it. */
	land?(): Promise<void> | void;
}

export interface LoginHandoffRequest {
	readonly session: BrowserSession;
	readonly stage: string;
	/** The stage's display name, which is what the banner says. */
	readonly stageLabel: string;
	readonly app: string;
	readonly appLabel: string;
	readonly role: string;
	readonly reason: LoginHandoffReason;
	/** The application's login URL the promoted context opens. */
	readonly loginUrl: string;
	/** The role's recipe: its declared `success` decides whether a success can
	 * be detected without the developer confirming. */
	readonly recipe: StageLoginRecipe;
	/** The stage's effective `maxLoginHandoffSeconds`. */
	readonly maxSeconds: number;
	/** The login the hand-off drives instead of a page's success condition
	 * (`add-stage-oauth2-code-pkce`). Absent for every recipe a page completes. */
	readonly completion?: LoginHandoffCompletionSource;
	/** The attention record's words. Names and the deadline only, no URL beyond
	 * the application's own origin and no credential. */
	readonly description: string;
	readonly context: string;
}

export interface LoginHandoffAttention {
	/** Create the run's attention record. */
	open(input: {
		readonly owner: string;
		readonly recordId: string;
		readonly description: string;
		readonly context: string;
		readonly expiresAt: string;
		/** Whether the record offers *Done*. A completion-driven login has no
		 * success a *Done* could verify, so it is offered *Abort* alone
		 * (`add-stage-oauth2-code-pkce`, USAB-207). */
		readonly canConfirm?: boolean;
	}): Promise<void>;
	/** The developer's answer, while the record is pending. */
	answer(input: {
		readonly owner: string;
		readonly recordId: string;
	}): Promise<"done" | "abort" | undefined>;
	/** Resolve the record without resuming any run. */
	close(input: {
		readonly owner: string;
		readonly recordId: string;
		readonly answer: "done" | "abort";
		readonly by: "developer" | "system";
		readonly outcome: string;
	}): Promise<void>;
}

export interface LoginHandoffDeps {
	readonly pool: BrowserPool;
	/** The headed capability of this machine, resolved per request. */
	readonly availability: () => LoginHandoffAvailability;
	readonly attention?: LoginHandoffAttention;
	readonly now?: () => number;
	/** The timer seam for tests; `setTimeout` when not given. */
	readonly schedule?: (run: () => void, ms: number) => () => void;
	readonly log?: (line: string) => void;
}

interface HandoffEntry {
	readonly handoffId: string;
	readonly request: LoginHandoffRequest;
	readonly owner: string;
	readonly deadlineAt: number;
	/** Set by `finish`; the run loop and every later call read it. */
	finished: boolean;
	/** Set by `activate`: whether this hand-off ever had a window. A queued
	 * hand-off that timed out must not open one. */
	activated: boolean;
	/** The promotion in flight. A deadline that lands here still has to close the
	 * window the promotion is about to open. */
	activating: boolean;
	/** Whether the run's attention record was created at all. Everything the
	 * developer is told about choosing *Done* is only true when it was. */
	recorded: boolean;
	/** The developer's answer, read from the record each tick. */
	answer: "done" | "abort" | undefined;
	/** When *Done* was seen, so the grace period is measured from it. */
	doneAt: number | undefined;
	outcome: LoginHandoffOutcome | undefined;
	settled: Promise<void>;
	settle: () => void;
}

const DEFAULT_SCHEDULE = (run: () => void, ms: number): (() => void) => {
	const timer = setTimeout(run, ms);
	// A pending hand-off timer is not a reason to keep the process alive.
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
};

/** Wait for one scheduling step, and keep the way to disarm it: a wait that is
 * answered early must not leave a timer armed for the rest of its cap. */
function after(
	schedule: (run: () => void, ms: number) => () => void,
	ms: number,
): { readonly done: Promise<void>; readonly cancel: () => void } {
	let disarm = () => {};
	const done = new Promise<void>((resolve) => {
		disarm = schedule(() => resolve(), ms);
	});
	return { done, cancel: () => disarm() };
}

export class LoginHandoffCoordinator {
	private readonly pool: BrowserPool;
	private readonly availability: () => LoginHandoffAvailability;
	/** Attached by the composition that can reach the workflow engine; a
	 * hand-off raised before it exists would otherwise never read *Done*. */
	private attention: LoginHandoffAttention | undefined;
	private readonly clock: () => number;
	private readonly schedule: (run: () => void, ms: number) => () => void;
	private readonly log: (line: string) => void;
	/** The one active hand-off. */
	private active: HandoffEntry | undefined;
	/** The hand-off whose window is being torn down. It still owns the slot, so
	 * a hand-off requested meanwhile queues instead of overtaking the FIFO. */
	private draining: HandoffEntry | undefined;
	/** Whether a queue drain is running, so it is never re-entered. */
	private advancing = false;
	/** The FIFO of hand-offs waiting for the active one to end. */
	private readonly queue: HandoffEntry[] = [];
	/** The pending hand-off of a session and, briefly, the last outcome it had,
	 * so a `stage_login_wait` that arrives after the end still learns it. */
	private readonly bySession = new Map<
		string,
		{
			readonly entry?: HandoffEntry;
			readonly outcome?: LoginHandoffOutcome;
			readonly at: number;
		}
	>();

	constructor(deps: LoginHandoffDeps) {
		this.pool = deps.pool;
		this.availability = deps.availability;
		this.attention = deps.attention;
		this.clock = deps.now ?? (() => Date.now());
		this.schedule = deps.schedule ?? DEFAULT_SCHEDULE;
		this.log = deps.log ?? (() => {});
	}

	/** Give a coordinator that was built before the workflow composition a way
	 * to read and resolve its records. Idempotent: the first adapter wins. */
	attachAttention(attention: LoginHandoffAttention): void {
		if (this.attention) return;
		this.attention = attention;
	}

	/** Whether a hand-off may be started at all. Checked before anything is
	 * queued, so a machine that cannot show a window never opens one and never
	 * creates a record. */
	available(): LoginHandoffAvailability {
		return this.availability();
	}

	/** The pending hand-off of one session, when it has one. */
	pending(session: BrowserSession): LoginHandoffStatus | undefined {
		const entry = this.bySession.get(session.id)?.entry;
		return entry && !entry.finished ? this.status(entry) : undefined;
	}

	/**
	 * Queue one hand-off, or rejoin the one this session already has. Answers
	 * the non-terminal status the tool returns immediately; the activation
	 * (promotion, banner, focus, record) continues in the background, because a
	 * `stage_login` result must not wait for a launch.
	 */
	async request(request: LoginHandoffRequest): Promise<LoginHandoffStatus> {
		return (await this.requestOwned(request)).status;
	}

	/**
	 * The same, and whether *this* request is the one that took the hand-off.
	 *
	 * A rejoin is not an owning answer: the caller that arrives second queued
	 * nothing, so machinery it opened before calling (a code grant's loopback
	 * receiver and its allowance) belongs to nobody and it has to close it rather
	 * than leave it listening for the rest of the hand-off (CONC-001, PERF-001).
	 *
	 * The decision and the registration happen without an intervening await, so two
	 * concurrent callers cannot both be told they own the hand-off.
	 */
	async requestOwned(
		request: LoginHandoffRequest,
	): Promise<{ readonly status: LoginHandoffStatus; readonly owned: boolean }> {
		this.pruneOutcomes();
		const existing = this.bySession.get(request.session.id)?.entry;
		if (existing && !existing.finished) {
			// A second `stage_login` on a held session rejoins the pending
			// hand-off; it never starts a second one.
			request.session.touch();
			return { status: this.status(existing), owned: false };
		}
		const handoffId = newHandoffId();
		const deadlineAt = this.clock() + Math.max(1, request.maxSeconds) * 1_000;
		const entry: HandoffEntry = {
			handoffId,
			request,
			owner: request.session.owner,
			deadlineAt,
			finished: false,
			activated: false,
			activating: false,
			recorded: false,
			answer: undefined,
			doneAt: undefined,
			outcome: undefined,
			settled: Promise.resolve(),
			settle: () => {},
		};
		entry.settled = new Promise<void>((resolve) => {
			entry.settle = resolve;
		});
		// The hold starts with the *queue*, not with the window: from this moment
		// on the session is the developer's, whatever state the hand-off is in.
		request.session.holdForUser({ handoffId, deadlineAt });
		this.bySession.set(request.session.id, { entry, at: this.clock() });
		// The slot is claimed *before* the record is created: the queue is arrival
		// order, so a workflow dispatch that resolves slowly must not let a later
		// hand-off overtake this one. It also means the record already knows
		// whether a window is opening for it or it is waiting behind another.
		const claimed = this.claim(entry);
		await this.openRecord(entry);
		// Creating the record yields, and the hand-off can be ended in that window
		// (a closed session, a deadline that had no time left). A finished entry
		// never becomes active.
		if (entry.finished) return { status: this.status(entry), owned: true };
		if (!claimed) return { status: this.status(entry), owned: true };
		this.start(entry);
		return { status: this.status(entry), owned: true };
	}

	/**
	 * Block until the session's hand-off ends or the cap is reached. The cap is
	 * the smaller of the hand-off's remaining deadline and `ms`; a cap that was
	 * reached *because* of the deadline ends the hand-off as a timeout, so a
	 * queued hand-off that never got a window still ends honestly (D6).
	 */
	async wait(session: BrowserSession, ms: number): Promise<LoginHandoffWait> {
		const record = this.bySession.get(session.id);
		const entry = record?.entry;
		if (!entry || entry.finished) {
			// The outcome is readable exactly as long as an outcome lives: `finish`
			// records it before its teardown awaits, so a wait that races the end reads
			// it, and past the TTL the tool is told to start over rather than inventing
			// a result.
			const settled = this.recentOutcome(session);
			if (settled) return { outcome: settled };
			throw new BrowserSessionError(
				"not-found",
				"no login hand-off is pending on this session; call stage_login first",
				404,
			);
		}
		const deadlineWait = Math.max(1, entry.deadlineAt - this.clock());
		const cap = Math.min(Math.max(1, ms), deadlineWait);
		const timer = after(this.schedule, cap);
		try {
			await Promise.race([entry.settled, timer.done]);
		} finally {
			// A wait the hand-off answered leaves no timer armed for the rest of its
			// cap holding the entry and the session alive.
			timer.cancel();
		}
		if (!entry.finished) {
			// The cap ran out. If the deadline is what ended the wait, the
			// hand-off is over: nothing else will end it.
			if (this.clock() >= entry.deadlineAt)
				await this.finish(entry, {
					outcome: "timeout",
					deadlineAt: isoFrom(entry.deadlineAt),
				});
			if (!entry.finished) return { status: this.status(entry) };
		}
		return await this.settledAnswer(entry);
	}

	/** End the session's hand-off because a developer chose to. Called by the
	 * answer reader; also the path *Done* takes after its grace period. */
	async answer(
		session: BrowserSession,
		answer: "done" | "abort",
	): Promise<void> {
		const entry = this.bySession.get(session.id)?.entry;
		if (!entry || entry.finished) return;
		entry.answer = answer;
		await this.tick(entry);
	}

	/** End the session's hand-off: `browser_close` (`agent`), a run ending
	 * (`run-ended`), the window going away (`window-closed`). */
	async abort(
		session: BrowserSession,
		by: LoginHandoffAbortBy,
	): Promise<boolean> {
		const entry = this.bySession.get(session.id)?.entry;
		if (!entry || entry.finished) return false;
		await this.finish(entry, { outcome: "aborted", by });
		return true;
	}

	/** The pool told us a session left it. A held session leaving is always the
	 * end of its hand-off. */
	async sessionClosed(session: BrowserSession, cause: string): Promise<void> {
		const by: LoginHandoffAbortBy =
			cause === "owner-closed" ? "run-ended" : "window-closed";
		await this.abort(session, by);
	}

	/** One poll turn of the active hand-off: window gone, answer, deadline,
	 * success. Exposed so a test can drive the loop with fake clocks. */
	async tick(entry?: HandoffEntry): Promise<void> {
		const current = entry ?? this.active;
		if (!current || current.finished) return;
		const session = current.request.session;
		if (session.crashed || session.windowClosed)
			return await this.finish(current, {
				outcome: "aborted",
				by: "window-closed",
			});
		if (current.answer === undefined)
			current.answer = await this.readAnswer(current);
		if (current.answer === "abort")
			return await this.finish(current, {
				outcome: "aborted",
				by: "developer",
			});
		// A login that ends off-page (`add-stage-oauth2-code-pkce`): the code-grant
		// flow's receiver took the callback and the token is held, or the exchange
		// ended without one. Nothing about the page is asked, because the page is
		// the provider's and the window's last stop is this server's own loopback
		// callback.
		const completion = current.request.completion;
		if (completion) {
			const login = completion.poll();
			if (login.state === "ok")
				return await this.finish(current, {
					outcome: "ok",
					via: "token",
					verified: true,
					url: sanitizeStageUrl(completion.url ?? session.url),
				});
			if (login.state === "failed")
				return await this.finish(current, {
					outcome: "failed",
					error: login.error,
				});
		}
		// A declared success condition is what makes an automatic ending
		// possible at all: without one, *Done* is the only thing that ends a
		// hand-off well.
		if (current.request.recipe.success !== undefined) {
			if (await this.successHolds(current))
				return await this.finish(current, {
					outcome: "ok",
					via: "handoff",
					verified: true,
					url: this.landingUrl(current),
				});
			if (current.answer === "done") {
				if (current.doneAt === undefined) current.doneAt = this.clock();
				if (this.clock() - current.doneAt >= HANDOFF_GRACE_MS)
					return await this.finish(current, {
						outcome: "unverified",
						url: this.landingUrl(current),
					});
			}
		} else if (current.answer === "done") {
			if (current.request.completion !== undefined) {
				// The developer says the sign-in is finished, but a code-grant login is
				// only done when its receiver has the token: give the callback the same
				// grace a declared success condition gets, then answer honestly that it
				// did not complete (a *Done* is never an `ok` without a token).
				if (current.doneAt === undefined) current.doneAt = this.clock();
				if (this.clock() - current.doneAt >= HANDOFF_GRACE_MS)
					return await this.finish(current, {
						outcome: "unverified",
						url: this.landingUrl(current),
					});
			} else {
				return await this.finish(current, {
					outcome: "ok",
					via: "handoff",
					verified: false,
					url: this.landingUrl(current),
				});
			}
		}
		if (this.clock() >= current.deadlineAt)
			await this.finish(current, {
				outcome: "timeout",
				deadlineAt: isoFrom(current.deadlineAt),
			});
	}

	// -- internals -----------------------------------------------------------

	/** Take the active slot for `entry`, or queue it behind whoever holds it.
	 * Synchronous on purpose: nothing may be awaited between deciding who is next
	 * and recording it. A drain that is tearing an expired entry down holds the
	 * slot too, so a hand-off requested meanwhile queues instead of starting on
	 * top of a teardown (QUALITY-102). */
	private claim(entry: HandoffEntry): boolean {
		if (this.active || this.draining || this.advancing) {
			this.queue.push(entry);
			this.logEvent("queued", entry, { queuePosition: this.queue.length });
			return false;
		}
		this.active = entry;
		return true;
	}

	/** Begin the activation of an entry that already owns the active slot;
	 * `claim` and `advance` are the only things that take it. */
	private start(entry: HandoffEntry): void {
		if (entry.finished || this.active !== entry) return;
		void this.run(entry);
	}

	/** The active entry's loop: activate, then poll once per tick until it ends.
	 * Activation failures are outcomes, never thrown: `stage_login` has already
	 * answered by the time a launch is attempted. */
	private async run(entry: HandoffEntry): Promise<void> {
		// The promotion in flight is visible to `finish`, so a deadline that lands
		// while the window is still being launched can still close it.
		entry.activating = true;
		let failed = false;
		try {
			await this.activate(entry);
		} catch (_error) {
			failed = true;
		} finally {
			entry.activating = false;
		}
		if (failed) {
			await this.finish(entry, {
				outcome: "unavailable",
				reason: "launch-failed",
			});
			return;
		}
		while (!entry.finished) {
			await this.tick(entry);
			if (entry.finished) break;
			await after(this.schedule, HANDOFF_TICK_MS).done;
		}
	}

	/** Promote (or re-use) the session's interactive context, install the
	 * banner *before* the first navigation, open the login URL, raise the window
	 * once, and report the entry active. */
	private async activate(entry: HandoffEntry): Promise<void> {
		if (entry.finished) return;
		const { session, loginUrl } = entry.request;
		const existing = this.bySession.get(session.id)?.entry;
		if (existing !== entry) return;
		const text: HandoffBannerText = {
			stage: entry.request.stageLabel,
			app: entry.request.appLabel,
			role: entry.request.role,
			reason: entry.request.reason,
			deadline: formatHandoffDeadline(entry.deadlineAt, this.clock()),
			// There is no *Done* to choose when the run refused the record, and a
			// banner that promises one leaves the developer waiting for a button that
			// never renders (USAB-105). Nor is there one to choose for a
			// completion-driven login: a code grant is done when its receiver has the
			// token, so *Done* would close the receiver and answer `unverified` to a
			// developer who followed the banner (USAB-201).
			canConfirm: entry.recorded && entry.request.completion === undefined,
		};
		await this.pool.openInteractive(session, loginUrl, async (context) => {
			await context.addInitScript(bannerScript(text));
		});
		entry.activated = true;
		if (entry.finished) {
			// The deadline or an abort won while the launch was in flight: the window
			// this promotion just opened is not the developer's to keep, and the login
			// page on it is not a page this run may read.
			await this.pool.closeWindow(session).catch(() => {});
			return;
		}
		await this.pool.focusWindow(session);
		this.logEvent("active", entry, {});
	}

	private async readAnswer(
		entry: HandoffEntry,
	): Promise<"done" | "abort" | undefined> {
		if (!this.attention) return undefined;
		return await this.attention
			.answer({ owner: entry.owner, recordId: entry.handoffId })
			.catch(() => undefined);
	}

	private async successHolds(entry: HandoffEntry): Promise<boolean> {
		return await declaredSuccessHolds({
			session: entry.request.session,
			recipe: entry.request.recipe,
		}).catch(() => false);
	}

	/** The landing URL as origin plus path: query and fragment are dropped
	 * whatever they carry (D4). */
	private landingUrl(entry: HandoffEntry): string {
		return sanitizeStageUrl(entry.request.session.url);
	}

	private async openRecord(entry: HandoffEntry): Promise<void> {
		if (!this.attention) return;
		try {
			await this.attention.open({
				owner: entry.owner,
				recordId: entry.handoffId,
				description: entry.request.description,
				context: `${entry.request.context} ${this.recordState(entry)}`,
				expiresAt: isoFrom(entry.deadlineAt),
				// The record offers the same two answers the banner does: a *Done* for a
				// login the page can finish, and no *Done* for a completion-driven one,
				// where it could only end the receiver as unverified (USAB-207).
				canConfirm: entry.request.completion === undefined,
			});
			entry.recorded = true;
		} catch (error: unknown) {
			this.log(
				`login hand-off attention record could not be created: ${message(error)}`,
			);
		}
	}

	/** What the record says about *this* hand-off: whether a window is opening for
	 * it or how many are ahead, and when it expires in words a developer can read
	 * without converting a UTC instant in their head (USAB-101, USAB-102,
	 * USAB-103). */
	private recordState(entry: HandoffEntry): string {
		const position = this.queue.indexOf(entry) + 1;
		const state =
			position > 0
				? `Another login is in progress; this hand-off is next (position ${position}) and its window opens when that one ends.`
				: "Its window is opening now.";
		return `${state} The hand-off expires at ${formatHandoffDeadline(entry.deadlineAt, this.clock())}.`;
	}

	/** End a hand-off exactly once, then let the next queued one start. The order
	 * matters: the banner is gone, the record is closed and the window is in its
	 * final state *before* the hold is released and the waiters are answered, so
	 * the agent's first snapshot after a hand-off cannot show the banner it never
	 * took down and the buffers never record the teardown. */
	private async finish(
		entry: HandoffEntry,
		outcome: LoginHandoffOutcome,
	): Promise<void> {
		if (entry.finished) return;
		entry.finished = true;
		entry.outcome = outcome;
		const session = entry.request.session;
		// The outcome is readable from the moment it exists, so a wait (or a later
		// tool call) that races this teardown reads it instead of being told nothing
		// is pending. Nothing awaits before this point, so the record is still ours.
		if (this.bySession.get(session.id)?.entry === entry)
			this.bySession.set(session.id, {
				entry,
				outcome,
				at: this.clock(),
			});
		// The slot stays reserved for the whole teardown: a hand-off requested while
		// the banner is taken down queues behind the FIFO instead of overtaking it.
		const wasActive = this.active === entry;
		if (wasActive) {
			this.active = undefined;
			this.draining = entry;
		}
		const queued = this.queue.indexOf(entry);
		if (queued >= 0) this.queue.splice(queued, 1);
		// The login's own machinery goes first: the loopback receiver stops listening
		// on every ending (success, mismatch, deadline, abort), so no port stays bound
		// after a hand-off and no later callback can take a second code.
		if (entry.request.completion !== undefined) {
			try {
				await entry.request.completion.close();
			} catch {
				// An ending path is never failed by the login's own teardown.
			}
			// A completed code-grant login leaves its window on the receiver's own
			// "you can close this window" page, which no longer answers once the
			// receiver is closed: the session is brought back to the application it
			// logged in to, so the next tool call finds a live page.
			if (
				outcome.outcome === "ok" &&
				entry.request.completion.land !== undefined
			) {
				try {
					await entry.request.completion.land();
				} catch {
					// The login already succeeded; a failed landing is not a failed login.
				}
			}
		}
		await this.pool.removeBanner(session).catch(() => {});
		// A deadline closes the window (spec), and a window the developer already
		// closed has closed itself. Neither is re-opened here: closing it marks the
		// session unusable, so the run's next tool call is answered
		// `browser-crashed` and the agent decides whether to open it again. A
		// hand-off whose window is still being launched counts as activated: the
		// promotion itself closes the window it is about to open. A hand-off that
		// was still queued never had one.
		if (outcome.outcome === "timeout" && (entry.activated || entry.activating))
			await this.pool.closeWindow(session).catch(() => {});
		await this.closeRecord(entry, outcome);
		this.logEvent("ended", entry, { outcome: outcomeCode(outcome) });
		if (wasActive) this.draining = undefined;
		// A second hand-off on the same session may already have registered itself
		// while this one was being torn down; only the owner of the map entry may
		// publish the terminal record, and it stays attached to the entry so the
		// next teardown can tell whose state it is looking at.
		const current = this.bySession.get(session.id);
		if (current === undefined || current.entry === entry)
			this.bySession.set(session.id, { entry, outcome, at: this.clock() });
		// The hold ends last, and only when it is still this hand-off's: a second
		// hand-off on the same session may have taken it during the teardown, and
		// releasing that one would hand the developer's session back mid-login.
		if (session.releaseHold(entry.handoffId)) session.clearTrace();
		entry.settle();
		if (wasActive) void this.advance();
	}

	private async closeRecord(
		entry: HandoffEntry,
		outcome: LoginHandoffOutcome,
	): Promise<void> {
		if (!this.attention) return;
		const answer =
			outcome.outcome === "ok"
				? "done"
				: outcome.outcome === "aborted" && outcome.by === "developer"
					? "abort"
					: entry.answer === "done"
						? "done"
						: "abort";
		await this.attention
			.close({
				owner: entry.owner,
				recordId: entry.handoffId,
				answer,
				by: entry.answer === answer ? "developer" : "system",
				outcome: outcomeCode(outcome),
			})
			.catch(() => {});
	}

	/** Start the first queued hand-off whose deadline has not passed. A queued
	 * hand-off that timed out while it waited never opens a window.
	 *
	 * Not re-entrant: `finish` is what calls this, and a drain that is already
	 * running picks up whatever an inner call would have started. */
	private async advance(): Promise<void> {
		if (this.advancing) return;
		this.advancing = true;
		try {
			for (;;) {
				const next = this.queue[0];
				if (!next) return;
				if (next.finished) {
					this.queue.shift();
					continue;
				}
				if (this.clock() >= next.deadlineAt) {
					this.queue.shift();
					// Never activated, so this ends it without a window.
					await this.finish(next, {
						outcome: "timeout",
						deadlineAt: isoFrom(next.deadlineAt),
					});
					continue;
				}
				// A request can claim the slot while the teardown above awaits, so the
				// reservation is re-read on every pass, not once before the loop, and the
				// entry is only taken out of the queue when it is actually started.
				if (this.active || this.draining) return;
				this.queue.shift();
				this.active = next;
				this.start(next);
				return;
			}
		} finally {
			this.advancing = false;
		}
	}

	private status(entry: HandoffEntry): LoginHandoffStatus {
		const queued = this.queue.indexOf(entry);
		return {
			handoffId: entry.handoffId,
			stage: entry.request.stage,
			app: entry.request.app,
			role: entry.request.role,
			reason: entry.request.reason,
			state: this.active === entry ? "active" : "queued",
			...(queued >= 0 ? { queuePosition: queued + 1 } : {}),
			deadlineAt: isoFrom(entry.deadlineAt),
		};
	}

	private async settledAnswer(entry: HandoffEntry): Promise<LoginHandoffWait> {
		if (entry.outcome) return { outcome: entry.outcome };
		return { status: this.status(entry) };
	}

	/** Forget the terminal outcomes a session no longer needs, so a long-lived
	 * server does not keep one record per hand-off it ever ran. */
	private pruneOutcomes(): void {
		for (const [id, record] of this.bySession) {
			// A pending hand-off is never pruned, however long it waits: a queued
			// hand-off's deadline is what ends it, not the idle sweep.
			if (record.entry && !record.entry.finished) continue;
			if (this.clock() - record.at <= HANDOFF_OUTCOME_TTL_MS) continue;
			this.bySession.delete(id);
		}
	}

	/** The last terminal outcome of one owner's named session, readable for its
	 * TTL even after the session became unusable, so a `stage_login_wait` that
	 * arrives after the end learns how the hand-off ended instead of meeting the
	 * pool's `browser-crashed` refusal (SEC-002). */
	recordedOutcome(
		owner: string,
		name: string,
	): LoginHandoffOutcome | undefined {
		const id = sessionKey(owner, name);
		const record = this.bySession.get(id);
		if (!record?.outcome) return undefined;
		if (this.clock() - record.at > HANDOFF_OUTCOME_TTL_MS) {
			// Expired outcomes are dropped rather than ignored, so a long-lived
			// server does not keep one record per session that ever handed off.
			this.bySession.delete(id);
			return undefined;
		}
		return record.outcome;
	}

	private recentOutcome(
		session: BrowserSession,
	): LoginHandoffOutcome | undefined {
		return this.recordedOutcome(session.owner, session.name);
	}

	/** Coordination only: stage, app, role, reason, state, outcome, queue time
	 * and duration. Never page content, a typed value or a URL (D4). */
	private logEvent(
		phase: "queued" | "active" | "ended",
		entry: HandoffEntry,
		extra: { readonly queuePosition?: number; readonly outcome?: string },
	): void {
		const at = isoFrom(this.clock());
		const fields: string[] = [
			`phase=${phase}`,
			`stage=${entry.request.stage}`,
			`app=${entry.request.app}`,
			`role=${entry.request.role}`,
			`reason=${entry.request.reason}`,
			`handoff=${entry.handoffId}`,
			`deadlineAt=${isoFrom(entry.deadlineAt)}`,
			`at=${at}`,
		];
		if (extra.queuePosition !== undefined)
			fields.push(`queuePosition=${extra.queuePosition}`);
		if (extra.outcome !== undefined) fields.push(`outcome=${extra.outcome}`);
		this.log(`login hand-off ${fields.join(" ")}`);
	}
}

function outcomeCode(outcome: LoginHandoffOutcome): string {
	switch (outcome.outcome) {
		case "ok":
			return "ok";
		case "unverified":
			return "login-handoff-unverified";
		case "timeout":
			return "login-handoff-timeout";
		case "aborted":
			return "login-handoff-aborted";
		case "failed":
			return "login-failed";
		case "unavailable":
			return "login-handoff-unavailable";
	}
}

function isoFrom(ms: number): string {
	return new Date(ms).toISOString();
}

/** A hand-off id: random, opaque, and the id of the attention record it raises,
 * so a resolution can always be matched to the hand-off that asked for it. */
function newHandoffId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return `login-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
