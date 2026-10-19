// The stage identity cache itself (`add-stage-identity-cache`, task 6.1).
//
// Everything here is pure: a fake clock, a `storageState()`-shaped snapshot and a
// list of origins. No browser, no server, no configuration root — the store's
// bounds, its origin scoping, its secret set and the one rule that matters most:
// nothing a read surface reports can carry a value.
import { beforeEach, describe, expect, test } from "bun:test";
import {
	boundIdentityState,
	carrySessionStorage,
	cookieBelongsTo,
	DEFAULT_IDENTITY_CACHE,
	DEFAULT_IDENTITY_MAX_ENTRIES,
	DEFAULT_IDENTITY_TTL_MS,
	identityFromStorageState,
	identityKey,
	identitySecrets,
	liveCookies,
	MAX_IDENTITY_ENTRY_BYTES,
	MAX_IDENTITY_VALUE_LENGTH,
	MAX_IDENTITY_VALUES_PER_ENTRY,
	MAX_LIVE_IDENTITY_SECRET_BYTES,
	MAX_LIVE_IDENTITY_SECRETS,
	MIN_IDENTITY_VALUE_LENGTH,
	mergeIdentitySecrets,
	parsedSessionStorage,
	resetStageIdentityCache,
	SESSION_STORAGE_READ_SCRIPT,
	StageIdentityCache,
	type StageIdentityState,
	type StageIdentitySummary,
	stageIdentityCache,
	storageInitScript,
	withSessionStorage,
} from "../src/server/stages/identity-cache.ts";

/** A write that must land. The store answers `undefined` only for a write it was
 * told to drop (a generation the caller has already lost), so a test that does not
 * race a forget would otherwise assert against a silent no-op. */
function stored(
	summary: StageIdentitySummary | undefined,
): StageIdentitySummary {
	if (summary === undefined) throw new Error("the store dropped the write");
	return summary;
}

const APP = "https://grid-int.example.test";
const IDP = "https://login.example.test";
const ORIGINS = [APP, IDP];

/** A clock a test advances by hand: every bound of the cache is time-based, and
 * sleeping is not an assertion. */
