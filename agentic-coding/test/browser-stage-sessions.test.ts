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
import {
	HANDOFF_GRACE_MS,
	HANDOFF_TICK_MS,
	type LoginHandoffAttention,
	type LoginHandoffAvailability,
	LoginHandoffCoordinator,
} from "../src/server/browser/handoff.ts";
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
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_EVAL_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_LOGIN_WAIT_PATH,
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	AGENT_BROWSER_WAIT_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { createStageGuard } from "../src/server/stages/guard.ts";
import { StageIdentityCache } from "../src/server/stages/identity-cache.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import { pkceSecrets } from "../src/server/stages/oauth2.ts";
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
					// A login no server can perform: the recipe is declared
					// `interactive`, so only a person can complete it.
					sso: { login: "sso" },
					// A recipe the role names without any credential reference: the
					// server can never log this role in.
					norefs: { login: "web-form" },
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
			// Declared success and nothing else: the whole login is the developer's.
			sso: { kind: "interactive", success: { notOrigin: IDP_URL } },
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

/** A configuration that forbids the headed window (`interactiveLogin: "never"`),
 * so an unautomatable login is refused instead of handed off. */
function forbidInteractiveLogin(configDir: string): void {
	fs.writeFileSync(
		stagePaths(configDir).policyFile,
		`${JSON.stringify({ interactiveLogin: "never" }, null, 2)}\n`,
	);
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
	options: {
		/** Every coordination line the hand-off writes, so a leak test can read
		 * them without a log sink. */
		readonly log?: string[];
		/** The attention record's stand-in: the words of the record the workflow
		 * layer would raise. */
		readonly attention?: LoginHandoffAttention;
		/** Whether this machine can show a window at all. Injected so a refusal is
		 * testable whatever the host's own display and browser are. */
		readonly availability?: () => LoginHandoffAvailability;
		/** Make the headed launch fail, as a machine that cannot open its window
		 * does: the refusal belongs to the wait, never to the login call. */
		readonly headedLaunchFails?: boolean;
		/** The coordinator's timer, so a test can drive its ticks and its grace
		 * period instead of sleeping through them. */
		readonly schedule?: (run: () => void, ms: number) => () => void;
		/** The identity cache the pool reads, so a test owns the store instead of the
		 * process-wide one (`add-stage-identity-cache`). */
		readonly identity?: StageIdentityCache;
	} = {},
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
		display: () => true,
	});
	let clock = 1_000_000;
	let coordinator: LoginHandoffCoordinator | undefined;
	const pool = new BrowserPool({
		driver,
		launch: (launchOptions) => {
			if (launchOptions?.headed === true && options.headedLaunchFails)
				throw new Error("the window could not be opened");
			return installer.resolveLaunch(launchOptions);
		},
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
		...(options.identity === undefined ? {} : { identity: options.identity }),
		onSessionClosed: (session, cause) => {
			void coordinator?.sessionClosed(session, cause);
		},
	});
	// The hand-off is real here, without an attention record: every ending except
	// the developer's *Done* is exercised, and `Done` is covered at the
	// coordinator's own boundary.
	coordinator = new LoginHandoffCoordinator({
		pool,
		availability:
			options.availability ?? (() => installer.headedAvailability()),
		now: () => clock,
		...(options.attention ? { attention: options.attention } : {}),
		...(options.schedule ? { schedule: options.schedule } : {}),
		log: (line) => options.log?.push(line),
	});
	return {
		installer,
		handoff: coordinator,
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

/** One owner's session, or a failure that says the fixture is wrong. */
function sessionOf(deps: BrowserRouteDeps, name: string, owner = OWNER) {
	const session = deps.pool.session(owner, name);
	if (!session) throw new Error(`no session ${name}`);
	return session;
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
	test("a stage-test write plan allows creation but refuses replacement and deletion", () => {
		const origin = new URL(APP_URL).origin;
		const refusals: Array<{ code: string; method: string; url: string }> = [];
		const guard = createStageGuard(
			{
				ident: "grid-int",
				access: "writable",
				writeAllowed: true,
				writeMethods: ["POST"],
				origins: [origin],
				readOnlyExceptions: [],
				limits: {
					maxSessions: 1,
					maxActionsPerMinute: 60,
					maxWaitSeconds: 60,
					maxScreenshots: 20,
					maxRecordingMinutes: 1,
					maxLoginHandoffSeconds: 60,
				},
			},
			(refusal) => refusals.push(refusal),
		);
		const request = {
			url: `${origin}/requests/one`,
			resourceType: "xhr",
			isMainFrameNavigation: false,
		};
		expect(guard({ ...request, method: "GET" })).toBe(true);
		expect(guard({ ...request, method: "POST" })).toBe(true);
		expect(guard({ ...request, method: "PUT" })).toBe(false);
		expect(guard({ ...request, method: "PATCH" })).toBe(false);
		expect(guard({ ...request, method: "DELETE" })).toBe(false);
		expect(refusals.map(({ code, method }) => ({ code, method }))).toEqual([
			{ code: "stage-plan-write-not-approved", method: "PUT" },
			{ code: "stage-plan-write-not-approved", method: "PATCH" },
			{ code: "stage-plan-write-not-approved", method: "DELETE" },
		]);
	});

	test("the route derives a stage-test session's write policy from the stage access, not the plan", async () => {
		const cases = [
			{ access: "read-only", createsData: true, writeAllowed: false },
			{ access: "writable", createsData: false, writeAllowed: true },
			{ access: "writable", createsData: true, writeAllowed: true },
		] as const;
		for (const [index, item] of cases.entries()) {
			const deps = build(
				configRoot({ access: item.access }),
				createFakeDriver(),
			);
			const stageDeps: BrowserRouteDeps = {
				...deps,
				locate: () => ({
					workflowId: "wf-stage",
					worktree: deps.worktree,
					definitionId: "stage-test",
					stage: "grid-int",
					stageAccess: item.access,
					currentStep: "stage.execute",
					selectedRoles: ["stage-tester"],
					stageTestPlan: {
						route: [{ application: "web" }],
						createsData: item.createsData,
					},
				}),
			};
			const opened = await openStage(stageDeps, {
				session: `policy-${index}`,
			});
			expect(opened.status).toBe(200);
			const session = sessionOf(stageDeps, `policy-${index}`);
			expect(session.stage?.writeAllowed).toBe(item.writeAllowed);
			expect(session.stage?.writeMethods).toEqual(["POST"]);
		}
	});

	test("stage_login in a stage-test run takes the stage application key even when the application declares another repository app", async () => {
		const configDir = configRoot();
		const definitionPath = path.join(
			stagePaths(configDir).defsDir,
			"grid-int.json",
		);
		const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
		definition.apps.web.app = "grid-web-fe";
		fs.writeFileSync(definitionPath, JSON.stringify(definition));
		const appsDir = path.join(configDir, "apps", "definitions");
		fs.mkdirSync(appsDir, { recursive: true });
		fs.writeFileSync(
			path.join(appsDir, "grid-web-fe.json"),
			JSON.stringify({
				ident: "grid-web-fe",
				displayName: "grid-web-fe",
				appType: "APP",
			}),
		);
		const deps = build(configDir, createFakeDriver());
		const stageDeps: BrowserRouteDeps = {
			...deps,
			locate: () => ({
				workflowId: "wf-stage",
				worktree: deps.worktree,
				definitionId: "stage-test",
				stage: "grid-int",
				stageAccess: "read-only",
				currentStep: "stage.execute",
				selectedRoles: ["stage-tester"],
				stageTestPlan: {
					route: [{ application: "web", role: "none" }],
					createsData: false,
				},
			}),
		};
		const opened = await openStage(stageDeps, {
			session: "keyed",
			stageRole: "none",
		});
		expect(opened.text).toContain('"ok":true');
		const ok = await call(stageDeps, AGENT_BROWSER_LOGIN_PATH, {
			session: "keyed",
			app: "web",
			role: "none",
		});
		expect(ok.status).toBe(200);
		// The repository app name is not a stage key: the plan routes `web`.
		const byRepoName = await call(stageDeps, AGENT_BROWSER_LOGIN_PATH, {
			session: "keyed",
			app: "grid-web-fe",
			role: "none",
		});
		expect(byRepoName.status).toBeGreaterThanOrEqual(400);
		// Another stage application is still refused on this session.
		const other = await call(stageDeps, AGENT_BROWSER_LOGIN_PATH, {
			session: "keyed",
			app: "plain",
			role: "none",
		});
		expect(other.status).toBe(403);
		expect(other.value.code).toBe("stage-app-unknown");
	});

	test("a stage-test plan can narrow a writable stage to read-only", () => {
		const origin = new URL(APP_URL).origin;
		const refusals: Array<{ code: string; method: string; url: string }> = [];
		// A declared read-only exception belongs to the stage's own read-only
		// policy; a plan that approved no creation must not fall through to it
		// (SEC-002).
		const guard = createStageGuard(
			{
				ident: "grid-int",
				access: "writable",
				writeAllowed: false,
				planNarrowed: true,
				origins: [origin],
				readOnlyExceptions: [
					{ origin, pathPrefix: "/search", methods: ["POST"] },
				],
				limits: {
					maxSessions: 1,
					maxActionsPerMinute: 60,
					maxWaitSeconds: 60,
					maxScreenshots: 20,
					maxRecordingMinutes: 1,
					maxLoginHandoffSeconds: 60,
				},
			},
			(refusal) => refusals.push(refusal),
		);
		const request = {
			url: `${origin}/requests`,
			resourceType: "xhr",
			isMainFrameNavigation: false,
		};
		expect(guard({ ...request, method: "GET" })).toBe(true);
		expect(guard({ ...request, method: "POST" })).toBe(false);
		expect(
			guard({
				...request,
				url: `${origin}/search`,
				method: "POST",
			}),
		).toBe(false);
		expect(refusals).toEqual([
			{
				code: "stage-plan-write-not-approved",
				method: "POST",
				url: `${origin}/requests`,
			},
			{
				code: "stage-plan-write-not-approved",
				method: "POST",
				url: `${origin}/search`,
			},
		]);
	});
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
		// Under a `never` policy an unautomatable login is the automated recipe's
		// own refusal; the hand-off path is covered by its own test.
		forbidInteractiveLogin(configDir);
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

	test("a login no recipe can automate is handed to the developer, and the session is held", async () => {
		const configDir = configRoot();
		// The password variable is dropped, so the recipe cannot be automated; the
		// policy keeps the default (`local`), so the developer is asked instead.
		fs.writeFileSync(
			path.join(configDir, ".env"),
			`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}\n`,
		);
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(handoff.status).toBe(200);
		expect(handoff.value.login).toBe("needs-user");
		expect(handoff.value.reason).toBe("no-credentials");
		expect(handoff.value.stage).toBe("grid-int");
		expect(handoff.value.role).toBe("clerk");
		expect(typeof handoff.value.handoffId).toBe("string");
		expect(typeof handoff.value.deadlineAt).toBe("string");
		// The promotion is a *second*, headed browser: the login page opens in a
		// window the developer can see, and nothing was typed into it.
		expect(driver.launchOptions).toContainEqual({ headless: false });
		expect(driver.performed).toEqual([]);
		// The session keeps its name and slot, and the visible window carries the
		// hand-off banner the developer reads.
		const heldSession = deps.pool.summaries().find((item) => item.heldByUser);
		expect(heldSession?.heldByUser).toBe(true);
		expect(
			deps.pool.find(OWNER, String(handoff.value.session))?.browserSlot,
		).toBe("interactive");
		// A second `stage_login` rejoins the same hand-off instead of opening a
		// second one.
		const again = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
			session: String(handoff.value.session),
		});
		expect(again.value.handoffId).toBe(handoff.value.handoffId);
		// While the developer owns the window no other tool may drive it.
		const held = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {
			session: String(handoff.value.session),
		});
		expect(held.status).toBe(409);
		expect(held.value.code).toBe("session-held-by-user");
		expect(String(held.value.message)).toContain("login hand-off");
		// The wait blocks in the server, not in the run: the developer's login is
		// detected through the recipe's own success condition, and the hand-off
		// ends as a verified login.
		const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session: String(handoff.value.session),
			timeoutSec: 30,
		});
		expect(waited.status).toBe(200);
		expect(waited.value.login).toBe("ok");
		expect(waited.value.via).toBe("handoff");
		expect(waited.value.verified).toBe(true);
		// The session stays open and usable once the developer has finished.
		expect(deps.pool.find(OWNER, String(handoff.value.session))?.hold).toBe(
			undefined,
		);
		await deps.pool.closeAll();
	});

	test("a configuration that forbids the window refuses, and says which reason", async () => {
		const configDir = configRoot();
		forbidInteractiveLogin(configDir);
		fs.writeFileSync(path.join(configDir, ".env"), "");
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		// Under `never` the automated recipe still runs, so its own refusal is the
		// answer: the missing variable is named and nothing was typed.
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("credential-missing");
		expect(refused.text).toContain("GRID_INT_CLERK_USERNAME");
		expect(driver.performed).toEqual([]);
		await deps.pool.closeAll();
	});

	test("an interactive recipe is handed off, never attempted", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		expect(handoff.status).toBe(200);
		expect(handoff.value.login).toBe("needs-user");
		// No step can be automated, so the reason says so — and nothing was typed.
		expect(handoff.value.reason).toBe("unautomatable-step");
		expect(driver.performed).toEqual([]);
		await deps.pool.closeAll();
	});

	test("an http-basic role without a value keeps the missing-credential answer instead of handing off", async () => {
		const configDir = configRoot();
		fs.writeFileSync(path.join(configDir, ".env"), "");
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await openStage(deps);
		// The browser's own authentication dialog does not appear in a window this
		// server launched (spike 0.2, D10), so a hand-off could never be answered:
		// the role keeps the foundation's refusal, and no window is opened.
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "basic",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("credential-missing");
		expect(String(refused.value.message)).toContain("GRID_INT_CLERK");
		expect(refused.text).not.toContain(PASSWORD_SENTINEL);
		// No window, no promotion, and no credential installed anywhere.
		expect(
			deps.handoff?.pending(deps.pool.session(OWNER, "default")),
		).toBeUndefined();
		expect(deps.pool.summaries()[0]?.heldByUser ?? false).toBe(false);
		expect(driver.launchOptions).toEqual([{ headless: true }]);
		expect(driver.httpCredentials).toEqual([]);
		await deps.pool.closeAll();
	});

	test("under never, a role this server can never log in is refused as a policy matter", async () => {
		const configDir = configRoot();
		forbidInteractiveLogin(configDir);
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await openStage(deps);
		// The role names a recipe but declares no credential reference at all.
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "norefs",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("login-user-unavailable");
		expect(String(refused.value.message)).toContain("interactiveLogin");
		expect(driver.launchOptions).toEqual([{ headless: true }]);
		await deps.pool.closeAll();
	});

	test("a second factor under local is handed off instead of reported", async () => {
		const driver = createFakeDriver();
		// The page asks for a second factor the recipe cannot answer; under the
		// default policy that is the developer's job, not a failed login.
		driver.counts = { 'selector=input[autocomplete="one-time-code"]': 1 };
		const deps = build(
			configRoot({
				limits: { maxWaitSeconds: 1 },
				logins: {
					"web-form": {
						kind: "form",
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { notOrigin: IDP_URL } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "clerk",
		});
		expect(handoff.status).toBe(200);
		expect(handoff.value.login).toBe("needs-user");
		expect(handoff.value.reason).toBe("unautomatable-step");
		// The credential was typed on the headless attempt, and nothing of it
		// reached the answer the agent sees.
		expect(handoff.text).not.toContain(PASSWORD_SENTINEL);
		await deps.pool.closeAll();
	});

	test("a server that cannot show a window refuses before anything is queued", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver, {
			availability: () => ({ ok: false, reason: "headless-only-browser" }),
		});
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		expect(refused.status).toBe(503);
		expect(refused.value.code).toBe("login-handoff-unavailable");
		expect(refused.value.reason).toBe("headless-only-browser");
		// Where the fix is: the refusal names the install surface, and nothing was
		// queued, held, launched or recorded for the hand-off.
		expect(String(refused.value.message)).toContain("Settings → Browser");
		expect(deps.handoff?.pending(sessionOf(deps, "default"))).toBeUndefined();
		expect(sessionOf(deps, "default").heldByUser).toBe(false);
		expect(driver.launchOptions).toEqual([{ headless: true }]);
		await deps.pool.closeAll();
	});

	test("a server with no hand-off capability at all refuses the same way", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const refused = await call(
			{ ...deps, handoff: undefined },
			AGENT_BROWSER_LOGIN_PATH,
			{ app: "web", role: "sso" },
		);
		expect(refused.status).toBe(503);
		expect(refused.value.code).toBe("login-handoff-unavailable");
		expect(refused.value.reason).toBe("headless-only-browser");
		expect(sessionOf(deps, "default").heldByUser).toBe(false);
		await deps.pool.closeAll();
	});

	test("a headed launch that fails is the wait's answer, not the login call's", async () => {
		const driver = createFakeDriver();
		const deps = build(configRoot(), driver, { headedLaunchFails: true });
		await openStage(deps);
		// `stage_login` answers before a launch is attempted, so a window that will
		// not open cannot turn the tool call into a failure.
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		expect(handoff.status).toBe(200);
		expect(handoff.value.login).toBe("needs-user");
		const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session: String(handoff.value.session),
			timeoutSec: 5,
		});
		expect(waited.status).toBe(503);
		expect(waited.value.code).toBe("login-handoff-unavailable");
		expect(waited.value.reason).toBe("launch-failed");
		// The hold is over and the session is the agent's again.
		expect(sessionOf(deps, String(handoff.value.session)).heldByUser).toBe(
			false,
		);
		await deps.pool.closeAll();
	});

	test("a session that already lives in the window reuses its login instead of a second hand-off", async () => {
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				apps: {
					web: {
						label: "Grid web",
						url: APP_URL,
						kind: "ui",
						roles: { sso: { login: "sso" } },
					},
					second: {
						label: "Grid second",
						url: `${APP_URL}second/`,
						kind: "ui",
						roles: { sso: { login: "sso" } },
					},
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		// The developer finishes the login in the window: the recipe's declared
		// condition holds once the page is back on the application.
		await sessionOf(deps, session).goto(`${APP_URL}home`, 30_000);
		const ended = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 30,
		});
		expect(ended.value.login).toBe("ok");
		expect(ended.value.via).toBe("handoff");

		// A second application on the same IdP, for the same role: the session's
		// own login is reused, and no hand-off starts.
		const reused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "second",
			role: "sso",
		});
		expect(reused.status).toBe(200);
		expect(reused.value.login).toBe("ok");
		expect(reused.value.via).toBe("existing-session");
		expect(reused.value.verified).toBe(true);
		expect(deps.handoff?.pending(sessionOf(deps, session))).toBeUndefined();
		expect(sessionOf(deps, session).browserSlot).toBe("interactive");
		await deps.pool.closeAll();
	});

	test("a login the developer finished is captured for the next session", async () => {
		// The spec's first requirement says the state is captured by an automated
		// recipe *or* by the developer, and the hand-off is the second one: this is
		// the only path whose capture happens after a wait, not after a recipe.
		const cache = new StageIdentityCache();
		const driver = createFakeDriver({
			storageState: {
				cookies: [
					{
						name: "ESTSAUTH",
						value: "SENT-handoff-signon-cookie-0123456789",
						domain: "login.example.test",
						path: "/",
						expires: -1,
						httpOnly: true,
						secure: true,
					},
				],
				origins: [
					{
						origin: "https://grid-int.example.test",
						localStorage: [
							{
								name: "msal.token.keys",
								value: "SENT-handoff-token-0123456789",
							},
						],
					},
				],
			},
		});
		const deps = build(configRoot(), driver, { identity: cache });
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		await sessionOf(deps, session).goto(`${APP_URL}home`, 30_000);
		const ended = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 30,
		});
		expect(ended.value.login).toBe("ok");
		expect(ended.value.identity).toBe("user");
		// One capture per outcome: the entry is the wait's, and it is the one the
		// session is remembered by.
		expect(cache.list().map((entry) => `${entry.stage}/${entry.role}`)).toEqual(
			["grid-int/sso"],
		);
		expect(
			cache.peek({ stage: "grid-int", role: "sso" })?.state.cookies,
		).toHaveLength(1);
		expect(sessionOf(deps, session).identity?.source).toBe("user");
		// Two call sites could each file the ending — the wait and the route that
		// answered it — so the count is what pins "one capture per outcome" rather
		// than the single entry, which either of them would produce (TESTQ-013).
		expect(driver.storageStateCalls).toBe(1);
		// A second wait on the same ending is a read-back: it captures nothing new.
		const again = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 30,
		});
		expect(again.value.login).toBe("ok");
		expect(driver.storageStateCalls).toBe(1);
		expect(cache.size).toBe(1);
		await deps.pool.closeAll();
	});

	test("a wait that runs out of time answers a timeout and closes the window", async () => {
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				limits: {
					maxSessions: 1,
					maxActionsPerMinute: 30,
					maxLoginHandoffSeconds: 1,
				},
				logins: {
					"web-form": { kind: "http-basic" },
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		expect(handoff.value.deadlineAt).toBeDefined();
		// The deadline is the request time plus the stage's one second: two calls
		// that read the clock put it in the past.
		deps.now?.();
		deps.now?.();
		const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 5,
		});
		expect(waited.status).toBe(408);
		expect(waited.value.code).toBe("login-handoff-timeout");
		expect(waited.value.deadlineAt).toBe(handoff.value.deadlineAt);
		// The window is closed (spec), so the session stays unusable until the agent
		// opens it again by name: it is still listed, and every call refuses it.
		expect(
			deps.pool.summaries().filter((entry) => entry.name === session),
		).toHaveLength(1);
		const after = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, { session });
		expect(after.value.code).toBe("browser-crashed");
		await deps.pool.closeAll();
	});

	test("a wait after the deadline reads the recorded outcome instead of the closed window", async () => {
		const driver = createFakeDriver();
		const records: Array<Record<string, unknown>> = [];
		const attention = {
			open: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
			answer: async () => undefined,
			close: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		const deps = build(
			configRoot({
				limits: {
					maxSessions: 1,
					maxActionsPerMinute: 30,
					maxLoginHandoffSeconds: 1,
				},
				logins: {
					"web-form": { kind: "http-basic" },
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
			{ attention },
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		// The record says this hand-off's own state in words — the window that is
		// opening and the deadline — and never names a key (USAB-101..104).
		const context = String(records[0]?.context);
		expect(context).toContain("Its window is opening now.");
		expect(context).toContain("The hand-off expires at");
		expect(context).toMatch(/local \(in (about|less than)/);
		expect(context).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
		expect(context).not.toContain("Escape");
		// The deadline is the request time plus the stage's one second: two calls
		// that read the clock put it in the past.
		deps.now?.();
		deps.now?.();
		const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 5,
		});
		expect(waited.status).toBe(408);
		expect(waited.value.code).toBe("login-handoff-timeout");
		// The deadline closed the window, so the session itself is refused; a wait
		// that arrives after it still learns how the login ended instead of being
		// told the browser crashed (SEC-002).
		const again = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 5,
		});
		expect(again.status).toBe(408);
		expect(again.value.code).toBe("login-handoff-timeout");
		expect(again.value.deadlineAt).toBe(handoff.value.deadlineAt);
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, { session });
		expect(snapshot.value.code).toBe("browser-crashed");
		await deps.pool.closeAll();
	});

	test("a Done whose success condition never holds is answered as unverified", async () => {
		const driver = createFakeDriver();
		const timers: Array<{ run: () => void; ms: number }> = [];
		const records: Array<Record<string, unknown>> = [];
		const attention = {
			open: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
			// The developer chose *Done*: from here only the grace period ends it.
			answer: async () => "done" as const,
			close: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		const deps = build(
			configRoot({
				logins: {
					"web-form": { kind: "http-basic" },
					"https-basic": { kind: "http-basic" },
					// A condition that never holds, so *Done* is the only good ending.
					sso: { kind: "interactive", success: { url: `${APP_URL}never` } },
				},
			}),
			driver,
			{
				attention,
				schedule: (run, ms) => {
					timers.push({ run, ms });
					return () => {};
				},
			},
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		const waiting = call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 600,
		});
		let settled = false;
		void waiting.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		// Drive the coordinator's own turns: the clock advances a second per turn,
		// which is what makes a ten-second grace period observable at all. The
		// wait's own cap is left parked, so it stays blocked exactly as it would.
		for (let i = 0; i < 40 && !settled; i++) {
			for (const timer of timers.splice(0, timers.length)) {
				if (timer.ms !== HANDOFF_TICK_MS) {
					timers.push(timer);
					continue;
				}
				deps.now?.();
				timer.run();
			}
			await Bun.sleep(1);
		}
		if (!settled) throw new Error("the grace period never ended the hand-off");
		const waited = await waiting;
		expect(HANDOFF_GRACE_MS).toBeGreaterThan(0);
		expect(waited.status).toBe(409);
		expect(waited.value.code).toBe("login-handoff-unverified");
		// The landing is the page the session is on, sanitized: origin and path,
		// never a query or a fragment.
		expect(String(waited.value.url)).toContain("grid-int.example.test");
		expect(String(waited.value.url)).not.toContain("?");
		expect(records).toHaveLength(2);
		await deps.pool.closeAll();
	});

	test("a window the developer closes mid-wait is answered as an abort", async () => {
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				logins: {
					"web-form": { kind: "http-basic" },
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		// The wait blocks in the server; the developer closes the window while it is
		// blocked, which is how the agent learns the login is over.
		const waiting = call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 30,
		});
		for (let i = 0; i < 400; i++) {
			if (driver.performed.includes("bringToFront")) break;
			await Bun.sleep(5);
		}
		driver.lastPage()?.close("user");
		const waited = await waiting;
		expect(waited.status).toBe(409);
		expect(waited.value.code).toBe("login-handoff-aborted");
		expect(waited.value.by).toBe("window-closed");
		await deps.pool.closeAll();
	});

	test("no session-addressed tool may drive a session the developer owns", async () => {
		const driver = createFakeDriver();
		// The stage's rate limit is tight, and the holds below are many: a refusal
		// that counted against the run's rolling minute would turn into
		// `stage-rate-limit` partway through this loop.
		const deps = build(
			configRoot({
				limits: { maxSessions: 4, maxActionsPerMinute: 5 },
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		const guarded: Array<[string, Record<string, unknown>]> = [
			[AGENT_BROWSER_SNAPSHOT_PATH, { session }],
			[
				AGENT_BROWSER_ACTION_PATH,
				{ session, action: "click", selector: "#go" },
			],
			[AGENT_BROWSER_WAIT_PATH, { session, text: "anything" }],
			[AGENT_BROWSER_EVAL_PATH, { session, code: "1 + 1" }],
			[AGENT_BROWSER_CONSOLE_PATH, { session }],
			[AGENT_BROWSER_NETWORK_PATH, { session }],
			[AGENT_BROWSER_SCREENSHOT_PATH, { session }],
			[AGENT_BROWSER_SCRIPT_PATH, { session, code: "return 1;" }],
			[AGENT_BROWSER_RECORD_PATH, { session, action: "start" }],
			[AGENT_BROWSER_RECORD_PATH, { session, action: "stop" }],
			[
				AGENT_BROWSER_OPEN_PATH,
				{ stage: "grid-int", stageApp: "web", session },
			],
		];
		for (const [routePath, body] of guarded) {
			for (const attempt of [1, 2]) {
				const refused = await call(deps, routePath, body);
				expect(`${routePath}:${attempt}:${refused.value.code}`).toBe(
					`${routePath}:${attempt}:session-held-by-user`,
				);
			}
		}
		// A held session still answers what a hold is made of: rejoining it, and
		// ending it.
		const rejoined = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		expect(rejoined.value.handoffId).toBe(handoff.value.handoffId);
		const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session,
			timeoutSec: 1,
		});
		expect(waited.status).toBe(200);
		// The listing names the hold and the origin, never the page: a URL of a
		// half-finished login lives in the query.
		const listed = deps.pool
			.summaries()
			.find((entry) => entry.heldByUser === true);
		expect(listed?.name).toBe(session);
		expect(listed?.url).toBe(new URL(APP_URL).origin);
		await deps.pool.closeAll();
	});

	test("a hand-off invalidates the refs and buffers of the page it replaces", async () => {
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {});
		expect(snapshot.value.refs).toBeGreaterThan(0);
		// A buffer entry from the page the developer is about to replace.
		driver
			.lastPage()
			?.emitConsole({ type: "log", text: "before the hand-off" });
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const sessionName = String(handoff.value.session);
		const session = deps.pool.session(OWNER, sessionName);
		if (!session) throw new Error("no session");
		// The promotion opens the window in the background of the tool result: the
		// focus call is its last step, so waiting for it waits out the swap's own
		// navigation too.
		for (let i = 0; i < 400; i++) {
			if (driver.performed.includes("bringToFront")) break;
			await Bun.sleep(5);
		}
		expect(session.browserSlot).toBe("interactive");
		expect(session.url).toBe(APP_URL);
		driver
			.lastPage()
			?.emitConsole({ type: "log", text: "during the hand-off" });
		await session.goto(`${APP_URL}home`, 30_000);
		const ended = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session: sessionName,
			timeoutSec: 5,
		});
		expect(ended.value.login).toBe("ok");
		// Both pages' traffic is gone, and so is every ref of the old one.
		const console = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {
			session: sessionName,
		});
		expect(console.value.entries).toEqual([]);
		const stale = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			session: sessionName,
			action: "click",
			ref: "e0",
		});
		expect(stale.status).toBe(409);
		expect(stale.value.code).toBe("snapshot-required");
		// Neither the snapshot nor the click raised the window: the one focus call
		// belongs to the hand-off, and nothing an agent does makes another.
		expect(
			driver.performed.filter((entry) => entry === "bringToFront"),
		).toHaveLength(1);
		await deps.pool.closeAll();
	});

	test("browser_close ends the hand-off as the agent's abort, before the context goes", async () => {
		const closed: Array<Record<string, unknown>> = [];
		const attention = {
			open: async () => undefined,
			answer: async () => undefined,
			close: async (input: Record<string, unknown>) => {
				closed.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
			{ attention },
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		expect(
			deps.pool.summaries().find((item) => item.name === session)?.heldByUser,
		).toBe(true);
		const closedRoute = await call(deps, AGENT_BROWSER_CLOSE_PATH, { session });
		expect(closedRoute.status).toBe(200);
		expect(closedRoute.value.closed).toBe(true);
		// The record is resolved as the agent's abort — not the developer's, and not
		// a timeout — and no session is left behind.
		expect(closed).toHaveLength(1);
		expect(closed[0]?.answer).toBe("abort");
		expect(closed[0]?.by).toBe("system");
		expect(closed[0]?.outcome).toBe("login-handoff-aborted");
		expect(deps.pool.summaries()).toEqual([]);
		await deps.pool.closeAll();
	});

	test("a recording is refused before the login path can hand off", async () => {
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		// `sso` has no credential reference at all and would otherwise hand off. The
		// recording is refused first, because a video must never hold a login.
		const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("recording-active");
		// Nothing was handed off and the developer was never asked.
		expect(deps.handoff?.pending(sessionOf(deps, "default"))).toBeUndefined();
		expect(deps.pool.summaries()[0]?.heldByUser ?? false).toBe(false);
		await deps.pool.closeAll();
	});

	test("a hand-off leaks no credential, code or token into anything an agent or an operator can read", async () => {
		const CODE_SENTINEL = "idp-code-sentinel-77aa";
		const STATE_SENTINEL = "idp-state-sentinel-31bc";
		const drag = `https://login.example.test/cb?code=${CODE_SENTINEL}&state=${STATE_SENTINEL}&login_hint=${USERNAME_SENTINEL}`;
		const logged: string[] = [];
		const records: Array<Record<string, unknown>> = [];
		const attention = {
			open: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
			answer: async () => undefined,
			close: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		const driver = createFakeDriver();
		const deps = build(
			configRoot({
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
			{ log: logged, attention },
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const sessionName = String(handoff.value.session);
		const session = deps.pool.session(OWNER, sessionName);
		if (!session) throw new Error("no session");

		// The developer types their credentials into the visible window, and the
		// identity provider redirects back with a code, a state and a login hint.
		// None of that is the agent's traffic: it is simulated on the promoted
		// page, exactly where a real browser would report it.
		const page = driver.lastPage();
		page?.emitConsole({
			type: "log",
			text: `signing in ${USERNAME_SENTINEL} with ${PASSWORD_SENTINEL}`,
		});
		page?.emitNetwork({
			kind: "request",
			id: "dev-1",
			method: "GET",
			url: drag,
			resourceType: "document",
		});
		page?.emitNetwork({
			kind: "response",
			id: "dev-1",
			status: 200,
			ok: true,
		});
		await session.goto(
			`${APP_URL}?code=${CODE_SENTINEL}#access_token=${STATE_SENTINEL}`,
			30_000,
		);

		// 1. The agent's tool results: nothing of the developer's session. The
		// hand-off ends first — the declared success condition holds on the app's
		// home page — because that is when the agent may look again.
		const endWait = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session: sessionName,
			timeoutSec: 1,
		});
		expect(endWait.value.login).toBe("needs-user");
		await session.goto(`${APP_URL}home`, 30_000);
		const ended = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
			session: sessionName,
			timeoutSec: 30,
		});
		expect(ended.value.login).toBe("ok");
		const consoleResult = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {
			session: sessionName,
		});
		const networkResult = await call(deps, AGENT_BROWSER_NETWORK_PATH, {
			session: sessionName,
		});
		const refused: string[] = [];
		for (const [routePath, body] of [
			[AGENT_BROWSER_SNAPSHOT_PATH, { session: sessionName }],
			[AGENT_BROWSER_SCRIPT_PATH, { session: sessionName, code: "return 1;" }],
		] as Array<[string, Record<string, unknown>]>) {
			const answer = await call(deps, routePath, body);
			refused.push(answer.text);
		}
		const everything = [
			consoleResult.text,
			networkResult.text,
			endWait.text,
			ended.text,
			...refused,
		].join("\n");
		for (const sentinel of [
			PASSWORD_SENTINEL,
			USERNAME_SENTINEL,
			CODE_SENTINEL,
			STATE_SENTINEL,
		]) {
			expect(everything).not.toContain(sentinel);
		}
		// The developer's own traffic is not in the buffers at all: a foreign
		// login is not the agent's history.
		expect(consoleResult.value.entries).toEqual([]);
		expect(networkResult.value.entries).toEqual([]);

		// 2. Server log lines: the shape of each line is the coordinator's own
		// fields, so no later field can carry anything the page produced. Asserting
		// the shape rather than one absent string is what makes this leg able to
		// fail (TQ2-004).
		expect(logged.length).toBeGreaterThan(0);
		const LOG_FIELDS = new Set([
			"stage",
			"app",
			"role",
			"reason",
			"handoff",
			"deadlineAt",
			"at",
			"queuePosition",
			"outcome",
		]);
		for (const line of logged) {
			expect(line.startsWith("login hand-off phase=")).toBe(true);
			for (const token of line.split(" ").slice(3)) {
				expect(LOG_FIELDS.has(token.split("=")[0] ?? "")).toBe(true);
			}
		}
		expect(logged.join("\n")).not.toContain("https://login.example.test");

		// 3. The attention record, which is what the dashboard and the workflow
		// store read: exactly the coordination fields, and nothing else. A field
		// added to either call fails here.
		expect(records).toHaveLength(2);
		expect(Object.keys(records[0] ?? {}).sort()).toEqual([
			// A page login's record offers *Done*, which a completion-driven one does
			// not (USAB-207): the flag is data, never a value of the login.
			"canConfirm",
			"context",
			"description",
			"expiresAt",
			"owner",
			"recordId",
		]);
		expect(Object.keys(records[1] ?? {}).sort()).toEqual([
			"answer",
			"by",
			"outcome",
			"owner",
			"recordId",
		]);
		expect(JSON.stringify(records)).not.toContain(CODE_SENTINEL);
		expect(JSON.stringify(records)).not.toContain(STATE_SENTINEL);
		expect(JSON.stringify(records)).not.toContain("login.example.test/cb");

		// 4. Nothing of the login ends up on disk: no profile, no storage state,
		// anywhere under either root — not only at its top level (TQ2-004).
		for (const root of [deps.configDir ?? deps.worktree, deps.worktree]) {
			const found = fs
				.readdirSync(root, { recursive: true })
				.map((entry) => String(entry))
				.join("\n");
			expect(found.toLowerCase()).not.toContain("storage");
			expect(found.toLowerCase()).not.toContain("profile");
			expect(found.toLowerCase()).not.toContain("cookies");
		}
		// 5. Telemetry. The browser routes export no span or log record today —
		// they are not instrumented, and the coordinator's `log` seam is what the
		// server records — so there is nothing of the login to inspect here. When a
		// span processor is attached to the browser path, this test has to assert
		// its attributes too.
		await deps.pool.closeAll();
	});

	test("the banner is installed before the login page and gone once the hand-off ends", async () => {
		const driver = createFakeDriver();
		// A login the server can never confirm by itself, so the hand-off stays
		// open while this test looks at the window.
		const deps = build(
			configRoot({
				logins: {
					"web-form": {
						kind: "form",
						origin: IDP_URL,
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
					"https-basic": { kind: "http-basic" },
					sso: { kind: "interactive", success: { url: `${APP_URL}home` } },
				},
			}),
			driver,
		);
		await openStage(deps);
		const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
			app: "web",
			role: "sso",
		});
		const session = String(handoff.value.session);
		// The window opens in the background of the tool result, so the test waits
		// for the promotion and its single focus call rather than racing them.
		for (let i = 0; i < 400; i++) {
			if (driver.performed.includes("bringToFront")) break;
			await Bun.sleep(5);
		}
		const page = driver.lastPage();
		// The init script is installed on the promoted context, before its first
		// navigation, so the very page the developer lands on carries it.
		const script = driver.initScripts.at(-1)?.[0] ?? "";
		expect(script).toContain("data-ac-handoff-banner");
		// The banner is what the requirement is about: it names the stage, the
		// application and the role, says the agent is waiting, and says that closing
		// the window aborts the hand-off (OSV-103).
		expect(script).toContain("Grid integration");
		expect(script).toContain("Grid web");
		expect(script).toContain("sso");
		expect(script).toContain("local (in about");
		expect(script).toContain("The agent is waiting for this login");
		expect(script).toMatch(/closing this window aborts (it|the hand-off)/);
		// The banner is the promoted context's own document state, so the page a
		// later snapshot reads must not carry it once the hand-off is over.
		expect(page?.bannerRemoved).toBe(false);
		// The window is raised once, for the hand-off; no later tool call of the
		// developer's does it.
		const focusBefore = driver.pages.reduce(
			(total, page) => total + page.focusCalls,
			0,
		);
		expect(focusBefore).toBe(1);
		// End the hand-off from the agent side, as `browser_close` does.
		const closed = await call(deps, AGENT_BROWSER_CLOSE_PATH, { session });
		expect(closed.status).toBe(200);
		const focusAfter = driver.pages.reduce(
			(total, entry) => total + entry.focusCalls,
			0,
		);
		expect(focusAfter).toBe(focusBefore);
		// The banner is taken down again, on the live document, when the hand-off
		// ends: the agent's next snapshot cannot show it.
		expect(page?.bannerRemoved).toBe(true);
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
				sso: { kind: "interactive", success: { notOrigin: IDP_URL } },
			},
		});

		forbidInteractiveLogin(configDir);
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
					// Declared because a role names it; the stage would be refused
					// otherwise.
					sso: { kind: "interactive", success: { notOrigin: IDP_URL } },
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
					sso: { kind: "interactive", success: { notOrigin: IDP_URL } },
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

