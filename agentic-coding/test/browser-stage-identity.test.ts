// The stage identity cache across the browser routes (`add-stage-identity-cache`,
// tasks 6.2-6.4).
//
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
// The whole path is exercised against the fake driver and a throwaway
// configuration root: a login captures the browser state of a `(stage, role)`, a
// later session names the role and starts from it, `stage_login` re-verifies the
// declared success condition instead of trusting the cache, a rejected entry is
// evicted, a stage can opt out, and — the rule that matters most — no value of
// the cache reaches any reply, log line or route listing.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFakeDriver,
	type FakeStorageState,
} from "../src/server/browser/fake-driver.ts";
import { LoginHandoffCoordinator } from "../src/server/browser/handoff.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
} from "../src/server/browser/routes.ts";
import {
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	STAGES_IDENTITY_FORGET_PATH,
	STAGES_IDENTITY_PATH,
} from "../src/server/protocol.ts";
import { readStageCatalog, stagePaths } from "../src/server/stages/catalog.ts";
import {
	DEFAULT_IDENTITY_CACHE,
	MAX_IDENTITY_CACHE_ENTRIES,
	MAX_IDENTITY_CACHE_REFRESH_SECONDS,
	MAX_IDENTITY_CACHE_TTL_MINUTES,
	resetStageIdentityCache,
	StageIdentityCache,
} from "../src/server/stages/identity-cache.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import {
	handleStageIdentityRoute,
	type StageRouteDeps,
} from "../src/server/stages/routes.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";

const OWNER = "workflow:wf-stage";
const OTHER_OWNER = "workflow:wf-other";
const APP_URL = "https://grid-int.example.test/";
const APP_ORIGIN = "https://grid-int.example.test";
const IDP_URL = "https://login.example.test/";
const IDP_ORIGIN = "https://login.example.test";

/** The values a page would hold after a real sign-in. Every one is a sentinel:
 * a leak is a failed comparison, not a judgement call. */
const SESSION_COOKIE = "SENT-app-session-cookie-0123456789";
const IDP_COOKIE = "SENT-idp-signon-cookie-0123456789";
const THIRD_PARTY_COOKIE = "SENT-third-party-cookie-0123456789";
const APP_TOKEN = "SENT-app-token-value-0123456789";
const SESSION_TOKEN = "SENT-session-storage-0123456789";
const SENTINELS = [
	SESSION_COOKIE,
	IDP_COOKIE,
	THIRD_PARTY_COOKIE,
	APP_TOKEN,
	SESSION_TOKEN,
];

/** What a browser holds after a successful sign-in. */
function loggedInState(): FakeStorageState {
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
				origin: APP_ORIGIN,
				localStorage: [{ name: "msal.token.keys", value: APP_TOKEN }],
			},
			{
				origin: "https://tracker.example.test",
				localStorage: [{ name: "leak", value: THIRD_PARTY_COOKIE }],
			},
		],
	};
}

/** One throwaway configuration root with one allow-listed stage. */
function configRoot(
	option: {
		/** The recipe's declared success condition. The default holds the moment
		 * the application's own page is reached. */
		readonly success?: Record<string, unknown>;
		/** `identityCache: false` on the stage. */
		readonly identityCache?: boolean;
		/** The policy file, when a test bounds the cache differently. */
		readonly policy?: Record<string, unknown>;
	} = {},
): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-identity-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(
			{
				ident: "grid-int",
				displayName: "Grid integration",
				environment: "integration",
				system: "grid",
				access: "read-only",
				apps: {
					web: {
						label: "Grid web",
						url: APP_URL,
						kind: "ui",
						roles: {
							clerk: {
								login: "web-form",
								username: "${GRID_INT_CLERK_USERNAME}",
								password: "${GRID_INT_CLERK_PASSWORD}",
							},
							admin: {
								login: "web-form",
								username: "${GRID_INT_ADMIN_USERNAME}",
								password: "${GRID_INT_ADMIN_PASSWORD}",
							},
							basic: { login: "https-basic" },
						},
					},
				},
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{
								fields: [{ credential: "username", label: "User" }],
								submit: { role: "button", name: "Next" },
							},
						],
						success: option.success ?? { notOrigin: IDP_URL },
					},
					"https-basic": { kind: "http-basic" },
				},
				allowedOrigins: [IDP_URL],
				...(option.identityCache === undefined
					? {}
					: { identityCache: option.identityCache }),
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		[
			"GRID_INT_CLERK_USERNAME=stage-user-sentinel",
			"GRID_INT_CLERK_PASSWORD=stage-pw-sentinel",
			"GRID_INT_ADMIN_USERNAME=stage-admin-user-sentinel",
			"GRID_INT_ADMIN_PASSWORD=stage-admin-pw-sentinel",
			"",
		].join("\n"),
	);
	if (option.policy)
		fs.writeFileSync(
			stagePaths(configDir).policyFile,
			`${JSON.stringify(option.policy, null, 2)}\n`,
		);
	return configDir;
}