function clock(start = 1_700_000_000_000) {
	let now = start;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

/** The sentinel values: each one is unmistakable, so a leak is a failed expect
 * rather than a judgement call. */
const SESSION_COOKIE = "SENTINEL-session-cookie-value-0123456789";
const APP_TOKEN = "SENTINEL-app-token-value-0123456789";
const IDP_COOKIE = "SENTINEL-idp-cookie-value-0123456789";
const THIRD_PARTY_COOKIE = "SENTINEL-third-party-cookie-0123456789";

/** A `storageState()` answer for a logged-in stage application. */
function snapshot(): Record<string, unknown> {
	return {
		cookies: [
			{
				name: ".AspNetCore.Session",
				value: SESSION_COOKIE,
				domain: "grid-int.example.test",
				path: "/",
				expires: -1,
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
			},
			{
				// A parent-domain sign-on cookie: the identity provider set it for the
				// whole tree, which is exactly the cookie a silent login reuses.
				name: "ESTSAUTH",
				value: IDP_COOKIE,
				domain: ".example.test",
				path: "/",
				expires: -1,
				httpOnly: true,
				secure: true,
			},
			{
				name: "analytics",
				value: THIRD_PARTY_COOKIE,
				domain: "analytics.example.test",
				path: "/",
				expires: 4_000_000_000,
				httpOnly: false,
				secure: true,
			},
		],
		origins: [
			{
				origin: APP,
				localStorage: [
					{ name: "msal.token.keys", value: APP_TOKEN },
					{ name: "t", value: "1" },
				],
			},
			{
				origin: "https://tracker.example.test",
				localStorage: [{ name: "leak", value: THIRD_PARTY_COOKIE }],
			},
		],
	};
}

function state(): StageIdentityState {
	return withSessionStorage(
		identityFromStorageState(snapshot(), ORIGINS),
		APP,
		[{ name: "session-token", value: "SENTINEL-session-storage-0123456789" }],
	);
}

describe("capture", () => {
	test("keeps the stage's own cookies and the identity provider's sign-on cookie", () => {
		const captured = identityFromStorageState(snapshot(), ORIGINS);
		expect(captured.cookies.map((cookie) => cookie.name)).toEqual([
			".AspNetCore.Session",
			"ESTSAUTH",
		]);
		// A third-party origin's cookie and storage are not this stage's identity.
		expect(
			captured.cookies.some((cookie) => cookie.value === THIRD_PARTY_COOKIE),
		).toBe(false);
		expect(captured.origins.map((origin) => origin.origin)).toEqual(ORIGINS);
		expect(
			captured.origins.find((origin) => origin.origin === APP)?.localStorage,
		).toEqual([
			{ name: "msal.token.keys", value: APP_TOKEN },
			{ name: "t", value: "1" },
		]);
		// No declared origin holds another origin's storage.
		expect(
			captured.origins.some((origin) =>
				origin.localStorage.some((entry) => entry.value === THIRD_PARTY_COOKIE),
			),
		).toBe(false);
	});

	test("tolerates anything a driver might report instead of a snapshot", () => {
		for (const value of [undefined, null, 42, "text", [], {}])
			expect(identityFromStorageState(value, ORIGINS).cookies).toEqual([]);
		// The declared origins are still reported, empty: an install of an empty
		// state is a no-op, not a broken page.
		expect(identityFromStorageState(null, ORIGINS).origins).toHaveLength(2);
	});

	test("a cookie domain belongs to the stage when it is the host or a parent of it", () => {
		expect(cookieBelongsTo("grid-int.example.test", ORIGINS)).toBe(true);
		expect(cookieBelongsTo(".example.test", ORIGINS)).toBe(true);
		expect(cookieBelongsTo("other.test", ORIGINS)).toBe(false);
		// Only a parent of a declared host counts: a *child* domain's cookie was set
		// for a host this stage does not drive.
		expect(cookieBelongsTo("int.example.test", ORIGINS)).toBe(false);
		expect(cookieBelongsTo("example.test.evil.test", ORIGINS)).toBe(false);
	});

	test("sessionStorage is read from the document's own origin only", () => {
		const captured = state();
		expect(
			captured.origins.find((origin) => origin.origin === APP)?.sessionStorage,
		).toEqual([
			{ name: "session-token", value: "SENTINEL-session-storage-0123456789" },
		]);
		expect(
			captured.origins.find((origin) => origin.origin === IDP)?.sessionStorage,
		).toEqual([]);
	});

	test("a sessionStorage answer that is not a JSON object of strings is empty", () => {
		expect(parsedSessionStorage('{"a":"1"}')).toEqual([
			{ name: "a", value: "1" },
		]);
		expect(parsedSessionStorage('{"a":1}')).toEqual([]);
		expect(parsedSessionStorage("[]")).toEqual([]);
		expect(parsedSessionStorage("null")).toEqual([]);
		expect(parsedSessionStorage("not json")).toEqual([]);
		expect(parsedSessionStorage(undefined)).toEqual([]);
	});
});

describe("bounds", () => {
	let fake: ReturnType<typeof clock>;
	beforeEach(() => {
		fake = clock();
	});

	test("the documented defaults are the defaults", () => {
		expect(DEFAULT_IDENTITY_CACHE).toEqual({
			ttlMinutes: 240,
			maxEntries: 8,
			refreshSeconds: 120,
		});
		expect(DEFAULT_IDENTITY_TTL_MS).toBe(240 * 60_000);
		expect(DEFAULT_IDENTITY_MAX_ENTRIES).toBe(8);
	});

	test("an entry ends at its absolute TTL, and reading does not extend it", () => {
		const cache = new StageIdentityCache({
			now: fake.now,
			ttlMs: 60_000,
			maxEntries: 4,
		});
		const summary = stored(
			cache.put({ stage: "grid-int", role: "clerk" }, state()),
		);
		expect(summary.expiresAt - summary.capturedAt).toBe(60_000);

		fake.advance(30_000);
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(true);
		// A read in the middle of its life changes neither instant.
		expect(cache.peek({ stage: "grid-int", role: "clerk" })?.expiresAt).toBe(
			summary.expiresAt,
		);

		fake.advance(30_000);
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(false);
		expect(cache.size).toBe(0);
		expect(cache.list()).toEqual([]);
	});

	test("a capture can ask for a shorter life but never a longer one", () => {
		const cache = new StageIdentityCache({
			now: fake.now,
			ttlMs: 60_000,
			maxEntries: 4,
		});
		const shorter = stored(
			cache.put({ stage: "s", role: "r" }, state(), {
				ttlMs: 10_000,
			}),
		);
		expect(shorter.expiresAt - shorter.capturedAt).toBe(10_000);
		const longer = stored(
			cache.put({ stage: "s", role: "r" }, state(), {
				ttlMs: 10 * 60_000,
			}),
		);
		expect(longer.expiresAt - longer.capturedAt).toBe(60_000);
	});

	test("the oldest capture leaves first when the cap is reached", () => {
		const cache = new StageIdentityCache({
			now: fake.now,
			ttlMs: 600_000,
			maxEntries: 2,
		});
		cache.put({ stage: "s", role: "a" }, state());
		fake.advance(1_000);
		cache.put({ stage: "s", role: "b" }, state());
		fake.advance(1_000);
		cache.put({ stage: "s", role: "c" }, state());
		expect(
			cache
				.list()
				.map((entry) => entry.role)
				.sort(),
		).toEqual(["b", "c"]);
		expect(cache.size).toBe(2);
	});

	test("a role's entry never stands in for another role of the same stage", () => {
		const cache = new StageIdentityCache({ now: fake.now });
		cache.put({ stage: "grid-int", role: "clerk" }, state());
		expect(cache.holds({ stage: "grid-int", role: "admin" })).toBe(false);
		expect(cache.holds({ stage: "grid-other", role: "clerk" })).toBe(false);
		expect(identityKey({ stage: "a", role: "b" })).not.toBe(
			identityKey({ stage: "a\u0000b", role: "" }),
		);
	});

	test("a newer capture replaces the entry entirely, and its TTL restarts", () => {
		const cache = new StageIdentityCache({ now: fake.now, ttlMs: 600_000 });
		const key = { stage: "grid-int", role: "clerk" };
		cache.put(key, {
			cookies: [capturedCookie("old", -1)],
			origins: [
				{
					origin: "https://grid-int.example.test",
					localStorage: [{ name: "msal.token.keys", value: APP_TOKEN }],
					sessionStorage: [],
				},
			],
		});
		const first = cache.peek(key);
		if (first === undefined) throw new Error("the first capture did not land");
		fake.advance(120_000);
		cache.put(key, {
			cookies: [capturedCookie("new", -1)],
			origins: [
				{
					origin: "https://grid-int.example.test",
					localStorage: [],
					sessionStorage: [],
				},
			],
		});
		const second = cache.peek(key);
		if (second === undefined)
			throw new Error("the second capture did not land");
		// The capture is a whole state, not a merge: a rotated cookie is not
		// unioned with the one it replaced, and the TTL is counted from the new
		// capture rather than the entry's first one.
		expect(second.state.cookies.map((cookie) => cookie.name)).toEqual(["new"]);
		expect(second.state.origins[0]?.localStorage).toEqual([]);
		expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
		expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
		expect(cache.size).toBe(1);
	});

	test("expired cookies are dropped on the way in", () => {
		const now = fake.now();
		const cookies = liveCookies(
			[
				{ ...capturedCookie("live", -1), value: "live-value-0123456789" },
				{
					...capturedCookie("ended", 1),
					value: "ended-value-0123456789",
				},
			],
			now,
		);
		expect(cookies.map((cookie) => cookie.name)).toEqual(["live"]);
	});

	test("an entry's state is a copy: two readers never share an array", () => {
		const cache = new StageIdentityCache({ now: fake.now });
		cache.put({ stage: "s", role: "r" }, state());
		const first = cache.peek({ stage: "s", role: "r" });
		const second = cache.peek({ stage: "s", role: "r" });
		expect(first).not.toBe(second);
		expect(first?.state.cookies).not.toBe(second?.state.cookies);
	});
});

/** One cookie of a `CapturedCookie` shape, for the filtering tests. */
function capturedCookie(name: string, expires: number) {
	return {
		name,
		value: `${name}-value-0123456789`,
		domain: "grid-int.example.test",
		path: "/",
		expires,
		httpOnly: true,
		secure: true,
	};
}

describe("forget", () => {
	test("a filter forgets one role, one stage or everything", () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, state());
		cache.put({ stage: "grid-int", role: "admin" }, state());
		cache.put({ stage: "grid-other", role: "clerk" }, state());

		expect(cache.forget({ stage: "grid-int", role: "clerk" })).toBe(1);
		expect(
			cache
				.list()
				.map((entry) => `${entry.stage}/${entry.role}`)
				.sort(),
		).toEqual(["grid-int/admin", "grid-other/clerk"]);

		expect(cache.forget({ stage: "grid-int" })).toBe(1);
		expect(cache.list().map((entry) => entry.stage)).toEqual(["grid-other"]);

		expect(cache.forget()).toBe(1);
		expect(cache.list()).toEqual([]);
		expect(cache.forget()).toBe(0);
	});

	test("a cleared store is what a restart is", () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "s", role: "r" }, state());
		cache.clear();
		expect(cache.size).toBe(0);
		// The process-wide instance is replaced, not emptied: "the server
		// restarted" is a new, empty cache.
		const before = stageIdentityCache();
		before.put({ stage: "s", role: "r" }, state());
		resetStageIdentityCache();
		expect(stageIdentityCache()).not.toBe(before);
		expect(stageIdentityCache().size).toBe(0);
	});
});

