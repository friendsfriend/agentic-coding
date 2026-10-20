// Stage usage limits (`add-stage-testing-foundation`, tasks 3.3–3.5).
//
// A stage's bounds are enforced server-side, per workflow: `maxSessions` counts
// the workflow's live sessions on that stage *plus the opens still in flight*,
// `maxActionsPerMinute` counts its browser tool calls on that stage in a rolling
// minute, and an `exclusive` stage refuses a second workflow while the first
// still holds it.
//
// The registry holds no session of its own. Session counts are derived from the
// pool's live sessions (`stageSessions`), so every path that ends a session —
// `browser_close`, the idle sweep, a crashed context, run end — releases the
// slot at the same moment, with no second lifecycle to keep in step. What cannot
// be derived is an open that has been admitted but whose context does not exist
// yet: that is counted as a *pending admission*, claimed in `open()` and given
// back by the caller once the open has settled. Without it the lease and the
// session bound would both be blind for the whole of Chromium's `newContext`
// round trip, and two workflows could drive one exclusive stage.
export class StageLimitError extends Error {
	constructor(
		readonly code:
			| "stage-held"
			| "stage-rate-limit"
			| "stage-session-limit"
			// `add-stage-flow-evidence`: the flow test's own bounds — kept video
			// minutes and stored screenshots, both per workflow and stage.
			| "stage-recording-limit"
			| "stage-screenshot-limit"
			// A `mail` wait on a session whose application is not a mail catcher.
			| "stage-mail-unsupported",
		message: string,
		/** How long the caller should wait, for a rate limit. */
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "StageLimitError";
	}
}

export interface StageUsageOptions {
	readonly now?: () => number;
	/** Live sessions of one owner on one stage, right now. */
	readonly stageSessions: (owner: string, stage: string) => number;
}

/** One admitted open. The caller gives it back exactly once, when the open has
 * settled — its session registered, or its context refused. */
export interface StageAdmission {
	readonly stage: string;
	readonly owner: string;
	settle(): void;
}

/** One reserved, and therefore stored, stage screenshot. Its reservation is the
 * charge; a failed capture or a refused attach gives it back. */
export interface StageScreenshotReservation {
	readonly stage: string;
	readonly owner: string;
}

/** One rolling minute, the window `maxActionsPerMinute` counts in. */
const RATE_WINDOW_MS = 60_000;

/** The least recording a start is still worth: below this the budget is spent
 * and a start would produce a segment too short to seek into. */
const MIN_RECORDING_MS = 1_000;

/** The rate window and the pending count are keyed differently on purpose:
 * `release(owner)` drops the windows of a finished workflow and must never
 * touch an admission, which is live by definition. */
function windowKey(stage: string, owner: string): string {
	return `${stage}\u0000${owner}`;
}

function pendingKey(stage: string, owner: string): string {
	return `${stage}\u0001${owner}`;
}

export class StageUsageRegistry {
	private readonly now: () => number;
	private readonly stageSessions: (owner: string, stage: string) => number;
	/** Rate-limit window per `stage\0owner`. */
	private readonly actions = new Map<string, number[]>();
	/** Lease owner per exclusive stage. */
	private readonly leases = new Map<string, string>();
	/** Opens admitted and not yet settled, per `stage\1owner`. */
	private readonly pending = new Map<string, number>();
	/** Screenshots stored per `stage\0owner` (`add-stage-flow-evidence`). Only a
	 * screenshot the agent asked to keep is counted: a viewed one costs no file. */
	private readonly screenshots = new Map<string, number>();
	/** Milliseconds of kept recording per `stage\0owner`. Settled when a segment's
	 * video is kept, so a discarded recording spends nothing. */
	private readonly recordedMs = new Map<string, number>();
	/** Milliseconds of recording granted to a start that has not stopped yet, per
	 * `stage\0owner\0session`. A grant is *reserved* the moment it is told out,
	 * because the budget is settled minutes later: without it, two sessions of one
	 * workflow would both be told the remainder and could each keep it.
	 *
	 * It is identified by the session it was granted to, not by its position in a
	 * list: a stop settles the grant of the session that stopped, so two segments
	 * stopped out of order (or a start that was refused after another session's
	 * grant) can neither release nor leave behind the wrong one. An entry also
	 * expires on its own bound, so a stop that never happens — a dropped session,
	 * a run that ended — cannot hold the budget forever. */
	private readonly reservedMs = new Map<
		string,
		{
			readonly windowKey: string;
			readonly ms: number;
			readonly expiresAt: number;
		}
	>();

	constructor(options: StageUsageOptions) {
		this.now = options.now ?? (() => Date.now());
		this.stageSessions = options.stageSessions;
	}