/** The pool and routes of one test, with an injected cache so a test owns its
 * store instead of the process-wide one. */
function build(
	configDir: string,
	driver: ReturnType<typeof createFakeDriver>,
	options: { readonly cache?: StageIdentityCache } = {},
): BrowserRouteDeps & { readonly pool: BrowserPool; readonly logs: string[] } {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-identity-wt-"));
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
		display: () => true,
	});
	let clock = 1_000_000;
	const logs: string[] = [];
	const pool = new BrowserPool({
		driver,
		launch: () => installer.resolveLaunch(undefined),
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
		identity: options.cache,
		// The same deterministic clock the routes use, advancing a second per read, so
		// a refresh interval can be crossed by making a call rather than by waiting.
		now: () => (clock += 1_000),
	});
	const handoff = new LoginHandoffCoordinator({
		pool,
		availability: () => ({ ok: false, reason: "headless-only-browser" }),
		now: () => clock,
	});
	return {
		installer,
		handoff,
		pool,
		configDir,
		worktree,
		settings: () => ({
			maxSessions: 4,
			idleTtlMs: 900_000,
			viewport: DEFAULT_BROWSER_VIEWPORT,
		}),
		stages: new StageUsageRegistry({
			now: () => clock,
			stageSessions: (owner, stage) => pool.stageSessions(owner, stage),
		}),
		locate: (workflowId: string) =>
			workflowId === "wf-stage"
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
		now: () => (clock += 1_000),
		log: (line: string) => logs.push(line),
		logs,
	} as unknown as BrowserRouteDeps & {
		readonly pool: BrowserPool;
		readonly logs: string[];
	};
}

/** One browser route call, as a run makes it. */
async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
	owner = OWNER,
): Promise<{
	status: number;
	value: Record<string, unknown>;
	text: string;
}> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleBrowserRoute(
		deps,
		new Request(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		new URL(url),
		owner,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return {
		status: response.status,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((parsed.error as Record<string, unknown>) ?? {}),
		text,
	};
}

/** One instance-authenticated identity route call. */
async function identityCall(
	routePath: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; value: Record<string, unknown>; text: string }> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleStageIdentityRoute(
		// The route reads one thing from its deps here — the `.env` whose values it
		// scrubs — so a throwaway root is enough.
		{ configDir: identityConfigDir() } as StageRouteDeps,
		new Request(url, {
			method: init.method ?? "GET",
			...(init.body === undefined
				? {}
				: {
						body: JSON.stringify(init.body),
						headers: { "content-type": "application/json" },
					}),
		}),
		routePath,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return {
		status: response.status,
		value: parsed.value as Record<string, unknown>,
		text,
	};
}

/** Open the stage application as one role. */
async function open(
	deps: BrowserRouteDeps,
	role?: string,
	session?: string,
	owner = OWNER,
) {
	return await call(
		deps,
		AGENT_BROWSER_OPEN_PATH,
		{
			stage: "grid-int",
			stageApp: "web",
			...(role === undefined ? {} : { stageRole: role }),
			...(session === undefined ? {} : { session }),
		},
		owner,
	);
}

/** One throwaway root for the identity routes' own `.env` read. */
let routeConfigDir: string | undefined;
function identityConfigDir(): string {
	routeConfigDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "stage-identity-"));
	return routeConfigDir;
}

/** The driver state of one logged-in stage application. */
function driverWithState() {
	return createFakeDriver({
		storageState: loggedInState(),
		sessionStorage: JSON.stringify({ "session-token": SESSION_TOKEN }),
	});
}

function assertValueFree(text: string): void {
	for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
}