describe("no value ever leaves the store", () => {
	function assertValueFree(text: string): void {
		for (const sentinel of [
			SESSION_COOKIE,
			APP_TOKEN,
			IDP_COOKIE,
			THIRD_PARTY_COOKIE,
			"SENTINEL-session-storage-0123456789",
		])
			expect(text).not.toContain(sentinel);
		// Not even a cookie name: the listing is a key and two instants.
		expect(text).not.toContain("ESTSAUTH");
		expect(text).not.toContain("msal.token.keys");
	}

	test("list, toJSON and toString report the key, the bounds and a count", () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, state());
		const [entry] = cache.list();
		expect(Object.keys(entry).sort()).toEqual([
			"capturedAt",
			"expiresAt",
			"role",
			"stage",
			"truncated",
		]);
		expect(JSON.stringify(cache.list())).not.toContain("tiny");
		assertValueFree(JSON.stringify(cache.toJSON()));
		assertValueFree(JSON.stringify(cache));
		assertValueFree(cache.toString());
		assertValueFree(String(cache));
	});
});

describe("the capture bounds", () => {
	test("a value too short or too long to be a credential is not kept", () => {
		const bounded = boundIdentityState(
			{
				cookies: [],
				origins: [
					{
						origin: APP,
						localStorage: [
							{ name: "t", value: "1" },
							{
								name: "tiny",
								value: "a".repeat(MIN_IDENTITY_VALUE_LENGTH - 1),
							},
							{ name: "edge", value: "a".repeat(MIN_IDENTITY_VALUE_LENGTH) },
							{
								name: "huge",
								value: "a".repeat(MAX_IDENTITY_VALUE_LENGTH + 1),
							},
						],
						sessionStorage: [],
					},
				],
			},
			Date.now(),
		);
		expect(bounded.state.origins[0]?.localStorage.map((e) => e.name)).toEqual([
			"edge",
		]);
		expect(bounded.truncated).toBe(3);
		// The registered values are exactly the kept ones: the redactor never has to
		// refuse a value the store holds.
		const secrets = identitySecrets(bounded.state).map(
			(secret) => secret.value,
		);
		expect(secrets).toContain("a".repeat(MIN_IDENTITY_VALUE_LENGTH));
	});

	test("an entry stops at its byte cap, counting what it dropped", () => {
		const value = "b".repeat(64 * 1024);
		const bounded = boundIdentityState(
			{
				cookies: [],
				origins: [
					{
						origin: APP,
						localStorage: Array.from({ length: 20 }, (_, index) => ({
							name: `key-${index}`,
							value,
						})),
						sessionStorage: [],
					},
				],
			},
			Date.now(),
		);
		const kept = bounded.state.origins[0]?.localStorage ?? [];
		expect(kept.length).toBeLessThan(20);
		expect(kept.length * (value.length + 5)).toBeLessThanOrEqual(
			MAX_IDENTITY_ENTRY_BYTES,
		);
		expect(bounded.truncated).toBe(20 - kept.length);
	});

	test("an entry stops at its value cap, counting what it dropped", () => {
		const cache = new StageIdentityCache();
		stored(
			cache.put(
				{ stage: "s", role: "r" },
				{
					cookies: [],
					origins: [
						{
							origin: APP,
							localStorage: Array.from(
								{ length: MAX_IDENTITY_VALUES_PER_ENTRY + 50 },
								(_, index) => ({
									name: `key-${index}`,
									value: `value-${index}-0123456789`,
								}),
							),
							sessionStorage: [],
						},
					],
				},
			),
		);
		// The capture bounds the entry, so the redaction set is bounded with it:
		// there is no separate truncation of secrets that could leave a stored value
		// unregistered (SEC-002).
		expect(cache.secrets().length).toBe(MAX_IDENTITY_VALUES_PER_ENTRY);
	});

	test("a truncation is reported as a count, never on a read surface", () => {
		const cache = new StageIdentityCache({ now: () => Date.now() });
		cache.put(
			{ stage: "s", role: "r" },
			{
				cookies: [],
				origins: [
					{
						origin: APP,
						localStorage: [{ name: "t", value: "1" }],
						sessionStorage: [],
					},
				],
			},
		);
		expect(cache.peek({ stage: "s", role: "r" })?.truncated).toBe(1);
		// The count reaches every read surface — an operator has to be able to see
		// that a key was stored cut short — and it is the *only* thing about the drop
		// that does: no name, no value, no origin.
		const [entry] = cache.list();
		expect(entry?.truncated).toBe(1);
		expect(Object.keys(entry ?? {}).sort()).toEqual([
			"capturedAt",
			"expiresAt",
			"role",
			"stage",
			"truncated",
		]);
		expect(JSON.stringify(cache.list())).not.toContain("tiny");
	});
});

