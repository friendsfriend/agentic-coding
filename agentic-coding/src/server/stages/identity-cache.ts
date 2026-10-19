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

/** One key of the cache: a stage and one role of it. Roles of one stage are
 * different users, so they never share an entry; stages are different trust
 * boundaries, so they never do either (`design.md` D1). */
export interface StageIdentityKey {
	readonly stage: string;
	readonly role: string;
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
	/** The absolute end of its life, epoch milliseconds. Reading never extends
	 * it (`design.md` D4). */
	readonly expiresAt: number;
}

/** What the cache reports about one entry, and everything it ever reports: no
 * cookie name, no storage key, no value, no token. */
export interface StageIdentitySummary extends StageIdentityKey {
	readonly capturedAt: number;
	readonly expiresAt: number;
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

/** The lifetime a cache entry gets when neither the stage nor the policy says
 * otherwise: the documented default, in milliseconds. */
export const DEFAULT_IDENTITY_TTL_MS =
	DEFAULT_IDENTITY_CACHE.ttlMinutes * 60_000;
/** How many `(stage, role)` entries one process keeps by default. */
export const DEFAULT_IDENTITY_MAX_ENTRIES = DEFAULT_IDENTITY_CACHE.maxEntries;
/** How many values the redactor is given from this cache. A page may store
 * hundreds of keys; the scrubber only needs the ones that look like credentials,
 * and an unbounded secret list is its own cost. */
export const MAX_IDENTITY_SECRETS = 200;

/** The shortest value worth scrubbing: a two-character value is ordinary page
 * text, and masking it would hide nothing. */
const MIN_SECRET_LENGTH = 8;

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
	 * Expired cookies are dropped here rather than at install time, so an entry
	 * that is still within its TTL never installs a cookie the browser would
	 * discard anyway. The entry's lifetime is the smaller of `ttlMs` and the
	 * store's own ceiling, and it is *absolute* from now.
	 */
	put(
		key: StageIdentityKey,
		state: StageIdentityState,
		options: { readonly ttlMs?: number; readonly maxEntries?: number } = {},
	): StageIdentitySummary {
		const now = this.clock();
		const ttlMs = Math.min(
			this.ttlMs,
			Math.max(1, options.ttlMs ?? this.ttlMs),
		);
		const entry: StageIdentityEntry = {
			stage: key.stage,
			role: key.role,
			state: {
				cookies: liveCookies(state.cookies, now),
				origins: state.origins.map((origin) => ({
					origin: origin.origin,
					localStorage: [...origin.localStorage],
					sessionStorage: [...origin.sessionStorage],
				})),
			},
			capturedAt: now,
			expiresAt: now + ttlMs,
		};
		// Re-inserting moves the key to the end, so the eviction order stays
		// "oldest capture leaves first".
		this.entries.delete(identityKey(key));
		this.entries.set(identityKey(key), entry);
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
			this.entries.delete(id);
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
		};
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
			this.entries.delete(id);
			removed += 1;
		}
		return removed;
	}

	/** Drop everything. A restart is simply a new process; this is the explicit
	 * form a test and a configuration-root switch use. */
	clear(): void {
		this.entries.clear();
	}

	/** Every live entry as `(stage, role, capturedAt, expiresAt)` — the listing
	 * the dashboard, the CLI and the route report, and the only thing they may. */
	list(): StageIdentitySummary[] {
		return [...this.entries.values()]
			.filter((entry) => this.clock() < entry.expiresAt)
			.map((entry) => summaryOf(entry));
	}

	/**
	 * Every value the redactor has to scrub: each cookie value and each stored
	 * value, plus the base64url segments of anything JWT-shaped. Longest first, so
	 * a segment is replaced before a value that contains it — and bounded, because
	 * this set is rebuilt on every reply.
	 */
	secrets(): Array<{ readonly name: string; readonly value: string }> {
		const state: StageIdentityState = {
			cookies: [...this.entries.values()].flatMap((entry) =>
				entry.state.cookies.map((cookie) => ({ ...cookie })),
			),
			origins: [...this.entries.values()].flatMap((entry) =>
				entry.state.origins.map((origin) => ({
					origin: origin.origin,
					localStorage: origin.localStorage,
					sessionStorage: origin.sessionStorage,
				})),
			),
		};
		return identitySecrets(state).slice(0, MAX_IDENTITY_SECRETS);
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
	 * which is the entry whose lifetime is also closest to its end. */
	private evictBeyondCap(cap = this.maxEntries): void {
		while (this.entries.size > cap) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) return;
			this.entries.delete(oldest.value);
		}
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
 * whatever the base state already held (nothing, for a first capture). */
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
				area.setItem(name, values[name]);
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
			out[name] = window.sessionStorage.getItem(name) ?? "";
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
 * each value is registered, and each JWT-shaped value contributes its own
 * base64url segments too (`add-stage-oauth2-auth` registers a token the same
 * way). Values too short to be a credential are skipped: scrubbing every `"1"`
 * would rewrite ordinary page text and hide nothing.
 */
export function identitySecrets(
	state: StageIdentityState,
): Array<{ readonly name: string; readonly value: string }> {
	const secrets: Array<{ readonly name: string; readonly value: string }> = [];
	const seen = new Set<string>();
	const add = (name: string, value: string): void => {
		if (value.length < MIN_SECRET_LENGTH) return;
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