	/**
	 * Admit one new session on a stage, or refuse it: `stage-held` when an
	 * exclusive stage is in another workflow's hands, `stage-session-limit` when
	 * this workflow already holds the stage's `maxSessions`.
	 *
	 * The admission is what the caller settles; until it is, the stage counts as
	 * held and the session as used, because from the stage's point of view the
	 * context is already coming.
	 */
	open(input: {
		readonly stage: string;
		readonly exclusive: boolean;
		readonly maxSessions: number;
		readonly owner: string;
	}): StageAdmission {
		const key = pendingKey(input.stage, input.owner);
		if (input.exclusive) {
			const holder = this.holder(input.stage);
			if (holder !== undefined && holder !== input.owner)
				throw new StageLimitError(
					"stage-held",
					`stage ${input.stage} is held by ${holder}; it is exclusive, so only one workflow may drive it at a time`,
				);
			this.leases.set(input.stage, input.owner);
		}
		const held =
			this.stageSessions(input.owner, input.stage) +
			(this.pending.get(key) ?? 0);
		if (held >= input.maxSessions)
			throw new StageLimitError(
				"stage-session-limit",
				`stage ${input.stage} already has ${held} of ${input.maxSessions} sessions in this workflow`,
			);
		this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
		let settled = false;
		return {
			stage: input.stage,
			owner: input.owner,
			settle: () => {
				// Idempotent: a caller that settles on both a success and a failure
				// path must not give the same admission back twice.
				if (settled) return;
				settled = true;
				const remaining = (this.pending.get(key) ?? 0) - 1;
				if (remaining > 0) this.pending.set(key, remaining);
				else this.pending.delete(key);
			},
		};
	}

	/** Count one browser tool call on a stage, or refuse it. */
	countAction(input: {
		readonly stage: string;
		readonly owner: string;
		readonly maxActionsPerMinute: number;
	}): void {
		const now = this.now();
		const key = windowKey(input.stage, input.owner);
		const window = (this.actions.get(key) ?? []).filter(
			(at) => now - at < RATE_WINDOW_MS,
		);
		if (window.length >= input.maxActionsPerMinute) {
			this.actions.set(key, window);
			const oldest = window[0] ?? now;
			throw new StageLimitError(
				"stage-rate-limit",
				`stage ${input.stage} allows ${input.maxActionsPerMinute} stage calls per minute in this workflow`,
				Math.max(1, oldest + RATE_WINDOW_MS - now),
			);
		}
		window.push(now);
		this.actions.set(key, window);
	}

	/**
	 * Reserve one stored screenshot, or refuse it (`stage-screenshot-limit`).
	 *
	 * The reservation *is* the charge, taken in one synchronous step: a check that
	 * refuses before the capture and charges after it lets two calls that overlap
	 * during the capture and the attach each pass the same bound, store `max + 1`
	 * screenshots, and answer one of them a `stage-screenshot-limit` for a file it
	 * actually stored (the reference to that file would be lost with it). A capture
	 * that fails, or an attach that refuses, gives its reservation back with
	 * `releaseScreenshot` — so nothing is stored beyond the bound, and
	 * `stage-screenshot-limit` only ever answers a call that stored nothing.
	 */
	reserveScreenshot(input: {
		readonly stage: string;
		readonly owner: string;
		readonly maxScreenshots: number;
	}): StageScreenshotReservation {
		const key = windowKey(input.stage, input.owner);
		const used = this.screenshots.get(key) ?? 0;
		if (used >= input.maxScreenshots)
			throw new StageLimitError(
				"stage-screenshot-limit",
				`stage ${input.stage} already stored ${used} of ${input.maxScreenshots} screenshots in this workflow; describe the page in a stage_step instead`,
			);
		this.screenshots.set(key, used + 1);
		return { stage: input.stage, owner: input.owner };
	}

	/** Give one reservation back: the capture failed, or the attach was refused. */
	releaseScreenshot(reservation: StageScreenshotReservation): void {
		const key = windowKey(reservation.stage, reservation.owner);
		const used = this.screenshots.get(key) ?? 0;
		if (used <= 1) this.screenshots.delete(key);
		else this.screenshots.set(key, used - 1);
	}

