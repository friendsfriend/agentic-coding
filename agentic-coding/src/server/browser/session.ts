// One browser session (`add-agent-browser-sessions`).
//
// A session is one isolated browser context of the shared browser process, owned
// by the durable run that opened it. It carries the four things a run needs
// between tool calls:
//
// * **The page and its refs.** `snapshot()` reads the page's public AI
//   snapshot; the refs the text names are the only refs the
//   action tools accept, so a ref from an older snapshot is refused rather than
//   silently resolving to a different element.
// * **Bounded console and network history**, per session, so `browser_console`
//   and `browser_network` answer from what happened *in this session* and can be
//   filtered without re-reading the page. Both the ring buffers *and* the
//   in-flight request index are bounded: a page that polls for hours grows
//   neither.
// * **The recording state**, so a video is attached to the session that recorded
//   it and a second `browser_record_start` is refused instead of silently
//   dropping the first recording.
// * **Whether a page close means a crash.** Recording deliberately replaces the
//   context, so a close during that swap must not mark the session crashed —
//   which would strand a perfectly usable session behind `browser-crashed`.
//
// Nothing here knows about the pool's capacity, the run's lifetime or evidence:
// the pool owns those, and every method here is a page operation plus one
// bounded buffer.

import type { EffectiveIdentityCache } from "../stages/catalog.ts";
import type { StageRefusal, StageSessionPolicy } from "../stages/guard.ts";
import {
	boundedSnapshotChars,
	boundedSnapshotDepth,
	diffSnapshotNodes,
	findSnapshotNodes,
	isRef,
	SNAPSHOT_HISTORY_CAPACITY,
	type SnapshotDelta,
	type SnapshotNode,
	snapshotRefs,
} from "./snapshot.ts";
import {
	type DriverActionTarget,
	type DriverConsoleEntry,
	type DriverContext,
	type DriverHttpCredentials,
	type DriverLocator,
	type DriverNetworkEvent,
	type DriverPage,
	type DriverScreenshotOptions,
	type DriverSnapshotResult,
	DriverTargetError,
	driverLocatorKey,
} from "./types.ts";

/** Console and network history are ring buffers: the newest entries are what a
 * debugger reads, and a long-lived page must not grow the server's memory. */
export const RING_CAPACITY = 500;
/** One bounded action timeout; a hung locator fails the tool rather than the
 * server's event loop. */
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
/** `browser_wait` may reach further, because waiting is the tool's whole job. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
export const MAX_WAIT_TIMEOUT_MS = 120_000;
/** How many refused requests one session reports before it stops counting: a
 * broken page redirecting in a loop must not grow a buffer without bound. */
export const MAX_GUARD_EVENTS = 20;
/** How many credential-filled elements one session remembers for its screenshots:
 * every stage screenshot resolves all of them, so the ledger is a per-frame cost
 * a login flow could otherwise inflate without bound. */
export const MAX_CREDENTIAL_FILLS = 32;

/** One origin a stage-bound session's requests are authenticated for
 * (`add-stage-oauth2-auth`, task 3.3). The origin is matched exactly: a bearer
 * token belongs to the application it was issued for and to nothing else. */
export interface StageBearerScope {
	readonly origin: string;
	/** The application key, for the error a failed acquisition reports. */
	readonly app: string;
	readonly role: string;
}

/** The bounds and origin rules a stage-bound session carries
 * (`add-stage-testing-foundation`): the guard policy itself, so the pool, the
 * session and the login path all read one object. */
export type StageSessionBinding = StageSessionPolicy & {
	/** The origins this session's requests get the role's bearer token on. Empty
	 * or absent is the common case: a stage that declares none keeps the
	 * foundation's behaviour exactly. */
	readonly bearer?: readonly StageBearerScope[];
	/** The origins a request may be *issued from* and still receive a bearer
	 * token: the stage's own origins (`add-stage-oauth2-auth`, SEC-002). A
	 * foreign-origin subframe inside a stage session never gets one, however
	 * allow-listed its target is. */
	readonly initiators?: readonly string[];
	/** The stage's effective identity-cache bounds (`add-stage-identity-cache`):
	 * whether this session may capture and reuse one, how long the entry lives,
	 * how often a living session refreshes it. Absent means the stage declares
	 * no cache, which is the same as `enabled: false`. */
	readonly identity?: EffectiveIdentityCache;
	/** The origins a cached identity covers: the stage's applications and its
	 * login recipes, never a third-party host. */
	readonly identityOrigins?: readonly string[];
};

/** The identity one stage session's login established
 * (`add-stage-identity-cache`). It is bookkeeping only: the captured cookie and
 * storage values live in the cache, never here. */
export interface SessionIdentity {
	/** The role whose login this session performs, `stageRole` at open time or the
	 * role `stage_login` names. */
	role: string;
	/** The role a cached entry was *installed* for, when the context started with
	 * one. A context carries one user's cookies and storage, so a login of a
	 * different role into the same context is never captured: that would file one
	 * user's state under another's key (`design.md` D1). */
	installedRole?: string;
	/** Every role this context has logged in as, the one it opened with
	 * included. More than one means the context's jar belongs to two users, and
	 * no capture of it may fill either role's key (`SEC-001`). */
	loggedRoles?: readonly string[];
	/** A cached entry was installed into this session's context before its first
	 * navigation, so a silent check is worth performing. */
	cacheInstalled: boolean;
	/** Where the identity now in the browser came from, once a login succeeded:
	 * `cache` (the installed entry was silently accepted), `recipe` (this server
	 * performed the login) or `user` (the developer did, through the hand-off).
	 * Absent until a login succeeds. */
	source?: "cache" | "recipe" | "user";
	/** When the cache last captured this identity, epoch milliseconds. */
	capturedAt?: number;
}

