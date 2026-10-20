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
	 * Count one stored screenshot, or refuse it (`stage-screenshot-limit`). The
	 * count happens *before* the file is written, so a refusal leaves no bytes
	 * behind.
	 */
	countScreenshot(input: {
		readonly stage: string;
		readonly owner: string;
		readonly maxScreenshots: number;
	}): number {
		const key = windowKey(input.stage, input.owner);
		const used = this.screenshots.get(key) ?? 0;
		if (used >= input.maxScreenshots)
			throw new StageLimitError(
				"stage-screenshot-limit",
				`stage ${input.stage} already stored ${used} of ${input.maxScreenshots} screenshots in this workflow; describe the page in a stage_step instead`,
			);
		this.screenshots.set(key, used + 1);
		return used + 1;
	}

	/** How many more milliseconds of recording this workflow may keep on a stage.
	 * Refuses with `stage-recording-limit` once the budget is spent, and otherwise
	 * answers the remainder so the recording is bounded by whichever is smaller:
	 * the per-recording default and what is left of the stage's budget. */
	recordingAllowance(input: {
		readonly stage: string;
		readonly owner: string;
		readonly maxRecordingMinutes: number;
	}): number {
		const budget = Math.max(0, input.maxRecordingMinutes) * 60_000;
		const used = this.recordedMs.get(windowKey(input.stage, input.owner)) ?? 0;
		const remaining = budget - used;
		if (remaining < MIN_RECORDING_MS)
			throw new StageLimitError(
				"stage-recording-limit",
				`stage ${input.stage} already kept ${Math.round(used / 60_000)} of ${input.maxRecordingMinutes} recording minutes in this workflow; describe the remaining steps in stage_step without a recording`,
			);
		return remaining;
	}

	/** Settle the milliseconds one kept recording actually used. A discarded
	 * recording calls nothing, so it spends nothing. */
	recordKept(input: {
		readonly stage: string;
		readonly owner: string;
		readonly elapsedMs: number;
	}): void {
		if (!Number.isFinite(input.elapsedMs) || input.elapsedMs <= 0) return;
		const key = windowKey(input.stage, input.owner);
		this.recordedMs.set(key, (this.recordedMs.get(key) ?? 0) + input.elapsedMs);
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
