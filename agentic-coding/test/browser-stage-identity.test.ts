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
	MIN_IDENTITY_CACHE_REFRESH_SECONDS,
	resetStageIdentityCache,
	StageIdentityCache,
	stageIdentityCache,
} from "../src/server/stages/identity-cache.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import {
	forgetStageIdentity,
	handleStageIdentityRoute,
	poolIdentityForget,
	registerStageIdentityForget,
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
	// The two values the identity-route test puts into the process store. They
	// belong to this list: a sentinel the assertion does not name is a sentinel that
	// can leak unnoticed (TESTQ-002).
	"LISTED_COOKIE",
	"LISTED_ADMIN_COOKIE",
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
	options: {
		readonly cache?: StageIdentityCache;
		/** Shortens the capture bound, so a driver call that never answers is
		 * dropped by the test rather than waited out. */
		readonly identityCaptureTimeoutMs?: number;
		/** Replaces the pool's clock. The refresh interval is counted from it, so a
		 * test that has to cross a floor of tens of seconds makes the clock step
		 * rather than wait. */
		readonly now?: () => number;
	} = {},
): BrowserRouteDeps & {
	readonly pool: BrowserPool;
	readonly logs: string[];
	readonly worktree: string;
} {
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
		identityCaptureTimeoutMs: () => options.identityCaptureTimeoutMs ?? 5_000,
		// The same deterministic clock the routes use, advancing a second per read, so
		// a refresh interval can be crossed by making a call rather than by waiting.
		now: options.now ?? (() => (clock += 1_000)),
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
		// The seam `app.ts` wires: the forget is the pool's, not the store's, so the
		// route exercises the implementation the server uses.
		identityForget: (filter: { stage?: string; role?: string }) => ({
			removed: pool.forgetIdentity(filter),
			entries: pool.identityStore().list(),
		}),
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
		readonly worktree: string;
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
	init: { method?: string; body?: unknown; deps?: StageRouteDeps } = {},
): Promise<{ status: number; value: Record<string, unknown>; text: string }> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleStageIdentityRoute(
		// By default the route reads one thing from its deps — the `.env` whose values
		// it scrubs — so a throwaway root is enough. A test that exercises the forget
		// seam passes the deps that carry it.
		init.deps ?? ({ configDir: identityConfigDir() } as StageRouteDeps),
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

function everyFile(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...everyFile(full));
		else if (entry.isFile()) found.push(full);
	}
	return found;
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
		// The positive control for every test that pins this count: one login
		// outcome is one `storageState()` read, so a later count that stays where it
		// was means the capture was refused rather than merely small (TESTQ-014).
		expect(driver.storageStateCalls).toBe(1);

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
		// One clock for the pool and the store, so the instants the entry carries are
		// the ones the refresh interval is measured against.
		let clock = 1_800_000_000_000;
		const cache = new StageIdentityCache({ now: () => clock });
		// Past the refresh floor (`MIN_IDENTITY_CACHE_REFRESH_SECONDS`), which a
		// declared interval can never go below: one clock step, and the policy's
		// one-second interval is already exceeded at the floor it was clamped to.
		const deps = build(
			configRoot({ policy: { identityCache: { refreshSeconds: 1 } } }),
			driverWithState(),
			{
				cache,
				now: () =>
					(clock += MIN_IDENTITY_CACHE_REFRESH_SECONDS * 1_000 + 1_000),
			},
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

	test("a capture reaches memory only: no file the run can write holds a value", async () => {
		// Task 3.2's proof, stated for what it can see. Every surface that *could*
		// record a value is inside one of the three trees walked below — the run's
		// worktree (where evidence, telemetry and a worktree-local store would land),
		// the configuration root, and a throwaway HOME this test owns, so a
		// `$HOME`-relative store, wiki or telemetry file would be found too. A heap
		// snapshot is memory, not a file any of this writes (design D6).
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "stage-identity-home-"));
		const saved = {
			home: process.env.HOME,
			config: process.env.AGENTIC_CODING_CONFIG_DIR,
			wiki: process.env.HERDR_WIKI_DIR,
		};
		process.env.HOME = home;
		process.env.AGENTIC_CODING_CONFIG_DIR = path.join(home, "config");
		process.env.HERDR_WIKI_DIR = path.join(home, "wiki");
		try {
			const cache = new StageIdentityCache();
			const root = configRoot();
			const deps = build(root, driverWithState(), { cache });
			const opened = await open(deps, "clerk");
			await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "clerk",
				session: String(opened.value.session),
			});
			// The guard on the assertion: the capture really happened, so an empty
			// walk cannot pass by finding nothing anywhere.
			expect(cache.size).toBe(1);
			await deps.pool.closeAll();
			// Two trees are all-but-empty by construction (`HOME` is where a store,
			// a wiki or a telemetry file would land if anything wrote one), and the
			// walk has to cover them too — an empty tree is the answer, not an
			// excuse. The other two are the ones that always hold files, so a broken
			// walk cannot pass unnoticed.
			for (const file of everyFile(home))
				assertValueFree(fs.readFileSync(file, "utf8"));
			for (const tree of [deps.worktree, root]) {
				const files = everyFile(tree);
				expect(files.length).toBeGreaterThan(0);
				for (const file of files)
					assertValueFree(fs.readFileSync(file, "utf8"));
			}
			// The route log is the one surface the walk above cannot see.
			assertValueFree(deps.logs.join("\n"));
			// Nothing on disk: the configuration root still holds only what the
			// fixture wrote.
			expect(fs.readdirSync(root).sort()).toEqual([".env", "stages"]);
			// A new store — what the process does on restart — holds nothing.
			expect(new StageIdentityCache().size).toBe(0);
			expect(new StageIdentityCache().list()).toEqual([]);
		} finally {
			for (const [key, value] of Object.entries({
				HOME: saved.home,
				AGENTIC_CODING_CONFIG_DIR: saved.config,
				HERDR_WIKI_DIR: saved.wiki,
			}))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			fs.rmSync(home, { recursive: true, force: true });
		}
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

	test("the registered forget answers both halves from its own store", () => {
		// The Settings path has no transport, so it reaches the process's forget
		// (D5). Removed count and listing come from one store: a listing taken from
		// the process store would report another cache's entries
		// (QUALITY-203/CONC-303).
		const store = new StageIdentityCache();
		store.put({ stage: "grid-int", role: "clerk" }, cachedState());
		registerStageIdentityForget((filter) => ({
			removed: store.forget(filter),
			entries: store.list(),
		}));
		try {
			expect(forgetStageIdentity({ stage: "grid-int" })).toEqual({
				removed: 1,
				entries: [],
			});
		} finally {
			registerStageIdentityForget();
		}
		// With no registration the process store answers both halves; nothing of the
		// injected seam survives the clear.
		const fallback = forgetStageIdentity({ stage: "no-such-stage" });
		expect(fallback.removed).toBe(0);
		expect(fallback.entries).toEqual(stageIdentityCache().list());
	});

	test("the shipped forget counts and lists from the pool it was built on", () => {
		// `app.ts` wires exactly this function (`poolIdentityForget(browser.pool)`),
		// so it is tested rather than re-implemented: a forget that counted from the
		// pool and listed from the process store would describe a cache it never
		// touched (QUALITY-203/CONC-303/TESTQ-016).
		resetStageIdentityCache();
		const pool = new StageIdentityCache();
		pool.put({ stage: "grid-int", role: "clerk" }, cachedState());
		stageIdentityCache().put(
			{ stage: "grid-int", role: "admin" },
			cachedState(),
		);
		const shipped = poolIdentityForget({
			forgetIdentity: (filter) => pool.forget(filter),
			identityStore: () => pool,
		});
		expect(shipped({ stage: "grid-int" })).toEqual({ removed: 1, entries: [] });
		// The process store was never consulted, in either half.
		expect(stageIdentityCache().size).toBe(1);
		resetStageIdentityCache();
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
						value: "LISTED_COOKIE",
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
						value: "LISTED_ADMIN_COOKIE",
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
				"truncated",
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

type CapturedState = Parameters<StageIdentityCache["put"]>[1];

/** The state a cached entry holds for the fake driver: the same sentinels the
 * driver reports, so an install and a capture are comparable. */
function cachedState(
	option: { readonly expired?: boolean } = {},
): CapturedState {
	return {
		cookies: [
			{
				name: "cached-session",
				value: SESSION_COOKIE,
				domain: "grid-int.example.test",
				path: "/",
				expires: -1,
				httpOnly: true,
				secure: true,
				sameSite: "Lax" as const,
			},
			...(option.expired === true
				? [
						{
							name: "cached-expired",
							value: IDP_COOKIE,
							domain: ".example.test",
							path: "/",
							// A cookie's own expiry is independent of the entry's TTL, so an
							// entry can hold one the browser would discard.
							expires: 1,
							httpOnly: true,
							secure: true,
						},
					]
				: []),
		],
		origins: [
			{
				origin: APP_ORIGIN,
				localStorage: [{ name: "msal.token.keys", value: APP_TOKEN }],
				sessionStorage: [{ name: "session-token", value: SESSION_TOKEN }],
			},
			{ origin: IDP_ORIGIN, localStorage: [], sessionStorage: [] },
		],
	};
}

describe("install order and the store's own bounds", () => {
	test("another origin's sessionStorage survives a capture that read one origin", async () => {
		const cache = new StageIdentityCache();
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [],
				origins: [
					{
						origin: APP_ORIGIN,
						localStorage: [{ name: "msal.token.keys", value: APP_TOKEN }],
						sessionStorage: [],
					},
					{
						origin: IDP_ORIGIN,
						localStorage: [],
						// A sign-on token the page cannot be asked for: only a script on
						// that origin can read it.
						sessionStorage: [{ name: "idp-session", value: IDP_COOKIE }],
					},
				],
			},
		);
		const driver = createFakeDriver({
			storageState: loggedInState(),
			sessionStorage: JSON.stringify({ "session-token": SESSION_TOKEN }),
		});
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(true);
		const origins =
			cache.peek({ stage: "grid-int", role: "clerk" })?.state.origins ?? [];
		// The origin the capture *did* read is the page's new truth...
		expect(
			origins.find((origin) => origin.origin === APP_ORIGIN)?.sessionStorage,
		).toEqual([{ name: "session-token", value: SESSION_TOKEN }]);
		// ...and the origin it could not read keeps what the entry had, or a stage
		// with several origins would lose the identity provider's token on every
		// capture (TESTQ-009).
		expect(
			origins.find((origin) => origin.origin === IDP_ORIGIN)?.sessionStorage,
		).toEqual([{ name: "idp-session", value: IDP_COOKIE }]);
		await deps.pool.closeAll();
	});

	test("the cached identity reaches the context before the first navigation", async () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.value.identityInstalled).toBe(true);
		// The order, not merely the presence: cookies and the storage script belong to
		// the context before a page of it is ever navigated, or the first document
		// would render a signed-out shell and the token would arrive a round trip too
		// late (D3).
		const cookies = driver.events.indexOf("addCookies");
		const script = driver.events.indexOf("addInitScript");
		const firstGoto = driver.events.findIndex((event) =>
			event.startsWith("goto "),
		);
		expect(cookies).toBeGreaterThanOrEqual(0);
		expect(script).toBeGreaterThanOrEqual(0);
		expect(firstGoto).toBeGreaterThan(cookies);
		expect(firstGoto).toBeGreaterThan(script);
		await deps.pool.closeAll();
	});

	test("a cookie of the entry that has expired is not installed", async () => {
		// The entry was captured when that cookie had a second of life left, which is
		// what the store's own clock says here; the install happens now.
		const cache = new StageIdentityCache({ now: () => 1 });
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			cachedState({ expired: true }),
		);
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.status).toBe(200);
		// `put` kept it — a cookie's own expiry is a browser fact, not an entry fact —
		// and the install drops it, because a browser would discard it anyway.
		expect(
			cache.peek({ stage: "grid-int", role: "clerk" })?.state.cookies,
		).toHaveLength(2);
		expect(
			driver.installedCookies.flatMap((cookies) =>
				cookies.map((cookie) => cookie.name),
			),
		).toEqual(["cached-session"]);
		await deps.pool.closeAll();
	});
});

