// Stage OAuth 2.0 bearer authorization in the browser layer
// (`add-stage-oauth2-auth`, tasks 3.3–3.4).
//
// Three questions, each asked the way the code asks it:
//
// * Which requests does this server authenticate? The pool's routing layer, asked
//   through the fake driver's `runAuthorization`, exactly as Playwright's route
//   handler asks it, plus a real navigation so the *reported* answer is covered.
// * Can a token reach anything an agent reads? The network report, a console
//   line and a snapshot are the three surfaces a token-shaped value would travel
//   through, and each is asserted with the token as a sentinel.
// * What does `stage_login` do for an `oauth2` role? It answers `ok` without a
//   page, a window or a person, and a refusal is the token path's own code.
//
// The provider is a real loopback HTTP server, so its token request is a real
// request; the browser is the existing fake driver.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file writes the literal `${VARIABLE}` reference syntax a stage file uses, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFakeDriver,
	type FakeContext,
} from "../src/server/browser/fake-driver.ts";
import type { LoginHandoffCoordinator } from "../src/server/browser/handoff.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	AUTHORIZATION_PLACEHOLDER,
	type BrowserRouteDeps,
	handleBrowserRoute,
} from "../src/server/browser/routes.ts";
import type { StageBearerScope } from "../src/server/browser/session.ts";
import {
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
} from "../src/server/protocol.ts";
import {
	readStageCatalog,
	stageByIdent,
	stagePaths,
} from "../src/server/stages/catalog.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import { roleToken, StageTokenStore } from "../src/server/stages/oauth2.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";

const OWNER = "workflow:wf-stage-oauth2-browser";
const APP_URL = "https://grid-int.example.test/";
const API_URL = "https://api.grid-int.example.test";
const IDP_URL = "https://login.example.test/";
const CLIENT_ID = "browser-client-id";
const CLIENT_SECRET = "browser-client-secret-do-not-leak-3f21";
const ACCESS_TOKEN = "browser-access-token-sentinel-6c40-do-not-leak";
const SCOPE = "api://grid/.default";

/** The provider: a real token endpoint on loopback. */
function provider(): {
	readonly endpoint: string;
	readonly calls: () => number;
	readonly stop: () => void;
} {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					access_token: ACCESS_TOKEN,
					token_type: "Bearer",
					expires_in: 3600,
					scope: SCOPE,
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}/oauth2/token`,
		calls: () => calls,
		stop: () => server.stop(true),
	};
}

/** One throwaway configuration root: a stage whose `api` role is `oauth2` and
 * whose page role is not. */
function configRoot(
	tokenEndpoint: string,
	options: { readonly withClientSecret?: boolean } = {},
): string {
	const configDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-oauth2-browser-"),
	);
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
					// The page a session is opened on: it is a page, not an API client, so
					// nothing about it is authenticated.
					viewer: {},
				},
			},
			api: {
				label: "Grid API",
				url: API_URL,
				kind: "api",
				roles: {
					service: {
						login: "oauth2",
						provider: "idp",
						grant: "client_credentials",
						bearerOrigins: [API_URL],
					},
				},
			},
		},
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint,
					clientId: "${GRID_INT_CLIENT_ID}",
					clientSecret: "${GRID_INT_CLIENT_SECRET}",
					scope: [SCOPE],
				},
			},
		},
		allowedOrigins: [new URL(tokenEndpoint).origin],
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${[
			`GRID_INT_CLIENT_ID=${CLIENT_ID}`,
			...(options.withClientSecret === false
				? []
				: [`GRID_INT_CLIENT_SECRET=${CLIENT_SECRET}`]),
		].join("\n")}\n`,
	);
	return configDir;
}

/** The token source the pool asks, mirroring `stageBearerToken`: the catalog is
 * re-read per request and the store decides whether a provider request happens. */
function fromProvider(tokens: StageTokenStore, configDir: string) {
	return async (
		binding: { readonly ident: string },
		scope: StageBearerScope,
	): Promise<string | undefined> => {
		const stage = stageByIdent(
			readStageCatalog(configDir),
			binding.ident,
		)?.stage;
		if (stage === undefined) return undefined;
		const token = await roleToken(
			{ stage, appKey: scope.app, role: scope.role, configDir },
			tokens,
		);
		return `Bearer ${token.accessToken}`;
	};
}

/** The browser layer over the fake driver, with a token source that records what
 * it was asked. Everything else is the harness the foundation's own tests use. */