/** The selector that covers every password field of a stage screenshot. */
export const PASSWORD_MASK: DriverLocator = {
	selector: 'input[type="password"]',
};

export interface ConsoleEntry {
	readonly level: string;
	readonly text: string;
	readonly at: string;
}

/** One network entry. `status`/`ok`/`error` are filled in place when the
 * request answers, so the ring never has to be rebuilt on the hot path. */
export interface NetworkEntry {
	readonly id: string;
	readonly method: string;
	readonly url: string;
	readonly resourceType: string;
	/** Whether the request carried an `Authorization` header. The *value* is not
	 * part of any entry: the renderers show `authorization: «redacted»` from this
	 * boolean, which is how `browser_network` reports a credential without ever
	 * holding one (`add-stage-oauth2-auth`, task 2.3). */
	readonly hasAuthorization?: boolean;
	status: number | null;
	ok: boolean | null;
	error?: string;
	readonly at: string;
}

/** A fixed-capacity history: pushing past the capacity drops the oldest entry,
 * so no session's buffer can grow with the page's lifetime. */
export class RingBuffer<T> {
	private items: T[] = [];

	constructor(readonly capacity: number = RING_CAPACITY) {}

	/** Push one entry, answering the entry it evicted (or `undefined`), so the
	 * owner of an auxiliary index can drop the evicted key with it. */
	push(value: T): T | undefined {
		this.items.push(value);
		if (this.items.length <= this.capacity) return undefined;
		const [evicted] = this.items.splice(0, this.items.length - this.capacity);
		return evicted;
	}

	toArray(): T[] {
		return [...this.items];
	}

	/** Drop every entry. A promoted session's history belongs to the headless
	 * context it left behind, so a hand-off clears both buffers (task 3.4). */
	clear(): void {
		this.items = [];
	}

	get size(): number {
		return this.items.length;
	}
}

/** The two ways a tool names the element it acts on: a ref from the current
 * snapshot (preferred), or a Playwright selector. */
export interface ActionTarget {
	readonly ref?: string;
	readonly selector?: string;
}

/** The bounds one scoped snapshot read may pass. `within` is a ref from the
 * current state or a Playwright selector; `diff`/`since` are handled by the
 * route against the stored history, never by a page read. */
export interface SessionSnapshotOptions {
	readonly within?: string;
	readonly depth?: number;
	readonly maxChars?: number;
	readonly timeoutMs?: number;
}

/** One parsed state. Only `text` is canonical; `nodes`, `refs` and `chars` are
 * derived from the bounded text, so a ref cut by truncation is never
 * actionable. */
export interface SessionSnapshotState {
	readonly id: string;
	readonly text: string;
	readonly nodes: readonly SnapshotNode[];
	readonly refs: readonly string[];
	readonly url: string;
	readonly depth: number;
	readonly chars: number;
	readonly maxChars: number;
	readonly truncated: boolean;
	readonly at: number;
}

/** A diff against a state still in the bounded history. */
export interface SessionSnapshotDiff {
	readonly from: SessionSnapshotState;
	readonly to: SessionSnapshotState;
	readonly delta: SnapshotDelta;
}

/** One find answer: only the matching nodes, never the tree. */
export interface SessionSnapshotFind {
	readonly snapshotId: string;
	readonly matches: readonly SnapshotNode[];
	readonly total: number;
	readonly truncated: boolean;
}

/** One in-flight recording: the context created for it, the maximum length it
 * may last, and where its bytes go. */
export interface SessionRecording {
	readonly startedAt: number;
	readonly startedUrl: string;
	readonly maxMs: number;
	/** The directory this one recording owns. A discarded recording removes it,
	 * so a `keep: false` stop leaves no video file anywhere and cannot touch
	 * another recording's bytes. */
	readonly dir: string;
	/** Set when the maximum length already stopped it, so `record_stop` reports
	 * `keep: false` rather than attaching a truncated video as if it were asked
	 * for. */
	autoStopped: boolean;
	/** This recording's segment number, unique per owner (`add-stage-flow-evidence`).
	 * A journal step written while the segment records names it, so the kept video
	 * can be back-filled onto exactly those steps and the flow page can seek each
	 * one to its offset. */
	readonly segment: number;
}

/** A refusal the routes translate one-to-one into their error envelope. */
export class BrowserSessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		/** A value-free machine-readable sub-reason, when the code alone is not
		 * precise enough (`login-handoff-unavailable`: a fixed vocabulary member).
		 */
		readonly reason?: string,
		/** Extra value-free fields the error envelope carries (a hand-off's id and
		 * deadline). Never page content and never a credential. */
		readonly details?: Readonly<Record<string, unknown>>,
	) {
		super(message);
		this.name = "BrowserSessionError";
	}
}

/** The hold one login hand-off puts on a session: while a hand-off is queued or
 * active the session belongs to the developer, so the pool never sweeps it and
 * the routes never drive it. */
export interface SessionHold {
	readonly handoffId: string;
	readonly deadlineAt: number;
}

/** Which browser process serves a session: the shared headless one, or the
 * second, interactive one a hand-off promoted it into. */
export type SessionBrowserSlot = "headless" | "interactive";