	/**
	 * How many milliseconds of recording this workflow may keep on a stage, and the
	 * reservation that comes with it.
	 *
	 * Refuses with `stage-recording-limit` once the budget is spent, and otherwise
	 * answers the remainder — of which the kept minutes and the live grants are both
	 * already spent, so two concurrent starts cannot be told the same remainder.
	 * The route bounds the segment by what this returns, and `settleRecording` gives
	 * the reservation back.
	 */
	recordingAllowance(input: {
		readonly stage: string;
		readonly owner: string;
		/** The session that will record: its grant is the one its stop settles. */
		readonly session: string;
		readonly maxRecordingMinutes: number;
		/** The longest one segment can run (`DEFAULT_RECORDING_MAX_MS`), which is
		 * what is reserved: the remainder bounds the segment, but only this much of
		 * it can actually be spent before the recording stops itself. */
		readonly maxSegmentMs: number;
	}): number {
		const budget = Math.max(0, input.maxRecordingMinutes) * 60_000;
		const key = windowKey(input.stage, input.owner);
		const used = this.recordedMs.get(key) ?? 0;
		const reserved = this.liveReservations(key).reduce(
			(total, each) => total + each.ms,
			0,
		);
		const remaining = budget - used - reserved;
		if (remaining < MIN_RECORDING_MS)
			throw new StageLimitError(
				"stage-recording-limit",
				`stage ${input.stage} already kept ${Math.round(used / 60_000)} of ${input.maxRecordingMinutes} recording minutes in this workflow; describe the remaining steps in stage_step without a recording`,
			);
		const ms = Math.min(input.maxSegmentMs, remaining);
		this.reservedMs.set(this.grantKey(key, input.session), {
			windowKey: key,
			ms,
			// Expires with the segment it was granted for, plus the window a settle
			// has to land in — not with the whole remainder of the budget.
			expiresAt: this.now() + ms + RATE_WINDOW_MS,
		});
		return remaining;
	}

	/**
	 * Settle one recording: give its reservation back and charge what was kept. A
	 * discarded recording settles with `keptMs: 0`, so it spends nothing but
	 * releases the grant it held while it ran.
	 *
	 * The grant belongs to the session that took it, so settling twice, settling a
	 * start that was refused before it reserved anything, and settling two segments
	 * out of order are all harmless: an unknown grant settles nothing but its kept
	 * minutes.
	 */
	settleRecording(input: {
		readonly stage: string;
		readonly owner: string;
		readonly session: string;
		readonly keptMs: number;
	}): void {
		const key = windowKey(input.stage, input.owner);
		this.liveReservations(key);
		this.reservedMs.delete(this.grantKey(key, input.session));
		if (!Number.isFinite(input.keptMs) || input.keptMs <= 0) return;
		this.recordedMs.set(key, (this.recordedMs.get(key) ?? 0) + input.keptMs);
	}

	/** One session's grant of one budget. */
	private grantKey(key: string, session: string): string {
		return `${key}\u0000${session}`;
	}

	/** The grants of one budget that still count, pruning the ones that expired. */
	private liveReservations(key: string): { readonly ms: number }[] {
		const now = this.now();
		const live: { readonly ms: number }[] = [];
		for (const [id, grant] of [...this.reservedMs]) {
			if (grant.expiresAt <= now || grant.windowKey !== key) {
				if (grant.expiresAt <= now) this.reservedMs.delete(id);
				continue;
			}
			live.push(grant);
		}
		return live;
	}

	/** The workflow currently holding an exclusive stage, if any. A lease whose
	 * holder has neither a session left nor an open in flight is gone: closing a
	 * session, the idle sweep and run end all release it. */
	holder(stage: string): string | undefined {
		const owner = this.leases.get(stage);
		if (owner === undefined) return undefined;
		if (this.holds(owner, stage)) return owner;
		this.leases.delete(stage);
		return undefined;
	}

	/**
	 * Forget one workflow's rate windows, called where its sessions are released
	 * (`pool.closeOwner`): the windows of a run that is over can never be read
	 * again, so keeping them would grow the map with the process's whole history.
	 * An admission is deliberately untouched — it belongs to an open in flight,
	 * and the run ending is what settles it.
	 */
	release(owner: string): void {
		const suffix = `\u0000${owner}`;
		for (const key of [...this.actions.keys()])
			if (key.endsWith(suffix)) this.actions.delete(key);
		for (const key of [...this.screenshots.keys()])
			if (key.endsWith(suffix)) this.screenshots.delete(key);
		for (const key of [...this.recordedMs.keys()])
			if (key.endsWith(suffix)) this.recordedMs.delete(key);
		for (const [key, grant] of [...this.reservedMs])
			if (grant.windowKey.endsWith(suffix)) this.reservedMs.delete(key);
	}

	/** Whether one owner still holds a stage: a registered session, or an admitted
	 * open whose context is still being created. */
	private holds(owner: string, stage: string): boolean {
		return (
			this.stageSessions(owner, stage) > 0 ||
			(this.pending.get(pendingKey(stage, owner)) ?? 0) > 0
		);
	}
}
