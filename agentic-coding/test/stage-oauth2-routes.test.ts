// `stage_api_request` and `stage_token_info` on the wire
// (`add-stage-oauth2-auth`, tasks 3.1–3.2).
//
// Both routes run through their real handler against a throwaway configuration
// root *and* real HTTP servers on loopback: a token endpoint that answers what a
// provider would, and an API host that records the request it received. The
// server's own HTTP client is deliberately not stubbed, because the thing under
// test is what actually goes out on the wire — the `Authorization` header, the
// host, the method, the headers, the body, and how many times a `401` costs a
// renewal.
//
// The token is a sentinel, and every answer an agent could read is asserted not
// to contain it: the value, the error message, the response headers, the
// token-info value and the stage read.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file writes the literal `${VARIABLE}` reference syntax a stage file uses, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AGENT_STAGE_API_REQUEST_PATH,
	AGENT_STAGE_TOKEN_INFO_PATH,
	AGENT_STAGES_PATH,
	STAGES_CREDENTIAL_PATH,
} from "../src/server/protocol.ts";
import { stageBearerToken } from "../src/server/stages/api-request.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import { StageTokenStore } from "../src/server/stages/oauth2.ts";
import {
	handleStageCredentialRoute,
	handleStageRoute,
	type StageRouteDeps,
} from "../src/server/stages/routes.ts";

const OWNER = "workflow:wf-stage-oauth2";
const CLIENT_ID = "client-id-of-the-service-role";
const CLIENT_SECRET = "client-secret-do-not-leak-a41f";
const ACCESS_TOKEN = "access-token-sentinel-9d2c-do-not-leak";
const REFRESH_TOKEN = "refresh-token-sentinel-77bd-do-not-leak";
const SCOPE = "api://grid/.default";

interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | null;
	readonly headers: Headers;
	readonly body: string;
}

interface Server {
	readonly origin: string;
	readonly calls: RecordedCall[];
	readonly stop: () => void;
}

/** One loopback server that records every request and answers with `answer`. */
function serve(answer: (request: Request) => Response): Server {
	const calls: RecordedCall[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const requestUrl = new URL(request.url);
			const body = await request.text();
			calls.push({
				method: request.method,
				path: `${requestUrl.pathname}${requestUrl.search}`,
				authorization: request.headers.get("authorization"),
				headers: request.headers,
				body,
			});
			return answer(request);
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		calls,
		stop: () => server.stop(true),
	};
}

/** The provider's token answer: one access token, one scope, one hour. */
function tokenAnswer(accessToken = ACCESS_TOKEN): Response {
	return new Response(
		JSON.stringify({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 3600,
			scope: SCOPE,
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json", ...headers },
	});
}

interface Fixture {
	readonly configDir: string;
	readonly deps: StageRouteDeps;
	readonly tokens: StageTokenStore;
	readonly api: Server;
	readonly idp: Server;
}

interface FixtureOptions {
	readonly access?: "read-only" | "writable";
	readonly grant?: "client_credentials" | "refresh_token";
	readonly apiAnswer?: (request: Request) => Response;
	/** The token endpoint's answer for the nth request. */
	readonly tokenAnswers?: (count: number) => Response;
	/** The audience the provider declares, for the `stage_token_info` shape. */
	readonly audience?: string;
	/** A read-only exception, resolved against the API server's own origin. */
	readonly readOnlyException?: { readonly pathPrefix: string };
	/** The stage's action rate, tightened so one test can be refused by it. */
	readonly maxActionsPerMinute?: number;
}

/** One allow-listed stage whose API app and provider both live on loopback. */
function seeded(options: FixtureOptions = {}): Fixture {
	let tokenCount = 0;
	const idp = serve(() => {
		tokenCount += 1;
		return options.tokenAnswers?.(tokenCount) ?? tokenAnswer();
	});
	const api = serve(options.apiAnswer ?? (() => json({ orders: [] })));
	const configDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-oauth2-routes-"),
	);
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	const grant = options.grant ?? "client_credentials";
	const definition = {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: options.access ?? "writable",
		...(options.maxActionsPerMinute === undefined
			? {}
			: { limits: { maxActionsPerMinute: options.maxActionsPerMinute } }),
		...(options.readOnlyException === undefined
			? {}
			: {
					readOnlyExceptions: [
						{
							origin: api.origin,
							pathPrefix: options.readOnlyException.pathPrefix,
							methods: ["POST"],
						},
					],
				}),
		apps: {
			api: {
				label: "Grid API",
				url: api.origin,
				kind: "api",
				roles: {
					service: {
						login: "oauth2",
						provider: "idp",
						grant,
						...(grant === "refresh_token"
							? { refreshToken: "${STAGE_GRID_INT_REFRESH_TOKEN}" }
							: {}),
						bearerOrigins: [api.origin],
					},
				},
			},
		},
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint: `${idp.origin}/oauth2/token`,
					clientId: "${STAGE_GRID_INT_CLIENT_ID}",
					clientSecret: "${STAGE_GRID_INT_CLIENT_SECRET}",
					scope: [SCOPE],
					...(options.audience === undefined
						? {}
						: { audience: options.audience }),
				},
			},
		},
		allowedOrigins: [api.origin, idp.origin],
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	writeEnv(configDir, {
		STAGE_GRID_INT_CLIENT_ID: CLIENT_ID,
		STAGE_GRID_INT_CLIENT_SECRET: CLIENT_SECRET,
		STAGE_GRID_INT_REFRESH_TOKEN: REFRESH_TOKEN,
	});
	const tokens = new StageTokenStore();
	return { configDir, deps: { configDir, tokens }, tokens, api, idp };
}