describe("capture", () => {
	test("a successful login leaves the stage's own browser state in the cache", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.status).toBe(200);
		// Nothing was cached yet, so nothing was installed and the open says so by
		// not claiming it.
		expect(opened.value.stageRole).toBe("clerk");
		expect(opened.value.identityInstalled).toBeUndefined();
		expect(driver.installedCookies).toEqual([]);

		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			...(opened.value.session === undefined
				? {}
				: { session: String(opened.value.session) }),
		});
		expect(login.status).toBe(200);
		expect(login.value.login).toBe("ok");
		expect(login.value.identity).toBe("recipe");
		assertValueFree(login.text);

		// The cache holds one entry, keyed by the stage and the role, and reports
		// two instants — never a cookie, a name or a value.
		const entries = cache.list();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.stage).toBe("grid-int");
		expect(entries[0]?.role).toBe("clerk");
		expect(entries[0]?.expiresAt).toBeGreaterThan(entries[0]?.capturedAt ?? 0);
		assertValueFree(JSON.stringify(cache));
		assertValueFree(cache.toString());

		// What was captured is the application's and the identity provider's state,
		// and nothing of the third-party origin the page also talked to.
		const state = cache.peek({ stage: "grid-int", role: "clerk" })?.state;
		expect(state?.cookies.map((cookie) => cookie.name).sort()).toEqual([
			".AspNetCore.Session",
			"ESTSAUTH",
		]);
		expect(
			state?.cookies.some((cookie) => cookie.value === THIRD_PARTY_COOKIE),
		).toBe(false);
		expect(
			state?.origins.find((origin) => origin.origin === APP_ORIGIN)
				?.localStorage,
		).toEqual([{ name: "msal.token.keys", value: APP_TOKEN }]);
		expect(
			state?.origins.find((origin) => origin.origin === APP_ORIGIN)
				?.sessionStorage,
		).toEqual([{ name: "session-token", value: SESSION_TOKEN }]);
		expect(
			state?.origins.some((origin) =>
				origin.localStorage.some((entry) => entry.value === THIRD_PARTY_COOKIE),
			),
		).toBe(false);
		// The identity provider's origin is part of the entry even though the
		// capture happened on the application's page: the entry is per origin, so a
		// later session can install a sign-on cookie for the identity provider too.
		expect(state?.origins.map((origin) => origin.origin)).toEqual([
			APP_ORIGIN,
			IDP_ORIGIN,
		]);
		await deps.pool.closeAll();
	});

	test("a stage that opts out captures nothing", async () => {
		const cache = new StageIdentityCache();
		const deps = build(
			configRoot({ identityCache: false }),
			driverWithState(),
			{ cache },
		);
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("a closed session captures what its login left behind", async () => {
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		// A fresh capture on close, so a session that logged in and then worked is
		// remembered as it ended rather than as it started.
		cache.clear();
		await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(opened.value.session),
		});
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(true);
		await deps.pool.closeAll();
	});
});