export interface SessionOptions {
	readonly owner: string;
	readonly name: string;
	readonly context: DriverContext;
	readonly page: DriverPage;
	readonly viewport: { readonly width: number; readonly height: number };
	readonly baseUrl?: string;
	readonly app?: string;
	/** The stage this session is bound to for its whole life, if any. */
	readonly stage?: StageSessionBinding;
	/** The identity this session starts with, when a cached entry was installed
	 * into its context before the first navigation
	 * (`add-stage-identity-cache`). */
	readonly identity?: SessionIdentity;
	/** The shared, bounded refusal buffer of this session, filled by the stage
	 * guard and drained by the tool call that sees it. */
	readonly guardEvents?: GuardRefusalRecord[];
	readonly now?: () => number;
}

/** One recorded refusal with the sequence number it was recorded at, so a tool
 * call can tell what its own page work produced from what it is merely
 * relaying, and whether a result has already reported it. */
export interface GuardRefusalRecord {
	readonly seq: number;
	readonly refusal: StageRefusal;
	/** Set once a tool result has reported it; it is then reported by nothing
	 * else. */
	claimed: boolean;
}

export class BrowserSession {
	readonly owner: string;
	readonly name: string;
	readonly console: RingBuffer<ConsoleEntry>;
	readonly network: RingBuffer<NetworkEntry>;
	context: DriverContext;
	page: DriverPage;
	/** The URL the session was opened on, kept for the recording and for a
	 * useful answer when the live URL is empty. */
	baseUrl: string;
	app: string | undefined;
	/** The stage binding: immutable for the session's life, so a session can never
	 * be talked into another stage's allow-list. */
	readonly stage: StageSessionBinding | undefined;
	/** HTTP basic credentials installed on this session's context, kept so a
	 * recording's replacement context keeps them. */
	httpCredentials: DriverHttpCredentials | undefined;
	/** The identity this session's login established, and where it came from
	 * (`add-stage-identity-cache`). Holds a role and a source, never a value. */
	identity: SessionIdentity | undefined;
	/** The values a cached entry installed into this context, kept as the
	 * redactor's secrets for as long as the context lives: an entry can be
	 * forgotten (or expire, or be evicted) while the browser still holds its
	 * cookies and storage, and an echo of one of them must stay masked
	 * (`design.md` D6). Values, never a read surface of their own. */
	installedIdentitySecrets: Array<{
		readonly name: string;
		readonly value: string;
	}> = [];
	viewport: { width: number; height: number };
	/** Set when the browser process went away under this session. */
	crashed = false;
	/** Set when the *developer* closed this session's window: a hand-off ends
	 * `window-closed` rather than reading as a crash. */
	windowClosed = false;
	/** The browser slot this session lives in. A promoted session stays in the
	 * interactive browser for the rest of its life. */
	browserSlot: SessionBrowserSlot = "headless";
	/** The pending hand-off, while one holds this session. */
	hold: SessionHold | undefined;
	recording: SessionRecording | undefined;
	readonly createdAt: number;
	lastUsed: number;

	private readonly clock: () => number;
	private refs = new Set<string>();
	/** The newest parsed state, and the bounded states `diff` may target. The
	 * current state is also the newest history entry. */
	private currentSnapshot: SessionSnapshotState | undefined;
	private snapshotHistory: SessionSnapshotState[] = [];
	private snapshotSeq = 0;
	/** Set after a post-action observation failed: refs from before the action
	 * must not be used, and the next action needs a fresh snapshot. */
	private snapshotInvalidated = false;
	/** In-flight requests only. A response removes its key, so the index is
	 * bounded by the page's concurrency, never by its total request count. */
	private readonly inFlight = new Map<string, NetworkEntry>();
	private active = 0;
	/** Elements a credential was typed into, so a screenshot covers them. */
	private readonly credentialFills: DriverLocator[] = [];
	/** The keys of `credentialFills`, so a repeated fill is one set lookup rather
	 * than a scan of everything this session has ever filled. */
	private readonly credentialFillKeys = new Set<string>();
	/** The refusals the guard recorded, each with the sequence number it was
	 * recorded at and whether a tool result has reported it yet. Shared with the
	 * guard installed on the context (and on the recording context after a swap). */
	private readonly guardEvents: GuardRefusalRecord[];
	/** How many refusals this session has recorded. The fence a tool call reports
	 * from; monotonic and never reset. */
	private refusalSeq = 0;
	/** The fences of the tool calls currently holding this session, one entry per
	 * live `beginUse`, keyed by the sequence the call began at. A reported refusal
	 * is kept while any of them is still below it, so a call that was already in
	 * flight when it happened is not the call that loses it. */
	private readonly liveFences = new Map<number, number>();
	/** True while the pool deliberately replaces this session's context
	 * (recording), when a page close is expected rather than a crash. */
	private swapping = false;

	constructor(options: SessionOptions) {
		this.owner = options.owner;
		this.name = options.name;
		this.context = options.context;
		this.page = options.page;
		this.viewport = {
			width: options.viewport.width,
			height: options.viewport.height,
		};
		this.baseUrl = options.baseUrl ?? "";
		this.app = options.app;
		this.stage = options.stage;
		this.identity = options.identity;
		this.guardEvents = options.guardEvents ?? [];
		this.clock = options.now ?? (() => Date.now());
		this.createdAt = this.clock();
		this.lastUsed = this.createdAt;
		this.console = new RingBuffer<ConsoleEntry>();
		this.network = new RingBuffer<NetworkEntry>();
		this.wire(this.page);
	}