function writeEnv(configDir: string, entries: Record<string, string>): void {
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(entries)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
}

/** Run one test against a fresh fixture, and always stop its servers. */
async function withFixture(
	options: FixtureOptions,
	body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
	const fixture = seeded(options);
	try {
		await body(fixture);
	} finally {
		fixture.api.stop();
		fixture.idp.stop();
	}
}

interface Answer {
	readonly status: number;
	readonly text: string;
	readonly value: Record<string, unknown>;
	readonly code?: string;
}

async function call(
	deps: StageRouteDeps,
	routePath: string,
	body: unknown,
	method = "POST",
): Promise<Answer> {
	const url = `http://127.0.0.1:4051${routePath}`;
	const response = await handleStageRoute(
		deps,
		new Request(url, {
			method,
			headers: { "content-type": "application/json" },
			...(method === "GET" ? {} : { body: JSON.stringify(body) }),
		}),
		new URL(url),
		OWNER,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	const error = parsed.error as Record<string, unknown> | undefined;
	return {
		status: response.status,
		text,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((error ?? {}) as Record<string, unknown>),
		...(error === undefined ? {} : { code: String(error.code) }),
	};
}

const apiRequest = (deps: StageRouteDeps, body: unknown) =>
	call(deps, AGENT_STAGE_API_REQUEST_PATH, body);

const tokenInfo = (deps: StageRouteDeps, body: unknown) =>
	call(deps, AGENT_STAGE_TOKEN_INFO_PATH, body);

const stageTestWorkflow = (overrides: Record<string, unknown> = {}) => ({
	workflowId: "wf-stage-oauth2",
	definitionId: "stage-test",
	stage: "grid-int",
	currentStep: "stage.execute",
	selectedRoles: ["stage-tester"],
	stageAccess: "writable" as const,
	...overrides,
});

describe("stage-test stage API authorization", () => {
	test("requests stay on the pinned stage and declared role in the tester step", async () => {
		await withFixture({ access: "writable" }, async (fixture) => {
			const deps: StageRouteDeps = {
				...fixture.deps,
				locateWorkflow: () => stageTestWorkflow(),
			};
			const otherStage = await apiRequest(deps, {
				stage: "other-stage",
				app: "api",
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(otherStage.status).toBe(403);
			expect(otherStage.code).toBe("stage-mismatch");
			const otherRole = await apiRequest(deps, {
				stage: "grid-int",
				app: "api",
				role: "other",
				method: "GET",
				path: "/orders",
			});
			expect(otherRole.status).toBe(404);
			expect(otherRole.code).toBe("stage-role-unknown");
			const outsideExecutor = await apiRequest(
				{
					...deps,
					locateWorkflow: () =>
						stageTestWorkflow({ currentStep: "stage.review" }),
				},
				{
					stage: "grid-int",
					app: "api",
					role: "service",
					method: "GET",
					path: "/orders",
				},
			);
			expect(outsideExecutor.status).toBe(403);
			expect(outsideExecutor.code).toBe("stage-test-tool-restricted");
			expect(fixture.api.calls).toHaveLength(0);
		});
	});

	test("a writable stage permits test data creation without a plan", async () => {
		await withFixture({ access: "writable" }, async (fixture) => {
			const deps: StageRouteDeps = {
				...fixture.deps,
				locateWorkflow: () => stageTestWorkflow(),
			};
			const answer = await apiRequest(deps, {
				stage: "grid-int",
				app: "api",
				role: "service",
				method: "POST",
				path: "/orders",
				body: "{}",
			});
			expect(answer.status).toBe(200);
			expect(fixture.api.calls).toHaveLength(1);
		});
	});

	test("a tester may POST but cannot replace or delete records", async () => {
		await withFixture({ access: "writable" }, async (fixture) => {
			const deps: StageRouteDeps = {
				...fixture.deps,
				locateWorkflow: () => stageTestWorkflow(),
			};
			for (const method of ["PUT", "PATCH", "DELETE"] as const) {
				const refused = await apiRequest(deps, {
					stage: "grid-int",
					app: "api",
					role: "service",
					method,
					path: "/orders/foreign-record",
					body: "{}",
				});
				expect(refused.status).toBe(403);
				expect(refused.code).toBe("stage-write-not-allowed");
			}
			expect(fixture.api.calls).toHaveLength(0);
			const created = await apiRequest(deps, {
				stage: "grid-int",
				app: "api",
				role: "service",
				method: "POST",
				path: "/orders",
				body: JSON.stringify({ reference: "wf-stage-oauth2-test" }),
			});
			expect(created.status).toBe(200);
			expect(fixture.api.calls).toHaveLength(1);
		});
	});
});

describe("stage_api_request sends the role's own credential", () => {
	test("the call carries the bearer token, and the answer carries no token", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await apiRequest(fixture.deps, {
				stage: "grid-int",
				app: "api",
				role: "service",
				method: "GET",
				path: "/orders?limit=2",
			});

			expect(answer.status).toBe(200);
			expect(answer.value).toMatchObject({
				stage: "grid-int",
				app: "api",
				role: "service",
				method: "GET",
				url: `${fixture.api.origin}/orders?limit=2`,
				status: 200,
				statusText: "OK",
				body: '{"orders":[]}',
				truncated: false,
				bytes: 13,
				renewals: 0,
			});
			// Exactly the fields the contract names: the response headers are the
			// host's own, reduced to an allow-list.
			expect(Object.keys(answer.value).sort()).toEqual([
				"app",
				"body",
				"bytes",
				"headers",
				"method",
				"renewals",
				"role",
				"stage",
				"status",
				"statusText",
				"truncated",
				"url",
			]);
			const headerNames = (answer.value.headers as Array<{ name: string }>).map(
				(header) => header.name,
			);
			expect(headerNames).toContain("content-type");
			expect(headerNames).not.toContain("set-cookie");
			// What actually went out: the stage's host, the role's token, the path
			// the agent named.
			const sent = fixture.api.calls[0];
			expect(sent?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
			expect(sent?.method).toBe("GET");
			expect(sent?.path).toBe("/orders?limit=2");
			// The provider was asked once, with its own credential in the `Basic`
			// header — never with a value the agent supplied.
			expect(fixture.idp.calls).toHaveLength(1);
			expect(fixture.idp.calls[0]?.path).toBe("/oauth2/token");
			expect(fixture.idp.calls[0]?.body).toContain(
				"grant_type=client_credentials",
			);
			expect(fixture.idp.calls[0]?.headers.get("authorization")).toBe(
				`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
			);
			expect(answer.text).not.toContain(ACCESS_TOKEN);
			expect(answer.text).not.toContain(CLIENT_SECRET);
		});
	});

	test("a body, a method and extra headers pass through, and the response headers are an allow-list", async () => {
		await withFixture(
			{
				apiAnswer: () =>
					json(
						{ ok: true },
						{
							// The API's own session machinery: never handed to the agent.
							"set-cookie": "session=secret-cookie-value",
							"x-custom": "not-allow-listed",
							"x-secret-session": "also-not-allow-listed",
							etag: '"v1"',
						},
					),
			},
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					// No `stage` and no `app`: exactly one of each exists, so the call
					// applies to them. Two would be `stage-app-ambiguous` instead.
					role: "service",
					method: "POST",
					path: "/orders",
					headers: { "content-type": "application/json", "x-trace": "abc" },
					body: '{"sku":"1"}',
				});

				expect(answer.status).toBe(200);
				expect(answer.value.stage).toBe("grid-int");
				expect(answer.value.app).toBe("api");
				const headers = answer.value.headers as Array<{
					name: string;
					value: string;
				}>;
				expect(headers.map((header) => header.name)).toContain("content-type");
				expect(headers.map((header) => header.name)).toContain("etag");
				expect(headers.map((header) => header.name)).not.toContain("x-custom");
				expect(answer.text).not.toContain("secret-cookie-value");
				expect(answer.text).not.toContain("not-allow-listed");

				const sent = fixture.api.calls[0];
				expect(sent?.method).toBe("POST");
				expect(sent?.body).toBe('{"sku":"1"}');
				expect(sent?.headers.get("x-trace")).toBe("abc");
				expect(sent?.headers.get("content-type")).toBe("application/json");
			},
		);
	});

	test("a token a stage echoes back is redacted out of the answer", async () => {
		await withFixture(
			// An API that repeats what it was given: the run's redactor, fed by the
			// token store, is the only thing between that and the agent.
			{
				apiAnswer: (request) =>
					json({ echo: request.headers.get("authorization") }),
			},
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/echo",
				});
				const body = String(answer.value.body);
				expect(body).not.toContain(ACCESS_TOKEN);
				expect(body).toContain("«redacted");
			},
		);
	});

	test("a refresh_token role presents its own grant, and the rotated token wins", async () => {
		await withFixture(
			{
				grant: "refresh_token",
				tokenAnswers: () =>
					new Response(
						JSON.stringify({
							access_token: ACCESS_TOKEN,
							refresh_token: "a-rotated-refresh-token",
							expires_in: 0,
						}),
						{ headers: { "content-type": "application/json" } },
					),
			},
			async (fixture) => {
				await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				// `expires_in: 0` means the entry is inside the renewal skew at once, so
				// the second call asks again — and sends the token the provider rotated
				// in, not the `.env` copy.
				await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				expect(fixture.idp.calls[0]?.body).toContain(
					`refresh_token=${REFRESH_TOKEN}`,
				);
				expect(fixture.idp.calls[1]?.body).toContain(
					"refresh_token=a-rotated-refresh-token",
				);
				expect(fixture.idp.calls[1]?.body).not.toContain(REFRESH_TOKEN);
			},
		);
	});
	test("query parameters are sent as the call's query string, and never twice", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await apiRequest(fixture.deps, {
				role: "service",
				method: "GET",
				path: "/orders",
				query: { limit: "5", tag: "a b" },
			});
			expect(answer.status).toBe(200);
			expect(fixture.api.calls[0]?.path).toBe("/orders?limit=5&tag=a+b");

			// One request cannot carry two query strings: a `?` in the path and a
			// `query` object are refused together, before anything is sent.
			const refused = await apiRequest(fixture.deps, {
				role: "service",
				method: "GET",
				path: "/orders?limit=5",
				query: { limit: "6" },
			});
			expect(refused.status).toBe(400);
			expect(refused.code).toBe("stage-request-invalid");
			expect(fixture.api.calls).toHaveLength(1);
		});
	});
});

describe("what stage_api_request refuses before anything is sent", () => {
	test("the path is a path: a URL and an authority-shaped path are refused", async () => {
		await withFixture({}, async (fixture) => {
			for (const bad of [
				"https://elsewhere.example.test/orders",
				"//elsewhere.example.test/orders",
				"orders",
			]) {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: bad,
				});
				expect(answer.status).toBe(400);
				expect(answer.code).toBe("stage-request-invalid");
			}
			// Neither the provider nor the API was touched.
			expect(fixture.idp.calls).toHaveLength(0);
			expect(fixture.api.calls).toHaveLength(0);
		});
	});

	test("an agent-supplied Authorization header is refused, not overwritten", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await apiRequest(fixture.deps, {
				role: "service",
				method: "GET",
				path: "/orders",
				headers: { Authorization: "Bearer a-credential-the-agent-invented" },
			});
			expect(answer.status).toBe(400);
			expect(answer.code).toBe("stage-auth-header");
			expect(answer.text).not.toContain("a-credential-the-agent-invented");
			expect(fixture.api.calls).toHaveLength(0);
		});
	});

	test("a write is refused on a read-only stage, and a declared exception admits one path", async () => {
		await withFixture(
			{
				access: "read-only",
				readOnlyException: { pathPrefix: "/search" },
			},
			async (fixture) => {
				const refused = await apiRequest(fixture.deps, {
					role: "service",
					method: "POST",
					path: "/orders",
				});
				expect(refused.status).toBe(400);
				expect(refused.code).toBe("stage-read-only");
				expect(refused.text).toContain("readOnlyExceptions");
				expect(fixture.api.calls).toHaveLength(0);

				// The exception the stage declares admits the one path it names, by the
				// same function the browser guard uses.
				const allowed = await apiRequest(fixture.deps, {
					role: "service",
					method: "POST",
					path: "/search?q=1",
				});
				expect(allowed.status).toBe(200);
				expect(fixture.api.calls[0]?.method).toBe("POST");
			},
		);
	});

	test("the stage's action rate is the one registry the browser tools share", async () => {
		const fixture = seeded({ maxActionsPerMinute: 1 });
		try {
			const deps: StageRouteDeps = {
				...fixture.deps,
				usage: new StageUsageRegistry({
					now: () => 1_000,
					stageSessions: () => 0,
				}),
			};
			const first = await apiRequest(deps, {
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(first.status).toBe(200);
			// The call was counted where a `browser_*` call is counted, so one stage
			// has one rate in this workflow whatever tool sends the request.
			const second = await apiRequest(deps, {
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(second.status).toBe(429);
			expect(second.code).toBe("stage-rate-limit");
			expect(Number(second.value.retryAfterMs)).toBeGreaterThan(0);
			expect(fixture.api.calls).toHaveLength(1);
		} finally {
			fixture.api.stop();
			fixture.idp.stop();
		}
	});

	test("the route answers POST only", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await call(
				fixture.deps,
				AGENT_STAGE_API_REQUEST_PATH,
				{},
				"GET",
			);
			expect(answer.status).toBe(405);
			expect(answer.code).toBe("method");
		});
	});
});

describe("one 401 costs exactly one renewal", () => {
	test("the refused token is dropped, the provider is asked again, and the retry answers", async () => {
		// The API accepts the token the provider issues on its *second* request:
		// the shape a restarted store creates.
		await withFixture(
			{
				tokenAnswers: (count) =>
					tokenAnswer(count === 1 ? "first-token-refused" : ACCESS_TOKEN),
				apiAnswer: (request) =>
					request.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`
						? json({ orders: ["fresh"] })
						: new Response("expired", { status: 401 }),
			},
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				expect(answer.status).toBe(200);
				expect(answer.value.status).toBe(200);
				expect(answer.value.renewals).toBe(1);
				// Two calls to the API and two tokens: the refused one was forgotten
				// rather than reused.
				expect(fixture.api.calls).toHaveLength(2);
				expect(fixture.idp.calls).toHaveLength(2);
				expect(fixture.api.calls[0]?.authorization).toBe(
					"Bearer first-token-refused",
				);
				expect(fixture.api.calls[1]?.authorization).toBe(
					`Bearer ${ACCESS_TOKEN}`,
				);
				expect(answer.text).not.toContain("first-token-refused");
			},
		);
	});

	test("a 401 renewal presents the rotated refresh token, not the .env one", async () => {
		// A rotating provider invalidates the refresh token it handed out before: the
		// retry has to present the replacement, or the renewal is refused as
		// `invalid_grant` even though the credential is fine (QA-002).
		await withFixture(
			{
				grant: "refresh_token",
				tokenAnswers: (count) =>
					json({
						access_token: `access-${count}`,
						refresh_token: `rotated-${count}`,
						expires_in: 3600,
					}),
				apiAnswer: (request) =>
					request.headers.get("authorization") === "Bearer access-2"
						? json({ orders: ["fresh"] })
						: new Response("expired", { status: 401 }),
			},
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				expect(answer.status).toBe(200);
				expect(answer.value.renewals).toBe(1);
				expect(fixture.idp.calls).toHaveLength(2);
				expect(fixture.idp.calls[0]?.body).toContain(
					`refresh_token=${REFRESH_TOKEN}`,
				);
				expect(fixture.idp.calls[1]?.body).toContain("refresh_token=rotated-1");
				expect(fixture.idp.calls[1]?.body).not.toContain(REFRESH_TOKEN);
			},
		);
	});

	test("a second 401 is reported as it is, and a 5xx is never retried as a credential problem", async () => {
		await withFixture(
			{
				apiAnswer: () => new Response("expired", { status: 401 }),
			},
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				// The API's answer, not an error: a stage that keeps refusing a valid
				// token is what the agent has to see.
				expect(answer.status).toBe(200);
				expect(answer.value.status).toBe(401);
				expect(answer.value.renewals).toBe(1);
				expect(fixture.api.calls).toHaveLength(2);
				expect(fixture.idp.calls).toHaveLength(2);
			},
		);

		await withFixture(
			{ apiAnswer: () => new Response("boom", { status: 500 }) },
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/orders",
				});
				expect(answer.status).toBe(200);
				expect(answer.value.status).toBe(500);
				expect(answer.value.renewals).toBe(0);
				expect(fixture.api.calls).toHaveLength(1);
				expect(fixture.idp.calls).toHaveLength(1);
			},
		);
	});
});

