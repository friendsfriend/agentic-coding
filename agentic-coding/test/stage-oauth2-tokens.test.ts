// The OAuth 2.0 token path (`add-stage-oauth2-auth`, tasks 2.1–2.3) against a
// local fake token endpoint.
//
// Two properties are asserted here and nowhere else: the store is single-flight
// and bounded (a burst of callers is one request, a renewed token replaces its
// predecessor, a failed renewal evicts), and no token value is ever part of a
// read surface — a refusal carries the provider's `error` code, `list()` carries
// metadata, and every value the redactor needs is reachable through `secrets()`.
//
// The endpoint is `Bun.serve` on a loopback port, so the client id, the client
// secret and the tokens are all fixtures of this process: no real identity
// provider, no real credential and no network egress are involved.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file writes the literal `${VARIABLE}` reference syntax a stage file uses, so every occurrence is intentional fixture text, not a template placeholder.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readStageCatalog,
	stageByIdent,
} from "../src/server/stages/catalog.ts";
import {
	DEFAULT_FAILURE_TTL_MS,
	DEFAULT_TOKEN_ENTRY_CAP,
	DEFAULT_TOKEN_LIFETIME_MS,
	DEFAULT_TOKEN_SKEW_MS,
	forgetStageTokens,
	roleToken,
	roleTokenKey,
	StageAuthError,
	StageTokenStore,
	stageTokenStore,
	tokenKey,
	tokenSecrets,
} from "../src/server/stages/oauth2.ts";

const CLIENT_ID_VALUE = "client-id-value-do-not-leak";
const CLIENT_SECRET_VALUE = "client-secret-value-do-not-leak";
const REFRESH_TOKEN_VALUE = "refresh-token-value-do-not-leak";
const ROTATED_REFRESH_TOKEN = "rotated-refresh-token-value-do-not-leak";

/** One recorded token request. */
interface TokenCall {
	readonly authorization: string | null;
	readonly contentType: string | null;
	readonly form: URLSearchParams;
}

/** A fake token endpoint: it records every request and answers the scripted
 * responses in order (the last one repeats). */
function fakeProvider(
	responses: Array<(call: TokenCall) => Response | Promise<Response>>,
): {
	readonly calls: TokenCall[];
	readonly endpoint: string;
	readonly stop: () => void;
} {
	const calls: TokenCall[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const form = new URLSearchParams(await request.text());
			const call: TokenCall = {
				authorization: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				form,
			};
			calls.push(call);
			const answer =
				responses[Math.min(calls.length - 1, responses.length - 1)];
			return answer === undefined
				? new Response("{}", { status: 500 })
				: answer(call);
		},
	});
	return {
		calls,
		endpoint: `http://127.0.0.1:${server.port}/oauth2/token`,
		stop: () => server.stop(true),
	};
}

/** A JWT-shaped access token: three base64url segments, the middle one the
 * claims an `iss`/`aud` presentation reads. */