describe("a generation makes a forget hold", () => {
	test("a write whose generation was lost is dropped", () => {
		const cache = new StageIdentityCache({ now: () => Date.now() });
		const key = { stage: "s", role: "r" };
		cache.put(key, state());
		const generation = cache.generation(key);
		// A capture that read the store before this forget is still in flight.
		expect(cache.forget({ stage: "s", role: "r" })).toBe(1);
		expect(cache.put(key, state(), { generation })).toBeUndefined();
		expect(cache.holds(key)).toBe(false);
	});

	test("a forgotten key with no entry yet still refuses the capture in flight", () => {
		const cache = new StageIdentityCache({ now: () => Date.now() });
		const key = { stage: "s", role: "r" };
		const generation = cache.generation(key);
		// Nothing to remove yet: the entries alone cannot name this key, so the
		// forget tells the store the key is invalid rather than dropping a row.
		cache.invalidate(key);
		expect(cache.put(key, state(), { generation })).toBeUndefined();
		expect(cache.holds(key)).toBe(false);
	});

	test("a write of the current generation lands", () => {
		const cache = new StageIdentityCache({ now: () => Date.now() });
		const key = { stage: "s", role: "r" };
		cache.put(key, state());
		const generation = cache.generation(key);
		expect(cache.put(key, state(), { generation })).not.toBeUndefined();
	});

	test("an eviction moves the generation of the key it dropped", () => {
		const cache = new StageIdentityCache({
			now: () => Date.now(),
			maxEntries: 1,
		});
		const first = { stage: "s", role: "a" };
		const generation = cache.generation(first);
		cache.put(first, state());
		cache.put({ stage: "s", role: "b" }, state());
		// `first` left when `b` arrived, so a capture of `first` that started before
		// the eviction cannot resurrect it.
		expect(cache.generation(first)).not.toBe(generation);
		expect(cache.put(first, state(), { generation })).toBeUndefined();
	});
});