describe("reuse", () => {
	test("a later session starts from the cached identity and reports it", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const first = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(first.value.session),
		});
		await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(first.value.session),
		});
		expect(cache.size).toBe(1);
		driver.installedCookies.length = 0;
		driver.performed.length = 0;

		// A new session of the same role: the cookies reach the context before the
		// first navigation, and the storage reaches it as an init script.
		const second = await open(deps, "clerk", "reuse");
		expect(second.status).toBe(200);
		expect(second.value.identityInstalled).toBe(true);
		expect(driver.installedCookies).toHaveLength(1);
		expect(
			driver.installedCookies[0]?.map((cookie) => cookie.name).sort(),
		).toEqual([".AspNetCore.Session", "ESTSAUTH"]);
		const session = deps.pool.find(OWNER, "reuse");
		if (session === undefined) throw new Error("the reused session is missing");
		const scripts = (session.context as { initScripts?: string[] }).initScripts;
		expect((scripts ?? []).join("\n")).toContain(APP_TOKEN);
		assertValueFree(second.text);

		// `stage_login` re-checks the recipe's declared condition, and only then
		// answers `ok`: the cache is a hint, the success condition is the decision.
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: "reuse",
		});
		expect(login.status).toBe(200);
		expect(login.value.login).toBe("ok");
		expect(login.value.via).toBe("cache");
		expect(login.value.identity).toBe("cache");
		expect(login.value.verified).toBe(true);
		assertValueFree(login.text);
		// The cached identity replaced the login: no credential was typed at all.
		expect(driver.performed).toEqual([]);
		// The entry stays, and it is the one the reuse just re-verified.
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(true);
		await deps.pool.closeAll();
	});

	test("a rejected identity is evicted and the normal login runs instead", async () => {
		// The declared condition is one this application never reaches, so the cached
		// identity cannot be accepted: the login falls back to the recipe — and the
		// recipe fails on the same condition, which is the honest outcome. What
		// matters is the two things the cache must do: never be trusted alone, and
		// never survive its own rejection.
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(
			configRoot({ success: { url: `${APP_URL}signed-in` } }),
			driver,
			{ cache },
		);
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [
					{
						name: "stale",
						value: "SENT-stale-cookie-0123456789",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);
		// The page is not asking for a second factor: the login simply never reaches
		// the declared condition, which is what this test needs it to do.
		driver.absentControls = [
			'selector=input[autocomplete="one-time-code"]',
			'selector=input[name="otc"]',
			"label=Enter code",
			"label=Code",
		];
		const opened = await open(deps, "clerk", "rejected");
		// The stale entry was installed, so the open says so before anything runs.
		expect(opened.value.identityInstalled).toBe(true);

		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: "rejected",
		});
		// The cache answered "not accepted", so the normal login ran and its own
		// declared condition decided — the cache is a hint, never the decision.
		expect(login.status).toBe(408);
		expect(login.value.code).toBe("login-timeout");
		expect(login.value.identity).toBeUndefined();
		// The recipe really ran: a credential was typed into the form.
		expect(driver.performed.join("\n")).toContain("fillField:label=User=");
		// The rejected entry is gone, and nothing replaced it: a login this call
		// performed is never discredited by the entry it left behind.
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(false);
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("an expired entry is not installed at all", async () => {
		let now = 1_000_000;
		const cache = new StageIdentityCache({ now: () => now, ttlMs: 1_000 });
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [
					{
						name: "expiring",
						value: "SENT-expiring-cookie-0123456789",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);
		now += 2_000;
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk", "late");
		expect(opened.status).toBe(200);
		expect(opened.value.identityInstalled).toBeUndefined();
		expect(driver.installedCookies).toEqual([]);
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("another role and another owner never receive the entry", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [
					{
						name: "clerk-only",
						value: "SENT-clerk-cookie-0123456789",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);
		// `admin` is a different person, and the cache is keyed by the role.
		const admin = await open(deps, "admin", "admin-session");
		expect(admin.status).toBe(200);
		expect(admin.value.identityInstalled).toBeUndefined();
		// A session that names no role starts empty, exactly as before.
		const anonymous = await open(deps, "clerk", "anonymous", OTHER_OWNER);
		expect(anonymous.status).toBe(200);
		expect(anonymous.value.identityInstalled).toBe(true);
		expect(
			driver.installedCookies.flatMap((cookies) =>
				cookies.map((cookie) => cookie.name),
			),
		).toEqual(["clerk-only"]);
		await deps.pool.closeAll();
	});
});

describe("the policy bounds the tree, and its ceilings bound the policy", () => {
	test("a policy above a hard ceiling is clamped, and the stage opts out on its own", async () => {
		const root = configRoot({
			policy: {
				identityCache: {
					ttlMinutes: 100_000,
					maxEntries: 5_000,
					refreshSeconds: 100_000,
				},
			},
		});
		const catalog = readStageCatalog(root);
		expect(catalog.entries[0]?.identity).toEqual({
			enabled: true,
			ttlMs: MAX_IDENTITY_CACHE_TTL_MINUTES * 60_000,
			maxEntries: MAX_IDENTITY_CACHE_ENTRIES,
			refreshMs: MAX_IDENTITY_CACHE_REFRESH_SECONDS * 1_000,
		});
		// A ceiling that had to be applied is said once, with the field it applied
		// to: a silently clamped policy is a policy nobody can debug.
		const warnings = catalog.diagnostics.filter((diagnostic) =>
			diagnostic.field.startsWith("identityCache."),
		);
		expect(warnings.map((diagnostic) => diagnostic.field).sort()).toEqual([
			"identityCache.maxEntries",
			"identityCache.refreshSeconds",
			"identityCache.ttlMinutes",
		]);
		// A diagnostic names the field and the rule, never a value.
		for (const warning of warnings) expect(warning.kind).toBe("warning");

		// The opt-out is the stage's own, and it wins over the policy.
		const off = readStageCatalog(configRoot({ identityCache: false }));
		expect(off.entries[0]?.identity.enabled).toBe(false);

		// The documented defaults are what an empty policy yields.
		const bare = readStageCatalog(configRoot());
		expect(bare.entries[0]?.identity).toEqual({
			enabled: true,
			ttlMs: DEFAULT_IDENTITY_CACHE.ttlMinutes * 60_000,
			maxEntries: DEFAULT_IDENTITY_CACHE.maxEntries,
			refreshMs: DEFAULT_IDENTITY_CACHE.refreshSeconds * 1_000,
		});
		expect(DEFAULT_IDENTITY_CACHE).toEqual({
			ttlMinutes: 240,
			maxEntries: 8,
			refreshSeconds: 120,
		});
	});
});

describe("refresh while the session lives", () => {
	test("a living session re-captures once its refresh interval has passed", async () => {
		// The store keeps its own clock, so a capture's `capturedAt` advances even when
		// the two captures happen inside the same millisecond of wall time.
		let storeClock = 1_800_000_000_000;
		const cache = new StageIdentityCache({ now: () => (storeClock += 1_000) });
		const deps = build(
			// One second of refresh: every later route call is past it, because the
			// test clock advances a second per call.
			configRoot({ policy: { identityCache: { refreshSeconds: 1 } } }),
			driverWithState(),
			{ cache },
		);
		const opened = await open(deps, "clerk");
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(login.status).toBe(200);
		const key = { stage: "grid-int", role: "clerk" };
		const captured = cache.peek(key);
		if (captured === undefined) throw new Error("the login captured nothing");

		// A browser call on the same session is the moment a rotated token has to
		// reach the cache: the entry is refreshed before the call itself runs.
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		const refreshed = cache.peek(key);
		if (refreshed === undefined)
			throw new Error("the refresh dropped the entry");
		expect(refreshed.capturedAt).toBeGreaterThan(captured.capturedAt);
		// The refresh is a re-capture of the same living page, so the state is the
		// same one and nothing was lost on the way through.
		expect(refreshed.state.cookies.map((cookie) => cookie.name)).toEqual(
			captured.state.cookies.map((cookie) => cookie.name),
		);
		expect(cache.size).toBe(1);
		await deps.pool.closeAll();
	});

	test("a session with nothing captured yet is not refreshed into an empty entry", async () => {
		const cache = new StageIdentityCache();
		const deps = build(
			configRoot({ policy: { identityCache: { refreshSeconds: 1 } } }),
			driverWithState(),
			{ cache },
		);
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		// No login ran, so there is nothing a capture could stand for: an open alone
		// never invents an identity out of a page that may be showing a login form.
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});
});

describe("no cached value leaves a surface", () => {
	test("every browser reply is scrubbed with the cached values", async () => {
		// The page itself echoes the cached cookie and the cached storage token: the
		// scrubbing this test asserts is the redactor's, not the driver's.
		const driver = createFakeDriver({
			storageState: loggedInState(),
			sessionStorage: JSON.stringify({ "session-token": SESSION_TOKEN }),
			snapshot: `${SESSION_COOKIE}\n${APP_TOKEN}\n${IDP_COOKIE}\nbutton "Sign out" [ref=e0]`,
			content: `<html><body><form><input name="q" value="${SESSION_COOKIE}"></form></body></html>`,
		});
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(login.status).toBe(200);
		expect(cache.size).toBe(1);
		assertValueFree(login.text);
		// The login captured it, so it is a secret of the session now: the snapshot
		// the page produced comes back masked, and so does everything else the
		// browser layer answers from here on.
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		expect(snapshot.text).toContain("«redacted:");
		assertValueFree(snapshot.text);
		const closed = await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(opened.value.session),
		});
		assertValueFree(closed.text);
		await deps.pool.closeAll();
	});

	test("the store, its serialisation and the log lines carry no value", async () => {
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(login.status).toBe(200);
		const store = deps.pool.identityStore();
		expect(store.size).toBe(1);
		// Three ways to look at the store, none of which is a value: the listing, the
		// JSON a snapshot or a log line would serialise, and the string form.
		assertValueFree(JSON.stringify(store.list()));
		assertValueFree(JSON.stringify(store));
		assertValueFree(String(store));
		assertValueFree(JSON.stringify(deps.pool.identities()));
		// The session's log lines and the guard's own record carry none either.
		assertValueFree(deps.logs.join("\n"));
		await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(opened.value.session),
		});
		// Closing the session captures before the context goes, and still reports
		// nothing: a clean close is not a place a value appears.
		expect(cache.size).toBe(1);
		assertValueFree(JSON.stringify(store.list()));
		assertValueFree(deps.logs.join("\n"));
		await deps.pool.closeAll();
	});

	test("a fresh process has an empty cache: nothing was written anywhere", async () => {
		const cache = new StageIdentityCache();
		const root = configRoot();
		const deps = build(root, driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(1);
		// Nothing on disk: the throwaway configuration root and its `.env` are the
		// only files this test wrote, and neither grew a cache.
		expect(fs.readdirSync(root).sort()).toEqual([".env", "stages"]);
		const defsDir = stagePaths(root).defsDir;
		if (defsDir === undefined) throw new Error("the stage root is missing");
		const stageFiles = fs
			.readdirSync(defsDir)
			.flatMap((name) => fs.readFileSync(path.join(defsDir, name), "utf8"));
		assertValueFree(stageFiles.join("\n"));
		// A new store — what the process does on restart — holds nothing.
		expect(new StageIdentityCache().size).toBe(0);
		expect(new StageIdentityCache().list()).toEqual([]);
		await deps.pool.closeAll();
	});
});