describe("the answer is bounded", () => {
	test("a body above the response bound is cut at the bound, and says so", async () => {
		const BIG = "x".repeat(300 * 1024);
		await withFixture(
			{ apiAnswer: () => new Response(BIG) },
			async (fixture) => {
				const answer = await apiRequest(fixture.deps, {
					role: "service",
					method: "GET",
					path: "/big",
				});
				expect(answer.status).toBe(200);
				expect(answer.value.truncated).toBe(true);
				expect(String(answer.value.body).length).toBeLessThanOrEqual(
					256 * 1024,
				);
				expect(Number(answer.value.bytes)).toBeGreaterThanOrEqual(300 * 1024);
			},
		);
	});

	test("a request body above the request bound never reaches the contract", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await apiRequest(fixture.deps, {
				role: "service",
				method: "POST",
				path: "/orders",
				body: "y".repeat(64 * 1024 + 1),
			});
			expect(answer.status).toBe(400);
			expect(fixture.api.calls).toHaveLength(0);
		});
	});

	test("the request bound is bytes, not characters, so a multi-byte body is refused too", async () => {
		await withFixture({}, async (fixture) => {
			// 40 000 characters, 80 000 bytes: the contract's character bound passes,
			// the route's byte bound does not.
			const answer = await apiRequest(fixture.deps, {
				role: "service",
				method: "POST",
				path: "/orders",
				body: "é".repeat(40_000),
			});
			expect(answer.status).toBe(413);
			expect(answer.code).toBe("stage-request-invalid");
			expect(fixture.api.calls).toHaveLength(0);
		});
	});

	test("a host that never answers is a call failure, not a hang", async () => {
		await withFixture({}, async (fixture) => {
			// The server's own client raising its timeout, which is what an
			// unresponsive host produces after the call's bound.
			const deps: StageRouteDeps = {
				...fixture.deps,
				fetch: (async (input: string | URL | Request, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : String(input);
					if (url.includes("/oauth2/token")) return await fetch(input, init);
					throw Object.assign(new Error("the operation timed out"), {
						name: "TimeoutError",
					});
				}) as unknown as typeof fetch,
			};
			const answer = await apiRequest(deps, {
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(answer.status).toBe(502);
			expect(answer.code).toBe("stage-request-failed");
			expect(answer.text).toContain("timeout");
			expect(answer.text).not.toContain(ACCESS_TOKEN);
		});
	});
});