describe("carrying sessionStorage forward", () => {
	const OTHER = "https://other.example.test";

	function withOrigins(entries: Record<string, string>): StageIdentityState {
		return {
			cookies: [],
			origins: [APP, OTHER].map((origin) => ({
				origin,
				localStorage: [],
				sessionStorage:
					entries[origin] === undefined
						? []
						: [{ name: "token", value: entries[origin] ?? "" }],
			})),
		};
	}

	test("an origin this capture could not read keeps what it had", () => {
		const previous = withOrigins({ [OTHER]: "kept-0123456789" });
		const state = carrySessionStorage(
			withOrigins({ [APP]: "fresh-0123456789" }),
			previous,
			APP,
		);
		const session = (origin: string) =>
			state.origins.find((entry) => entry.origin === origin)?.sessionStorage;
		// The document's own origin is what was just read, so it is replaced.
		expect(session(APP)).toEqual([
			{ name: "token", value: "fresh-0123456789" },
		]);
		// The other origin's value would otherwise be lost on every capture.
		expect(session(OTHER)).toEqual([
			{ name: "token", value: "kept-0123456789" },
		]);
	});

	test("a first capture has nothing to carry", () => {
		const state = withOrigins({ [APP]: "fresh-0123456789" });
		expect(carrySessionStorage(state, undefined, APP)).toEqual(state);
	});
});