	/**
	 * Attach the session's history to a page. Recording replaces the underlying
	 * context, so the buffers are re-wired to the new page rather than a second
	 * session being created: the console history of one page of one run is still
	 * that run's history after a recording context swap.
	 */
	attachPage(page: DriverPage): void {
		this.page = page;
		this.swapping = false;
		this.crashed = false;
		this.windowClosed = false;
		// The new context has a new document and its own ref registry. A ref from
		// the page this session just left is exactly the stale handle to refuse.
		this.clearSnapshotStates();
		this.wire(page);
	}

	/** Announce that the next page close is a deliberate context replacement.
	 * Paired with `endContextSwap` on every path that does not complete one. */
	beginContextSwap(): void {
		this.swapping = true;
	}

	/** Unwind a swap that did not happen, so the page-close guard goes back to
	 * reporting a genuine crash. */
	endContextSwap(): void {
		this.swapping = false;
	}

	/** Mark the session unusable without pretending the process died: the caller
	 * keeps the entry, so the next call answers `browser-crashed`. */
	markCrashed(): void {
		this.crashed = true;
	}

	/** Whether a login hand-off holds this session. A held session is exempt from
	 * the idle sweep and is refused to every agent route. */
	get heldByUser(): boolean {
		return this.hold !== undefined;
	}

	/** Hold the session for a hand-off, and clear what the headless context left
	 * behind: the console and network buffers belong to the page the developer is
	 * about to replace, and a ref taken before the promotion names an element of
	 * that page. */
	holdForUser(hold: SessionHold): void {
		this.hold = hold;
		this.clearTrace();
	}

	/** Release the hold, so the agent may drive the session again. Only the
	 * hand-off that took the hold may release it: a second hand-off on the same
	 * session can have replaced it, and ending the older one must not hand the
	 * developer's session back mid-login (QUALITY-103). Answers whether the hold
	 * was this hand-off's. */
	releaseHold(handoffId: string): boolean {
		if (this.hold?.handoffId !== handoffId) return false;
		this.hold = undefined;
		return true;
	}

	/** Forget everything the hand-off's own traffic produced, and every ref. */
	clearTrace(): void {
		this.console.clear();
		this.network.clear();
		this.inFlight.clear();
		this.clearSnapshotStates();
	}

	/** Drop the current state and its history. The sequence stays monotonic, so
	 * an id returned before a context swap can never name a later state. */
	private clearSnapshotStates(): void {
		this.refs = new Set<string>();
		this.currentSnapshot = undefined;
		this.snapshotHistory = [];
		this.snapshotInvalidated = false;
	}

	/** The newest state, when one exists. */
	get snapshotState(): SessionSnapshotState | undefined {
		return this.currentSnapshot;
	}

	/** Whether an action has to take a snapshot before it can name a ref. */
	get snapshotRequired(): boolean {
		return this.snapshotInvalidated || this.currentSnapshot === undefined;
	}

	/** True when a post-action observation failed and the ref registry can no
	 * longer be trusted. */
	get snapshotInvalid(): boolean {
		return this.snapshotInvalidated;
	}

	/** The bounded history, oldest first, current last. */
	snapshotStates(): readonly SessionSnapshotState[] {
		return [...this.snapshotHistory];
	}

	/** A failed post-action read: the action itself may have succeeded, but its
	 * refs are no longer a contract. */
	invalidateSnapshot(): void {
		this.refs = new Set<string>();
		this.currentSnapshot = undefined;
		this.snapshotHistory = [];
		this.snapshotInvalidated = true;
	}

	/** How many requests are in flight on this session. */
	get busyCount(): number {
		return this.active;
	}

	/** The in-flight request index's size, so the bound it promises is readable
	 * (and assertable) rather than a claim about a private map. */
	get inFlightSize(): number {
		return this.inFlight.size;
	}

	/** Whether a request is currently working on this session. The idle sweep
	 * must not close a session under an operation that is still running. */
	get busy(): boolean {
		return this.active > 0;
	}

	/**
	 * Mark one request in flight on this session, and answer the refusal fence its
	 * report reads from: what the guard recorded before this call began is not
	 * this call's to *own* (it is still reported, as somebody else's).
	 */
	beginUse(): number {
		this.active += 1;
		const fence = this.refusalSeq;
		this.liveFences.set(fence, (this.liveFences.get(fence) ?? 0) + 1);
		this.touch();
		return fence;
	}

	/** The matching release; safe to call once per `beginUse`. The fence is given
	 * back with it, so a long-running call stops holding refusals open. */
	endUse(fence?: number): void {
		this.active = Math.max(0, this.active - 1);
		if (fence === undefined) return;
		const live = this.liveFences.get(fence);
		if (live === undefined) return;
		if (live > 1) this.liveFences.set(fence, live - 1);
		else this.liveFences.delete(fence);
	}

	/** Every operation on a session is a use of it: the idle TTL measures
	 * silence, not age. */
	touch(): void {
		this.lastUsed = this.clock();
	}

	/** The stable identity the pool addresses a session by. */
	get id(): string {
		return `${this.owner}\u0000${this.name}`;
	}

	/** Whether the session has been silent for longer than `idleTtlMs`. */
	idleFor(idleTtlMs: number): boolean {
		return this.clock() - this.lastUsed > idleTtlMs;
	}

	/** The live URL, falling back to the opened one while a page is new. */
	get url(): string {
		try {
			return this.page.url() || this.baseUrl;
		} catch {
			return this.baseUrl;
		}
	}

