// The stage identity cache (`add-stage-identity-cache`, task 1.1).
//
// A stage test logs in per role, and the login it establishes leaves browser
// state behind: the identity provider's sign-on cookie, and the application's own
// token — an `HttpOnly` cookie, `localStorage` (MSAL keeps its token cache there)
// or `sessionStorage`. A fresh browser context starts empty, so without a cache
// every workflow would ask the developer to sign in again.
//
// This module is that cache, and it is deliberately *only* a store:
//
// * **In memory, in this process.** A `Map` in the server, never a file, never
//   the workflow store, never a snapshot, never telemetry. A restart empties it,
//   which is the point: a live token on disk is exactly what the foundation
//   refused.
// * **Bounded.** Every entry has an absolute lifetime from its capture (the
//   policy's TTL), expired cookies are dropped on the way in, and the whole store
//   is capped, evicting the oldest entry.
// * **Value-free on every read surface.** `list()`, `toJSON()` and `toString()`
//   report `(stage, role, capturedAt, expiresAt)` and nothing else: no cookie
//   name, no storage key, no value.
// * **A secret set.** `secrets()` is what the browser and stage replies scrub
//   with, so an accidental echo of a cached value in a page title, a console line
//   or a network URL is masked instead of reaching a model, a log or evidence.
//
// Capture and install are here too, because they are pure functions of a
// `storageState()`-shaped snapshot and a value-free origin list: the pool reads
// them, and a unit test exercises them without a browser.
import { MIN_SECRET_CHARS } from "../redaction.ts";

/** One key of the cache: a stage and one role of it. Roles of one stage are
 * different users, so they never share an entry; stages are different trust
 * boundaries, so they never do either (`design.md` D1). */
export interface StageIdentityKey {
	readonly stage: string;
	readonly role: string;
}

/** One value the redactor masks, with a name that only says where it came from. */
export interface IdentitySecret {
	readonly name: string;
	readonly value: string;
}

/** The most values one live context may register, and the most bytes they may
 * hold. The set grows with the run: every capture re-registers the whole current
 * state, and a rotating token is a *distinct* value on each capture, so the union
 * would otherwise be bounded by the length of the run rather than by anything the
 * cache bounds (`PERF`). The newest values are the ones a context is most likely
 * to still echo, so a set at its bound drops its oldest entries. */
export const MAX_LIVE_IDENTITY_SECRETS = 512;
export const MAX_LIVE_IDENTITY_SECRET_BYTES = 1_048_576;

/** The union of the values a context has carried, bounded. Deduped by name and
 * value, newest kept: `added` is the state of the moment and `existing` what an
 * earlier install or capture recorded (`design.md` D6). */
