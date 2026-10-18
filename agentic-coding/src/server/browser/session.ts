// One browser session (`add-agent-browser-sessions`).
//
// A session is one isolated browser context of the shared browser process, owned
// by the durable run that opened it. It carries the four things a run needs
// between tool calls:
//
// * **The page and its refs.** `snapshot()` re-walks the page and re-injects
//   `data-ac-ref` attributes; the refs the text names are the only refs the
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

import type { StageRefusal, StageSessionPolicy } from "../stages/guard.ts";
import { refSelector, snapshotRefs } from "./snapshot.ts";
import type {
	DriverConsoleEntry,
	DriverContext,
	DriverHttpCredentials,
	DriverLocator,
	DriverNetworkEvent,
	DriverPage,
	DriverScreenshotOptions,
} from "./types.ts";
import { driverLocatorKey } from "./types.ts";

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

/** The bounds and origin rules a stage-bound session carries
 * (`add-stage-testing-foundation`): the guard policy itself, so the pool, the
 * session and the login path all read one object. */
export type StageSessionBinding = StageSessionPolicy;

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
}

/** A refusal the routes translate one-to-one into their error envelope. */
export class BrowserSessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "BrowserSessionError";
	}
}

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
	viewport: { width: number; height: number };
	/** Set when the browser process went away under this session. */
	crashed = false;
	recording: SessionRecording | undefined;
	readonly createdAt: number;
	lastUsed: number;

	private readonly clock: () => number;
	private refs = new Set<string>();
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
	 * Re-walk the page and re-inject the refs. The ref set is replaced, never
	 * merged: a ref from an earlier snapshot is exactly the stale handle the
	 * refusal below exists for.
	 */
	async snapshot(): Promise<{ text: string; refs: string[] }> {
		const text = await this.page.snapshot();
		const refs = snapshotRefs(text);
		this.refs = new Set(refs);
		return { text, refs };
	}

	/** Resolve a tool's target to the selector the driver acts on, refusing a ref
	 * this session never produced. */
	selectorFor(target: ActionTarget): string {
		const ref = target.ref?.trim();
		const selector = target.selector?.trim();
		if (ref) {
			if (!this.refs.has(ref))
				throw new BrowserSessionError(
					"unknown-ref",
					`${ref} is not a ref from the current snapshot; take a new snapshot and use a ref it names`,
					400,
				);
			return refSelector(ref);
		}
		if (selector) return selector;
		throw new BrowserSessionError(
			"target-required",
			"an action needs a ref (preferred) or a selector",
			400,
		);
	}

	private wire(page: DriverPage): void {
		page.onConsole((entry) => this.recordConsole(entry));
		page.onNetwork((event) => this.recordNetwork(event));
		page.onClosed(() => {
			// A close during a recording swap is the pool replacing this session's
			// context on purpose, not the browser going away.
			if (!this.swapping) this.crashed = true;
		});
	}

	private recordConsole(entry: DriverConsoleEntry): void {
		this.console.push({
			level: entry.type === "warning" ? "warn" : entry.type,
			text: entry.text,
			at: new Date(this.clock()).toISOString(),
		});
	}

	private recordNetwork(event: DriverNetworkEvent): void {
		if (event.kind === "request") {
			const entry: NetworkEntry = {
				id: event.id,
				method: event.method,
				url: event.url,
				resourceType: event.resourceType,
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

	async click(target: ActionTarget, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
		this.touch();
		await this.page.click(this.selectorFor(target), timeoutMs);
	}

	async fill(
		target: ActionTarget,
		value: string,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.page.fill(this.selectorFor(target), value, timeoutMs);
	}

	async press(
		key: string,
		target: ActionTarget,
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.page.press(this.selectorFor(target), key, timeoutMs);
	}

	async select(
		target: ActionTarget,
		values: readonly string[],
		timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	) {
		this.touch();
		await this.page.selectOption(this.selectorFor(target), values, timeoutMs);
	}

	async hover(target: ActionTarget, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
		this.touch();
		await this.page.hover(this.selectorFor(target), timeoutMs);
	}

	async wait(input: {
		readonly target?: ActionTarget;
		readonly text?: string;
		readonly url?: string;
		readonly timeoutMs: number;
	}): Promise<void> {
		this.touch();
		if (input.target) {
			await this.page.waitForSelector(
				this.selectorFor(input.target),
				input.timeoutMs,
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
		return await this.page.textContent(this.selectorFor(target), timeoutMs);
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
		const selector =
			options.ref !== undefined
				? this.selectorFor({ ref: options.ref })
				: options.selector;
		const narrowed = selector === undefined && this.viewport.width > maxWidth;
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
				...(selector === undefined ? {} : { selector }),
				// A stage screenshot covers every password field and every element a
				// credential was typed into; another session has nothing to mask.
				...(this.stage ? { mask: this.maskLocators() } : {}),
			});
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