describe("the secret set", () => {
	// `identitySecrets` registers what the store *holds*, and the capture decides
	// what it holds: one place refuses a value, and no second place can leave a
	// stored value unregistered (SEC-002).
	test("every captured value is registered, longest first", () => {
		// What the store holds, not what a page reported: the capture floor is what
		// keeps a one-character value out, and a value it kept is never refused here.
		const kept = boundIdentityState(state(), Date.now());
		expect(kept.truncated).toBe(1);
		const secrets = identitySecrets(kept.state);
		const values = secrets.map((secret) => secret.value);
		expect(values).toContain(SESSION_COOKIE);
		expect(values).toContain(APP_TOKEN);
		expect(values).toContain(IDP_COOKIE);
		expect(values).toContain("SENTINEL-session-storage-0123456789");
		expect(values).not.toContain("1");
		const lengths = values.map((value) => value.length);
		expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
	});

	test("a JWT contributes its own segments", () => {
		const token = [
			"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
			"eyJhdWQiOiJncmlkIiwicm9sZSI6ImNsZXJrIn0",
			"SENTINEL-signature-0123456789",
		].join(".");
		const secrets = identitySecrets({
			cookies: [],
			origins: [
				{
					origin: APP,
					localStorage: [{ name: "access_token", value: token }],
					sessionStorage: [],
				},
			],
		});
		const values = secrets.map((secret) => secret.value);
		expect(values).toContain(token);
		for (const part of token.split(".")) expect(values).toContain(part);
	});

	test("a value the store dropped is not in the set", () => {
		const cache = new StageIdentityCache();
		cache.put(
			{ stage: "s", role: "r" },
			{
				cookies: [{ ...capturedCookie("short", -1), value: "1" }],
				origins: [
					{
						origin: APP,
						localStorage: [{ name: "msal.token.keys", value: APP_TOKEN }],
						sessionStorage: [],
					},
				],
			},
		);
		const values = cache.secrets().map((secret) => secret.value);
		expect(values).toContain(APP_TOKEN);
		expect(values).not.toContain("1");
	});
});