	/**
	 * Read one bounded snapshot and make its refs the current state. The ref set
	 * is replaced, never merged: a ref from an earlier state is exactly the stale
	 * handle the refusal below exists for.
	 */
	async snapshot(
		options: SessionSnapshotOptions = {},
	): Promise<SessionSnapshotState> {
		this.touch();
		const within =
			options.within === undefined
				? undefined
				: this.withinTarget(options.within);
		const maxChars = boundedSnapshotChars(options.maxChars);
		let result: DriverSnapshotResult;
		try {
			result = await this.page.snapshot({
				depth: boundedSnapshotDepth(options.depth),
				maxChars,
				...(options.timeoutMs === undefined
					? {}
					: { timeoutMs: options.timeoutMs }),
				...(within === undefined
					? {}
					: { within: this.driverTargetFor(within) }),
			});
		} catch (error) {
			throw this.targetError(error);
		}
		return this.recordSnapshot(result);
	}

	/** Keep one parsed state and make its refs current. */
	private recordSnapshot(result: DriverSnapshotResult): SessionSnapshotState {
		this.snapshotSeq += 1;
		const refs = snapshotRefs(result.snapshotText);
		const state: SessionSnapshotState = {
			id: `s${this.snapshotSeq}`,
			text: result.snapshotText,
			nodes: result.snapshotNodes,
			refs,
			url: this.url,
			depth: result.depth,
			chars: result.chars,
			maxChars: result.maxChars,
			truncated: result.truncated,
			at: this.clock(),
		};
		this.currentSnapshot = state;
		this.snapshotHistory.push(state);
		while (this.snapshotHistory.length > SNAPSHOT_HISTORY_CAPACITY)
			this.snapshotHistory.shift();
		this.refs = new Set(refs);
		this.snapshotInvalidated = false;
		return state;
	}

	/** Require a current state for a read that has nothing to do after a failed
	 * observation or before the first snapshot. */
	private requireSnapshot(): SessionSnapshotState {
		if (this.currentSnapshot === undefined || this.snapshotInvalidated)
			throw new BrowserSessionError(
				"snapshot-required",
				"no current snapshot state; take browser_snapshot before using refs or reading a delta",
				409,
			);
		return this.currentSnapshot;
	}

	/**
	 * Refuse a ref from an older state before touching the page. A supplied
	 * snapshot id is an explicit assertion by the caller; a ref is checked
	 * against the newest state either way.
	 */
	assertAction(snapshotId: string | undefined, target: ActionTarget): void {
		if (snapshotId !== undefined) {
			if (this.currentSnapshot?.id !== snapshotId)
				throw new BrowserSessionError(
					"stale-snapshot",
					`${snapshotId} is not the current snapshot${this.currentSnapshot ? ` (${this.currentSnapshot.id})` : ""}; take a new snapshot and use its refs`,
					409,
					undefined,
					this.currentSnapshot
						? { snapshotId: this.currentSnapshot.id }
						: undefined,
				);
		}
		this.validateTarget(target);
	}

	/** Resolve a tool's target, refusing a ref this session never produced. */
	validateTarget(target: ActionTarget): ActionTarget {
		const ref = target.ref?.trim();
		const selector = target.selector?.trim();
		if (ref) {
			if (!this.refs.has(ref)) {
				if (this.currentSnapshot === undefined || this.snapshotInvalidated)
					throw new BrowserSessionError(
						"snapshot-required",
						"no current snapshot state; take browser_snapshot before using a ref",
						409,
					);
				throw new BrowserSessionError(
					"unknown-ref",
					`${ref} is not a ref from the current snapshot; take a new snapshot and use a ref it names`,
					400,
				);
			}
			return { ref };
		}
		if (selector) return { selector };
		throw new BrowserSessionError(
			"target-required",
			"an action needs a ref (preferred) or a selector",
			400,
		);
	}

	/** A `within` value is a ref when it has the AI ref grammar, otherwise a
	 * Playwright selector. A ref must belong to the current state. */
	private withinTarget(value: string): ActionTarget {
		const trimmed = value.trim();
		if (trimmed === "")
			throw new BrowserSessionError(
				"target-required",
				"within needs a ref or a selector",
				400,
			);
		if (!isRef(trimmed)) return { selector: trimmed };
		this.requireSnapshot();
		if (!this.refs.has(trimmed))
			throw new BrowserSessionError(
				"unknown-ref",
				`${trimmed} is not a ref from the current snapshot; take a new snapshot and use a ref it names`,
				400,
			);
		return { ref: trimmed };
	}

	/** Translate a validated target into the driver contract. */
	private driverTargetFor(target: ActionTarget): DriverActionTarget {
		if (target.ref !== undefined) return { ref: target.ref };
		if (target.selector !== undefined) return { selector: target.selector };
		throw new BrowserSessionError(
			"target-required",
			"an action needs a ref (preferred) or a selector",
			400,
		);
	}

	/** The locator descriptor a credential fill and its mask use. */
	driverLocatorFor(target: ActionTarget): DriverLocator {
		const resolved = this.validateTarget(target);
		if (resolved.ref !== undefined) return { ref: resolved.ref };
		if (resolved.selector !== undefined) return { selector: resolved.selector };
		throw new BrowserSessionError(
			"target-required",
			"an action needs a ref (preferred) or a selector",
			400,
		);
	}

	/** Take a snapshot and return the bounded view the action observation needs. */
	async captureAfterAction(): Promise<SessionSnapshotState> {
		return await this.snapshot();
	}