describe("a capture that finds nothing", () => {
	test("an empty capture does not overwrite an entry that holds something", async () => {
		// A clock that moves on every read, so "the instant did not change" is a
		// statement about the store rather than about a frozen clock (TESTQ-011).
		let clock = 1_700_000_000_000;
		const cache = new StageIdentityCache({ now: () => (clock += 1_000) });
		// The context reports no browser state at all — the token-only login D2 names
		// — and it was opened while the cache was empty, so no install put anything
		// into it: what it reads really is nothing.
		const driver = createFakeDriver({
			storageState: { cookies: [], origins: [] },
		});
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		const seeded = cache.peek({ stage: "grid-int", role: "clerk" });
		if (seeded === undefined) throw new Error("the seed entry is missing");
		const before = seeded.capturedAt;
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(false);
		// An empty fact is not a newer truth: what the earlier capture held is still
		// the best thing this server knows about the session.
		const entry = cache.peek({ stage: "grid-int", role: "clerk" });
		expect(entry?.state.cookies.map((cookie) => cookie.name)).toEqual([
			"cached-session",
		]);
		expect(entry?.capturedAt).toBe(before);
		expect(cache.list()[0]?.capturedAt).toBe(before);
		// The control that makes the assertion above mean something: another key put
		// through the same store does carry the newer instant.
		cache.put({ stage: "grid-int", role: "admin" }, cachedState());
		expect(
			cache.peek({ stage: "grid-int", role: "admin" })?.capturedAt,
		).not.toBe(before);
		await deps.pool.closeAll();
	});

	test("a capture whose only values are below the floor never replaces an entry", async () => {
		// The floor is the redactor's own, so a value under it is dropped on the way
		// in rather than kept and left unmasked. A capture left with nothing is the
		// same fact as an empty one, and it does not overwrite an entry (TESTQ-019).
		const cache = new StageIdentityCache();
		const driver = createFakeDriver({
			storageState: {
				cookies: [
					{
						name: "tiny",
						value: "abc",
						domain: "grid-int.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [],
			},
		});
		const deps = build(configRoot(), driver, { cache });
		// Opened while the cache is empty, so no install put anything into the context.
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		const before = cache.peek({ stage: "grid-int", role: "clerk" })?.capturedAt;
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(false);
		const entry = cache.peek({ stage: "grid-int", role: "clerk" });
		expect(entry?.state.cookies.map((cookie) => cookie.name)).toEqual([
			"cached-session",
		]);
		expect(entry?.capturedAt).toBe(before);
		await deps.pool.closeAll();
	});
});

describe("a session that changes role, and the forget against it", () => {
	test("a login of another role into an installed context is not captured", async () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.value.identityInstalled).toBe(true);
		const reads = driver.storageStateCalls;
		// The context carries the clerk's cookies; a login that names the admin role
		// is still the clerk's browser, so its state must not be filed under the
		// admin key (CONC-001/QUALITY-004).
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "admin",
			session: String(opened.value.session),
		});
		expect(login.status).toBe(200);
		expect(cache.holds({ stage: "grid-int", role: "admin" })).toBe(false);
		// Refused before the read, not after it: a capture that ran and discarded
		// the result would still have serialised another user's whole context
		// (TESTQ-014).
		expect(driver.storageStateCalls).toBe(reads);
		// The role it *was* installed for keeps exactly what it had.
		expect(
			cache.peek({ stage: "grid-int", role: "clerk" })?.state.cookies,
		).toHaveLength(1);
		await deps.pool.closeAll();
	});

	test("a context that logged in as two roles fills neither key", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		// No install and no cache: the mixed jar is two developer logins in one
		// window, which `stage_login` allows (SEC-001).
		const opened = await open(deps, "clerk");
		const session = String(opened.value.session);
		const clerk = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session,
		});
		expect(clerk.status).toBe(200);
		expect(cache.holds({ stage: "grid-int", role: "clerk" })).toBe(true);
		const admin = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "admin",
			session,
		});
		expect(admin.status).toBe(200);
		// The admin login reuses the clerk's context, so the jar it reads now holds
		// both users' cookies. Filing it under `admin` would hand the clerk's session
		// to a later admin run, so the second login captures nothing at all — and it
		// does not capture the clerk's key again either.
		expect(cache.holds({ stage: "grid-int", role: "admin" })).toBe(false);
		expect(cache.list().map((entry) => entry.role)).toEqual(["clerk"]);
		await deps.pool.closeAll();
	});

	test("a forget keeps the login history the mixed-jar guard reads", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		for (const role of ["clerk", "admin"]) {
			const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role,
				session: String(opened.value.session),
			});
			expect(login.status).toBe(200);
		}
		expect(session.identity?.loggedRoles).toEqual(["clerk", "admin"]);
		// The forget rewrites the attribution and nothing else: a rewrite that
		// re-enumerated the fields dropped `loggedRoles`, so the same context could
		// file its mixed jar under one user afterwards (SEC-001/CONC-401).
		deps.pool.forgetIdentity({ stage: "grid-int" });
		expect(session.identity?.loggedRoles).toEqual(["clerk", "admin"]);
		expect(session.identity?.source).toBeUndefined();
		expect(session.identity?.capturedAt).toBeUndefined();
		const admin = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "admin",
			session: String(opened.value.session),
		});
		expect(admin.status).toBe(200);
		expect(cache.holds({ stage: "grid-int", role: "admin" })).toBe(false);
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("a capture adds to the secret set instead of replacing it", async () => {
		// The install and the capture both write that set, and a capture only reports
		// what it read: a replace would drop the values an install registered for a
		// context that still carries them (TESTQ-020).
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		const installedOnly = "SENT-installed-only-value-0123456789";
		session.installedIdentitySecrets = [
			{ name: "stage-identity-cookie", value: installedOnly },
		];
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(true);
		const registered = session.installedIdentitySecrets.map(
			(secret) => secret.value,
		);
		expect(registered).toContain(installedOnly);
		// The capture's own values joined it rather than standing in for it.
		expect(registered).toContain(SESSION_COOKIE);
		expect(deps.pool.installedIdentitySecrets()).toContainEqual({
			name: "stage-identity-cookie",
			value: installedOnly,
		});
		await deps.pool.closeAll();
	});

	test("a capture queued behind another is dropped once the interval has passed", async () => {
		// The interval is a decision, so it is checked again inside the gate: two
		// browser calls that both saw it elapsed before either finished must not read
		// the context twice (TESTQ-018/CONC-302).
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		const reads = driver.storageStateCalls;
		driver.holdStorageState = true;
		const first = deps.pool.captureIdentity(session, "recipe", {
			minIntervalMs: 60_000,
		});
		for (
			let index = 0;
			index < 200 && driver.pendingStorageStates === 0;
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(driver.pendingStorageStates).toBe(1);
		// Admitted before the first one stamped the attempt, so only the in-gate
		// check can stop it.
		const second = deps.pool.captureIdentity(session, "recipe", {
			minIntervalMs: 60_000,
		});
		driver.holdStorageState = false;
		driver.releaseStorageState();
		expect(await first).toBe(true);
		expect(await second).toBe(false);
		// One read for the two captures: the queued one returned before reading.
		expect(driver.storageStateCalls).toBe(reads + 1);
		await deps.pool.closeAll();
	});

	test("a capture that read the store across a role change is dropped", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		driver.holdStorageState = true;
		const capture = deps.pool.captureIdentity(session, "recipe");
		// Wait for the read to be in flight rather than guessing at it.
		for (
			let index = 0;
			index < 200 && driver.pendingStorageStates === 0;
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(driver.pendingStorageStates).toBe(1);
		// `stage_login` naming another role wins over a capture that is already
		// reading: the write would otherwise file one user's state under another's
		// key.
		session.identity = { role: "admin", cacheInstalled: false };
		driver.releaseStorageState();
		expect(await capture).toBe(false);
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("a capture waiting behind another is dropped by a forget that lands first", async () => {
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		const source = session.identity?.source;
		expect(source).toBe("recipe");
		driver.holdStorageState = true;
		const first = deps.pool.captureIdentity(session, source ?? "recipe", {
			expectedSource: source,
		});
		for (
			let index = 0;
			index < 200 && driver.pendingStorageStates === 0;
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(driver.pendingStorageStates).toBe(1);
		// The second capture waits behind the first, so it enters the gate only after
		// the forget below has moved the key's generation and cleared the session's
		// source — both re-checks have to drop it, not just the generation (CONC-001,
		// TESTQ-015).
		const second = deps.pool.captureIdentity(session, source ?? "recipe", {
			expectedSource: source,
		});
		deps.pool.forgetIdentity({ stage: "grid-int", role: "clerk" });
		driver.holdStorageState = false;
		driver.releaseStorageState();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("a forget holds against the refresh and the clean close", async () => {
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(1);
		expect(deps.pool.forgetIdentity({ stage: "grid-int", role: "clerk" })).toBe(
			1,
		);
		// The live session keeps its browser state — a forget is not a logout — but
		// neither its next refresh nor its clean close may put the key back
		// (CONC-002).
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		expect(cache.size).toBe(0);
		await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(0);
		expect(cache.list()).toEqual([]);
		await deps.pool.closeAll();
	});

	test("the values a live context installed stay redacted after a forget", async () => {
		// The page echoes the very values the entry installs, so the only thing that
		// can keep them out of the reply is the redaction set (SEC-001).
		const driver = createFakeDriver({
			storageState: { cookies: [], origins: [] },
			snapshot: `${SESSION_COOKIE}\n${APP_TOKEN}\nbutton "Sign out" [ref=e0]`,
		});
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.value.identityInstalled).toBe(true);
		expect(deps.pool.installedIdentitySecrets().length).toBeGreaterThan(0);
		// Forgotten while the context still carries the cookies and the storage: the
		// values are credentials for as long as a browser this server drives has them.
		deps.pool.forgetIdentity({ stage: "grid-int", role: "clerk" });
		expect(cache.size).toBe(0);
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		expect(snapshot.text).toContain("«redacted:");
		assertValueFree(snapshot.text);
		await deps.pool.closeAll();
	});
});

describe("a session that logged in itself", () => {
	test("keeps its captured values masked after the entry is forgotten", async () => {
		// SEC-002: nothing was installed, so the pool knows these values only because
		// the capture recorded them on the session itself.
		const driver = createFakeDriver({
			storageState: loggedInState(),
			snapshot: `${APP_TOKEN}\n${IDP_COOKIE}\nbutton "Sign out" [ref=e0]`,
		});
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		expect(opened.value.identityInstalled).toBeUndefined();
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(login.value.login).toBe("ok");
		expect(cache.size).toBe(1);
		expect(deps.pool.installedIdentitySecrets().length).toBeGreaterThan(0);
		// The entry goes, the browser does not: the values are still credentials for
		// as long as this server drives that context.
		deps.pool.forgetIdentity({});
		expect(cache.size).toBe(0);
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		expect(snapshot.text).toContain("«redacted:");
		expect(snapshot.text).not.toContain(APP_TOKEN);
		expect(snapshot.text).not.toContain(IDP_COOKIE);
		await deps.pool.closeAll();
	});
});

describe("the operator forget, and the pool it has to reach", () => {
	test("a route forget moves the key on, so the refresh and the clean close cannot restore it", async () => {
		// SEC-001/QUALITY-101: a forget that only dropped the entry would be undone by
		// the live session's next capture, which is why the route goes through the
		// pool's forget rather than the store's.
		const cache = new StageIdentityCache();
		const deps = build(configRoot(), driverWithState(), { cache });
		const opened = await open(deps, "clerk");
		await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(1);
		const forgotten = await identityCall(STAGES_IDENTITY_FORGET_PATH, {
			method: "POST",
			body: { stage: "grid-int", role: "clerk" },
			deps: deps as unknown as StageRouteDeps,
		});
		expect(forgotten.status).toBe(200);
		expect(forgotten.value.removed).toBe(1);
		expect(forgotten.value.entries).toEqual([]);
		// A call that would refresh the session, and then the close that would capture
		// it one last time: neither may bring the key back.
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(opened.value.session),
		});
		expect(snapshot.status).toBe(200);
		expect(cache.size).toBe(0);
		await call(deps, AGENT_BROWSER_CLOSE_PATH, {
			session: String(opened.value.session),
		});
		expect(cache.size).toBe(0);
		await deps.pool.closeAll();
	});

	test("the whole-cache scope removes every key", async () => {
		const cache = new StageIdentityCache();
		cache.put({ stage: "grid-int", role: "clerk" }, cachedState());
		cache.put({ stage: "retired", role: "admin" }, cachedState());
		expect(cache.size).toBe(2);
		const deps = build(configRoot(), driverWithState(), { cache });
		const forgotten = await identityCall(STAGES_IDENTITY_FORGET_PATH, {
			method: "POST",
			body: {},
			deps: deps as unknown as StageRouteDeps,
		});
		expect(forgotten.value.removed).toBe(2);
		expect(forgotten.value.entries).toEqual([]);
		await deps.pool.closeAll();
	});
});

describe("a capture that cannot finish", () => {
	test("a driver read that never answers is dropped instead of hanging the call", async () => {
		// PERF-005: the bound is what keeps one unresponsive driver call from hanging
		// the browser call that triggered the capture.
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, {
			cache,
			identityCaptureTimeoutMs: 5,
		});
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		driver.holdStorageState = true;
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(false);
		expect(cache.size).toBe(0);
		driver.releaseStorageState();
		await deps.pool.closeAll();
	});

	test("two sessions of one key capture one at a time", async () => {
		// CONC-202: the gate is the store's key, not the session, so two browser
		// sessions of one `(stage, role)` cannot read the context alongside each other
		// and write the entry out of order.
		const cache = new StageIdentityCache();
		const driver = driverWithState();
		const deps = build(configRoot(), driver, { cache });
		await open(deps, "clerk", "first");
		await open(deps, "clerk", "second");
		const first = deps.pool.find(OWNER, "first");
		const second = deps.pool.find(OWNER, "second");
		if (first === undefined || second === undefined)
			throw new Error("both sessions have to exist");
		driver.holdStorageState = true;
		const one = deps.pool.captureIdentity(first, "user");
		for (
			let index = 0;
			index < 200 && driver.pendingStorageStates === 0;
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(driver.pendingStorageStates).toBe(1);
		const two = deps.pool.captureIdentity(second, "user");
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The second is waiting on the key's gate, not reading beside the first.
		expect(driver.pendingStorageStates).toBe(1);
		driver.holdStorageState = false;
		driver.releaseStorageState();
		expect(await one).toBe(true);
		expect(await two).toBe(true);
		await deps.pool.closeAll();
	});

	test("a sessionStorage read that failed keeps what the entry had for that origin", async () => {
		// QUALITY-103: a read that throws is not an empty storage. Replacing the origin
		// with nothing would drop a token the previous capture had kept, and the next
		// session would start without it.
		const cache = new StageIdentityCache();
		cache.put(
			{ stage: "grid-int", role: "clerk" },
			{
				cookies: [],
				origins: [
					{
						origin: APP_ORIGIN,
						localStorage: [{ name: "app-token", value: APP_TOKEN }],
						sessionStorage: [{ name: "session-token", value: SESSION_TOKEN }],
					},
				],
			},
		);
		const driver = createFakeDriver({
			storageState: loggedInState(),
			failSessionStorage: true,
		});
		const deps = build(configRoot(), driver, { cache });
		const opened = await open(deps, "clerk");
		const session = deps.pool.find(OWNER, String(opened.value.session));
		if (session === undefined) throw new Error("the session is missing");
		expect(await deps.pool.captureIdentity(session, "recipe")).toBe(true);
		const kept = cache
			.peek({ stage: "grid-int", role: "clerk" })
			?.state.origins.find((origin) => origin.origin === APP_ORIGIN);
		expect(kept?.sessionStorage).toEqual([
			{ name: "session-token", value: SESSION_TOKEN },
		]);
		await deps.pool.closeAll();
	});
});