export function mergeIdentitySecrets(
	existing: readonly IdentitySecret[],
	added: readonly IdentitySecret[],
): IdentitySecret[] {
	const seen = new Set<string>();
	const merged: IdentitySecret[] = [];
	for (const secret of [...existing, ...added]) {
		const key = `${secret.name}\u0000${secret.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(secret);
	}
	// Newest first while trimming, then longest first for the scrubber: a segment
	// of a token is replaced before the token itself ever is.
	const kept: IdentitySecret[] = [];
	let bytes = 0;
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		const secret = merged[index];
		if (secret === undefined) continue;
		if (kept.length >= MAX_LIVE_IDENTITY_SECRETS) break;
		// The newest value is always kept, whatever its size: dropping it would
		// leave the one thing a page is most likely to echo unmasked.
		if (
			kept.length > 0 &&
			bytes + secret.value.length > MAX_LIVE_IDENTITY_SECRET_BYTES
		)
			break;
		kept.push(secret);
		bytes += secret.value.length;
	}
	return kept.sort((left, right) => right.value.length - left.value.length);
}

/** One captured cookie, in the shape `context.storageState()` reports it and
 * `context.addCookies()` takes it back. `expires` is epoch *seconds*, `-1` for a
 * cookie with no expiry of its own (it lives until the entry's TTL). */
export interface CapturedCookie {
	readonly name: string;
	readonly value: string;
	readonly domain: string;
	readonly path: string;
	readonly expires: number;
	readonly httpOnly: boolean;
	readonly secure: boolean;
	readonly sameSite?: "Strict" | "Lax" | "None";
}

/** One `localStorage`/`sessionStorage` key. */
export interface CapturedStorageEntry {
	readonly name: string;
	readonly value: string;
}

/** The storage of one origin of the stage. */
export interface CapturedOriginStorage {
	readonly origin: string;
	readonly localStorage: readonly CapturedStorageEntry[];
	readonly sessionStorage: readonly CapturedStorageEntry[];
}

/** The browser session state of one `(stage, role)`. */
export interface StageIdentityState {
	readonly cookies: readonly CapturedCookie[];
	readonly origins: readonly CapturedOriginStorage[];
}

/** One cache entry, with the bounds the store enforces on it. */
export interface StageIdentityEntry extends StageIdentityKey {
	readonly state: StageIdentityState;
	/** When the last successful login captured it, epoch milliseconds. */
	readonly capturedAt: number;
	/** The absolute end of its life, epoch milliseconds. A *new capture* restarts
	 * it; reading never does (`design.md` D4). */
	readonly expiresAt: number;
	/** How many captured values the entry's bounds dropped. A count, never a
	 * value: the listing reports it as `truncated`, so an operator can see that a
	 * key was stored cut short without learning what was cut. */
	readonly truncated: number;
}

/** What the cache reports about one entry, and everything it ever reports: no
 * cookie name, no storage key, no value, no token. `truncated` is a count of
 * what the capture bounds dropped, so an operator can tell a key that was stored
 * whole from one that was cut short — and it names nothing. */
export interface StageIdentitySummary extends StageIdentityKey {
	readonly capturedAt: number;
	readonly expiresAt: number;
	readonly truncated: number;
}

/** The identity cache's documented defaults (`add-stage-identity-cache`, D4):
 * four hours, eight `(stage, role)` entries, and a re-capture every two minutes
 * of a session that stays alive. */
export const DEFAULT_IDENTITY_CACHE = {
	ttlMinutes: 240,
	maxEntries: 8,
	refreshSeconds: 120,
} as const;

/** The hard ceilings of the identity cache, whatever the policy says. A day is as
 * long as a sign-on may outlive the login that produced it, fifty entries is what
 * one process may hold in memory, and an hour is the longest gap between the
 * re-captures that keep a long run's rotated token current. */
export const MAX_IDENTITY_CACHE_TTL_MINUTES = 1_440;
export const MAX_IDENTITY_CACHE_ENTRIES = 50;
export const MAX_IDENTITY_CACHE_REFRESH_SECONDS = 3_600;
/** The shortest re-capture interval the process honours. The refresh is bound to
 * use, so the interval is what keeps a chatty session off a per-call capture: at
 * one second it would re-serialise the whole context on nearly every browser
 * call, which is the cost this bound exists to avoid (PERF). */
export const MIN_IDENTITY_CACHE_REFRESH_SECONDS = 30;

/** The lifetime a cache entry gets when neither the stage nor the policy says
 * otherwise: the documented default, in milliseconds. */
export const DEFAULT_IDENTITY_TTL_MS =
	DEFAULT_IDENTITY_CACHE.ttlMinutes * 60_000;
/** How many `(stage, role)` entries one process keeps by default. */
export const DEFAULT_IDENTITY_MAX_ENTRIES = DEFAULT_IDENTITY_CACHE.maxEntries;
/** The most values one entry keeps: cookies plus stored keys. A page controls
 * how many keys it writes, so the store bounds them instead of letting the page
 * decide what the process holds (`design.md` D4). */
export const MAX_IDENTITY_VALUES_PER_ENTRY = 256;

/** The longest value one entry keeps. No credential this store exists for — a
 * cookie, a JWT, an MSAL cache entry — comes close, and a page may otherwise
 * put megabytes of base64 into the server's heap. */
export const MAX_IDENTITY_VALUE_LENGTH = 32 * 1024;

/** The shortest value one entry keeps. Below this a value is ordinary page text
 * (`true`, `1`, a language tag) rather than a credential — and the scrubber only
 * masks a value it can find on its own, which it does from `MIN_SECRET_CHARS`
 * upward. Paying for storage the redactor cannot act on would make "every cached
 * value is a secret" a claim about a set that is never actually scrubbed, so the
 * capture floor *is* the scrubber's floor: one shared constant, not two numbers
 * that happen to agree (`src/server/redaction.ts`). */
export const MIN_IDENTITY_VALUE_LENGTH = MIN_SECRET_CHARS;

/** How many bytes of values one entry may hold. `maxEntries` entries of a
 * capture could otherwise retain whatever a page wrote, multiplied by the
 * stage's origins. */
export const MAX_IDENTITY_ENTRY_BYTES = 512 * 1024;

export interface StageIdentityCacheOptions {
	readonly now?: () => number;
	/** The ceiling every entry's TTL is clamped to (the policy's
	 * `identityCache.ttlMinutes`). */
	readonly ttlMs?: number;
	/** The entry cap (the policy's `identityCache.maxEntries`). */
	readonly maxEntries?: number;
}

/**
 * The cache itself. One instance per process (`stageIdentityCache()` below), and
 * a caller may pass its own — a test, and the browser pool's own seam.
 */
export class StageIdentityCache {
	private readonly entries = new Map<string, StageIdentityEntry>();
	private readonly clock: () => number;
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	/** One counter per key, moved on by every `remove()` (a forget, an eviction,
	 * a replacement after expiry, a `clear()`). A capture reads it before it starts
	 * and passes it back into `put()`: a forget that lands while a capture is
	 * reading is not undone by the write that was already in flight, because the
	 * generation moved (D5). A counter per key is all that is needed — a stale one
	 * is worthless, because a key that leaves and comes back starts a new epoch. */
	private readonly generations = new Map<string, number>();
	/** The redaction set, built from the entries (`secrets()`): MSAL stores its whole
	 * token cache in one `localStorage` value, so this is called on every tool result
	 * and must not re-walk the store each time. Emptyed by every write. */
	private secretCache: Array<{ name: string; value: string }> = [];

	constructor(options: StageIdentityCacheOptions = {}) {
		this.clock = options.now ?? (() => Date.now());
		this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_IDENTITY_TTL_MS);
		this.maxEntries = Math.max(
			1,
			options.maxEntries ?? DEFAULT_IDENTITY_MAX_ENTRIES,
		);
	}

	/** How many entries the store holds (a bounded count, never a name). */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Store one capture, replacing whatever the key held. The capture is the
	 * newest truth about that identity: a rotated refresh token or a renewed JWT
	 * supersedes the older copy, which is why this is a replacement and not a
	 * merge.
	 *
	 * Every capture is bounded *here*, not by its caller: expired cookies are
	 * dropped, a value shorter than `MIN_IDENTITY_VALUE_LENGTH` or longer than
	 * `MAX_IDENTITY_VALUE_LENGTH` is not kept, and an entry stops at
	 * `MAX_IDENTITY_VALUES_PER_ENTRY` values or `MAX_IDENTITY_ENTRY_BYTES` bytes —
	 * a page does not decide what this process holds. What was dropped is reported
	 * as a count and nothing else.
	 *
	 * A caller that observed a `generation` passes it back and the write is dropped
	 * when the key was forgotten or evicted in between: answers `undefined` then,
	 * so a forget is never undone by a capture that was already reading.
	 *
	 * The entry's lifetime is the smaller of `ttlMs` and the store's own ceiling,
	 * and it is *absolute* from now.
	 */
	put(
		key: StageIdentityKey,
		state: StageIdentityState,
		options: {
			readonly ttlMs?: number;
			readonly maxEntries?: number;
			readonly generation?: number;
		} = {},
	): StageIdentitySummary | undefined {
		const id = identityKey(key);
		if (
			options.generation !== undefined &&
			options.generation !== this.generation(key)
		)
			return undefined;
		const now = this.clock();
		const ttlMs = Math.min(
			this.ttlMs,
			Math.max(1, options.ttlMs ?? this.ttlMs),
		);
		const bounded = boundIdentityState(state, now);
		const entry: StageIdentityEntry = {
			stage: key.stage,
			role: key.role,
			state: bounded.state,
			capturedAt: now,
			expiresAt: now + ttlMs,
			truncated: bounded.truncated,
		};
		// Re-inserting moves the key to the end, so the eviction order stays
		// "oldest capture leaves first".
		this.entries.delete(id);
		this.entries.set(id, entry);
		this.secretCache = [];
		this.evictBeyondCap(
			Math.min(options.maxEntries ?? this.maxEntries, this.maxEntries),
		);
		return summaryOf(entry);
	}

	/**
	 * The entry of one key, or `undefined` when there is none or its lifetime is
	 * over (an expired entry is dropped as it is read, so it can never be
	 * installed). The answer is a *copy*: two parallel runs never share the arrays
	 * they install, so neither can mutate the other's view (`design.md` D7).
	 */
	peek(key: StageIdentityKey): StageIdentityEntry | undefined {
		const id = identityKey(key);
		const entry = this.entries.get(id);
		if (entry === undefined) return undefined;
		if (this.clock() >= entry.expiresAt) {
			this.remove(id);
			return undefined;
		}
		return {
			stage: entry.stage,
			role: entry.role,
			state: {
				cookies: entry.state.cookies.map((cookie) => ({ ...cookie })),
				origins: entry.state.origins.map((origin) => ({
					origin: origin.origin,
					localStorage: origin.localStorage.map((item) => ({ ...item })),
					sessionStorage: origin.sessionStorage.map((item) => ({ ...item })),
				})),
			},
			capturedAt: entry.capturedAt,
			expiresAt: entry.expiresAt,
			truncated: entry.truncated,
		};
	}

	/**
	 * How many times a key has been forgotten or evicted. A capture reads it before
	 * it starts and hands it back to `put`, so a forget that lands while the
	 * capture is still reading a live context wins over it.
	 */
	generation(key: StageIdentityKey): number {
		return this.generations.get(identityKey(key)) ?? 0;
	}

	/**
	 * Move one key's generation on without touching what it holds, so a capture that
	 * already read the store is refused when it comes back.
	 *
	 * A forget does this for every entry it removes; this form covers the key that
	 * has no entry *yet* — a session's very first capture, in flight when the
	 * operator forgets — which the entries alone cannot name. Without it, forgetting
	 * a key that is being captured would be undone by that capture.
	 */
	invalidate(key: StageIdentityKey): void {
		const id = identityKey(key);
		this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
	}

	/** Whether one key holds a live entry. */
	holds(key: StageIdentityKey): boolean {
		return this.peek(key) !== undefined;
	}

	/**
	 * Forget what the filter names: one stage, one role of it, or everything.
	 * Answers how many entries left. This is the manual forget (dashboard, CLI)
	 * and the automatic eviction of an identity the application rejected — both
	 * ends with the next login running the normal path.
	 */
	forget(filter: Partial<StageIdentityKey> = {}): number {
		let removed = 0;
		for (const [id, entry] of [...this.entries]) {
			if (filter.stage !== undefined && filter.stage !== entry.stage) continue;
			if (filter.role !== undefined && filter.role !== entry.role) continue;
			this.remove(id);
			removed += 1;
		}
		return removed;
	}

	/** Drop everything. A restart is simply a new process; this is the explicit
	 * form a test and a configuration-root switch use. */
	clear(): void {
		for (const id of [...this.entries.keys()]) this.remove(id);
		this.secretCache = [];
	}

	/** Every live entry as `(stage, role, capturedAt, expiresAt, truncated)` — the
	 * listing the dashboard, the CLI and the route report, and the only thing they
	 * may. */
	list(): StageIdentitySummary[] {
		return [...this.entries.values()]
			.filter((entry) => this.clock() < entry.expiresAt)
			.map((entry) => summaryOf(entry));
	}

	/**
	 * Every value the redactor has to scrub: each cookie value and each stored
	 * value, plus the base64url segments of anything JWT-shaped. Longest first, so
	 * a segment is replaced before a value that contains it.
	 *
	 * Every value an entry *keeps* is registered — no floor and no cap at this
	 * end, because a value this store decided to keep is a credential by
	 * construction (`design.md` D6). What bounds the set is the capture: at most
	 * `MAX_IDENTITY_VALUES_PER_ENTRY` values, each at least
	 * `MIN_IDENTITY_VALUE_LENGTH` characters. The list is memoised per store state,
	 * because every browser reply asks for it.
	 */
	secrets(): Array<{ readonly name: string; readonly value: string }> {
		if (this.secretCache.length === 0 && this.entries.size > 0)
			this.secretCache = identitySecrets({
				cookies: [...this.entries.values()].flatMap(
					(entry) => entry.state.cookies,
				),
				origins: [...this.entries.values()].flatMap(
					(entry) => entry.state.origins,
				),
			});
		return this.secretCache;
	}

	/** The value-free serialisation, so an accidental `JSON.stringify` of the
	 * store cannot carry a cookie or a token into a log, a report or a snapshot. */
	toJSON(): { readonly entries: readonly StageIdentitySummary[] } {
		return { entries: this.list() };
	}

	toString(): string {
		return `StageIdentityCache(${this.list().length} entries)`;
	}

	/** The one bound this store enforces, readable so a caller can clamp a
	 * policy value to what the process actually holds. */
	get capacity(): number {
		return this.maxEntries;
	}

	/** The absolute TTL ceiling this store applies to one capture. */
	get ttlCeilingMs(): number {
		return this.ttlMs;
	}

	/** Drop the oldest *captures* past the cap. The oldest capture leaves first,
	 * which is the entry whose lifetime is also closest to its end. An evicted key's
	 * generation moves on, so a capture already reading for it cannot put it
	 * back. */
	private evictBeyondCap(cap = this.maxEntries): void {
		while (this.entries.size > cap) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) return;
			this.remove(oldest.value);
		}
	}

	/** Remove one key, moving its generation on so a capture in flight cannot
	 * resurrect it, and dropping the memoised secret set with it. */
	private remove(id: string): void {
		this.entries.delete(id);
		this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
		this.secretCache = [];
	}
}

/** The map key of one entry. Exported so a test can assert the two-part key
 * without reaching into the store. */
export function identityKey(key: StageIdentityKey): string {
	return `${key.stage}\u0000${key.role}`;
}

function summaryOf(entry: StageIdentityEntry): StageIdentitySummary {
	return {
		stage: entry.stage,
		role: entry.role,
		capturedAt: entry.capturedAt,
		expiresAt: entry.expiresAt,
		truncated: entry.truncated,
	};
}

/** The cookies of one capture whose own expiry has not passed. A session cookie
 * (`expires: -1`, or an absent value) is kept: its life is the entry's TTL. */
export function liveCookies(
	cookies: readonly CapturedCookie[],
	now: number,
): CapturedCookie[] {
	return cookies
		.filter((cookie) => cookie.expires === -1 || cookie.expires * 1_000 > now)
		.map((cookie) => ({ ...cookie }));
}

/** Whether one captured value is worth keeping: long enough to be a credential
 * and short enough that a page cannot put a blob in the server's heap. */
function keepsValue(value: string): boolean {
	return (
		value.length >= MIN_IDENTITY_VALUE_LENGTH &&
		value.length <= MAX_IDENTITY_VALUE_LENGTH
	);
}

/**
 * One capture, bounded (`design.md` D4): expired cookies dropped, values below
 * `MIN_IDENTITY_VALUE_LENGTH` or above `MAX_IDENTITY_VALUE_LENGTH` dropped, and
 * the entry stopped at `MAX_IDENTITY_VALUES_PER_ENTRY` values or
 * `MAX_IDENTITY_ENTRY_BYTES` bytes. `truncated` counts what the bounds dropped,
 * which is the only thing a read surface may say about it.
 */
export function boundIdentityState(
	state: StageIdentityState,
	now: number,
): { readonly state: StageIdentityState; readonly truncated: number } {
	let truncated = 0;
	let values = 0;
	let bytes = 0;
	const room = (name: string, value: string): boolean => {
		if (!keepsValue(value)) {
			truncated += 1;
			return false;
		}
		if (values >= MAX_IDENTITY_VALUES_PER_ENTRY) {
			truncated += 1;
			return false;
		}
		const size = name.length + value.length;
		if (bytes + size > MAX_IDENTITY_ENTRY_BYTES) {
			truncated += 1;
			return false;
		}
		values += 1;
		bytes += size;
		return true;
	};
	const cookies = liveCookies(state.cookies, now).filter((cookie) =>
		room(cookie.name, cookie.value),
	);
	const origins = state.origins.map((origin) => ({
		origin: origin.origin,
		localStorage: origin.localStorage.filter((entry) =>
			room(entry.name, entry.value),
		),
		sessionStorage: origin.sessionStorage.filter((entry) =>
			room(entry.name, entry.value),
		),
	}));
	return { state: { cookies, origins }, truncated };
}

// ---------------------------------------------------------------------------
// Capture: a `storageState()`-shaped snapshot, filtered to the stage's origins
// ---------------------------------------------------------------------------

/** One storage map entry as `storageState()` reports it. */
interface RawStorageEntry {
	readonly name: string;
	readonly value: string;
}

/**
 * The cookies and `localStorage` of the origins the stage declares, from a
 * `storageState()`-shaped snapshot.
 *
 * Two filters, both of them deliberate:
 *
 * * a cookie belongs to the capture when its own domain is one of the stage's
 *   origins' hosts (or a parent domain of one) — a wildcard `Domain=.example.test`
 *   cookie the identity provider set is the whole point of the cache;
 * * a `localStorage` map belongs to the capture when its origin is exactly one of
 *   the declared origins.
 *
 * Anything else is dropped: a page may call a third-party host, and that host's
 * cookies are not this stage's identity (`design.md` D2, spec "Capture after a
 * successful login").
 *
 * `sessionStorage` is not part of `storageState()`: it is read from the live
 * document separately (`sessionStorageOf`), because only the page's own origin
 * can be read while its document exists.
 */
export function identityFromStorageState(
	snapshot: unknown,
	origins: readonly string[],
): StageIdentityState {
	const allowed = new Set(origins);
	const snapshotValue =
		snapshot !== null && typeof snapshot === "object"
			? (snapshot as Record<string, unknown>)
			: {};
	const cookies = Array.isArray(snapshotValue.cookies)
		? snapshotValue.cookies
				.map((cookie) => capturedCookie(cookie, origins))
				.filter((cookie): cookie is CapturedCookie => cookie !== undefined)
		: [];
	const stored = Array.isArray(snapshotValue.origins)
		? snapshotValue.origins
		: [];
	const byOrigin = new Map<string, CapturedStorageEntry[]>();
	for (const entry of stored) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const origin = typeof record.origin === "string" ? record.origin : "";
		if (!allowed.has(origin)) continue;
		byOrigin.set(origin, storageEntries(record.localStorage));
	}
	return {
		cookies,
		origins: [...allowed].map((origin) => ({
			origin,
			localStorage: byOrigin.get(origin) ?? [],
			sessionStorage: [],
		})),
	};
}

/** The union of a base state and the `sessionStorage` read from one document:
 * the document's origin gets what it reported, and every other origin keeps
 * whatever the base state already held.
 *
 * A capture only ever reads the `sessionStorage` of the document the session is
 * on, so the previous entry is what keeps the *other* origins' values: without it
 * a capture taken while the page sits on origin A would drop origin B's stored
 * token, and B's next session would have to sign in again. `current` is the
 * origin this capture read (`undefined` when the page was on no stage origin), so
 * only the origins that could not be read are carried forward. */
export function carrySessionStorage(
	state: StageIdentityState,
	previous: StageIdentityState | undefined,
	current: string | undefined,
): StageIdentityState {
	if (previous === undefined) return state;
	const earlier = new Map(
		previous.origins.map((origin) => [origin.origin, origin.sessionStorage]),
	);
	return {
		cookies: state.cookies,
		origins: state.origins.map((stored) => {
			if (stored.origin === current || stored.sessionStorage.length > 0)
				return stored;
			const kept = earlier.get(stored.origin);
			return kept === undefined || kept.length === 0
				? stored
				: { ...stored, sessionStorage: kept.map((item) => ({ ...item })) };
		}),
	};
}

export function withSessionStorage(
	state: StageIdentityState,
	origin: string,
	entries: readonly CapturedStorageEntry[],
): StageIdentityState {
	return {
		cookies: state.cookies,
		origins: state.origins.map((stored) =>
			stored.origin === origin
				? { ...stored, sessionStorage: [...entries] }
				: stored,
		),
	};
}

/** One raw cookie of a snapshot, when it belongs to one of the origins. */
function capturedCookie(
	value: unknown,
	origins: readonly string[],
): CapturedCookie | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : "";
	const domain = typeof record.domain === "string" ? record.domain : "";
	if (name === "" || domain === "") return undefined;
	if (!cookieBelongsTo(domain, origins)) return undefined;
	const sameSite = record.sameSite;
	return {
		name,
		value: typeof record.value === "string" ? record.value : "",
		domain,
		path:
			typeof record.path === "string" && record.path !== "" ? record.path : "/",
		expires: typeof record.expires === "number" ? record.expires : -1,
		httpOnly: record.httpOnly === true,
		secure: record.secure === true,
		...(sameSite === "Strict" || sameSite === "Lax" || sameSite === "None"
			? { sameSite }
			: {}),
	};
}

/** The storage entries of one origin, tolerant of anything a driver reports. */
function storageEntries(value: unknown): CapturedStorageEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: CapturedStorageEntry[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const record: RawStorageEntry = item as RawStorageEntry;
		if (typeof record.name !== "string" || typeof record.value !== "string")
			continue;
		entries.push({ name: record.name, value: record.value });
	}
	return entries;
}

/**
 * Whether a cookie's `domain` belongs to one of the origins.
 *
 * A cookie domain is a host (`grid-int.example.test`) or a domain with a leading
 * dot (`=.example.test`). A cookie is this stage's when its host equals one of the
 * origins' hosts, or when it is a parent domain of one — an identity provider's
 * `Domain=.example.test` cookie is set for the whole tree and is exactly the
 * cookie a silent sign-in reuses.
 */
export function cookieBelongsTo(
	domain: string,
	origins: readonly string[],
): boolean {
	const bare = domain.replace(/^\./, "").toLowerCase();
	if (bare === "") return false;
	for (const origin of origins) {
		const host = hostOf(origin);
		if (host === undefined) continue;
		if (host === bare) return true;
		if (host.endsWith(`.${bare}`)) return true;
	}
	return false;
}

function hostOf(origin: string): string | undefined {
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Install: an origin-scoped init script
// ---------------------------------------------------------------------------

/** One origin's storage, keyed by origin, as the init script embeds it. */
function scriptState(state: StageIdentityState): Record<
	string,
	{
		localStorage: Record<string, string>;
		sessionStorage: Record<string, string>;
	}
> {
	const perOrigin: Record<
		string,
		{
			localStorage: Record<string, string>;
			sessionStorage: Record<string, string>;
		}
	> = {};
	for (const origin of state.origins) {
		const localStorage: Record<string, string> = {};
		for (const entry of origin.localStorage)
			localStorage[entry.name] = entry.value;
		const sessionStorage: Record<string, string> = {};
		for (const entry of origin.sessionStorage)
			sessionStorage[entry.name] = entry.value;
		if (
			Object.keys(localStorage).length === 0 &&
			Object.keys(sessionStorage).length === 0
		)
			continue;
		perOrigin[origin.origin] = { localStorage, sessionStorage };
	}
	return perOrigin;
}

/**
 * The one init script a cached state is installed with (`design.md` D3).
 *
 * It runs before the page's own scripts on the *first* document of every origin,
 * so an application that reads its token at load (MSAL reads `localStorage` the
 * moment it initialises) finds it — which a navigation-then-write could not
 * promise. The origin check is the scoping: a document of any other host writes
 * nothing, so a page that navigates to a foreign origin never receives this
 * stage's state. Every write is guarded, so a storage area a browser refuses (a
 * quota, a disabled store) cannot break the page the login is for.
 *
 * Answers an empty string when there is nothing to install, so a caller can skip
 * `addInitScript` entirely.
 */
export function storageInitScript(state: StageIdentityState): string {
	const perOrigin = scriptState(state);
	if (Object.keys(perOrigin).length === 0) return "";
	return `(() => {
	const state = ${JSON.stringify(perOrigin)};
	let entry;
	try {
		entry = state[window.location.origin];
	} catch {
		return;
	}
	if (!entry) return;
	const write = (area, values) => {
		for (const name of Object.keys(values)) {
			try {
				// Seed only what the first document does not have: this script runs on
				// every document of the context, and a later load must keep what the live
				// session wrote (a rotated refresh token) instead of restoring the
				// open-time snapshot over it.
				if (area.getItem(name) === null) area.setItem(name, values[name]);
			} catch {
				/* a refused storage area must not break the page */
			}
		}
	};
	try {
		if (window.localStorage) write(window.localStorage, entry.localStorage);
	} catch {
		/* no localStorage on this page */
	}
	try {
		if (window.sessionStorage) write(window.sessionStorage, entry.sessionStorage);
	} catch {
		/* no sessionStorage on this page */
	}
})();`;
}

/** The expression the live document is read with: every `sessionStorage` key of
 * the document's own origin, as JSON. A page needs no cooperation for this — the
 * store is readable from the document itself. */
export const SESSION_STORAGE_READ_SCRIPT = `(() => {
	try {
		const out = {};
		for (let index = 0; index < window.sessionStorage.length; index += 1) {
			const name = window.sessionStorage.key(index);
			if (name === null) continue;
			const value = window.sessionStorage.getItem(name) ?? "";
			if (value.length > ${MAX_IDENTITY_VALUE_LENGTH}) continue;
			out[name] = value;
		}
		return JSON.stringify(out);
	} catch {
		return "{}";
	}
})()`;

/** The `sessionStorage` entries a `SESSION_STORAGE_READ_SCRIPT` answer carries.
 * Anything that is not a JSON object of strings is an empty read. */
export function parsedSessionStorage(value: unknown): CapturedStorageEntry[] {
	const text = typeof value === "string" ? value : "";
	if (text === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return [];
	return Object.entries(parsed as Record<string, unknown>)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.map(([name, entry]) => ({ name, value: entry }));
}

// ---------------------------------------------------------------------------
// The secret set
// ---------------------------------------------------------------------------

/**
 * Every value the redactor has to scrub, from one captured state.
 *
 * A cookie value and a stored value are credentials as surely as an access token
 * is, and MSAL stores its whole token cache inside one `localStorage` value — so
 * each value is registered, without a floor and without a cap (the capture bounds
 * what is kept; see `boundIdentityState`), and each JWT-shaped value contributes
 * its own base64url segments too (`add-stage-oauth2-auth` registers a token the
 * same way).
 */
export function identitySecrets(state: StageIdentityState): IdentitySecret[] {
	const secrets: IdentitySecret[] = [];
	const seen = new Set<string>();
	const add = (name: string, value: string): void => {
		if (value === "") return;
		const key = `${name}\u0000${value}`;
		if (seen.has(key)) return;
		seen.add(key);
		secrets.push({ name, value });
	};
	for (const cookie of state.cookies)
		add("stage-identity-cookie", cookie.value);
	for (const origin of state.origins)
		for (const entry of [...origin.localStorage, ...origin.sessionStorage])
			add("stage-identity-storage", entry.value);
	// A JWT-shaped value is scrubbed segment by segment as well: an application
	// that echoes one claim into a page title would otherwise leave that claim
	// readable even though the whole token is masked.
	for (const secret of [...secrets]) {
		const parts = secret.value.split(".");
		if (parts.length !== 3) continue;
		for (const [index, part] of parts.entries())
			if (part.length >= 20) add(`${secret.name}:jwt-${index + 1}`, part);
	}
	// Longest first: a segment of a token is replaced before the token itself
	// would be, so no partial replacement can leave a recognisable fragment.
	return secrets.sort((left, right) => right.value.length - left.value.length);
}

/** The process-wide cache: the server owns exactly one, so a forgotten identity
 * is forgotten for every run of this server. It is built with the *hard*
 * ceilings, because the bound that applies to one capture is the one its stage
 * resolved from the policy at capture time. */
let processCache: StageIdentityCache | undefined;

export function stageIdentityCache(): StageIdentityCache {
	processCache ??= new StageIdentityCache({
		ttlMs: MAX_IDENTITY_CACHE_TTL_MINUTES * 60_000,
		maxEntries: MAX_IDENTITY_CACHE_ENTRIES,
	});
	return processCache;
}

/** Replace the process-wide cache (a configuration-root switch, and the one seam
 * a test uses to prove that a restart starts empty). Answers nothing: the old
 * instance is simply no longer reachable, which is what "the server restarted"
 * means for an in-memory store. */
export function resetStageIdentityCache(): void {
	processCache = undefined;
}
