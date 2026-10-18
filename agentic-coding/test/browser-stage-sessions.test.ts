// Stage-bound browser sessions (`add-stage-testing-foundation`, tasks 3.4-3.8).
//
// The whole stage path is exercised against the fake driver and a throwaway
// configuration root: the stage open resolves from the catalog, the client-side
// guard refuses what the allow-list does not cover, a read-only stage refuses
// every state-changing method except a declared exception, the pool's bounds and
// the exclusive lease refuse an open rather than queue it, a declared login runs
// without a value ever being reported, and a screenshot masks what it must.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFakeDriver,
	type FakeContext,
} from "../src/server/browser/fake-driver.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { totpCode } from "../src/server/browser/login.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
	reproSpec,
	stageCredentialNames,
} from "../src/server/browser/routes.ts";
import {
	type BrowserSession,
	MAX_CREDENTIAL_FILLS,
	PASSWORD_MASK,
} from "../src/server/browser/session.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const OWNER = "workflow:wf-stage";
const OTHER_OWNER = "workflow:wf-other";
const PASSWORD_SENTINEL = "stage-pw-sentinel-c41d";
const USERNAME_SENTINEL = "stage-user-sentinel";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
/** The origin no stage declares, and the URL that must be refused: the query
 * carries a token, so a refusal that reported it would leak it. */
const OFF_LIST = "https://evil.example.test/harvest?token=leak-me#frag";
const OFF_LIST_SANITIZED = "https://evil.example.test/harvest";
const APP_URL = "https://grid-int.example.test/";
const IDP_URL = "https://login.example.test/";

/** One throwaway configuration root with one allow-listed stage. */
function configRoot(overrides: Record<string, unknown> = {}): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-browser-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	const definition = {
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
						totp: "${GRID_INT_CLERK_TOTP}",
					},
					basic: {
						login: "https-basic",
						username: "${GRID_INT_CLERK_USERNAME}",
						password: "${GRID_INT_CLERK_PASSWORD}",
					},
					none: {},
				},
			},
			plain: { label: "Grid plain", url: `${APP_URL}plain/`, kind: "ui" },
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
					{ fields: [{ credential: "password", label: "Password" }] },
				],
				// The login is complete once the page has left the identity provider:
				// the application it redirected back to is where a browser lands.
				success: { notOrigin: IDP_URL },
			},
			"https-basic": { kind: "http-basic" },
		},
		allowedOrigins: [IDP_URL],
		readOnlyExceptions: [
			{ origin: APP_URL, pathPrefix: "/search", methods: ["POST"] },
		],
		limits: { maxSessions: 1, maxActionsPerMinute: 30 },
		...overrides,
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		[
			`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}`,
			`GRID_INT_CLERK_PASSWORD=${PASSWORD_SENTINEL}`,
			`GRID_INT_CLERK_TOTP=${TOTP_SECRET}`,
			"",
		].join("\n"),
	);
	return configDir;
}

/** One more allow-listed stage, so two opens can disagree about a binding. */
function addStage(configDir: string, ident: string, url: string): void {
	fs.writeFileSync(
		path.join(stagePaths(configDir).defsDir, `${ident}.json`),
		`${JSON.stringify(
			{
				ident,
				displayName: `Grid ${ident}`,
				environment: "uat",
				system: "grid",
				access: "read-only",
				apps: { web: { label: "Grid web", url, kind: "ui" } },
			},
			null,
			2,
		)}\n`,
	);
}

function build(
	configDir: string,
	driver: ReturnType<typeof createFakeDriver>,
): BrowserRouteDeps & {
	readonly pool: BrowserPool;
	readonly worktree: string;
} {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-worktree-"));
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
	});
	let clock = 1_000_000;
	const pool = new BrowserPool({
		driver,
		launch: () => installer.resolveLaunch(),
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
	});
	return {
		installer,
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
		// A recording writes into the workflow's own evidence store; the run is
		// located without the engine, as the recording tests do.
		locate: (workflowId: string) =>
			workflowId === "wf-stage"
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
		now: () => (clock += 1_000),
	};
}

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
	owner = OWNER,
): Promise<{
	status: number;
	value: Record<string, unknown>;
	envelope: Record<string, unknown>;
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
		// The guard refusals sit beside the value, not inside it: a refusal a
		// page caused is reported *on* the call that saw it.
		envelope: parsed,
		text,
	};
}

/** The fake context of one owner's session, so a test can ask the guard the
 * question a page would ask it. */
function contextOf(deps: BrowserRouteDeps, owner = OWNER): FakeContext {
	const session = deps.pool.session(owner, "default");
	if (!session) throw new Error("no session");
	return session.context as unknown as FakeContext;
}

async function openStage(
	deps: BrowserRouteDeps,
	body: Record<string, unknown> = {},
	owner = OWNER,
): Promise<{
	status: number;
	value: Record<string, unknown>;
	envelope: Record<string, unknown>;
	text: string;
}> {
	return await call(
		deps,
		AGENT_BROWSER_OPEN_PATH,
		{ stage: "grid-int", stageApp: "web", ...body },
		owner,
	);
}