	/** Diff the current state against the previous one, or an id still held in
	 * the bounded history. */
	diffSnapshot(since?: string): SessionSnapshotDiff {
		const to = this.requireSnapshot();
		const from =
			since !== undefined
				? this.snapshotHistory.find((state) => state.id === since)
				: this.snapshotHistory[this.snapshotHistory.length - 2];
		if (from === undefined)
			throw new BrowserSessionError(
				"snapshot-history-missing",
				since === undefined
					? "no previous snapshot is retained; take another browser_snapshot before asking for a delta"
					: `${since} is not retained in this session's snapshot history; take a new snapshot`,
				409,
				undefined,
				{ retained: this.snapshotHistory.map((state) => state.id) },
			);
		return { from, to, delta: diffSnapshotNodes(from.nodes, to.nodes) };
	}

	/** Search the current state without returning the tree. A ref `within`
	 * filters the stored nodes; a selector `within` takes a scoped read but does
	 * not replace the current id. */
	async findSnapshot(filter: {
		readonly query: string;
		readonly role?: string;
		readonly name?: string;
		readonly within?: string;
		readonly limit: number;
	}): Promise<SessionSnapshotFind> {
		const current = this.requireSnapshot();
		let nodes: readonly SnapshotNode[] = current.nodes;
		if (filter.within !== undefined) {
			const target = this.withinTarget(filter.within);
			if (target.ref !== undefined) {
				nodes = this.nodesWithin(current.nodes, target.ref);
			} else {
				const result = await this.page.snapshot({
					within: this.driverTargetFor(target),
				});
				nodes = result.snapshotNodes;
			}
		}
		const found = findSnapshotNodes(nodes, {
			query: filter.query,
			...(filter.role === undefined ? {} : { role: filter.role }),
			...(filter.name === undefined ? {} : { name: filter.name }),
			limit: filter.limit,
		});
		return {
			snapshotId: current.id,
			matches: found.matches,
			total: found.total,
			truncated: found.truncated,
		};
	}

	/** The stored subtree rooted at a ref, with depths rebased to zero. */
	private nodesWithin(
		nodes: readonly SnapshotNode[],
		ref: string,
	): readonly SnapshotNode[] {
		const index = nodes.findIndex((node) => node.ref === ref);
		if (index < 0)
			throw new BrowserSessionError(
				"unknown-ref",
				`${ref} is not a ref from the current snapshot; take a new snapshot and use a ref it names`,
				400,
			);
		const rootDepth = nodes[index]?.depth ?? 0;
		const subtree: SnapshotNode[] = [];
		for (let cursor = index; cursor < nodes.length; cursor += 1) {
			const node = nodes[cursor];
			if (node === undefined) break;
			if (cursor > index && node.depth <= rootDepth) break;
			subtree.push({ ...node, depth: Math.max(0, node.depth - rootDepth) });
		}
		return subtree;
	}

	/** Turn the driver's missing-ref error into the session's stale-ref refusal,
	 * with the current id so the caller knows which state is still current. */
	targetError(error: unknown): unknown {
		if (!(error instanceof DriverTargetError)) return error;
		if (error.code === "target-required")
			return new BrowserSessionError(
				"target-required",
				"an action needs a ref (preferred) or a selector",
				400,
			);
		return new BrowserSessionError(
			"stale-ref",
			error.message,
			409,
			undefined,
			this.currentSnapshot
				? { snapshotId: this.currentSnapshot.id }
				: undefined,
		);
	}

	private wire(page: DriverPage): void {
		page.onConsole((entry) => this.recordConsole(entry));
		page.onNetwork((event) => this.recordNetwork(event));
		page.onClosed((reason) => {
			// A close during a context swap is the pool replacing this session's
			// context on purpose, not the browser going away.
			if (this.swapping || reason === "server") return;
			// The developer closed the window. The context is gone either way, so the
			// session is unusable, but a hand-off has to read this as `window-closed`
			// rather than as a crash.
			this.windowClosed = true;
			this.crashed = true;
		});
	}

	private recordConsole(entry: DriverConsoleEntry): void {
		// Nothing an agent can read is buffered while a hand-off holds the session:
		// the login page's console and network traffic are the developer's, and
		// `browser_console`/`browser_network` must not surface them afterwards.
		if (this.hold) return;
		this.console.push({
			level: entry.type === "warning" ? "warn" : entry.type,
			text: entry.text,
			at: new Date(this.clock()).toISOString(),
		});
	}

	private recordNetwork(event: DriverNetworkEvent): void {
		if (this.hold) return;
		if (event.kind === "request") {
			const entry: NetworkEntry = {
				id: event.id,
				method: event.method,
				url: event.url,
				resourceType: event.resourceType,
				...(event.hasAuthorization === undefined
					? {}
					: { hasAuthorization: event.hasAuthorization }),
				status: null,
				ok: null,
				at: new Date(this.clock()).toISOString(),
			};
			this.inFlight.set(event.id, entry);
			const evicted = this.network.push(entry);
			if (evicted) this.inFlight.delete(evicted.id);
			// A page with more requests in flight than the whole ring holds cannot
			// grow the index past it: the oldest in-flight entry leaves with the
			// oldest ring entry.
			while (this.inFlight.size > this.network.capacity) {
				const oldest = this.inFlight.keys().next().value;
				if (oldest === undefined) break;
				this.inFlight.delete(oldest);
			}
			return;
		}
		const entry = this.inFlight.get(event.id);
		// An answer for a request the ring already evicted is no longer readable,
		// and the caller can never see it: nothing to update.
		if (!entry) return;
		if (event.kind === "response") {
			entry.status = event.status;
			entry.ok = event.ok;
		} else {
			entry.ok = false;
			entry.error = event.error;
		}
		this.inFlight.delete(event.id);
	}