// The authorization code hand-off (`add-stage-oauth2-code-pkce`).
//
// The developer's sign-in at the provider is the fake driver's page work; what
// this block drives is everything the server does around it: `stage_login`
// answers `login-needs-user` and opens the provider's authorization endpoint in
// the hand-off window, the session may reach the loopback callback while the
// hand-off runs (and only then), the provider's redirect is a real HTTP request
// on the receiver, and `stage_login_wait` answers `ok` only once the token is
// held — never with a code, a verifier, a `state` or a token in its answer.
const CODE_CLIENT_ID = "code-pkce-client-id-do-not-leak";
const CODE_CLIENT_SECRET = "code-pkce-client-secret-do-not-leak";
const CODE_AUTHORIZATION_CODE = "authorization-code-do-not-leak";
const CODE_ACCESS_TOKEN = "authorization-code-access-token-do-not-leak";

/** A fake token endpoint that records what the exchange sent. */
function codeTokenEndpoint(): {
	readonly endpoint: string;
	readonly calls: URLSearchParams[];
	readonly stop: () => void;
} {
	const calls: URLSearchParams[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			calls.push(new URLSearchParams(await request.text()));
			return Response.json({
				access_token: CODE_ACCESS_TOKEN,
				expires_in: 3_600,
			});
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}/oauth2/token`,
		calls,
		stop: () => server.stop(true),
	};
}

/** One configuration root whose only role signs in with the code grant. */
function codeConfigRoot(
	tokenEndpoint: string,
	limits: Record<string, unknown> = {},
): string {
	const configDir = configRoot({
		apps: {
			web: {
				label: "Grid web",
				url: APP_URL,
				kind: "ui",
				roles: {
					user: {
						login: "oauth2",
						provider: "idp",
						grant: "authorization_code",
					},
				},
			},
		},
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint,
					authorizationEndpoint: `${IDP_URL}oauth2/authorize`,
					clientId: "${GRID_INT_CLIENT_ID}",
					clientSecret: "${GRID_INT_CLIENT_SECRET}",
				},
			},
		},
		allowedOrigins: [IDP_URL, new URL(tokenEndpoint).origin],
		limits: { maxSessions: 1, maxActionsPerMinute: 30, ...limits },
	});
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`GRID_INT_CLIENT_ID=${CODE_CLIENT_ID}\nGRID_INT_CLIENT_SECRET=${CODE_CLIENT_SECRET}\n`,
	);
	return configDir;
}

/** Every value one PKCE secret currently carries. The list rather than one
 * lookup: a state outlives the flow that registered it, so a count is how a
 * leaked flow is told from a closed one. */
function pkceValues(name: string): string[] {
	return pkceSecrets()
		.filter((secret) => secret.name === name)
		.map((secret) => secret.value);
}

/** One PKCE value the server currently keeps out of every reply. A login forgets
 * its verifier when its flow closes, so at most one is live here. */
function pkce(name: string): string | undefined {
	return pkceValues(name).at(-1);
}

/** The `state` of the login whose authorization URL the window is standing on:
 * what the provider's redirect would send back. */
function stateOf(session: BrowserSession): string {
	const state = new URL(session.url).searchParams.get("state");
	if (state === null) throw new Error("the provider URL carries no state");
	return state;
}

/** The loopback URL the provider would redirect to. */
function callbackUrl(origin: string, params: Record<string, string>): string {
	return `${origin}/callback?${new URLSearchParams(params).toString()}`;
}

/** Wait for the hand-off's window to finish its activation: the promotion and the
 * navigation to the provider happen after `stage_login` has answered. */
async function waitForUrl(
	session: BrowserSession,
	fragment: string,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (session.url.includes(fragment)) return;
		await Bun.sleep(5);
	}
	throw new Error(`the window never reached ${fragment}`);
}

describe("the authorization code hand-off", () => {
	test("stage_login opens the provider, the callback completes it, and the wait answers ok", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			// A recorded hand-off is what makes the banner's *Done* rule observable at
			// all: with no record the banner has no *Done* for the other reason, and a
			// regression of the completion rule would leave the assertion below green
			// (TQ-007). The record is also the surface the developer answers in.
			const records: Array<Record<string, unknown>> = [];
			const attention = {
				open: async (input: Record<string, unknown>) => {
					records.push({ ...input });
				},
				answer: async () => undefined,
				close: async () => {},
			} as unknown as LoginHandoffAttention;
			const deps = build(codeConfigRoot(idp.endpoint), driver, { attention });
			await openStage(deps);
			const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(handoff.status).toBe(200);
			expect(handoff.value.login).toBe("needs-user");
			expect(handoff.value.reason).toBe("user-identity");
			expect(typeof handoff.value.deadlineAt).toBe("string");
			// The answer carries the hand-off's status and nothing of the flow: no
			// challenge, no `state`, no URL.
			expect(handoff.text).not.toContain("code_challenge");
			expect(handoff.text).not.toContain("state=");

			const session = sessionOf(deps, "default");
			// The window was promoted and now stands on the provider's authorization
			// endpoint, which carries the challenge and the opaque state.
			expect(driver.launchOptions).toContainEqual({ headless: false });
			await waitForUrl(session, "oauth2/authorize");
			expect(session.url).toContain(`${IDP_URL}oauth2/authorize`);
			expect(session.url).toContain("code_challenge_method=S256");
			const state = stateOf(session);
			// The banner this window carries is the login's own: it says which role is
			// signing in and why, and it offers no *Done* the developer could choose,
			// because this login ends when the provider has called back — not when
			// someone says so (USAB-201).
			const banner = driver.initScripts.at(-1)?.[0] ?? "";
			expect(banner).toContain("data-ac-handoff-banner");
			expect(banner).toContain(
				"this role signs in with your own identity at the provider",
			);
			expect(banner).not.toContain("choose Done");
			expect(banner).toContain("the hand-off ends when the login is detected");
			expect(banner).not.toContain(state);
			expect(banner).not.toContain("code_challenge");
			// The dashboard record offers the same answers the banner does: *Done* would
			// end this login without a token, so it is not one of them (USAB-207).
			expect(records).toHaveLength(1);
			expect(records[0]?.canConfirm).toBe(false);
			const origin = deps.pool.handoffRedirect(session);
			expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			if (origin === undefined) throw new Error("no loopback allowance");
			// The one navigation an allow-list would otherwise abort is the redirect
			// the login itself asked for.
			expect(
				contextOf(deps).runGuard({
					url: callbackUrl(origin, { code: "x", state: "y" }),
					method: "GET",
					resourceType: "document",
					isMainFrameNavigation: true,
				}),
			).toBe(true);

			const verifier = pkce("stage-oauth2-code-verifier");
			expect(verifier).toBeDefined();
			const answered = await fetch(
				callbackUrl(origin, {
					code: CODE_AUTHORIZATION_CODE,
					state,
				}),
			);
			expect(answered.status).toBe(200);
			expect(await answered.text()).toContain("close this window");

			const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(waited.status).toBe(200);
			expect(waited.value.login).toBe("ok");
			expect(waited.value.via).toBe("token");
			expect(waited.value.verified).toBe(true);
			// The landing is the application, sanitized: never the callback the window
			// last landed on.
			expect(waited.value.url).toBe(APP_URL);
			for (const value of [
				CODE_AUTHORIZATION_CODE,
				CODE_ACCESS_TOKEN,
				state,
				verifier ?? "",
				origin,
				CODE_CLIENT_SECRET,
			])
				expect(waited.text).not.toContain(value);

			// The exchange happened once, with the verifier and this login's redirect.
			expect(idp.calls).toHaveLength(1);
			const exchange = idp.calls[0];
			if (exchange === undefined) throw new Error("no exchange was made");
			expect(exchange.get("grant_type")).toBe("authorization_code");
			expect(exchange.get("code")).toBe(CODE_AUTHORIZATION_CODE);
			expect(exchange.get("code_verifier")).toBe(verifier ?? "");
			expect(exchange.get("redirect_uri")).toBe(`${origin}/callback`);

			// The allowance is gone with the hand-off, and the window is back on the
			// application rather than on a callback page that no longer answers.
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			expect(session.url).toBe(APP_URL);
			expect(
				contextOf(deps).runGuard({
					url: callbackUrl(origin, { code: "x", state: "y" }),
					method: "GET",
					resourceType: "document",
					isMainFrameNavigation: true,
				}),
			).toBe(false);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a callback whose state does not match fails the login, and nothing is exchanged", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver);
			await openStage(deps);
			const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(handoff.value.login).toBe("needs-user");
			const session = sessionOf(deps, "default");
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");

			const answered = await fetch(
				callbackUrl(origin, {
					code: CODE_AUTHORIZATION_CODE,
					state: "not-this-logins-state",
				}),
			);
			expect(answered.status).toBe(400);
			expect(await answered.text()).not.toContain(CODE_AUTHORIZATION_CODE);

			const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(waited.status).toBe(502);
			expect(waited.value.code).toBe("login-failed");
			expect(String(waited.value.message)).toContain("state");
			expect(waited.text).not.toContain(CODE_AUTHORIZATION_CODE);
			// No exchange was attempted, and the receiver is not listening any more.
			expect(idp.calls).toHaveLength(0);
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			const late = await fetch(
				callbackUrl(origin, { code: "late", state: "late" }),
			).catch(() => undefined);
			expect(late).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("the deadline closes the receiver and answers login-handoff-timeout", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(
				codeConfigRoot(idp.endpoint, { maxLoginHandoffSeconds: 1 }),
				driver,
			);
			await openStage(deps);
			const handoff = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			const session = sessionOf(deps, "default");
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			// The deadline is the request time plus the stage's one second: two reads
			// of the clock put it in the past.
			deps.now?.();
			deps.now?.();
			const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: String(handoff.value.session),
				timeoutSec: 5,
			});
			expect(waited.status).toBe(408);
			expect(waited.value.code).toBe("login-handoff-timeout");
			expect(idp.calls).toHaveLength(0);
			// The receiver went with the deadline: nothing answers a late callback.
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			const late = await fetch(
				callbackUrl(origin, { code: "late", state: "late" }),
			).catch(() => undefined);
			expect(late).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("the code, the state and the verifier never survive a reply the page produced", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			// Two sessions: the login runs on the stage's, while the page-produced line
			// is read back through one the developer's sign-in does not hold. The
			// redaction set is the process's, so a reply on either one is scrubbed
			// (TQ-002).
			const deps = build(
				codeConfigRoot(idp.endpoint, { maxSessions: 2 }),
				driver,
			);
			await call(deps, AGENT_BROWSER_OPEN_PATH, {
				session: "plain",
				url: "https://plain.example.test/",
			});
			const plain = driver.lastPage();
			if (plain === undefined) throw new Error("no page was opened");
			await openStage(deps);
			await call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" });
			const session = sessionOf(deps, "default");
			await waitForUrl(session, "oauth2/authorize");
			const state = stateOf(session);
			const verifier = pkce("stage-oauth2-code-verifier");
			if (verifier === undefined) throw new Error("no verifier was registered");
			// A page that logs its own configuration is the usual source of a leaked
			// value. The verifier is put in the line to prove the set covers it, though
			// a page never sees one: it travels in the exchange's own body.
			plain.emitConsole({
				type: "error",
				text: `verifier=${verifier} state=${state}`,
			});
			const live = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {
				session: "plain",
			});
			expect(live.status).toBe(200);
			expect(live.text).toContain("verifier=");
			expect(live.text).not.toContain(verifier);
			expect(live.text).not.toContain(state);
			expect(live.text).toContain("redacted");

			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			const callback = callbackUrl(origin, {
				code: CODE_AUTHORIZATION_CODE,
				state,
			});
			expect(await fetch(callback).then((answer) => answer.status)).toBe(200);
			// The code is the one value the provider's redirect carries and could replay,
			// so it stays scrubbed for the rest of the process.
			plain.emitConsole({ type: "error", text: `replayed ${callback}` });
			const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(waited.value.login).toBe("ok");
			expect(waited.text).not.toContain(CODE_AUTHORIZATION_CODE);
			expect(waited.text).not.toContain(CODE_ACCESS_TOKEN);
			const after = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {
				session: "plain",
			});
			expect(after.text).toContain("replayed");
			expect(after.text).not.toContain(CODE_AUTHORIZATION_CODE);
			expect(after.text).not.toContain(CODE_CLIENT_SECRET);
			expect(after.text).toContain("redacted");
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a wait the developer ends by closing the window aborts the login and releases the receiver", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver);
			await openStage(deps);
			await call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" });
			const session = sessionOf(deps, "default");
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			const waiting = call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			for (let i = 0; i < 400; i++) {
				if (driver.performed.includes("bringToFront")) break;
				await Bun.sleep(5);
			}
			driver.lastPage()?.close("user");

			const waited = await waiting;
			expect(waited.status).toBe(409);
			expect(waited.value.code).toBe("login-handoff-aborted");
			expect(waited.value.by).toBe("window-closed");
			// An abort ends the login: no allowance, no listener, no exchange, and no
			// value in the answer (task 2.1).
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			expect(pkceValues("stage-oauth2-code-verifier")).toHaveLength(0);
			expect(
				await fetch(callbackUrl(origin, { code: "late", state: "late" })).catch(
					() => undefined,
				),
			).toBeUndefined();
			expect(idp.calls).toHaveLength(0);
			expect(waited.text).not.toContain(CODE_CLIENT_SECRET);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("Done on a login the provider completes is answered as unverified, and it closes the receiver", async () => {
		const idp = codeTokenEndpoint();
		const timers: Array<{ run: () => void; ms: number }> = [];
		const records: Array<Record<string, unknown>> = [];
		const attention = {
			open: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
			// The developer chose *Done*: for a completion-driven login that is not a
			// verification, and it must not be reported as one (TQ-003).
			answer: async () => "done" as const,
			close: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver, {
				attention,
				schedule: (run, ms) => {
					timers.push({ run, ms });
					return () => {};
				},
			});
			await openStage(deps);
			await call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" });
			const session = sessionOf(deps, "default");
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			const waiting = call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 600,
			});
			let settled = false;
			void waiting.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			for (let i = 0; i < 40 && !settled; i++) {
				for (const timer of timers.splice(0, timers.length)) {
					if (timer.ms !== HANDOFF_TICK_MS) {
						timers.push(timer);
						continue;
					}
					deps.now?.();
					timer.run();
				}
				await Bun.sleep(1);
			}
			expect(settled).toBe(true);
			const waited = await waiting;
			expect(waited.status).toBe(409);
			expect(waited.value.code).toBe("login-handoff-unverified");
			// *Done* ended the login without a token: the receiver goes, and nothing
			// was exchanged.
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			expect(idp.calls).toHaveLength(0);
			expect(
				await fetch(callbackUrl(origin, { code: "late", state: "late" })).catch(
					() => undefined,
				),
			).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("the attention record names the loopback origin in words and never the URL", async () => {
		const idp = codeTokenEndpoint();
		const records: Array<Record<string, unknown>> = [];
		const attention = {
			open: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
			answer: async () => undefined,
			close: async (input: Record<string, unknown>) => {
				records.push({ ...input });
			},
		} as unknown as LoginHandoffAttention;
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver, { attention });
			await openStage(deps);
			await call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" });
			const session = sessionOf(deps, "default");
			await waitForUrl(session, "oauth2/authorize");
			const state = stateOf(session);
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			const context = String(records[0]?.context);
			// The record says where to sign in as an origin and nothing more: the
			// provider's own, never the authorization URL's path or query, never
			// `state`, and never the loopback receiver the developer never visits
			// (TQ-004).
			expect(context).toContain("login.example.test");
			expect(context).toContain("own identity");
			expect(context).not.toContain("oauth2/authorize");
			expect(context).not.toContain("?");
			expect(context).not.toContain("127.0.0.1");
			expect(context).not.toContain(state);
			expect(context).not.toContain("code_challenge");
			expect(context).toContain("The hand-off expires at");
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("two logins that overlap leave exactly one receiver, and the login still completes", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver);
			await openStage(deps);
			// Two calls racing on one session: each opens a receiver before either
			// owns the hand-off, and the one that loses has to close its own without
			// touching the winner's (CONC-001, CONC-002, CONC-003, PERF-001).
			const [first, second] = await Promise.all([
				call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" }),
				call(deps, AGENT_BROWSER_LOGIN_PATH, { app: "web", role: "user" }),
			]);
			expect(first.value.login).toBe("needs-user");
			expect(second.value.login).toBe("needs-user");
			// One hand-off, not two: both answers describe the same queued login.
			expect(second.value.handoffId).toBe(first.value.handoffId);
			const session = sessionOf(deps, "default");
			// Exactly one verifier is live: the loser's flow was closed, so exactly one
			// receiver is listening and exactly one allowance remains.
			expect(pkceValues("stage-oauth2-code-verifier")).toHaveLength(1);
			const origin = deps.pool.handoffRedirect(session);
			if (origin === undefined) throw new Error("no loopback allowance");
			await waitForUrl(session, "oauth2/authorize");
			const answered = await fetch(
				callbackUrl(origin, {
					code: CODE_AUTHORIZATION_CODE,
					state: stateOf(session),
				}),
			);
			expect(answered.status).toBe(200);
			const waited = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(waited.value.login).toBe("ok");
			expect(idp.calls).toHaveLength(1);
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a role whose client id is not set is refused before a window or a receiver exists", async () => {
		const idp = codeTokenEndpoint();
		try {
			const configDir = codeConfigRoot(idp.endpoint);
			fs.writeFileSync(path.join(configDir, ".env"), "\n");
			const driver = createFakeDriver();
			const deps = build(configDir, driver);
			await openStage(deps);
			const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			// The mode `stage_info` reports is `unavailable` for this role, and the
			// refusal names the variable that is missing — the client id here, because the
			// provider's views are read in order and it is the first one unset (USAB-206).
			expect(refused.status).toBe(409);
			expect(refused.value.code).toBe("credential-missing");
			expect(String(refused.value.message)).toContain(
				"GRID_INT_CLIENT_ID is not set in the configuration .env",
			);
			expect(String(refused.value.message)).toContain("Settings → Stages");
			expect(refused.text).not.toContain("client id;");
			expect(driver.launchOptions).toEqual([{ headless: true }]);
			expect(driver.performed).toEqual([]);
			expect(
				deps.pool.handoffRedirect(sessionOf(deps, "default")),
			).toBeUndefined();
			expect(pkceValues("stage-oauth2-code-verifier")).toHaveLength(0);
			expect(idp.calls).toHaveLength(0);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a role whose provider secret is not set names that variable, not the client id", async () => {
		const idp = codeTokenEndpoint();
		try {
			const configDir = codeConfigRoot(idp.endpoint);
			// The provider declares both references, so the views are read in order: a
			// refusal that assumed the client id would name the one credential that *is*
			// set (USAB-206).
			fs.writeFileSync(
				path.join(configDir, ".env"),
				`GRID_INT_CLIENT_ID=${CODE_CLIENT_ID}\n`,
			);
			const driver = createFakeDriver();
			const deps = build(configDir, driver);
			await openStage(deps);
			const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(refused.status).toBe(409);
			expect(refused.value.code).toBe("credential-missing");
			expect(String(refused.value.message)).toContain(
				"GRID_INT_CLIENT_SECRET is not set in the configuration .env",
			);
			expect(refused.text).not.toContain("GRID_INT_CLIENT_ID is not set");
			expect(refused.text).not.toContain(CODE_CLIENT_ID);
			expect(driver.performed).toEqual([]);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a second sign-in exchanges its own code, even while the store holds the first token", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver);
			await openStage(deps);
			const session = sessionOf(deps, "default");

			const first = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(first.value.login).toBe("needs-user");
			await waitForUrl(session, "oauth2/authorize");
			const firstState = stateOf(session);
			const firstOrigin = deps.pool.handoffRedirect(session);
			if (firstOrigin === undefined) throw new Error("no loopback allowance");
			expect(
				await fetch(
					callbackUrl(firstOrigin, {
						code: CODE_AUTHORIZATION_CODE,
						state: firstState,
					}),
				).then((answer) => answer.status),
			).toBe(200);
			const firstWait = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(firstWait.value.login).toBe("ok");
			expect(idp.calls).toHaveLength(1);

			// A signed-in role is not a reason to skip a sign-in the developer asked for:
			// the exchange is this login's own acquisition, so it neither returns the
			// token the store already holds nor joins an acquisition of it (CONC-002,
			// TQ-009). Without that option the second login would answer `ok` from the
			// first token and never present its own code.
			const second = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(second.value.login).toBe("needs-user");
			let secondState = firstState;
			for (let attempt = 0; attempt < 400; attempt += 1) {
				// Read the URL before parsing it: a fresh login starts with the window still
				// on the application, which carries no `state` at all (TQ-012).
				const standing = new URL(session.url).searchParams.get("state");
				if (
					session.url.includes("oauth2/authorize") &&
					standing !== null &&
					standing !== firstState
				) {
					secondState = standing;
					break;
				}
				await Bun.sleep(5);
			}
			expect(secondState).not.toBe(firstState);
			const secondOrigin = deps.pool.handoffRedirect(session);
			if (secondOrigin === undefined) throw new Error("no loopback allowance");
			expect(
				await fetch(
					callbackUrl(secondOrigin, {
						code: `${CODE_AUTHORIZATION_CODE}-2`,
						state: secondState,
					}),
				).then((answer) => answer.status),
			).toBe(200);
			const secondWait = await call(deps, AGENT_BROWSER_LOGIN_WAIT_PATH, {
				session: "default",
				timeoutSec: 30,
			});
			expect(secondWait.value.login).toBe("ok");
			// Two sign-ins, two exchanges: the second presented the second code.
			expect(idp.calls).toHaveLength(2);
			expect(idp.calls[1]?.get("grant_type")).toBe("authorization_code");
			expect(idp.calls[1]?.get("code")).toBe(`${CODE_AUTHORIZATION_CODE}-2`);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("an allowance is released by its own origin, and never takes another's", async () => {
		const idp = codeTokenEndpoint();
		try {
			const driver = createFakeDriver();
			const deps = build(codeConfigRoot(idp.endpoint), driver);
			await openStage(deps);
			const session = sessionOf(deps, "default");
			// Two flows that overlap both hold an allowance, and the one that loses the
			// hand-off releases only its own (CONC-003).
			deps.pool.allowHandoffRedirect(session, "http://127.0.0.1:1");
			deps.pool.allowHandoffRedirect(session, "http://127.0.0.1:2");
			deps.pool.clearHandoffRedirect(session, "http://127.0.0.1:2");

			expect(deps.pool.handoffRedirect(session)).toBe("http://127.0.0.1:1");
			const guard = contextOf(deps).runGuard({
				url: "http://127.0.0.1:1/callback?code=x&state=y",
				method: "GET",
				resourceType: "document",
				isMainFrameNavigation: true,
			});
			expect(guard).toBe(true);
			expect(
				contextOf(deps).runGuard({
					url: "http://127.0.0.1:2/callback?code=x&state=y",
					method: "GET",
					resourceType: "document",
					isMainFrameNavigation: true,
				}),
			).toBe(false);
			// Releasing the last one leaves the session exactly as it was.
			deps.pool.clearHandoffRedirect(session, "http://127.0.0.1:1");
			expect(deps.pool.handoffRedirect(session)).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a policy that forbids the window refuses the code login without opening one", async () => {
		const idp = codeTokenEndpoint();
		try {
			const configDir = codeConfigRoot(idp.endpoint);
			forbidInteractiveLogin(configDir);
			const driver = createFakeDriver();
			const deps = build(configDir, driver);
			await openStage(deps);
			const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "web",
				role: "user",
			});
			expect(refused.status).toBe(409);
			expect(refused.value.code).toBe("login-user-unavailable");
			// No window, no banner, no receiver: the refusal is the policy's.
			expect(driver.launchOptions).toEqual([{ headless: true }]);
			expect(driver.performed).toEqual([]);
			expect(
				deps.pool.handoffRedirect(sessionOf(deps, "default")),
			).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});
});
