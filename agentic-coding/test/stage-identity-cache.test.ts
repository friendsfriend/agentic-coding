// The stage identity cache itself (`add-stage-identity-cache`, task 6.1).
//
// Everything here is pure: a fake clock, a `storageState()`-shaped snapshot and a
// list of origins. No browser, no server, no configuration root — the store's
// bounds, its origin scoping, its secret set and the one rule that matters most:
// nothing a read surface reports can carry a value.
import { beforeEach, describe, expect, test } from "bun:test";
import {
	cookieBelongsTo,
	DEFAULT_IDENTITY_CACHE,
	DEFAULT_IDENTITY_MAX_ENTRIES,
	DEFAULT_IDENTITY_TTL_MS,
	identityFromStorageState,
	identityKey,
	identitySecrets,
	liveCookies,
	MAX_IDENTITY_SECRETS,
	parsedSessionStorage,
	resetStageIdentityCache,
	SESSION_STORAGE_READ_SCRIPT,
	StageIdentityCache,
	type StageIdentityState,
	stageIdentityCache,
	storageInitScript,
	withSessionStorage,
} from "../src/server/stages/identity-cache.ts";

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
		const summary = cache.put({ stage: "grid-int", role: "clerk" }, state());
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
		const shorter = cache.put({ stage: "s", role: "r" }, state(), {
			ttlMs: 10_000,
		});
		expect(shorter.expiresAt - shorter.capturedAt).toBe(10_000);
		const longer = cache.put({ stage: "s", role: "r" }, state(), {
			ttlMs: 10 * 60_000,
		});
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

	test("list, toJSON and toString report the key and the bounds only", () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, state());
		const [entry] = cache.list();
		expect(Object.keys(entry).sort()).toEqual([
			"capturedAt",
			"expiresAt",
			"role",
			"stage",
		]);
		assertValueFree(JSON.stringify(cache.list()));
		assertValueFree(JSON.stringify(cache.toJSON()));
		assertValueFree(JSON.stringify(cache));
		assertValueFree(cache.toString());
		assertValueFree(String(cache));
	});
});

describe("the secret set", () => {
	test("every captured value is registered, longest first", () => {
		const secrets = identitySecrets(state());
		const values = secrets.map((secret) => secret.value);
		expect(values).toContain(SESSION_COOKIE);
		expect(values).toContain(APP_TOKEN);
		expect(values).toContain(IDP_COOKIE);
		expect(values).toContain("SENTINEL-session-storage-0123456789");
		// A one-character value is ordinary page text, and scrubbing it would hide
		// nothing while rewriting the page.
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

	test("the process store's set is bounded", () => {
		const cache = new StageIdentityCache();
		cache.put(
			{ stage: "s", role: "r" },
			{
				cookies: [],
				origins: [
					{
						origin: APP,
						localStorage: Array.from(
							{ length: MAX_IDENTITY_SECRETS + 50 },
							(_, index) => ({
								name: `key-${index}`,
								value: `value-${index}-0123456789`,
							}),
						),
						sessionStorage: [],
					},
				],
			},
		);
		expect(cache.secrets().length).toBe(MAX_IDENTITY_SECRETS);
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