describe("a capture that is stored", () => {
	test("a cookie whose own expiry has passed is not kept", () => {
		// TESTQ-008: the entry's TTL is not a cookie's life. A capture taken while a
		// cookie is already past its own expiry would otherwise store a credential no
		// browser would send, and install it as a live one.
		const now = 1_000_000;
		const cache = new StageIdentityCache({ now: () => now });
		cache.put(
			{ stage: "s", role: "r" },
			{
				cookies: [
					{
						name: "expired",
						value: "SENT-expired-cookie-value",
						domain: "app.example.test",
						path: "/",
						expires: Math.floor(now / 1_000) - 60,
						httpOnly: true,
						secure: true,
					},
					{
						name: "live",
						value: "SENT-live-cookie-value",
						domain: "app.example.test",
						path: "/",
						expires: Math.floor(now / 1_000) + 60,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);
		expect(
			cache
				.peek({ stage: "s", role: "r" })
				?.state.cookies.map((cookie) => cookie.name),
		).toEqual(["live"]);
	});
});

describe("install", () => {
	test("the init script embeds the state behind an origin check", () => {
		const script = storageInitScript(state());
		expect(script).toContain(APP);
		// An origin with no storage to install is left out, so the blob the browser
		// receives is only what it can use.
		expect(script).not.toContain(IDP);
		// The guard is `location.origin`, so a document of another host writes
		// nothing even though it runs the same script.
		expect(script).toContain("window.location.origin");
		expect(script).toContain("setItem");
		// `setItem` runs only when the key is not already there, so an install never
		// overwrites a value the page wrote for itself before the script ran
		// (QUALITY-005).
		expect(script).toContain("getItem");
		expect(script.indexOf("getItem")).toBeLessThan(script.indexOf("setItem"));
		// The values are in the script the browser runs, and nowhere else.
		expect(script).toContain(APP_TOKEN);
	});

	test("nothing to install is an empty script, not a no-op scan", () => {
		expect(storageInitScript({ cookies: [], origins: [] })).toBe("");
		// Cookies alone are installed by the context, so there is no script.
		const cookiesOnly = identityFromStorageState(
			{ cookies: snapshot().cookies, origins: [] },
			ORIGINS,
		);
		expect(storageInitScript(cookiesOnly)).toBe("");
	});

	test("the sessionStorage read script is a bounded, self-contained expression", () => {
		expect(SESSION_STORAGE_READ_SCRIPT).toContain("window.sessionStorage");
		expect(SESSION_STORAGE_READ_SCRIPT).toContain("JSON.stringify");
		expect(SESSION_STORAGE_READ_SCRIPT.trimEnd().endsWith(")()")).toBe(true);
	});
});

describe("the secret set a live context registers", () => {
	test("it is the union of what the context carried, deduped", () => {
		// A capture re-registers the whole state and an install registered its
		// snapshot: the union is what a page of that context could still echo, and a
		// value both saw twice is one secret (TESTQ-020).
		const merged = mergeIdentitySecrets(
			[{ name: "stage-identity-cookie", value: "SENT-first-value" }],
			[
				{ name: "stage-identity-cookie", value: "SENT-second-value" },
				// The same value the previous capture registered: one secret, not two.
				{ name: "stage-identity-cookie", value: "SENT-first-value" },
			],
		);
		expect(merged.map((secret) => secret.value).sort()).toEqual([
			"SENT-first-value",
			"SENT-second-value",
		]);
		expect(
			mergeIdentitySecrets(merged, [
				{ name: "stage-identity-cookie", value: "SENT-second-value" },
			]),
		).toHaveLength(2);
		expect(mergeIdentitySecrets([], [])).toEqual([]);
	});

	test("it is bounded by count and by bytes, keeping the newest values", () => {
		// Every capture of a rotating token is a distinct value, so without a bound
		// the set — and with it the cost of scrubbing every reply — would follow the
		// length of the run (PERF).
		const many = Array.from(
			{ length: MAX_LIVE_IDENTITY_SECRETS + 10 },
			(_, index) => ({
				name: "stage-identity-storage",
				value: `value-${String(index).padStart(4, "0")}`,
			}),
		);
		const merged = mergeIdentitySecrets([], many);
		expect(merged).toHaveLength(MAX_LIVE_IDENTITY_SECRETS);
		const kept = new Set(merged.map((secret) => secret.value));
		const newest = many[many.length - 1];
		const oldest = many[0];
		if (!newest || !oldest) throw new Error("the fixture is empty");
		expect(kept.has(newest.value)).toBe(true);
		expect(kept.has(oldest.value)).toBe(false);
		// A byte bound, not only an entry one: a capture of large values cannot
		// register more than that either.
		const large = Array.from({ length: 40 }, (_, index) => ({
			name: "stage-identity-cookie",
			value: `${String(index).padStart(2, "0")}${"x".repeat(64 * 1024)}`,
		}));
		const bounded = mergeIdentitySecrets([], large);
		expect(
			bounded.reduce((total, secret) => total + secret.value.length, 0),
		).toBeLessThanOrEqual(MAX_LIVE_IDENTITY_SECRET_BYTES);
		expect(bounded.length).toBeGreaterThan(0);
		// The newest value survives alone above the byte bound: the value a page is
		// most likely to echo is never the one the bound drops.
		expect(
			mergeIdentitySecrets(
				[],
				[
					{
						name: "stage-identity-cookie",
						value: "y".repeat(MAX_LIVE_IDENTITY_SECRET_BYTES + 1),
					},
				],
			),
		).toHaveLength(1);
	});
});