function build(
	configDir: string,
	driver: ReturnType<typeof createFakeDriver>,
	options: {
		/** Wire the real token source over this harness's own store. */
		readonly readsProvider?: boolean;
		/** Or a source of the test's own. */
		readonly source?: (
			binding: { readonly ident: string },
			scope: StageBearerScope,
		) => Promise<string | undefined>;
	} = {},
): BrowserRouteDeps & {
	readonly pool: BrowserPool;
	readonly tokens: StageTokenStore;
	readonly asked: StageBearerScope[];
	/** Every `handoff.pending` question: an `oauth2` login must ask none. */
	readonly handoffAsks: string[];
} {
	const worktree = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-oauth2-worktree-"),
	);
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
		display: () => true,
	});
	const asked: StageBearerScope[] = [];
	const handoffAsks: string[] = [];
	let clock = 1_000_000;
	// The store and the routes must share one clock: a token's `expiresAt` is
	// computed from the `now` the route passes, and the store decides staleness with
	// its own, so two clocks would make every token look decades old.
	const now = () => (clock += 1_000);
	const tokens = new StageTokenStore({ now });
	// The pool is given a source only when the stage could have one: a stage with no
	// `bearerOrigins` must not even install the provider.
	const source =
		options.source ??
		(options.readsProvider === true
			? fromProvider(tokens, configDir)
			: undefined);
	const pool = new BrowserPool({
		driver,
		launch: (launchOptions) => installer.resolveLaunch(launchOptions),
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
		...(source === undefined
			? {}
			: {
					bearerToken: async (
						binding: { readonly ident: string },
						scope: StageBearerScope,
					) => {
						asked.push(scope);
						return await source(binding, scope);
					},
				}),
	});
	return {
		installer,
		// Without a real hand-off: an `oauth2` login must never need one, and the
		// question is recorded so a test can assert it was never asked.
		handoff: {
			pending: (session: { readonly name: string }) => {
				handoffAsks.push(session.name);
				return undefined;
			},
		} as unknown as LoginHandoffCoordinator,
		pool,
		configDir,
		// A recording needs its workflow located to have a scratch area; this harness
		// answers without the engine, as the foundation's own tests do.
		locate: (workflowId: string) =>
			workflowId === "wf-stage-oauth2-browser"
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
		tokens,
		asked,
		handoffAsks,
		settings: () => ({
			maxSessions: 4,
			idleTtlMs: 900_000,
			viewport: DEFAULT_BROWSER_VIEWPORT,
		}),
		stages: new StageUsageRegistry({
			now: () => clock,
			stageSessions: (owner, stage) => pool.stageSessions(owner, stage),
		}),
		now,
	};
}

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
): Promise<{
	readonly status: number;
	readonly value: Record<string, unknown>;
	readonly text: string;
}> {
	const url = `http://127.0.0.1:4052${routePath}`;
	const response = await handleBrowserRoute(
		deps,
		new Request(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		new URL(url),
		OWNER,
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

/** One open session on the stage. */
function openStage(deps: BrowserRouteDeps, body: Record<string, unknown> = {}) {
	return call(deps, AGENT_BROWSER_OPEN_PATH, {
		stage: "grid-int",
		stageApp: "web",
		...body,
	});
}

/** The routing layer's question for one request the page makes. */
function askAuthorization(
	deps: BrowserRouteDeps,
	url: string,
	headers: Record<string, string> = {},
): Promise<string | undefined> {
	const session = deps.pool.session(OWNER, "default");
	if (!session) throw new Error("no session");
	const context = session.context as unknown as FakeContext;
	return context.runAuthorization(
		{
			url,
			method: "GET",
			resourceType: "fetch",
			isMainFrameNavigation: false,
		},
		headers,
	);
}

/** The binding a session carries, or a failure that says the fixture is wrong. */
function bindingOf(deps: BrowserRouteDeps) {
	const session = deps.pool.session(OWNER, "default");
	if (!session) throw new Error("no session");
	return session.stage;
}

describe("the bearer scope of a stage-bound session", () => {
	test("only the origins a role declared are authenticated, and never over the page's own header", async () => {
		const idp = provider();
		try {
			const configDir = configRoot(idp.endpoint);
			const driver = createFakeDriver();
			const deps = build(configDir, driver, { readsProvider: true });
			await openStage(deps);

			// Opening the stage binds the scope; it does not ask for a token, because
			// no request has needed one yet.
			expect(bindingOf(deps)?.bearer).toEqual([
				{ origin: API_URL, app: "api", role: "service" },
			]);
			expect(deps.asked).toEqual([]);
			expect(idp.calls()).toBe(0);

			// The declared origin is authenticated, through the store the routes share.
			expect(await askAuthorization(deps, `${API_URL}/orders`)).toBe(
				`Bearer ${ACCESS_TOKEN}`,
			);
			expect(deps.asked).toEqual([
				{ origin: API_URL, app: "api", role: "service" },
			]);
			expect(idp.calls()).toBe(1);

			// A second request reuses the stored token.
			expect(await askAuthorization(deps, `${API_URL}/other`)).toBe(
				`Bearer ${ACCESS_TOKEN}`,
			);
			expect(idp.calls()).toBe(1);

			// Any other origin is left exactly as the page built it: the page's own
			// app and the identity provider declare no bearer scope.
			expect(
				await askAuthorization(deps, `${APP_URL}dashboard`),
			).toBeUndefined();
			expect(await askAuthorization(deps, IDP_URL)).toBeUndefined();
			expect(deps.asked).toHaveLength(2);

			// A request that already carries an `Authorization` header is never
			// overwritten: the page's own credential wins.
			expect(
				await askAuthorization(deps, `${API_URL}/orders`, {
					authorization: "Bearer the-page-own-token",
				}),
			).toBeUndefined();
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a role that declares no bearer origin installs no provider at all", async () => {
		const idp = provider();
		try {
			const configDir = configRoot(idp.endpoint);
			// The recipe stays; only the origin list goes. A token is still obtainable
			// for `stage_api_request`, and no page request is authenticated with it.
			const file = path.join(stagePaths(configDir).defsDir, "grid-int.json");
			const definition = JSON.parse(fs.readFileSync(file, "utf8")) as {
				apps: { api: { roles: { service: Record<string, unknown> } } };
			};
			delete definition.apps.api.roles.service.bearerOrigins;
			fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);

			const deps = build(configDir, createFakeDriver(), {
				source: async () => `Bearer ${ACCESS_TOKEN}`,
			});
			await openStage(deps);
			expect(bindingOf(deps)?.bearer).toBeUndefined();
			expect(await askAuthorization(deps, `${API_URL}/orders`)).toBeUndefined();
			expect(deps.asked).toEqual([]);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a recording keeps the bearer provider across its context swap", async () => {
		const idp = provider();
		try {
			const configDir = configRoot(idp.endpoint);
			const deps = build(configDir, createFakeDriver(), {
				readsProvider: true,
			});
			await openStage(deps);
			const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
				action: "start",
			});
			expect(started.status).toBe(200);
			// The recording swaps in a second context. A page that lost its bearer
			// provider would be a different session than the one the agent recorded —
			// strictly more observable and suddenly unauthenticated.
			expect(await askAuthorization(deps, `${API_URL}/orders`)).toBe(
				`Bearer ${ACCESS_TOKEN}`,
			);
			expect(idp.calls()).toBe(1);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a token source that cannot answer leaves the request unauthenticated, never aborted", async () => {
		const idp = provider();
		try {
			// The client secret is not set, and the source is the real one: it throws
			// `credential-missing`, which the pool swallows. A page request must still
			// go out unauthenticated rather than fail.
			const configDir = configRoot(idp.endpoint, { withClientSecret: false });
			const deps = build(configDir, createFakeDriver(), {
				readsProvider: true,
			});
			await openStage(deps);
			expect(await askAuthorization(deps, `${API_URL}/orders`)).toBeUndefined();
			expect(idp.calls()).toBe(0);
			// The session is still usable, which is the point: an unauthenticated
			// request is a page that works, an aborted one is a page that looks broken.
			expect((await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {})).status).toBe(
				200,
			);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});
});

describe("a token never reaches what an agent reads", () => {
	test("a navigation is authenticated, and the network report carries a placeholder instead of the header", async () => {
		const idp = provider();
		try {
			const configDir = configRoot(idp.endpoint);
			const driver = createFakeDriver();
			const deps = build(configDir, driver, { readsProvider: true });
			// A session opened on the API application navigates to the origin the
			// role declared, so the open's own first request is an authenticated one.
			const opened = await openStage(deps, { stageApp: "api" });
			expect(opened.status).toBe(200);
			expect(idp.calls()).toBe(1);
			expect(driver.authorized[0]?.header).toBe(`Bearer ${ACCESS_TOKEN}`);
			// The reported URL carries no authorization: the token lives in the request
			// the browser made, not in the session it reports.
			expect(opened.text).not.toContain(ACCESS_TOKEN);

			const network = await call(deps, AGENT_BROWSER_NETWORK_PATH, {});
			expect(network.status).toBe(200);
			const entries = network.value.entries as Array<Record<string, unknown>>;
			const authenticated = entries.filter(
				(entry) => entry.authorization !== undefined,
			);
			expect(authenticated).toHaveLength(1);
			expect(authenticated[0]?.authorization).toBe(AUTHORIZATION_PLACEHOLDER);
			// No header list and no value: an entry says *that* the request was
			// authenticated, never with what.
			expect(authenticated[0]?.hasAuthorization).toBeUndefined();
			expect(network.text).not.toContain(ACCESS_TOKEN);
			expect(network.text).not.toContain(CLIENT_SECRET);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a console line the page writes with the token, and a snapshot that shows it, are both redacted", async () => {
		const idp = provider();
		try {
			const configDir = configRoot(idp.endpoint);
			const driver = createFakeDriver({
				snapshot: `button "Authenticated with ${ACCESS_TOKEN}" [ref=e1]`,
			});
			const deps = build(configDir, driver, { readsProvider: true });
			await openStage(deps);
			// Acquire the token, so the store's secret set covers it: a page that echoes
			// a token back is redacted by the store and not only by the `.env`.
			await askAuthorization(deps, `${API_URL}/orders`);

			driver.pages[0]?.emitConsole({
				type: "log",
				text: `sending Authorization: Bearer ${ACCESS_TOKEN}`,
			});
			const console = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {});
			expect(console.status).toBe(200);
			expect(console.text).not.toContain(ACCESS_TOKEN);
			expect(console.text).toContain("«redacted");

			const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {});
			expect(snapshot.status).toBe(200);
			expect(snapshot.text).not.toContain(ACCESS_TOKEN);
			expect(snapshot.text).toContain("«redacted");
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});
});

describe("stage_login on an oauth2 role", () => {
	test("it answers ok through the token path, with no page, no window and no person", async () => {
		const idp = provider();
		try {
			const driver = createFakeDriver();
			const deps = build(configRoot(idp.endpoint), driver);
			expect((await openStage(deps)).status).toBe(200);

			const logged = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "api",
				role: "service",
			});
			expect(logged.status).toBe(200);
			expect(logged.value).toMatchObject({
				session: "default",
				stage: "grid-int",
				login: "ok",
				via: "token",
			});
			expect(String(logged.value.url)).toContain("grid-int.example.test");
			// No window, no typing, no hand-off: the login is a token request.
			expect(
				driver.launchOptions.filter((entry) => entry?.headless === false),
			).toEqual([]);
			expect(driver.performed).toEqual([]);
			// A token login opens no hand-off: the pending question is asked for every
			// login, and this one answered "nothing pending".
			expect(deps.handoffAsks).toEqual(["default"]);
			expect(idp.calls()).toBe(1);
			expect(logged.text).not.toContain(ACCESS_TOKEN);
			expect(logged.text).not.toContain(CLIENT_SECRET);

			// A second login reuses the token the store already holds.
			const again = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "api",
				role: "service",
			});
			expect(again.status).toBe(200);
			expect(idp.calls()).toBe(1);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a missing variable is refused by name, before the provider is asked", async () => {
		const idp = provider();
		try {
			const deps = build(
				configRoot(idp.endpoint, { withClientSecret: false }),
				createFakeDriver(),
			);
			await openStage(deps);
			const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "api",
				role: "service",
			});
			// The same code and status the declared recipes answer a `.env` gap with:
			// one surface, one meaning for `credential-missing`.
			expect(refused.status).toBe(409);
			expect(refused.value.code).toBe("credential-missing");
			expect(refused.text).toContain("GRID_INT_CLIENT_SECRET");
			expect(idp.calls()).toBe(0);
			await deps.pool.closeAll();
		} finally {
			idp.stop();
		}
	});

	test("a provider refusal is the token path's own code, scrubbed of the secret it was sent", async () => {
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async () => {
				calls += 1;
				return new Response(
					JSON.stringify({
						error: "invalid_client",
						error_description: `the client ${CLIENT_SECRET} is not known`,
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			},
		});
		try {
			const deps = build(
				configRoot(`http://127.0.0.1:${server.port}/oauth2/token`),
				createFakeDriver(),
			);
			await openStage(deps);
			const refused = await call(deps, AGENT_BROWSER_LOGIN_PATH, {
				app: "api",
				role: "service",
			});
			expect(refused.status).toBe(502);
			expect(refused.value.code).toBe("login-failed");
			expect(refused.text).toContain("invalid_client");
			expect(refused.text).not.toContain(CLIENT_SECRET);
			expect(calls).toBe(1);
			await deps.pool.closeAll();
		} finally {
			server.stop(true);
		}
	});
});