	/** Console entries matching the tool's filters, newest `limit` of them. */
	consoleEntries(filter: {
		readonly level?: string;
		readonly limit: number;
	}): ConsoleEntry[] {
		const level = filter.level?.trim().toLowerCase();
		const entries = this.console
			.toArray()
			.filter((entry) => !level || entry.level.toLowerCase() === level);
		return entries.slice(Math.max(0, entries.length - filter.limit));
	}

	/** Network entries matching the tool's filters, newest `limit` of them. */
	networkEntries(filter: {
		readonly status?: number;
		readonly url?: string;
		readonly limit: number;
	}): NetworkEntry[] {
		const needle = filter.url?.trim();
		const entries = this.network
			.toArray()
			.filter(
				(entry) =>
					(filter.status === undefined || entry.status === filter.status) &&
					(!needle || entry.url.includes(needle)),
			);
		return entries.slice(Math.max(0, entries.length - filter.limit));
	}

	/**
	 * The refusals a tool call has to report, split by who owns them.
	 *
	 * * `mine` — recorded after this call began, so its own page work produced them.
	 * * `unclaimed` — recorded before it began and not reported by anything yet. The
	 *   spec is explicit that the *next* tool result on a session reports what the
	 *   guard refused, including page work that happened between two calls (an
	 *   abandoned script's own request, a late redirect), and this is that rule.
	 *
	 * Reporting is a *claim*, never a clear: one session carries several calls at
	 * once (a script abandoned by its own timeout keeps driving the page while the
	 * next call runs), and a call that emptied the buffer would delete the refusals
	 * of every call still in flight. An entry is dropped once it has been reported
	 * and no caller with an older fence can still be looking for it.
	 */
	claimRefusals(since = 0): {
		readonly mine: StageRefusal[];
		readonly unclaimed: StageRefusal[];
	} {
		const mine: StageRefusal[] = [];
		const unclaimed: StageRefusal[] = [];
		for (const entry of this.guardEvents) {
			if (entry.claimed) continue;
			if (entry.seq > since) mine.push(entry.refusal);
			else unclaimed.push(entry.refusal);
			entry.claimed = true;
		}
		if (this.guardEvents.some((entry) => entry.claimed)) this.pruneClaimed();
		return { mine, unclaimed };
	}

	/** Record one refusal, bounded. Called by the guard this session installed. */
	recordRefusal(refusal: StageRefusal): void {
		this.refusalSeq += 1;
		// Bounded, and the *oldest* goes: the refusals a call can still act on are
		// the ones the page just produced.
		if (this.guardEvents.length >= MAX_GUARD_EVENTS) this.guardEvents.shift();
		this.guardEvents.push({
			seq: this.refusalSeq,
			refusal,
			claimed: false,
		});
	}

	/** Drop the reported refusals no live call can still be looking for: one below
	 * the lowest live fence belongs to a call that has already read it or begun
	 * after it happened. */
	private pruneClaimed(): void {
		const floor = this.lowestLiveFence();
		for (let index = this.guardEvents.length - 1; index >= 0; index -= 1) {
			const entry = this.guardEvents[index] as GuardRefusalRecord;
			if (!entry.claimed) continue;
			if (floor !== undefined && entry.seq > floor) continue;
			this.guardEvents.splice(index, 1);
		}
	}

	/** The fence the oldest live call began at, or `undefined` when none is live. */
	private lowestLiveFence(): number | undefined {
		let lowest: number | undefined;
		for (const fence of this.liveFences.keys())
			if (lowest === undefined || fence < lowest) lowest = fence;
		return lowest;
	}

	/** Refuse using a stage session for another stage. */
	assertStage(ident: string): void {
		if (!this.stage)
			throw new BrowserSessionError(
				"stage-session-required",
				`this session is not stage-bound, so it cannot be used for stage ${ident}`,
				409,
			);
		if (this.stage.ident !== ident)
			throw new BrowserSessionError(
				"stage-mismatch",
				`this session is bound to stage ${this.stage.ident}; a session cannot be re-bound to ${ident}`,
				409,
			);
	}

	/**
	 * Fill one element with a resolved credential.
	 *
	 * The value is passed straight to the driver and never stored, echoed or
	 * logged; what *is* remembered is the locator, so every element a credential
	 * was typed into can be covered in the next screenshot.
	 */
	async fillCredential(
		locator: DriverLocator,
		value: string,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	): Promise<void> {
		this.touch();
		try {
			await this.page.fillField(locator, value, timeoutMs);
		} catch (error) {
			// The driver's `fill` writes the value it was handed into its own call
			// log, and every error Playwright throws carries that log back inside its
			// message. So the error is *replaced*, never re-thrown: no credential can
			// travel in a message to the model, a log line or a transcript, whatever
			// shape a driver's failure message has.
			throw new BrowserSessionError(
				"credential-fill-failed",
				`the element ${driverLocatorKey(locator)} could not be filled with a credential (${error instanceof Error ? error.name : "Error"}); nothing of the value is reported`,
				502,
			);
		}
		const key = driverLocatorKey(locator);
		if (this.credentialFillKeys.has(key)) return;
		// Bounded: `maskLocators` resolves every entry on *every* stage screenshot,
		// so an unbounded ledger is a per-frame cost a login flow could inflate with
		// a loop of distinct selectors. The oldest key is dropped instead of the
		// newest refused, and `PASSWORD_MASK` still covers policy-named password
		// fields whether or not their own element is still remembered.
		if (this.credentialFills.length >= MAX_CREDENTIAL_FILLS) {
			const dropped = this.credentialFills.shift();
			if (dropped) this.credentialFillKeys.delete(driverLocatorKey(dropped));
		}
		this.credentialFillKeys.add(key);
		this.credentialFills.push(locator);
	}