describe("the cache is owned by the server, not by a run", () => {
	test("a role the application does not declare is refused", async () => {
		const deps = build(configRoot(), driverWithState(), {
			cache: new StageIdentityCache(),
		});
		const refused = await open(deps, "nobody");
		expect(refused.status).toBe(404);
		expect(refused.value.code).toBe("stage-role-unknown");
		expect(String(refused.value.message)).toContain("clerk");
		await deps.pool.closeAll();
	});

	test("the listing is value-free and the forget removes exactly one key", async () => {
		resetStageIdentityCache();
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		await deps.pool.closeAll();
		// The routes read the process store, which is what the server owns; the
		// pool's own store is injected above, so the listing is driven through the
		// process one to keep the two seams apart.
		const process = (
			await import("../src/server/stages/identity-cache.ts")
		).stageIdentityCache();
		process.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [
					{
						name: "listed",
						value: "SENT-listed-cookie-0123456789",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);
		process.put(
			{ stage: "grid-int", role: "admin" },
			{
				cookies: [
					{
						name: "listed-admin",
						value: "SENT-listed-admin-cookie-0123456789",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		);

		const listed = await identityCall(STAGES_IDENTITY_PATH);
		expect(listed.status).toBe(200);
		const entries = listed.value.entries as Array<Record<string, unknown>>;
		expect(entries.map((entry) => entry.role).sort()).toEqual([
			"admin",
			"clerk",
		]);
		for (const entry of entries)
			expect(Object.keys(entry).sort()).toEqual([
				"capturedAt",
				"expiresAt",
				"role",
				"stage",
			]);
		assertValueFree(listed.text);

		const forgotten = await identityCall(STAGES_IDENTITY_FORGET_PATH, {
			method: "POST",
			body: { stage: "grid-int", role: "clerk" },
		});
		expect(forgotten.status).toBe(200);
		expect(forgotten.value.removed).toBe(1);
		expect(
			(forgotten.value.entries as Array<Record<string, unknown>>).map(
				(entry) => entry.role,
			),
		).toEqual(["admin"]);
		assertValueFree(forgotten.text);

		// A forget of a stage that holds nothing is a no-op, not an error.
		const nothing = await identityCall(STAGES_IDENTITY_FORGET_PATH, {
			method: "POST",
			body: { stage: "grid-int", role: "clerk" },
		});
		expect(nothing.value.removed).toBe(0);
		// A GET on the forget path is refused: the listing is the read.
		const wrongMethod = await identityCall(STAGES_IDENTITY_FORGET_PATH);
		expect(wrongMethod.status).toBe(405);
		resetStageIdentityCache();
	});
});