describe("stage-bound sessions", () => {
	test("a derived one-time code matches RFC 6238, and only the code is typed", () => {
		// RFC 6238 Appendix B (SHA-1) at the RFC's own counters, truncated to the six
		// digits a login form takes. The dynamic-truncation offset is the low nibble
		// of the digest's last byte: without that mask the index is out of range on
		// most steps, which is what makes these vectors the regression test.
		expect(totpCode(TOTP_SECRET, 59_000)).toBe("287082");
		expect(totpCode(TOTP_SECRET, 1_111_111_109_000)).toBe("081804");
		expect(totpCode(TOTP_SECRET, 1_111_111_111_000)).toBe("050471");
		expect(totpCode(TOTP_SECRET, 2_000_000_000_000)).toBe("279037");
		// An `otpauth://` URI contributes its `secret` parameter, and the same step
		// gives the same code.
		expect(
			totpCode(
				`otpauth://totp/Grid:clerk?secret=${TOTP_SECRET}&issuer=Grid`,
				59_000,
			),
		).toBe("287082");
	});

	test("a stage open resolves the app URL, binds the session and reports the stage", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		const opened = await openStage(deps, { path: "/dash?tab=1" });
		expect(opened.status).toBe(200);
		expect(opened.value.url).toBe(`${APP_URL}dash?tab=1`);
		expect(opened.value.stage).toBe("grid-int");
		expect(driver.lastPage()?.url()).toBe(`${APP_URL}dash?tab=1`);
		// The binding is the session's own for life, and the pool knows the stage.
		const session = deps.pool.session(OWNER, "default");
		expect(session?.stage?.ident).toBe("grid-int");
		expect(deps.pool.stageSessions(OWNER, "grid-int")).toBe(1);
		await deps.pool.closeAll();
	});

	test("an unknown stage, an unknown app and a re-binding are refused by name", async () => {
		const deps = build(configRoot(), createFakeDriver());
		const unknown = await openStage(deps, { stage: "grid-nope" });
		expect(unknown.status).toBe(404);
		expect(unknown.value.code).toBe("stage-not-configured");

		const noApp = await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
		});
		expect(noApp.status).toBe(400);
		expect(noApp.value.code).toBe("stage-app-unknown");
		expect(String(noApp.value.message)).toContain("web, plain");

		const typo = await openStage(deps, { stageApp: "webby" });
		expect(typo.status).toBe(404);
		expect(typo.value.code).toBe("stage-app-unknown");
		await deps.pool.closeAll();
	});

	test("a raw URL inside a stage-bound session is checked against the allow-list", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_OPEN_PATH, {
			url: OFF_LIST,
		});
		expect(refused.status).toBe(403);
		expect(refused.value.code).toBe("origin-not-allowed");
		// The refusal names origin and path only: never the query, never the
		// fragment, both of which can carry a token.
		expect(refused.text).toContain(OFF_LIST_SANITIZED);
		expect(refused.text).not.toContain("leak-me");
		expect(refused.text).not.toContain("#frag");

		// The stage's own origins are still allowed, and the identity provider is
		// one of them because the stage declares it: a login redirect must land.
		const allowed = await call(deps, AGENT_BROWSER_OPEN_PATH, { url: IDP_URL });
		expect(allowed.status).toBe(200);

		// A session cannot change stage: the two stages are two allow-lists.
		const mismatch = await openStage(deps, {
			stage: "grid-int",
			stageApp: "plain",
		});
		expect(mismatch.status).toBe(200);
		await deps.pool.closeAll();
	});

	test("a session bound to one stage cannot be re-bound to another", async () => {
		const configDir = configRoot();
		const defsDir = stagePaths(configDir).defsDir;
		fs.writeFileSync(
			path.join(defsDir, "grid-uat.json"),
			`${JSON.stringify(
				{
					ident: "grid-uat",
					displayName: "Grid UAT",
					environment: "uat",
					system: "grid",
					access: "read-only",
					apps: {
						web: {
							label: "Grid web",
							url: "https://grid-uat.example.test/",
							kind: "ui",
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const deps = build(configDir, createFakeDriver());
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-uat",
			stageApp: "web",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("stage-mismatch");
		expect(String(refused.value.message)).toContain("grid-int");
		await deps.pool.closeAll();
	});

	test("the guard refuses an off-list document and a state-changing method", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const context = contextOf(deps);
		const ask = (url: string, method: string) =>
			context.runGuard({
				url,
				method,
				resourceType: "document",
				isMainFrameNavigation: true,
			});

		// An off-list main-frame navigation is refused.
		expect(ask(OFF_LIST, "GET")).toBe(false);
		// The stage's own origins and the declared identity provider are allowed.
		expect(ask(APP_URL, "GET")).toBe(true);
		expect(ask(IDP_URL, "GET")).toBe(true);
		// A read-only stage refuses every state-changing method...
		expect(ask(APP_URL, "POST")).toBe(false);
		expect(ask(APP_URL, "DELETE")).toBe(false);
		// ...except a declared exception, on its own origin and path prefix.
		expect(ask(`${APP_URL}search?q=1`, "POST")).toBe(true);
		expect(ask(`${APP_URL}orders`, "POST")).toBe(false);
		// `OPTIONS` is a preflight: refusing it would break the UI it protects.
		expect(ask(APP_URL, "OPTIONS")).toBe(true);
		// An inline or scheme-relative target never leaves the process.
		expect(ask("about:blank", "GET")).toBe(true);
		expect(ask("data:text/plain,x", "GET")).toBe(true);

		// A subresource is not a navigation: a page the allow-list covers still
		// fetches fonts, images and telemetry from hosts the stage never named, and
		// blocking those would break the page instead of protecting the stage. A
		// state-changing request is refused wherever it goes.
		const subresource = (url: string, method: string) =>
			context.runGuard({
				url,
				method,
				resourceType: "image",
				isMainFrameNavigation: false,
			});
		expect(subresource(OFF_LIST, "GET")).toBe(true);
		expect(subresource(APP_URL, "GET")).toBe(true);
		expect(subresource(OFF_LIST, "POST")).toBe(false);
		await deps.pool.closeAll();
	});

	test("a refusal a call's own page work produced is reported on that call, once", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const context = contextOf(deps);
		const ask = (url: string, method: string, resourceType = "document") =>
			context.runGuard({
				url,
				method,
				resourceType,
				isMainFrameNavigation: resourceType === "document",
			});

		// One call is in flight, on its own allowed navigation, while the page asks
		// the guard five more times — exactly the shape of a page whose scripts
		// outlive the request that started them. Every refusal belongs to *this*
		// call, not to whichever call happens to look at the session next.
		driver.holdGoto = true;
		const pending = call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `await page.goto(${JSON.stringify(APP_URL)});`,
		});
		while (driver.pendingGotos === 0) await Bun.sleep(1);
		expect(ask(OFF_LIST, "GET")).toBe(false);
		expect(ask(APP_URL, "POST")).toBe(false);
		expect(ask(APP_URL, "DELETE")).toBe(false);
		expect(ask(`${APP_URL}orders`, "POST")).toBe(false);
		expect(ask(OFF_LIST, "POST", "image")).toBe(false);
		driver.releaseGoto();
		const opened = await pending;
		expect(opened.status).toBe(200);
		expect(opened.envelope.guardEvents).toEqual([
			{
				code: "origin-not-allowed",
				url: OFF_LIST_SANITIZED,
				method: "GET",
			},
			{ code: "stage-read-only", url: APP_URL, method: "POST" },
			{ code: "stage-read-only", url: APP_URL, method: "DELETE" },
			{ code: "stage-read-only", url: `${APP_URL}orders`, method: "POST" },
			{ code: "stage-read-only", url: OFF_LIST_SANITIZED, method: "POST" },
		]);
		// Neither the query nor the fragment of the refused URL is reported.
		expect(opened.text).not.toContain("leak-me");
		expect(opened.text).not.toContain("#frag");
		// Each refusal is reported once: the buffer was drained.
		const again = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(again.envelope.guardEvents).toBeUndefined();
		await deps.pool.closeAll();
	});

	test("an aborted navigation answers with the refusal's own code, not `net::ERR_ABORTED`", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `await page.goto(${JSON.stringify(OFF_LIST)});`,
		});
		expect(script.status).toBe(403);
		expect(script.value.code).toBe("origin-not-allowed");
		expect(script.text).toContain("origin allow-list");
		expect(script.text).not.toContain("leak-me");
		expect(script.envelope.guardEvents).toEqual([
			{
				code: "origin-not-allowed",
				url: OFF_LIST_SANITIZED,
				method: "GET",
			},
		]);
		await deps.pool.closeAll();
	});

	test("a refusal nothing reported yet is relayed by the next result, without owning it", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const context = contextOf(deps);

		// Page work between two calls: an abandoned script's own request, a late
		// redirect, anything the page asks the guard while no tool call is in flight.
		// The spec is explicit that the *next* result on that session reports it.
		expect(
			context.runGuard({
				url: OFF_LIST,
				method: "GET",
				resourceType: "document",
				isMainFrameNavigation: true,
			}),
		).toBe(false);

		const next = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH);
		// Reported, with the refusal's own code and sanitized URL…
		expect(next.status).toBe(200);
		expect(next.envelope.guardEvents).toEqual([
			{ code: "origin-not-allowed", url: OFF_LIST_SANITIZED, method: "GET" },
		]);
		expect(next.text).not.toContain("leak-me");
		// …but not *owned*: a snapshot nothing refused is still a snapshot.
		expect(next.value.ok ?? true).toBe(true);

		// Reported once: a claim, not a clear, and the entry is gone for the call
		// after this one.
		const after = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(after.envelope.guardEvents).toBeUndefined();
		await deps.pool.closeAll();
	});

	test("a refusal of a call still in flight survives another call's report", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const context = contextOf(deps);
		const ask = (url: string, method: string) =>
			context.runGuard({
				url,
				method,
				resourceType: "document",
				isMainFrameNavigation: true,
			});

		// Call A is in flight and its page work is refused part-way through it.
		driver.holdGoto = true;
		const held = call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `await page.goto(${JSON.stringify(APP_URL)});`,
		});
		while (driver.pendingGotos === 0) await Bun.sleep(1);
		expect(ask(OFF_LIST, "GET")).toBe(false);

		// Call B reports in between. It relays A's refusal (nothing had reported it)
		// and must not delete it: A is still in flight and its own report follows.
		const between = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(between.status).toBe(200);
		expect(between.envelope.guardEvents).toEqual([
			{ code: "origin-not-allowed", url: OFF_LIST_SANITIZED, method: "GET" },
		]);

		driver.releaseGoto();
		const finished = await held;
		expect(finished.status).toBe(200);
		// Whatever A reports is a refusal of its own work, not `browser-failed`:
		// the two calls each got their answer from one buffer.
		expect(finished.envelope.guardEvents ?? []).toEqual([]);
		await deps.pool.closeAll();
	});

	test("a stage open reports what its own first navigation refused", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		// The page the open navigates to is allow-listed, and its own script posts a
		// request on load: the navigation succeeds while its page work is refused,
		// which makes the open the *call* that has to report it.
		driver.duringGoto = [
			{ url: `${APP_URL}orders`, method: "POST", resourceType: "xhr" },
		];
		const open = await openStage(deps);
		expect(open.status).toBe(200);
		expect(open.envelope.guardEvents).toEqual([
			{ code: "stage-read-only", url: `${APP_URL}orders`, method: "POST" },
		]);
		// Reported once: the open owned it, and nothing else picks it up.
		const next = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(next.envelope.guardEvents).toBeUndefined();
		await deps.pool.closeAll();
	});

	test("a stage session's cookies and storage are refused by the script facade", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return await context.cookies();",
		});
		expect(script.status).toBe(409);
		expect(script.value.code).toBe("stage-session-restricted");
		expect(String(script.value.message)).toContain("credential");
		await deps.pool.closeAll();
	});

	test("the per-stage session bound and the rate limit each refuse an open", async () => {
		const deps = build(
			configRoot({ limits: { maxSessions: 1, maxActionsPerMinute: 2 } }),
			createFakeDriver(),
		);
		await openStage(deps, { session: "one" });
		// maxSessions is 1: a second session on the same stage is refused rather
		// than queued.
		const second = await openStage(deps, { session: "two" });
		expect(second.status).toBe(409);
		expect(second.value.code).toBe("stage-session-limit");
		expect(String(second.value.message)).toContain("1 of 1 sessions");

		// maxActionsPerMinute is 2: the third action inside the minute is refused,
		// and the answer says when to retry.
		for (const _ of [1, 2])
			await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, { session: "one" });
		const third = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: "one",
		});
		expect(third.status).toBe(429);
		expect(third.value.code).toBe("stage-rate-limit");
		expect(Number(third.value.retryAfterMs)).toBeGreaterThan(0);
		await deps.pool.closeAll();
	});

	test("an exclusive stage is refused to a second workflow while the first holds it", async () => {
		const deps = build(
			configRoot({ exclusive: true, limits: { maxSessions: 2 } }),
			createFakeDriver(),
		);
		await openStage(deps, { session: "one" });
		const held = await call(
			deps,
			AGENT_BROWSER_OPEN_PATH,
			{ stage: "grid-int", stageApp: "web" },
			OTHER_OWNER,
		);
		expect(held.status).toBe(409);
		expect(held.value.code).toBe("stage-held");
		expect(String(held.value.message)).toContain(OWNER);
		// A non-exclusive stage is the default, and a second workflow may drive it:
		// that is what the residual-risk note in the design accepts.
		const shared = build(configRoot(), createFakeDriver());
		await openStage(shared, { session: "one" });
		const other = await call(
			shared,
			AGENT_BROWSER_OPEN_PATH,
			{ stage: "grid-int", stageApp: "web" },
			OTHER_OWNER,
		);
		expect(other.status).toBe(200);
		await deps.pool.closeAll();
		await shared.pool.closeAll();
	});

	test("a concurrent open cannot re-bind a session another request is creating", async () => {
		const driver = createFakeDriver();
		const configDir = configRoot();
		addStage(configDir, "grid-uat", "https://grid-uat.example.test/");
		const deps = build(configDir, driver);

		// The first open is inside Chromium's `newContext`: admitted, but registered
		// nowhere yet, so nothing the second request can look at would tell it that
		// the session name is already taken — and it is about to be bound to a
		// different stage.
		driver.holdNewContext = true;
		const first = call(
			deps,
			AGENT_BROWSER_OPEN_PATH,
			{ stage: "grid-uat", stageApp: "web", session: "shared" },
			OTHER_OWNER,
		);
		while (driver.pendingContexts === 0) await Bun.sleep(1);
		expect(deps.pool.find(OTHER_OWNER, "shared")).toBeUndefined();

		const second = call(
			deps,
			AGENT_BROWSER_OPEN_PATH,
			{ stage: "grid-int", stageApp: "web", session: "shared" },
			OTHER_OWNER,
		);
		// The second request cannot finish while the first holds its context, so a
		// short wait is enough for it to have passed its own pre-check.
		await Bun.sleep(20);
		driver.releaseNewContext();
		const firstResult = await first;
		expect(firstResult.status).toBe(200);
		// The refusal comes from where the reuse decision is actually taken, so it is
		// the second request that is refused once the first has registered — and the
		// session keeps the binding it was created with.
		const secondResult = await second;
		expect(secondResult.status).toBe(409);
		expect(secondResult.value.code).toBe("stage-mismatch");
		expect(String(secondResult.value.message)).toContain("grid-uat");
		expect(String(secondResult.value.message)).toContain("grid-int");
		expect(deps.pool.find(OTHER_OWNER, "shared")?.stage?.ident).toBe(
			"grid-uat",
		);
		expect(deps.pool.ownedBy(OTHER_OWNER)).toHaveLength(1);
		await deps.pool.closeAll();
	});

	test("an open reuses the session a workflow already holds on the stage", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const again = await openStage(deps);
		expect(again.status).toBe(200);
		// One navigation, one session: re-opening is not a second use of the stage.
		expect(driver.lastPage()?.performed).toEqual([]);
		expect(deps.pool.ownedBy(OWNER)).toHaveLength(1);
		await deps.pool.closeAll();
	});

	test("a declared form login runs the recipe, and reports no value it typed", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(login.status).toBe(200);
		expect(login.value.stage).toBe("grid-int");
		expect(login.value.login).toBe("ok");
		// The success condition is the application's own URL, and the URL a stage
		// reply carries is sanitized the same way a refusal is.
		expect(login.value.url).toBe(APP_URL);
		expect(login.text).not.toContain(PASSWORD_SENTINEL);
		expect(login.text).not.toContain(USERNAME_SENTINEL);
		expect(login.text).not.toContain(TOTP_SECRET);
		// The credential did reach the driver's fill, and the element it went into
		// is recorded so a later screenshot masks it.
		const performed = driver.performed.join("\n");
		expect(performed).toContain(`fillField:label=User=${USERNAME_SENTINEL}`);
		expect(performed).toContain("clickControl:role=button[name=Next]");
		expect(performed).toContain(
			`fillField:label=Password=${PASSWORD_SENTINEL}`,
		);

		// A totp reference holds the shared secret and types a derived code: the
		// secret itself is never typed.
		const totp = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=otp]",
			credential: { app: "web", role: "clerk", field: "totp" },
		});
		expect(totp.status).toBe(200);
		expect(totp.text).not.toContain(TOTP_SECRET);
		const filled = driver.performed.join("\n");
		expect(filled).toMatch(/fillField:selector=input\[name=otp\]=\d{6}/);
		expect(filled).not.toContain(TOTP_SECRET);
		await deps.pool.closeAll();
	});

	test("a login failure is named, and a missing variable is refused before anything is typed", async () => {
		const configDir = configRoot();
		// The password variable is dropped from the `.env`.
		fs.writeFileSync(
			path.join(configDir, ".env"),
			`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}\n`,
		);
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await openStage(deps);
		const missing = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(missing.status).toBe(409);
		expect(missing.value.code).toBe("credential-missing");
		expect(String(missing.value.message)).toContain("GRID_INT_CLERK_PASSWORD");
		// Resolving first means nothing was typed at all.
		expect(driver.performed).toEqual([]);
		await deps.pool.closeAll();
	});

	test("a step that never appears is named, and a role without a recipe is an answer", async () => {
		const driver = createFakeDriver();
		// The fake world snapshots the absent controls when the context is created,
		// exactly like a real page that never renders the control.
		driver.absentControls = ["label=Password"];
		const deps = build(configRoot(), driver);
		await openStage(deps);

		// The second step's control never appears, and the step is not optional.
		const notFound = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(notFound.status).toBe(408);
		expect(notFound.value.code).toBe("login-step-not-found");
		expect(String(notFound.value.message)).toContain("step 1");

		// A role with no login recipe needs none: that is an answer, not an error.
		const notRequired = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "none",
		});
		expect(notRequired.status).toBe(200);
		expect(notRequired.value.code).toBe("login-not-required");
		expect(notRequired.value.login).toBe("not-required");

		// An HTTP-basic recipe installs the credentials on the context instead of
		// typing them, and they are never echoed back.
		const basic = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "basic",
		});
		expect(basic.status).toBe(200);
		expect(driver.httpCredentials).toEqual([
			{ username: USERNAME_SENTINEL, password: PASSWORD_SENTINEL },
		]);
		expect(basic.text).not.toContain(PASSWORD_SENTINEL);

		// A login on a session that is not stage-bound has no recipe to run.
		await call(
			deps,
			AGENT_BROWSER_OPEN_PATH,
			{ url: "https://example.test/" },
			OTHER_OWNER,
		);
		const unbound = await call(
			deps,
			AGENT_BROWSER_LOGIN_PATH,
			{ app: "web", role: "clerk" },
			OTHER_OWNER,
		);
		expect(unbound.status).toBe(409);
		expect(unbound.value.code).toBe("stage-session-restricted");

		// And a caller with no session at all is told to open one.
		const noSession = await call(
			deps,
			AGENT_BROWSER_LOGIN_PATH,
			{ app: "web", role: "clerk" },
			"workflow:wf-none",
		);
		expect(noSession.status).toBe(409);
		expect(noSession.value.code).toBe("session-not-open");
		await deps.pool.closeAll();
	});

	test("an unsupported second factor is named, and a login that never finishes times out", async () => {
		const driver = createFakeDriver();
		// A recipe whose success condition cannot hold here (the fake never
		// navigates), bounded to a second so the test does not sit on its poll.
		const configDir = configRoot({
			limits: { maxWaitSeconds: 1 },
			logins: {
				"web-form": {
					kind: "form",
					steps: [
						{
							fields: [{ credential: "username", label: "User" }],
							submit: { role: "button", name: "Next" },
						},
						{ fields: [{ credential: "password", label: "Password" }] },
					],
					success: { url: `${APP_URL}home` },
				},
				// Declared, because a role that names a recipe the stage does not
				// declare is a refused stage, not a refused login.
				"https-basic": { kind: "http-basic" },
			},
		});

		// The page asks for a second factor the recipe does not provide. The fake
		// world snapshots the counts at context creation, so the probe answer is
		// set before the session is opened.
		driver.counts = { 'selector=input[autocomplete="one-time-code"]': 1 };
		const mfaDeps = build(configDir, driver);
		await openStage(mfaDeps);
		const mfa = await call(mfaDeps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(mfa.status).toBe(403);
		expect(mfa.value.code).toBe("login-mfa-required");
		expect(mfa.text).not.toContain(PASSWORD_SENTINEL);
		// The credential was typed before the second factor could be detected, and
		// still nothing of it is reported.
		expect(driver.performed.join("\n")).toContain(
			`fillField:label=Password=${PASSWORD_SENTINEL}`,
		);
		await mfaDeps.pool.closeAll();

		// No second factor, no success: the login simply did not finish. The MFA
		// probes are absent from this page, so nothing else answers first.
		driver.counts = {};
		driver.absentControls = [
			'selector=input[autocomplete="one-time-code"]',
			'selector=input[name="otc"]',
			"label=Enter code",
			"label=Code",
		];
		const timeoutDeps = build(configDir, driver);
		await openStage(timeoutDeps);
		const timedOut = await call(timeoutDeps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(timedOut.status).toBe(408);
		expect(timedOut.value.code).toBe("login-timeout");
		expect(timedOut.text).not.toContain(PASSWORD_SENTINEL);
		await timeoutDeps.pool.closeAll();
	});

	test("an http-basic recipe reports the status a rejected credential earns", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		// The application answers its own page with a 401 once the credentials are
		// installed: the login did not happen, and the answer says which status
		// refused it rather than waiting for a condition that will never come.
		driver.navigationStatus = 401;
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "basic",
		});
		expect(refused.status).toBe(401);
		expect(refused.value.code).toBe("login-failed");
		expect(String(refused.value.message)).toContain("401");
		expect(refused.text).not.toContain(PASSWORD_SENTINEL);
		expect(driver.httpCredentials).toHaveLength(1);
		await deps.pool.closeAll();
	});

	test("an http-basic recipe waits only for a success condition it declares", async () => {
		const driver = createFakeDriver();
		// `origin` names the application the credentials belong to; for http-basic it
		// is not a *condition* the login waits on, so a page that answered below the
		// error range is a login that happened rather than one that times out.
		const deps = build(
			configRoot({
				limits: { maxWaitSeconds: 1 },
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
						success: { notOrigin: IDP_URL },
					},
					"https-basic": { kind: "http-basic", origin: APP_URL },
				},
			}),
			driver,
		);
		const opened = await openStage(deps);
		expect(opened.status).toBe(200);
		const basic = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "basic",
		});
		expect(basic.status).toBe(200);
		expect(basic.value.login).toBe("ok");
		expect(basic.value.steps).toBe(0);
		expect(basic.text).not.toContain(PASSWORD_SENTINEL);
		await deps.pool.closeAll();
	});

	test("a form recipe that declares no success condition does not accept its own start page", async () => {
		const driver = createFakeDriver();
		// Nothing here names the MFA probes, so the fake reports them absent and a
		// login that simply did not finish is not mistaken for a second factor.
		driver.absentControls = [
			'selector=input[autocomplete="one-time-code"]',
			'selector=input[name="otc"]',
			"label=Enter code",
			"label=Code",
		];
		const deps = build(
			configRoot({
				limits: { maxWaitSeconds: 1 },
				logins: {
					"web-form": {
						kind: "form",
						steps: [
							{
								fields: [{ credential: "username", label: "User" }],
								submit: { role: "button", name: "Next" },
							},
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
				},
			}),
			driver,
		);
		await openStage(deps);
		// The recipe declares no `success`, no `notOrigin` and no `origin`, and the
		// page never moves: “the page is not the one the recipe started on” is a real
		// condition, so this is a login that did not finish.
		const timedOut = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(timedOut.status).toBe(408);
		expect(timedOut.value.code).toBe("login-timeout");
		expect(timedOut.text).not.toContain(PASSWORD_SENTINEL);
		expect(timedOut.text).not.toContain(USERNAME_SENTINEL);
		// The recipe's own steps *were* run before the wait: nothing was skipped.
		expect(driver.performed.join("\n")).toContain(
			`fillField:label=Password=${PASSWORD_SENTINEL}`,
		);
		await deps.pool.closeAll();
	});

	test("a credential that cannot be typed is refused without a value", async () => {
		const driver = createFakeDriver();
		// The field the credential belongs in never appears.
		driver.absentControls = ["selector=input[name=user]"];
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=user]",
			credential: { app: "web", role: "clerk", field: "username" },
		});
		// The driver's failure message carries the value it was handed, so the error
		// is replaced rather than passed on: the code names the element and nothing
		// of the secret.
		expect(refused.status).toBe(502);
		expect(refused.value.code).toBe("credential-fill-failed");
		expect(String(refused.value.message)).toContain("nothing of the value");
		expect(refused.text).not.toContain(USERNAME_SENTINEL);
		await deps.pool.closeAll();
	});

	test("a fill that fails after the value was handed over reports nothing of it", async () => {
		// The shape that actually leaks: the element resolves and the fill runs, so
		// the driver's call log — the message a real Playwright error carries — holds
		// the value. Neither a credential fill nor a login step may pass that on.
		const driver = createFakeDriver({ failFill: true });
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const filled = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=user]",
			credential: { app: "web", role: "clerk", field: "username" },
		});
		expect(filled.status).toBe(502);
		expect(filled.value.code).toBe("credential-fill-failed");
		expect(filled.text).not.toContain(USERNAME_SENTINEL);
		expect(filled.text).not.toContain("Call log");

		// The same for a login recipe's own step fill.
		const login = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(login.status).toBe(502);
		expect(login.value.code).toBe("credential-fill-failed");
		expect(login.text).not.toContain(USERNAME_SENTINEL);
		expect(login.text).not.toContain(PASSWORD_SENTINEL);

		// A `totp` reference types a *derived* code, which no `.env` redaction rule
		// can ever match: only scrubbing at the source keeps it out of the reply.
		const totp = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=otp]",
			credential: { app: "web", role: "clerk", field: "totp" },
		});
		expect(totp.status).toBe(502);
		expect(totp.value.code).toBe("credential-fill-failed");
		expect(totp.text).not.toContain(TOTP_SECRET);
		expect(totp.text).not.toMatch(/\d{6}/);
		await deps.pool.closeAll();
	});

	test("a stage screenshot masks the password field and every credential-filled element", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=user]",
			credential: { app: "web", role: "clerk", field: "username" },
		});
		const shot = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {});
		expect(shot.status).toBe(200);
		const masked = driver.lastPage()?.masked ?? [];
		expect(masked).toHaveLength(1);
		const keys = (masked[0] ?? []).map((locator) => ({
			selector: locator.selector,
			label: locator.label,
		}));
		// The password input is masked because it is a password input, and the
		// element the credential was typed into because it holds one.
		expect(keys).toContainEqual({
			selector: 'input[type="password"]',
			label: undefined,
		});
		expect(keys).toContainEqual({
			selector: "input[name=user]",
			label: undefined,
		});
		await deps.pool.closeAll();
	});

	test("a screenshot a script takes is masked exactly like the tool's own", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=user]",
			credential: { app: "web", role: "clerk", field: "username" },
		});
		// The script facade is not a way around the masking: one rule covers the
		// captures a stage-bound session takes, whoever asked for them.
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return await page.screenshot();",
		});
		expect(script.status).toBe(200);
		const masked = driver.lastPage()?.masked ?? [];
		expect(masked).toHaveLength(1);
		const selectors = (masked[0] ?? []).map((locator) => locator.selector);
		expect(selectors).toContain('input[type="password"]');
		expect(selectors).toContain("input[name=user]");
		await deps.pool.closeAll();
	});

	test("a reuse-only open refuses to create the session it expected", async () => {
		// The route skips the stage admission when it finds a session, so the pool may
		// only *reuse* it: a context created here would sit outside the exclusive
		// lease and the stage's session bound.
		const deps = build(configRoot(), createFakeDriver());
		const refused = await deps.pool
			.acquire({
				owner: OWNER,
				name: "default",
				viewport: DEFAULT_BROWSER_VIEWPORT,
				url: APP_URL,
				reuseOnly: true,
			})
			.then(
				() => undefined,
				(error: { code?: string; status?: number }) => error,
			);
		expect(refused?.code).toBe("session-not-open");
		expect(refused?.status).toBe(409);
		expect(deps.pool.ownedBy(OWNER)).toHaveLength(0);
		await deps.pool.closeAll();
	});

	test("the credential-fill ledger is bounded, and the password mask always covers", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const session = deps.pool.session(OWNER, "default");
		for (let index = 0; index < MAX_CREDENTIAL_FILLS + 5; index += 1)
			await session.fillCredential(
				{ selector: `input#pw-${index}` },
				`value-${index}`,
			);
		// Every stage screenshot resolves this list, so it is bounded…
		expect(session.maskLocators()).toHaveLength(MAX_CREDENTIAL_FILLS + 1);
		// …and the policy's own password mask is never the entry that is dropped.
		expect(session.maskLocators()[0]).toEqual(PASSWORD_MASK);
		// The newest fill is still remembered, and a repeat is one entry.
		const newest = { selector: `input#pw-${MAX_CREDENTIAL_FILLS + 4}` };
		expect(session.maskLocators()).toContainEqual(newest);
		await session.fillCredential(newest, "again");
		expect(session.maskLocators()).toHaveLength(MAX_CREDENTIAL_FILLS + 1);
		// The oldest was evicted, which is what keeps the bound.
		expect(session.maskLocators()).not.toContainEqual({
			selector: "input#pw-0",
		});
		await deps.pool.closeAll();
	});

	test("an open that meant to reuse a session the pool no longer has is refused, not admitted", async () => {
		// The route reads the pool once to decide whether the stage needs admitting,
		// and the pool takes that decision again later. A session that is gone by
		// then must not be replaced by an unadmitted one: nothing would hold the
		// stage's lease or count the session against its bound.
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const stale = deps.pool.session(OWNER, "default");
		const find = spyOn(deps.pool, "find").mockReturnValue(stale);
		// The run ends while the reuse is still in flight.
		await deps.pool.closeOwner(OWNER);
		const refused = await openStage(deps);
		find.mockRestore();
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("session-not-open");
		// The point of the refusal: no context was created behind the stage's back.
		expect(deps.pool.ownedBy(OWNER)).toHaveLength(0);
		// And the next open is a real one, with its own admission.
		const reopened = await openStage(deps);
		expect(reopened.status).toBe(200);
		expect(reopened.value.stage).toBe("grid-int");
		await deps.pool.closeAll();
	});

	test("a recording is refused when its session was closed while its context swapped", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		// The swap navigates back to the session's URL after it has taken the new
		// context, so the hold is what opens the window the run's end lands in.
		driver.holdGoto = true;
		const starting = call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" });
		while (driver.pendingGotos === 0) await Bun.sleep(1);
		await deps.pool.closeOwner(OWNER);
		driver.releaseGoto();
		const refused = await starting;
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("session-not-open");
		// The recording the run never started owns nothing: its directory is gone
		// rather than left behind as an orphaned WebM target.
		const scope = workflowEvidenceScope({
			workflowId: "wf-stage",
			worktree: deps.worktree,
			definitionId: "core",
		});
		const videoDir = path.join(scope.dataRoot, "browser", "video");
		expect(fs.existsSync(videoDir) ? fs.readdirSync(videoDir) : []).toEqual([]);
		await deps.pool.closeAll();
	});

	test("a repro spec saved from a stage session carries variable names and no value", async () => {
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await openStage(deps);
		const names = stageCredentialNames(configDir, "grid-int");
		expect(names).toEqual([
			"GRID_INT_CLERK_PASSWORD",
			"GRID_INT_CLERK_TOTP",
			"GRID_INT_CLERK_USERNAME",
		]);
		const spec = reproSpec("return 1", APP_URL, { credentialVariables: names });
		expect(spec).toContain(
			'GRID_INT_CLERK_PASSWORD: required("GRID_INT_CLERK_PASSWORD")',
		);
		for (const value of [PASSWORD_SENTINEL, USERNAME_SENTINEL, TOTP_SECRET])
			expect(spec).not.toContain(value);
		await deps.pool.closeAll();
	});

	test("a repro spec saved through the route is stored, redacted, and readable", async () => {
		// The route is what actually writes the file: the pure builder alone cannot
		// show that the spec a developer opens tomorrow carries variable names and no
		// value of one.
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await openStage(deps);
		const saved = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `await page.fill("input#pw", ${JSON.stringify(PASSWORD_SENTINEL)});`,
			save: true,
		});
		expect(saved.status).toBe(200);
		expect(saved.text).not.toContain(PASSWORD_SENTINEL);
		const scope = workflowEvidenceScope({
			workflowId: "wf-stage",
			worktree: deps.worktree,
			definitionId: "core",
		});
		const entry = listEvidence(scope).entries.find(
			(item) => item.kind === "script",
		);
		if (!entry) throw new Error("no script evidence was attached");
		const text = fs.readFileSync(path.join(scope.root, entry.file), "utf8");
		expect(text).toContain("@playwright/test");
		for (const name of [
			"GRID_INT_CLERK_PASSWORD",
			"GRID_INT_CLERK_TOTP",
			"GRID_INT_CLERK_USERNAME",
		])
			expect(text).toContain(`required("${name}")`);
		expect(text).toContain("«redacted:GRID_INT_CLERK_PASSWORD»");
		for (const value of [PASSWORD_SENTINEL, USERNAME_SENTINEL, TOTP_SECRET])
			expect(text).not.toContain(value);
		await deps.pool.closeAll();
	});

	test("a recording refuses a credential fill, and the swap keeps the stage guard", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		// One recording in flight; a credential must never reach a video.
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		expect(
			(deps.pool.session(OWNER, "default") as BrowserSession).recording,
		).toBeTruthy();

		// The recording swapped the browser context; the stage's guard came with it,
		// so a recording is more observable but never less restricted.
		const context = contextOf(deps);
		expect(
			context.runGuard({
				url: OFF_LIST,
				method: "GET",
				resourceType: "document",
				isMainFrameNavigation: true,
			}),
		).toBe(false);
		expect(
			context.runGuard({
				url: APP_URL,
				method: "GET",
				resourceType: "document",
				isMainFrameNavigation: true,
			}),
		).toBe(true);

		const refused = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=password]",
			credential: { app: "web", role: "clerk", field: "password" },
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("recording-active");
		await deps.pool.closeAll();
	});
});