	/** The elements a stage screenshot has to cover: every password field, plus
	 * every element this session typed a credential into. */
	maskLocators(): DriverLocator[] {
		if (!this.stage) return [];
		return [PASSWORD_MASK, ...this.credentialFills];
	}

	/** Wait for one control named by a locator descriptor; throws on timeout,
	 * which is how a login step learns its control is absent. */
	async waitForControl(
		locator: DriverLocator,
		timeoutMs: number,
	): Promise<void> {
		this.touch();
		await this.page.waitForControl(locator, timeoutMs);
	}

	/** Click one control named by a locator descriptor. */
	async clickControl(
		locator: DriverLocator,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	): Promise<void> {
		this.touch();
		await this.page.clickControl(locator, timeoutMs);
	}

	/** How many elements one locator matches (the MFA-prompt probe). */
	async locatorCount(locator: DriverLocator): Promise<number> {
		this.touch();
		return await this.page.locatorCount(locator);
	}

	async goto(url: string, timeoutMs: number): Promise<number | null> {
		this.touch();
		const status = await this.page.goto(url, timeoutMs);
		this.baseUrl = this.url;
		return status;
	}

	async title(): Promise<string> {
		this.touch();
		return await this.page.title();
	}

	/** Resolve once and translate a vanished ref into the session's refusal. */
	private async actOn<T>(
		target: ActionTarget,
		operation: (target: DriverActionTarget) => Promise<T>,
	): Promise<T> {
		const resolved = this.validateTarget(target);
		const driverTarget = this.driverTargetFor(resolved);
		try {
			return await operation(driverTarget);
		} catch (error) {
			throw this.targetError(error);
		}
	}

	async click(target: ActionTarget, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
		this.touch();
		await this.actOn(target, (resolved) =>
			this.page.click(resolved, timeoutMs),
		);
	}

	async fill(
		target: ActionTarget,
		value: string,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.actOn(target, (resolved) =>
			this.page.fill(resolved, value, timeoutMs),
		);
	}

	async press(
		key: string,
		target: ActionTarget,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.actOn(target, (resolved) =>
			this.page.press(resolved, key, timeoutMs),
		);
	}

	async select(
		target: ActionTarget,
		values: readonly string[],
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.actOn(target, (resolved) =>
			this.page.selectOption(resolved, values, timeoutMs),
		);
	}

	async hover(target: ActionTarget, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
		this.touch();
		await this.actOn(target, (resolved) =>
			this.page.hover(resolved, timeoutMs),
		);
	}

	async wait(input: {
		readonly target?: ActionTarget;
		readonly text?: string;
		readonly url?: string;
		readonly timeoutMs: number;
	}): Promise<void> {
		this.touch();
		if (input.target) {
			await this.actOn(input.target, (resolved) =>
				this.page.waitForTarget(resolved, input.timeoutMs),
			);
			return;
		}
		if (input.text !== undefined) {
			await this.page.waitForText(input.text, input.timeoutMs);
			return;
		}
		if (input.url !== undefined) {
			await this.page.waitForUrl(input.url, input.timeoutMs);
			return;
		}
		// No condition named: settle the page and answer, rather than hanging on a
		// condition the caller never asked for.
		await this.page.waitForSelector("body", Math.min(2_000, input.timeoutMs));
	}

	async evaluate(expression: string): Promise<unknown> {
		this.touch();
		return await this.page.evaluate(expression);
	}

	async textContent(target: ActionTarget, timeoutMs: number): Promise<string> {
		this.touch();
		return await this.actOn(target, (resolved) =>
			this.page.textContent(resolved, timeoutMs),
		);
	}

	/**
	 * One screenshot, bounded to the width the model can read.
	 *
	 * The design bounds the image at 1280 px wide. Rather than resampling (the
	 * server has no image library and must not gain one for this), the capture
	 * viewport is narrowed for the shot and restored afterwards, so the returned
	 * image is never wider than the bound while the page keeps the viewport the
	 * session was opened with.
	 */
	async screenshot(
		options: DriverScreenshotOptions & { readonly ref?: string },
		maxWidth: number,
	): Promise<Uint8Array> {
		this.touch();
		const requested: ActionTarget | undefined =
			options.ref !== undefined
				? { ref: options.ref }
				: options.selector !== undefined
					? { selector: options.selector }
					: undefined;
		const target =
			requested === undefined
				? undefined
				: this.driverTargetFor(this.validateTarget(requested));
		const narrowed = target === undefined && this.viewport.width > maxWidth;
		const previous = this.viewport;
		if (narrowed)
			await this.page.setViewportSize({
				width: maxWidth,
				height: previous.height,
			});
		try {
			return await this.page.screenshot({
				type: options.type,
				...(options.quality === undefined ? {} : { quality: options.quality }),
				fullPage: options.fullPage,
				...(target?.ref === undefined ? {} : { ref: target.ref }),
				...(target?.selector === undefined
					? {}
					: { selector: target.selector }),
				// A stage screenshot covers every password field and every element a
				// credential was typed into; another session has nothing to mask.
				...(this.stage ? { mask: this.maskLocators() } : {}),
			});
		} catch (error) {
			throw this.targetError(error);
		} finally {
			if (narrowed) await this.page.setViewportSize(previous);
		}
	}

	attachRecording(recording: SessionRecording): void {
		this.recording = recording;
	}

	detachRecording(): SessionRecording | undefined {
		const recording = this.recording;
		this.recording = undefined;
		return recording;
	}
}