describe("stage_token_info answers four fields", () => {
	test("it acquires a token when there is none, and names expiry, scopes and issuer", async () => {
		await withFixture({}, async (fixture) => {
			const before = Date.now();
			const answer = await tokenInfo(fixture.deps, {
				stage: "grid-int",
				app: "api",
				role: "service",
			});

			expect(answer.status).toBe(200);
			// Exactly the contract's fields: an opaque token's issuer is its
			// endpoint's origin, and no claim, subject or value is told.
			expect(Object.keys(answer.value).sort()).toEqual([
				"expiresAt",
				"issuer",
				"scopes",
			]);
			expect(answer.value.scopes).toEqual([SCOPE]);
			expect(answer.value.issuer).toBe(fixture.idp.origin);
			expect(Number(answer.value.expiresAt)).toBeGreaterThan(before);
			expect(fixture.idp.calls).toHaveLength(1);
			expect(answer.text).not.toContain(ACCESS_TOKEN);
			// The store holds the token; nothing that can be read out of it does.
			expect(fixture.tokens.list()).toHaveLength(1);
			expect(JSON.stringify(fixture.tokens.list())).not.toContain(ACCESS_TOKEN);
		});
	});

	test("a second read does not spend a second token request", async () => {
		await withFixture({}, async (fixture) => {
			await tokenInfo(fixture.deps, { role: "service", app: "api" });
			await tokenInfo(fixture.deps, { role: "service", app: "api" });
			expect(fixture.idp.calls).toHaveLength(1);
			expect(fixture.tokens.list()).toHaveLength(1);
		});
	});

	test("a declared audience is one of the four fields, and an absent one is not invented", async () => {
		await withFixture({ audience: "api://grid" }, async (fixture) => {
			const answer = await tokenInfo(fixture.deps, { role: "service" });
			expect(answer.status).toBe(200);
			expect(Object.keys(answer.value).sort()).toEqual([
				"audience",
				"expiresAt",
				"issuer",
				"scopes",
			]);
			expect(answer.value.audience).toBe("api://grid");
		});
	});

	test("a provider that names no lifetime still answers its expiry instead of failing", async () => {
		// `expires_in` is only RECOMMENDED, so an answer without it is legal: the
		// token is treated as short-lived, and the four fields are still reported
		// rather than the read failing on a token it just acquired (QA-001).
		await withFixture(
			{
				tokenAnswers: () =>
					json({ access_token: ACCESS_TOKEN, token_type: "Bearer" }),
			},
			async (fixture) => {
				const before = Date.now();
				const answer = await tokenInfo(fixture.deps, { role: "service" });
				expect(answer.status).toBe(200);
				expect(Number(answer.value.expiresAt)).toBeGreaterThanOrEqual(before);
				expect(answer.value.expiresAt).toBeLessThan(before + 60_000);
				expect(fixture.idp.calls).toHaveLength(1);
			},
		);
	});

	test("a provider that refuses answers its error code alone", async () => {
		await withFixture(
			{
				tokenAnswers: () =>
					new Response(
						JSON.stringify({
							error: "invalid_client",
							error_description: `the client ${CLIENT_SECRET} is not known`,
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					),
			},
			async (fixture) => {
				const answer = await tokenInfo(fixture.deps, { role: "service" });
				expect(answer.status).toBe(502);
				expect(answer.code).toBe("login-failed");
				expect(answer.text).toContain("invalid_client");
				// The provider's description is scrubbed of the values this server
				// holds: a token endpoint that echoes the secret back is covered.
				expect(answer.text).not.toContain(CLIENT_SECRET);
				expect(answer.text).toContain("«redacted");
			},
		);
	});

	test("a role with no reachable credential is refused by variable name", async () => {
		const fixture = seeded();
		try {
			// The client id is set, the secret is not: the refusal names the variable
			// the developer has to set, and sends no request.
			writeEnv(fixture.configDir, { STAGE_GRID_INT_CLIENT_ID: CLIENT_ID });
			const answer = await tokenInfo(fixture.deps, { role: "service" });
			expect(answer.status).toBe(400);
			expect(answer.code).toBe("credential-missing");
			expect(answer.text).toContain("STAGE_GRID_INT_CLIENT_SECRET");
			expect(fixture.idp.calls).toHaveLength(0);
		} finally {
			fixture.api.stop();
			fixture.idp.stop();
		}
	});

	test("an unset refresh token is refused by name too", async () => {
		await withFixture({ grant: "refresh_token" }, async (fixture) => {
			writeEnv(fixture.configDir, {
				STAGE_GRID_INT_CLIENT_ID: CLIENT_ID,
				STAGE_GRID_INT_CLIENT_SECRET: CLIENT_SECRET,
			});
			const answer = await tokenInfo(fixture.deps, { role: "service" });
			expect(answer.status).toBe(400);
			expect(answer.code).toBe("credential-missing");
			expect(answer.text).toContain("STAGE_GRID_INT_REFRESH_TOKEN");
			expect(fixture.idp.calls).toHaveLength(0);
		});
	});

	test("a stage nobody allow-listed, and a role nobody declares, are refused by name", async () => {
		await withFixture({}, async (fixture) => {
			const unknownStage = await tokenInfo(fixture.deps, {
				stage: "nope",
				role: "service",
			});
			expect(unknownStage.status).toBe(404);
			expect(unknownStage.code).toBe("stage-not-configured");

			const unknownRole = await tokenInfo(fixture.deps, {
				stage: "grid-int",
				role: "nobody",
			});
			expect(unknownRole.status).toBe(404);
			expect(unknownRole.code).toBe("stage-role-unknown");
			expect(fixture.idp.calls).toHaveLength(0);
		});
	});
});

describe("a rewritten credential is not shadowed by a token", () => {
	test("writing the client secret forgets the stage's tokens, so the next call uses it", async () => {
		await withFixture({}, async (fixture) => {
			await apiRequest(fixture.deps, {
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(fixture.tokens.list()).toHaveLength(1);

			const written = await handleStageCredentialRoute(
				fixture.deps,
				new Request(`http://127.0.0.1:4051${STAGES_CREDENTIAL_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						variable: "STAGE_GRID_INT_CLIENT_SECRET",
						value: "a-rotated-client-secret",
					}),
				}),
			);
			expect(written.status).toBe(200);
			// The entry acquired with the old secret is gone: the next call has to ask
			// the provider again, with what is on disk.
			expect(fixture.tokens.list()).toEqual([]);
			await apiRequest(fixture.deps, {
				role: "service",
				method: "GET",
				path: "/orders",
			});
			expect(fixture.idp.calls).toHaveLength(2);
			expect(fixture.idp.calls[1]?.headers.get("authorization")).toBe(
				`Basic ${Buffer.from(`${CLIENT_ID}:a-rotated-client-secret`).toString("base64")}`,
			);
		});
	});
});

describe("a session's bearer scope is resolved once", () => {
	test("the same page's N requests cost one catalog read and one token", async () => {
		await withFixture({}, async (fixture) => {
			// One binding object is one session: the pool passes the session's own
			// binding for every request its page makes (PERF-001, PERF-002).
			const binding = { ident: "grid-int" };
			const scope = { app: "api", role: "service" };
			expect(await stageBearerToken(fixture.deps, binding, scope)).toBe(
				`Bearer ${ACCESS_TOKEN}`,
			);
			expect(fixture.idp.calls).toHaveLength(1);

			// A second request of the same session, with deps that could not resolve
			// anything: the role was resolved once, and the token comes from the store.
			const elsewhere = {
				...fixture.deps,
				configDir: path.join(os.tmpdir(), "stage-oauth2-no-such-root"),
			};
			expect(await stageBearerToken(elsewhere, binding, scope)).toBe(
				`Bearer ${ACCESS_TOKEN}`,
			);
			expect(fixture.idp.calls).toHaveLength(1);

			// Another session has its own resolution, and refuses rather than
			// borrowing the first one's: the cache is per binding, not per role name.
			expect(
				await stageBearerToken(elsewhere, { ident: "grid-int" }, scope),
			).toBeUndefined();
			expect(fixture.idp.calls).toHaveLength(1);
		});
	});
});

describe("the stage read names the provider without a value", () => {
	test("the catalog read lists the provider, its endpoint and its credential status", async () => {
		await withFixture({}, async (fixture) => {
			const answer = await call(
				fixture.deps,
				`${AGENT_STAGES_PATH}/grid-int`,
				undefined,
				"GET",
			);
			expect(answer.status).toBe(200);
			const stages = answer.value.stages as Array<Record<string, unknown>>;
			const oauth2 = stages[0]?.oauth2 as {
				providers: Array<Record<string, unknown>>;
			};
			expect(oauth2.providers[0]?.name).toBe("idp");
			expect(oauth2.providers[0]?.tokenEndpoint).toBe(
				`${fixture.idp.origin}/oauth2/token`,
			);
			expect(oauth2.providers[0]?.scope).toEqual([SCOPE]);
			expect(oauth2.providers[0]?.credentials).toEqual([
				{
					field: "clientId",
					variable: "STAGE_GRID_INT_CLIENT_ID",
					status: "set",
				},
				{
					field: "clientSecret",
					variable: "STAGE_GRID_INT_CLIENT_SECRET",
					status: "set",
				},
			]);
			// The role reports the recipe, the provider and the origins it may carry a
			// bearer token to.
			const apps = stages[0]?.apps as Array<{
				roles: Array<Record<string, unknown>>;
			}>;
			const roles = apps[0]?.roles;
			expect(roles?.[0]).toMatchObject({
				role: "service",
				login: "oauth2",
				loginKind: "oauth2",
				provider: "idp",
				grant: "client_credentials",
				loginMode: "automated",
				cacheable: true,
				bearerOrigins: [fixture.api.origin],
			});
			for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN])
				expect(answer.text).not.toContain(secret);
		});
	});
});