function jwt(claims: Record<string, unknown>): string {
	const segment = (value: unknown) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(claims)}.signature-part-of-the-token`;
}

/** The `.env` and the stage file of one stage whose provider points at the fake
 * endpoint. */
function seeded(options: {
	readonly endpoint: string;
	readonly grant: "client_credentials" | "refresh_token" | "authorization_code";
	readonly env?: Record<string, string>;
	readonly scope?: readonly string[];
	readonly audience?: string;
	readonly clientAuth?: "basic" | "body";
	readonly clientSecret?: boolean;
	/** Declare the provider's authorization endpoint, which the
	 * `authorization_code` grant requires. */
	readonly authorizationEndpoint?: boolean;
}): { readonly configDir: string } {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-oauth2-"));
	const defsDir = path.join(configDir, "stages", "definitions");
	fs.mkdirSync(defsDir, { recursive: true });
	const origin = new URL(options.endpoint).origin;
	const definition = {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "read-only",
		apps: {
			api: {
				label: "Grid API",
				url: origin,
				kind: "api",
				roles: {
					service: {
						login: "oauth2",
						provider: "idp",
						grant: options.grant,
						...(options.grant === "refresh_token"
							? { refreshToken: "${STAGE_GRID_INT_REFRESH_TOKEN}" }
							: {}),
						bearerOrigins: [origin],
					},
				},
			},
		},
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint: options.endpoint,
					...(options.authorizationEndpoint === true
						? { authorizationEndpoint: `${origin}/oauth2/authorize` }
						: {}),
					clientId: "${STAGE_GRID_INT_CLIENT_ID}",
					...(options.clientSecret === false
						? {}
						: { clientSecret: "${STAGE_GRID_INT_CLIENT_SECRET}" }),
					...(options.scope === undefined ? {} : { scope: options.scope }),
					...(options.audience === undefined
						? {}
						: { audience: options.audience }),
					...(options.clientAuth === undefined
						? {}
						: { clientAuth: options.clientAuth }),
				},
			},
		},
		allowedOrigins: [origin],
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	const env = {
		STAGE_GRID_INT_CLIENT_ID: CLIENT_ID_VALUE,
		STAGE_GRID_INT_CLIENT_SECRET: CLIENT_SECRET_VALUE,
		STAGE_GRID_INT_REFRESH_TOKEN: REFRESH_TOKEN_VALUE,
		...options.env,
	};
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(env)
			.filter(([, value]) => value !== "")
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
	return { configDir };
}

function roleOf(configDir: string, ident = "grid-int") {
	const catalog = readStageCatalog(configDir);
	const entry = stageByIdent(catalog, ident);
	if (entry === undefined)
		throw new Error(`stage ${ident} is not allow-listed`);
	return {
		entry,
		roleInput: {
			stage: entry.stage,
			appKey: "api",
			role: "service",
			configDir,
		},
	};
}

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

function provider(
	...responses: Array<(call: TokenCall) => Response | Promise<Response>>
) {
	const created = fakeProvider(responses);
	stops.push(created.stop);
	return created;
}

const tokenAnswer = (body: Record<string, unknown>) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});

describe("a client_credentials token request", () => {
	test("it authenticates with HTTP basic by default and stores what the provider answered", async () => {
		const accessToken = jwt({
			iss: "https://idp.example.test",
			aud: "grid-backend",
		});
		const idp = provider(() =>
			tokenAnswer({
				access_token: accessToken,
				expires_in: 3600,
				scope: "grid.read grid.write",
			}),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
			scope: ["grid.read", "grid.write"],
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore();

		const token = await roleToken(roleInput, store);

		expect(token.accessToken).toBe(accessToken);
		expect(token.scopes).toEqual(["grid.read", "grid.write"]);
		// The two presentation fields: the JWT's own `iss`, and the provider's
		// declared audience ahead of the token's `aud`.
		expect(token.issuer).toBe("https://idp.example.test");
		expect(token.audience).toBe("grid-backend");
		expect(idp.calls).toHaveLength(1);
		expect(idp.calls[0]?.contentType).toBe("application/x-www-form-urlencoded");
		expect(idp.calls[0]?.form.get("grant_type")).toBe("client_credentials");
		expect(idp.calls[0]?.form.get("scope")).toBe("grid.read grid.write");
		// The secret never travels in the form when the client uses basic auth.
		expect(idp.calls[0]?.form.get("client_secret")).toBeNull();
		expect(idp.calls[0]?.authorization).toBe(
			`Basic ${Buffer.from(`${CLIENT_ID_VALUE}:${CLIENT_SECRET_VALUE}`).toString("base64")}`,
		);
		// A second call rides the entry it already holds.
		await roleToken(roleInput, store);
		expect(idp.calls).toHaveLength(1);
	});

	test("the client may authenticate in the body instead, and an opaque token still names its issuer", async () => {
		const idp = provider(() =>
			tokenAnswer({ access_token: "opaque-access-token", expires_in: 60 }),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
			clientAuth: "body",
		});
		const { roleInput } = roleOf(configDir);

		const token = await roleToken(roleInput, new StageTokenStore());

		expect(idp.calls[0]?.form.get("client_secret")).toBe(CLIENT_SECRET_VALUE);
		expect(idp.calls[0]?.authorization).toBeNull();
		// Not a JWT: the only thing this may say about where it came from is the
		// origin of the endpoint that issued it.
		expect(token.issuer).toBe(new URL(idp.endpoint).origin);
		expect(token.audience).toBeUndefined();
	});

	test("the audience is the provider's declaration, and the token's `aud` only when there is none", async () => {
		const idp = provider(() =>
			tokenAnswer({
				access_token: jwt({ aud: "from-the-token", iss: "iss-a" }),
				expires_in: 60,
			}),
		);
		const declared = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
			audience: "declared-audience",
		});
		const declaredRole = roleOf(declared.configDir);
		expect(
			(await roleToken(declaredRole.roleInput, new StageTokenStore())).audience,
		).toBe("declared-audience");
		expect(idp.calls[0]?.form.get("audience")).toBe("declared-audience");

		const token = await roleToken(
			declaredRole.roleInput,
			new StageTokenStore(),
			{},
		);
		expect(token.scopes).toEqual([]);
	});
});

describe("the store", () => {
	test("a burst of callers produces exactly one request, and they all get the same token", async () => {
		const idp = provider(
			() =>
				new Response(
					JSON.stringify({ access_token: "one-token", expires_in: 3600 }),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore();

		const tokens = await Promise.all([
			roleToken(roleInput, store),
			roleToken(roleInput, store),
			roleToken(roleInput, store),
		]);

		expect(idp.calls).toHaveLength(1);
		expect(new Set(tokens.map((token) => token.accessToken)).size).toBe(1);
	});

	test("it renews inside the skew window, and a renewal answers the new token", async () => {
		let clock = 1_000_000;
		const idp = provider(
			() =>
				new Response(
					JSON.stringify({
						access_token: `token-${idp.calls.length}`,
						expires_in: 120,
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore({ now: () => clock });

		const first = await roleToken(roleInput, store, { now: () => clock });
		// Well outside the skew, so the entry is still fresh.
		clock += 30_000;
		expect(
			(await roleToken(roleInput, store, { now: () => clock })).accessToken,
		).toBe(first.accessToken);
		expect(idp.calls).toHaveLength(1);
		// Inside the last minute of the lifetime it is renewed rather than handed
		// out again.
		clock += 35_000;
		const third = await roleToken(roleInput, store, { now: () => clock });
		expect(third.accessToken).not.toBe(first.accessToken);
		expect(idp.calls).toHaveLength(2);
	});

	test("a burst of callers inside the skew window is still one renewal", async () => {
		let clock = 1_000_000;
		const idp = provider(() =>
			tokenAnswer({
				access_token: `token-${idp.calls.length}`,
				expires_in: 120,
			}),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore({ now: () => clock });

		const first = await roleToken(roleInput, store, { now: () => clock });
		// The entry is now inside the skew, so every caller renews it — and every
		// caller has to share the one renewal that is in flight (TQV-006).
		clock += 120_000 - DEFAULT_TOKEN_SKEW_MS + 1;
		const renewed = await Promise.all([
			roleToken(roleInput, store, { now: () => clock }),
			roleToken(roleInput, store, { now: () => clock }),
			roleToken(roleInput, store, { now: () => clock }),
		]);

		expect(idp.calls).toHaveLength(2);
		expect(new Set(renewed.map((token) => token.accessToken)).size).toBe(1);
		expect(renewed[0]?.accessToken).not.toBe(first.accessToken);
		// The renewed entry is what the store holds: the burst did not leave the
		// older token behind it.
		expect(store.peek(roleTokenKey(roleInput))?.accessToken).toBe(
			renewed[0]?.accessToken,
		);
	});

	test("a token endpoint that never answers is a timeout, and leaves no entry behind", async () => {
		const idp = provider(() =>
			tokenAnswer({ access_token: "never-asked", expires_in: 60 }),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore();

		const failure = (await roleToken(roleInput, store, {
			fetch: (async () => {
				throw Object.assign(new Error("the operation timed out"), {
					name: "TimeoutError",
				});
			}) as unknown as typeof fetch,
		}).catch((error: unknown) => error)) as StageAuthError;

		expect(failure).toBeInstanceOf(StageAuthError);
		expect(failure.code).toBe("login-failed");
		expect(failure.providerCode).toBe("token_endpoint_unreachable");
		expect(failure.message).toContain("timeout");
		expect(failure.message).not.toContain(CLIENT_SECRET_VALUE);
		expect(idp.calls).toHaveLength(0);
		expect(store.list()).toEqual([]);
	});

	test("a refresh_token grant sends the declared token, and a rotated one wins thereafter", async () => {
		let clock = 5_000_000;
		const idp = provider(
			() =>
				new Response(
					JSON.stringify({
						access_token: `token-${idp.calls.length}`,
						refresh_token: ROTATED_REFRESH_TOKEN,
						expires_in: 60,
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "refresh_token",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore({ now: () => clock });

		await roleToken(roleInput, store, { now: () => clock });
		expect(idp.calls[0]?.form.get("grant_type")).toBe("refresh_token");
		expect(idp.calls[0]?.form.get("refresh_token")).toBe(REFRESH_TOKEN_VALUE);

		// The next renewal exchanges the *rotated* token: the `.env` value is never
		// rewritten, and the copy the provider invalidated is not sent again.
		clock += 60_000;
		await roleToken(roleInput, store, { now: () => clock });
		expect(idp.calls).toHaveLength(2);
		expect(idp.calls[1]?.form.get("refresh_token")).toBe(ROTATED_REFRESH_TOKEN);
	});

	test("a provider refusal is its error code and nothing else, and it evicts the entry", async () => {
		const idp = provider(
			() =>
				new Response(
					JSON.stringify({
						error: "invalid_client",
						error_description: `client secret ${CLIENT_SECRET_VALUE} was rejected`,
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore();

		const failure = await roleToken(roleInput, store).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(StageAuthError);
		const auth = failure as StageAuthError;
		expect(auth.code).toBe("login-failed");
		expect(auth.providerCode).toBe("invalid_client");
		expect(auth.message).toContain("invalid_client");
		// The description is scrubbed of every value the client holds.
		expect(auth.message).not.toContain(CLIENT_SECRET_VALUE);
		expect(auth.message).toContain("«redacted:stage-client-secret»");
		// Nothing was remembered, and nothing failed *silently*.
		expect(store.peek(roleTokenKey(roleInput))).toBeUndefined();
		expect(store.secrets()).toEqual([]);
	});

	test("an unset credential is credential-missing, naming the variable and sending no request", async () => {
		const idp = provider(() =>
			tokenAnswer({ access_token: "never-asked", expires_in: 60 }),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
			env: { STAGE_GRID_INT_CLIENT_SECRET: "" },
		});
		const { roleInput } = roleOf(configDir);

		const failure = await roleToken(roleInput, new StageTokenStore()).catch(
			(error: unknown) => error,
		);

		const auth = failure as StageAuthError;
		expect(auth.code).toBe("credential-missing");
		expect(auth.message).toContain("STAGE_GRID_INT_CLIENT_SECRET");
		expect(auth.providerCode).toBeUndefined();
		expect(idp.calls).toHaveLength(0);
	});

	test("the authorization_code grant is a named refusal rather than a half-built login", async () => {
		const idp = provider(() =>
			tokenAnswer({ access_token: "never-asked", expires_in: 60 }),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "authorization_code",
			authorizationEndpoint: true,
		});
		const { roleInput } = roleOf(configDir);

		const failure = (await roleToken(roleInput, new StageTokenStore()).catch(
			(error: unknown) => error,
		)) as StageAuthError;

		expect(failure.code).toBe("login-failed");
		expect(failure.providerCode).toBe("unsupported_grant");
		// The message is for its reader: it names the grants that do work here, and
		// never an internal change id (USAB-004).
		expect(failure.message).toContain("not supported by this build");
		expect(failure.message).toContain("client_credentials");
		expect(failure.message).not.toContain("add-stage");
		expect(idp.calls).toHaveLength(0);
	});
});

describe("the store's bounds", () => {
	test("forget drops the entries of one stage, and only those", async () => {
		const store = new StageTokenStore();
		const acquire = (stage: string, name: string) =>
			store.token(
				{ stage, app: "api", role: "r", provider: "idp", scope: [] },
				async () => ({
					accessToken: name,
					expiresAt: Date.now() + 60_000,
					scopes: [],
					provider: "idp",
				}),
			);

		await acquire("a", "token-a");
		await acquire("b", "token-b");
		expect(store.list()).toHaveLength(2);

		forgetStageTokens({ stage: "a" }, store);

		const left = store.list();
		expect(left).toHaveLength(1);
		expect(left[0]?.stage).toBe("b");
	});

	test("the entry cap evicts the token that expires soonest, and the ceiling bounds a long lifetime", async () => {
		const store = new StageTokenStore({
			entryCap: 2,
			now: () => 1_000,
		});
		const token = (name: string, expiresAt: number) =>
			store.token(
				{ stage: "s", app: "api", role: name, provider: "idp", scope: [] },
				async () => ({
					accessToken: `token-${name}`,
					expiresAt,
					scopes: ["a"],
					provider: "idp",
				}),
			);
		// A provider may answer a 30-day lifetime; the store holds eight hours.
		const long = await token("one", 1_000 + 30 * 24 * 60 * 60 * 1000);
		expect(long.expiresAt).toBe(1_000 + DEFAULT_TOKEN_LIFETIME_MS);
		await token("two", 1_000 + 60_000);
		// The earliest-expiring entry goes, not the oldest insertion: an entry whose
		// renewal is in flight is never the one evicted (CONC-002).
		await token("three", 1_000 + 120_000);

		const held = store.list();
		expect(held).toHaveLength(2);
		expect(held.map((entry) => entry.role)).toEqual(["one", "three"]);
	});

	test("a credential written while a token request is in flight is not shadowed by its answer", async () => {
		// `STAGES_CREDENTIAL_PATH` writes the secret and forgets the stage's entries
		// while a request the old secret started is still open. Its answer describes a
		// credential that no longer exists, so the store must not keep it (CONC-001).
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const idp = provider(async () => {
			await gate;
			return tokenAnswer({
				access_token: "token-of-the-old-secret",
				expires_in: 3600,
			});
		});
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore();

		const inFlight = roleToken(roleInput, store);
		forgetStageTokens({ stage: "grid-int" }, store);
		release?.();
		const handed = await inFlight;

		// The caller that asked before the write still gets an answer...
		expect(handed.accessToken).toBe("token-of-the-old-secret");
		// ...and nothing of it is remembered, so the next call asks again.
		expect(store.list()).toEqual([]);
		expect(store.peek(roleTokenKey(roleInput))).toBeUndefined();
		expect(store.secrets()).toEqual([]);
		await roleToken(roleInput, store);
		expect(idp.calls).toHaveLength(2);
	});

	test("expiring one entry keeps the refresh token it rotated in, and forgetting it does not", async () => {
		const clock = 5_000_000;
		const idp = provider(() =>
			tokenAnswer({
				access_token: `token-${idp.calls.length}`,
				refresh_token: ROTATED_REFRESH_TOKEN,
				expires_in: 3600,
			}),
		);
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "refresh_token",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore({ now: () => clock });

		await roleToken(roleInput, store, { now: () => clock });
		// A `401` drops the access token the stage refused, and the rotated refresh
		// token survives it: a provider that rotates keeps only the value it last
		// issued, so the renewal has to present that one (QA-002).
		store.expire(roleTokenKey(roleInput));
		expect(store.peek(roleTokenKey(roleInput))).toBeUndefined();
		expect(
			store.refreshTokenFor(roleTokenKey(roleInput), REFRESH_TOKEN_VALUE),
		).toBe(ROTATED_REFRESH_TOKEN);
		await roleToken(roleInput, store, { now: () => clock });
		expect(idp.calls[1]?.form.get("refresh_token")).toBe(ROTATED_REFRESH_TOKEN);

		// A forgotten credential is the opposite case: the `.env` value is current
		// again, because the entry was dropped together with what it derived.
		forgetStageTokens({ stage: "grid-int" }, store);
		expect(
			store.refreshTokenFor(roleTokenKey(roleInput), REFRESH_TOKEN_VALUE),
		).toBe(REFRESH_TOKEN_VALUE);
		await roleToken(roleInput, store, { now: () => clock });
		expect(idp.calls[2]?.form.get("refresh_token")).toBe(REFRESH_TOKEN_VALUE);
	});

	test("an unreachable provider is asked once per failure window, not once per call", async () => {
		let clock = 9_000_000;
		const idp = provider(() => new Response("{}", { status: 503 }));
		const { configDir } = seeded({
			endpoint: idp.endpoint,
			grant: "client_credentials",
		});
		const { roleInput } = roleOf(configDir);
		const store = new StageTokenStore({ now: () => clock });

		const first = await roleToken(roleInput, store, {
			now: () => clock,
		}).catch((error: unknown) => error);
		expect(first).toBeInstanceOf(StageAuthError);
		// A provider that is down costs one request per window, not one per page
		// request that asks for a token (PERF-003).
		const second = await roleToken(roleInput, store, {
			now: () => clock,
		}).catch((error: unknown) => error);
		expect(second).toBe(first);
		expect(idp.calls).toHaveLength(1);

		// Once the window has passed the provider is asked again.
		clock += DEFAULT_FAILURE_TTL_MS + 1;
		await roleToken(roleInput, store, { now: () => clock }).catch(
			() => undefined,
		);
		expect(idp.calls).toHaveLength(2);
	});

	test("the cap never evicts an entry whose renewal is in flight", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const clock = 1_000_000;
		const store = new StageTokenStore({ entryCap: 2, now: () => clock });
		const keyOf = (role: string) => ({
			stage: "s",
			app: "api",
			role,
			provider: "idp",
			scope: [],
		});
		const acquire = (role: string, expiresAt: number) =>
			store.token(keyOf(role), async () => ({
				accessToken: `token-${role}`,
				expiresAt,
				scopes: [],
				provider: "idp",
			}));

		await acquire("one", clock + 10_000);
		await acquire("two", clock + 20_000);
		// A renewal of `one` is in flight, and a third entry arrives: the cap has to
		// evict something else, because the in-flight key's rotated refresh token is
		// the one its own acquisition needs (CONC-002).
		const inFlight = store.token(keyOf("one"), async () => {
			await gate;
			return {
				accessToken: "token-one-again",
				expiresAt: clock + 30_000,
				scopes: [],
				provider: "idp",
			};
		});
		await acquire("three", clock + 40_000);
		const held = store.list().map((entry) => entry.role);
		expect(held).toContain("one");
		expect(held).not.toContain("two");
		release?.();
		expect((await inFlight).accessToken).toBe("token-one-again");
	});

	test("the process store is one store, and it lists metadata that carries no token", async () => {
		expect(stageTokenStore()).toBe(stageTokenStore());
		const store = stageTokenStore();
		const before = store.list().length;
		const token = jwt({ iss: "iss", aud: "aud" });
		await store.token(
			{ stage: "s", app: "api", role: "r", provider: "idp", scope: ["x"] },
			async () => ({
				accessToken: token,
				refreshToken: REFRESH_TOKEN_VALUE,
				expiresAt: Date.now() + 60_000,
				scopes: ["x"],
				provider: "idp",
			}),
		);
		const listed = JSON.stringify(store.list());
		expect(listed).not.toContain(token);
		expect(listed).not.toContain(REFRESH_TOKEN_VALUE);
		expect(store.list().length).toBe(before + 1);
		forgetStageTokens({ stage: "s" }, store);
		expect(store.list().length).toBe(before);
	});

	test("the redactor's secret set covers the access token, the refresh token and every JWT segment", () => {
		const accessToken = jwt({ iss: "iss", aud: "aud" });
		const segments = accessToken.split(".");
		const secrets = tokenSecrets([
			{
				accessToken,
				refreshToken: REFRESH_TOKEN_VALUE,
				expiresAt: Date.now(),
				scopes: [],
				provider: "idp",
			},
		]);
		const values = secrets.map((secret) => secret.value);
		expect(values).toContain(accessToken);
		expect(values).toContain(REFRESH_TOKEN_VALUE);
		for (const segment of segments)
			if (segment.length >= 20) expect(values).toContain(segment);
		// Longest first, so a segment is never replaced by the token that contains
		// it (or the other way round).
		expect(values[0]?.length).toBe(
			Math.max(...values.map((value) => value.length)),
		);
	});

	test("the documented default cap is the one a default store applies", async () => {
		expect(DEFAULT_TOKEN_ENTRY_CAP).toBe(32);
		// A store nobody configured, driven past the cap: the constant and the
		// default have to be the same number, or the docs describe another store.
		const store = new StageTokenStore({ now: () => 1_000 });
		const acquire = (n: number) =>
			store.token(
				{ stage: "s", app: "a", role: `r${n}`, provider: "p", scope: [] },
				async () => ({
					accessToken: `token-${n}`,
					expiresAt: 1_000 + n * 1_000,
					scopes: [],
					provider: "p",
				}),
			);
		for (let n = 0; n < DEFAULT_TOKEN_ENTRY_CAP + 3; n += 1) await acquire(n);

		const held = store.list();
		expect(held).toHaveLength(DEFAULT_TOKEN_ENTRY_CAP);
		// The first three went, earliest expiry first.
		expect(held.map((entry) => entry.role)).toEqual(
			Array.from({ length: DEFAULT_TOKEN_ENTRY_CAP }, (_, i) => `r${i + 3}`),
		);
	});

	test("the key normalizes the scope set, so two spellings are one entry", () => {
		expect(
			tokenKey({
				stage: "s",
				app: "a",
				role: "r",
				provider: "p",
				scope: ["b", "a"],
			}),
		).toBe(
			tokenKey({
				stage: "s",
				app: "a",
				role: "r",
				provider: "p",
				scope: ["a", "b"],
			}),
		);
	});
});
