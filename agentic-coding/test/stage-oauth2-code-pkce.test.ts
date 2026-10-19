// The authorization code grant with PKCE (`add-stage-oauth2-code-pkce`).
//
// What is asserted here is the part of the flow that a person is not part of:
// the PKCE pair (against the RFC 7636 appendix B vector), the opaque `state`,
// the authorization URL (which carries no secret), the single-use loopback
// receiver (one callback, `state` validated before any exchange, closed on
// every ending path), the exchange itself against a local fake token endpoint,
// and the rule that no code, verifier or `state` ever reaches a reply, a
// message or a page.
//
// The receiver and the token endpoint are `127.0.0.1` fixtures of this process:
// no real identity provider, no real credential and no network egress.
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
	authorizationUrl,
	beginAuthorizationCodeLogin,
	codeChallengeS256,
	createAuthorizationState,
	createCodeVerifier,
	LOOPBACK_CALLBACK_PATH,
	type LoopbackReceiver,
	pkceSecrets,
	roleTokenKey,
	StageAuthError,
	StageTokenStore,
	startLoopbackReceiver,
} from "../src/server/stages/oauth2.ts";

const CLIENT_ID_VALUE = "code-pkce-client-id-do-not-leak";
const CLIENT_SECRET_VALUE = "code-pkce-client-secret-do-not-leak";
const AUTHORIZATION_CODE = "authorization-code-value-do-not-leak";
const ACCESS_TOKEN = "authorization-code-access-token-do-not-leak";

/** One recorded token request. */
interface TokenCall {
	readonly authorization: string | null;
	readonly form: URLSearchParams;
}

/** A fake token endpoint that records every request and answers the scripted
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
			const call: TokenCall = {
				authorization: request.headers.get("authorization"),
				form: new URLSearchParams(await request.text()),
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

function tokenAnswer(accessToken = ACCESS_TOKEN): Response {
	return Response.json({
		access_token: accessToken,
		expires_in: 3_600,
		scope: "api://grid/.default",
	});
}

/** The `.env` and the stage file of one stage whose role signs in with the code
 * grant, pointing at the fake token endpoint. */
function seeded(options: {
	readonly endpoint: string;
	readonly authorizationEndpoint: string;
	readonly clientSecret?: boolean;
	readonly interactiveLogin?: "local" | "never";
}): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-code-pkce-"));
	const defsDir = path.join(configDir, "stages", "definitions");
	fs.mkdirSync(defsDir, { recursive: true });
	const origin = new URL(options.endpoint).origin;
	const definition = {
		ident: "grid-int",
		displayName: "Grid integration",
		environment: "integration",
		system: "grid",
		access: "writable",
		apps: {
			api: {
				label: "Grid API",
				url: origin,
				kind: "api",
				roles: {
					user: {
						login: "oauth2",
						provider: "idp",
						grant: "authorization_code",
						bearerOrigins: [origin],
					},
				},
			},
		},
		oauth2: {
			providers: {
				idp: {
					tokenEndpoint: options.endpoint,
					authorizationEndpoint: options.authorizationEndpoint,
					clientId: "${STAGE_GRID_INT_CLIENT_ID}",
					...(options.clientSecret === false
						? {}
						: { clientSecret: "${STAGE_GRID_INT_CLIENT_SECRET}" }),
					scope: ["api://grid/.default"],
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
		...(options.clientSecret === false
			? {}
			: { STAGE_GRID_INT_CLIENT_SECRET: CLIENT_SECRET_VALUE }),
	};
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`${Object.entries(env)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
	if (options.interactiveLogin !== undefined)
		fs.writeFileSync(
			path.join(configDir, "stages", "policy.json"),
			`${JSON.stringify({ interactiveLogin: options.interactiveLogin })}\n`,
		);
	return configDir;
}

function roleOf(configDir: string) {
	const entry = stageByIdent(readStageCatalog(configDir), "grid-int");
	if (entry === undefined)
		throw new Error("the fixture stage is not allow-listed");
	return {
		entry,
		roleInput: {
			stage: entry.stage,
			appKey: "api",
			role: "user",
			configDir,
		},
	};
}

const stops: Array<() => void> = [];
const receivers: LoopbackReceiver[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const receiver of receivers.splice(0)) receiver.close();
});

function provider(
	...responses: Array<(call: TokenCall) => Response | Promise<Response>>
) {
	const fake = fakeProvider(responses);
	stops.push(fake.stop);
	const configDir = seeded({
		endpoint: fake.endpoint,
		authorizationEndpoint: `${new URL(fake.endpoint).origin}/oauth2/authorize`,
	});
	return { ...fake, configDir, ...roleOf(configDir) };
}

/** Every value one PKCE secret currently carries, by its redaction name. A name
 * can have several live values — a state outlives the flow that registered it —
 * so presence is asserted on the list rather than on one lookup. */
function pkceValues(name: string): string[] {
	return pkceSecrets()
		.filter((secret) => secret.name === name)
		.map((secret) => secret.value);
}

/** The one live verifier: exactly one login is open at a time in this file, and
 * a flow forgets its verifier on close. */
function liveVerifier(): string | undefined {
	return pkceValues("stage-oauth2-code-verifier").at(-1);
}

/** The `state` a login put in its own authorization URL: what the provider would
 * send back, read from the URL the window opens. */
function stateOf(flow: { readonly authorizationUrl: string }): string {
	const state = new URL(flow.authorizationUrl).searchParams.get("state");
	if (state === null) throw new Error("the authorization URL carries no state");
	return state;
}

/** Answer the receiver's callback the way the provider's redirect would. */
async function callBack(
	origin: string,
	params: Record<string, string>,
): Promise<Response> {
	const query = new URLSearchParams(params).toString();
	return await fetch(`${origin}${LOOPBACK_CALLBACK_PATH}?${query}`);
}

/** Wait for an asynchronous ending without depending on a wall-clock guess. */
async function settle(
	poll: () => { readonly state: string },
	attempts = 200,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (poll().state !== "pending") return;
		await Bun.sleep(10);
	}
	throw new Error("the flow did not settle");
}

describe("PKCE and state", () => {
	test("the S256 challenge matches the RFC 7636 appendix B vector", () => {
		// The vector is the RFC's own: a verifier and the challenge it must hash
		// to. A build that changed the encoding or the padding breaks this.
		expect(
			codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	test("a verifier is 43 characters of the unreserved alphabet, and two of them differ", () => {
		const verifier = createCodeVerifier();
		expect(verifier).toHaveLength(43);
		expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
		expect(createCodeVerifier()).not.toBe(verifier);
		// The RFC's bound is 43–128 characters, and the challenge is one base64url
		// SHA-256 digest: 43 characters, no padding.
		expect(codeChallengeS256(verifier)).toHaveLength(43);
	});

	test("state is opaque and unguessable", () => {
		const state = createAuthorizationState();
		expect(state).toHaveLength(43);
		expect(createAuthorizationState()).not.toBe(state);
	});

	test("the authorization URL carries the challenge and never a secret", () => {
		const url = new URL(
			authorizationUrl({
				authorizationEndpoint: "https://login.example.test/oauth2/authorize",
				clientId: CLIENT_ID_VALUE,
				redirectUri: "http://127.0.0.1:43210/callback",
				state: "the-state",
				codeChallenge: "the-challenge",
				scope: ["api://grid/.default", "openid"],
				audience: "api://grid",
			}),
		);

		expect(url.origin).toBe("https://login.example.test");
		expect(url.pathname).toBe("/oauth2/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID_VALUE);
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://127.0.0.1:43210/callback",
		);
		expect(url.searchParams.get("state")).toBe("the-state");
		expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toBe("api://grid/.default openid");
		expect(url.searchParams.get("audience")).toBe("api://grid");
		// No client secret, no code and no verifier can be part of the URL the
		// browser opens.
		expect(url.searchParams.get("client_secret")).toBeNull();
		expect(url.searchParams.get("code")).toBeNull();
		expect(url.searchParams.get("code_verifier")).toBeNull();
	});
});

describe("the single-use loopback receiver", () => {
	test("it binds loopback on an ephemeral port and takes exactly one code", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		receivers.push(receiver);

		expect(receiver.redirectUri).toBe(
			`http://127.0.0.1:${new URL(receiver.redirectUri).port}${LOOPBACK_CALLBACK_PATH}`,
		);
		// The listener is loopback and nothing else, and it says so: a wildcard bind
		// would expose a callback that carries an authorization code, and a redirect
		// URI that did not name the bound address would send the provider where
		// nothing listens (TQ-006, QUALITY-004).
		expect(receiver.address).toBe("127.0.0.1");
		expect(new URL(receiver.redirectUri).port).toBe(String(receiver.port));
		expect(receiver.redirectUri).toBe(
			`http://${receiver.address}:${receiver.port}${LOOPBACK_CALLBACK_PATH}`,
		);
		const answer = await callBack(receiver.origin, {
			code: AUTHORIZATION_CODE,
			state,
		});
		expect(answer.status).toBe(200);
		expect(await receiver.code).toBe(AUTHORIZATION_CODE);

		// Single use: the callback that completed it was the only one that could,
		// and the receiver stops listening. A second attempt either finds nothing
		// listening or is refused — it never yields a second code.
		const second = await callBack(receiver.origin, {
			code: "a-second-code",
			state,
		}).catch(() => undefined);
		expect(second?.status ?? 0).not.toBe(200);
	});

	test("a state mismatch ends the login without a code and without a value in the answer", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		receivers.push(receiver);
		// The handler goes on before the callback, so the rejection is observed the
		// moment it happens instead of being reported as unhandled.
		const failed = receiver.code.catch((error: unknown) => error);

		const answer = await callBack(receiver.origin, {
			code: AUTHORIZATION_CODE,
			state: "not-the-state",
		});
		expect(answer.status).toBe(400);
		const page = await answer.text();
		// The page says the sign-in did not complete and reflects nothing: neither
		// the code it was offered nor the `state` that did not match.
		expect(page).not.toContain(AUTHORIZATION_CODE);
		expect(page).not.toContain("not-the-state");

		const failure = (await failed) as StageAuthError;
		expect(failure).toBeInstanceOf(StageAuthError);
		expect(failure.code).toBe("login-failed");
		expect(failure.providerCode).toBe("state_mismatch");
		expect(failure.message).not.toContain(AUTHORIZATION_CODE);
	});

	test("a state of the right length but the wrong value is refused like any other", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		receivers.push(receiver);
		// A forgery that a length check would accept: the same number of characters
		// as the real state, differing in the last one. The comparison is the whole
		// value, not its shape.
		const forged = `${state.slice(0, -1)}${state.at(-1) === "A" ? "B" : "A"}`;
		expect(forged).toHaveLength(state.length);
		const refused = receiver.code.catch((error: unknown) => error);

		const answer = await callBack(receiver.origin, {
			code: AUTHORIZATION_CODE,
			state: forged,
		});
		expect(answer.status).toBe(400);
		expect(await answer.text()).not.toContain(AUTHORIZATION_CODE);
		const failure = (await refused) as StageAuthError;
		expect(failure.providerCode).toBe("state_mismatch");

		// The login is over: a callback that does not carry this login's own state
		// ends it rather than leaving a receiver listening for a state a forgery
		// already answered (the comparison is the whole value, in constant time).
		const late = await callBack(receiver.origin, {
			code: AUTHORIZATION_CODE,
			state,
		}).catch(() => undefined);
		expect(late?.status ?? 0).not.toBe(200);
	});

	test("an error the provider passed back is a bounded, value-free code", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		receivers.push(receiver);
		const failed = receiver.code.catch((error: unknown) => error);

		const answer = await callBack(receiver.origin, {
			error: "access_denied",
			error_description: `the user refused; code ${AUTHORIZATION_CODE}`,
			state,
		});
		expect(answer.status).toBe(400);
		expect(await answer.text()).not.toContain(AUTHORIZATION_CODE);

		const failure = (await failed) as StageAuthError;
		expect(failure.providerCode).toBe("access_denied");
		expect(failure.message).toContain("access_denied");
		expect(failure.message).not.toContain(AUTHORIZATION_CODE);
	});

	test("close() ends the wait without a code and releases the port", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		const failure = receiver.code.catch((error: unknown) => error);
		receiver.close();

		const aborted = (await failure) as StageAuthError;
		expect(aborted.providerCode).toBe("login_aborted");
		// A closed receiver answers nothing: no page, no code, no port.
		const after = await callBack(receiver.origin, { code: "late" }).catch(
			() => undefined,
		);
		expect(after).toBeUndefined();
	});

	test("a path other than the callback is refused without taking the code", async () => {
		const state = createAuthorizationState();
		const receiver = await startLoopbackReceiver({ state });
		receivers.push(receiver);

		const elsewhere = await fetch(`${receiver.origin}/somewhere-else?code=x`);
		expect(elsewhere.status).toBe(404);
		// Still single-use and still waiting: the refusal did not consume it.
		expect(
			await callBack(receiver.origin, { code: AUTHORIZATION_CODE, state }).then(
				(answer) => answer.status,
			),
		).toBe(200);
		expect(await receiver.code).toBe(AUTHORIZATION_CODE);
	});
});

describe("the login a flow runs", () => {
	test("the callback's code is exchanged, and the token lands in the store", async () => {
		const fake = provider(() => tokenAnswer());
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const verifier = liveVerifier();
			const state = stateOf(flow);
			expect(verifier).toBeDefined();
			expect(state).toBeDefined();
			if (verifier === undefined)
				throw new Error("the flow registered no verifier");
			expect(flow.poll().state).toBe("pending");

			// The authorization URL the window opens is this flow's own request.
			const authorization = new URL(flow.authorizationUrl);
			expect(authorization.searchParams.get("code_challenge")).toBe(
				codeChallengeS256(verifier),
			);
			expect(authorization.searchParams.get("state")).toBe(state);
			expect(authorization.searchParams.get("redirect_uri")).toBe(
				`${flow.redirectOrigin}${LOOPBACK_CALLBACK_PATH}`,
			);
			expect(flow.authorizationUrl).not.toContain(CLIENT_SECRET_VALUE);

			const answer = await callBack(flow.redirectOrigin, {
				code: AUTHORIZATION_CODE,
				state,
			});
			expect(answer.status).toBe(200);
			expect(await answer.text()).toContain("close this window");

			await settle(flow.poll);
			expect(flow.poll().state).toBe("ok");

			// The token is the server's: the store holds it, and nothing reported it.
			expect(store.peek(roleTokenKey(fake.roleInput))?.accessToken).toBe(
				ACCESS_TOKEN,
			);

			const call = fake.calls[0];
			if (call === undefined) throw new Error("no token request was made");
			expect(call.form.get("grant_type")).toBe("authorization_code");
			expect(call.form.get("code")).toBe(AUTHORIZATION_CODE);
			expect(call.form.get("redirect_uri")).toBe(
				`${flow.redirectOrigin}${LOOPBACK_CALLBACK_PATH}`,
			);
			expect(call.form.get("code_verifier")).toBe(verifier);
			expect(call.form.get("client_id")).toBe(CLIENT_ID_VALUE);
			// A confidential client authenticates exactly as the unattended grants
			// do; the verifier is the only PKCE value that reaches the endpoint.
			expect(call.authorization).toBe(
				`Basic ${Buffer.from(
					`${CLIENT_ID_VALUE}:${CLIENT_SECRET_VALUE}`,
					"utf8",
				).toString("base64")}`,
			);
			expect(call.form.get("code_challenge")).toBeNull();
		} finally {
			flow.close();
		}
	});

	test("a public client sends its client id and no secret", async () => {
		const fake = provider(() => tokenAnswer());
		const publicClient = seeded({
			endpoint: fake.endpoint,
			authorizationEndpoint: `${new URL(fake.endpoint).origin}/oauth2/authorize`,
			clientSecret: false,
		});
		const role = roleOf(publicClient);
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(role.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const state = stateOf(flow);
			const answer = await callBack(flow.redirectOrigin, {
				code: AUTHORIZATION_CODE,
				state,
			});
			expect(answer.status).toBe(200);
			await settle(flow.poll);
			expect(flow.poll().state).toBe("ok");
			const call = fake.calls[0];
			if (call === undefined) throw new Error("no token request was made");
			expect(call.authorization).toBeNull();
			expect(call.form.get("client_secret")).toBeNull();
			expect(call.form.get("client_id")).toBe(CLIENT_ID_VALUE);
		} finally {
			flow.close();
		}
	});

	test("a refused exchange fails the flow with a value-free error", async () => {
		const fake = provider(() =>
			Response.json(
				{
					error: "invalid_grant",
					// A provider that echoes what it was given, which is exactly why the
					// description is scrubbed with the values of this login.
					error_description: `bad code ${AUTHORIZATION_CODE}`,
				},
				{ status: 400 },
			),
		);
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const verifier = liveVerifier();
			const state = stateOf(flow);
			await callBack(flow.redirectOrigin, { code: AUTHORIZATION_CODE, state });
			await settle(flow.poll);

			const settled = flow.poll();
			expect(settled.state).toBe("failed");
			if (settled.state !== "failed") throw new Error("the flow succeeded");
			const failure = settled.error as StageAuthError;
			expect(failure).toBeInstanceOf(StageAuthError);
			expect(failure.code).toBe("login-failed");
			expect(failure.providerCode).toBe("invalid_grant");
			expect(failure.message).not.toContain(AUTHORIZATION_CODE);
			if (verifier !== undefined)
				expect(failure.message).not.toContain(verifier);
			expect(store.peek(roleTokenKey(fake.roleInput))).toBeUndefined();
		} finally {
			flow.close();
		}
	});

	test("the verifier is spent with the flow, while the state and the code outlive it", async () => {
		const fake = provider(() => tokenAnswer());
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		const verifier = liveVerifier();
		const state = stateOf(flow);
		if (verifier === undefined) throw new Error("no verifier was registered");
		try {
			// While the login runs, what the provider's redirect carries is scrubbed.
			expect(pkceValues("stage-oauth2-code-verifier")).toContain(verifier);
			expect(pkceValues("stage-oauth2-state")).toContain(state);
			const answered = await callBack(flow.redirectOrigin, {
				code: AUTHORIZATION_CODE,
				state,
			});
			expect(answered.status).toBe(200);
			await settle(flow.poll);
		} finally {
			flow.close();
		}
		// The verifier's one chance is spent with the flow that owned it. `state` and
		// the code stay registered: a hand-off that ends without bringing the window
		// back to the application leaves it standing on the provider's authorization
		// URL, which carries `state=`, and a replay of the callback URL carries both
		// (OAS-002).
		expect(pkceValues("stage-oauth2-code-verifier")).not.toContain(verifier);
		expect(pkceValues("stage-oauth2-state")).toContain(state);
		expect(pkceValues("stage-oauth2-authorization-code")).toContain(
			AUTHORIZATION_CODE,
		);
	});

	test("a token answer above the byte cap is refused instead of parsed", async () => {
		// The answer carries a perfectly good token and 70 KB of padding: a read that
		// trusts the endpoint would hand the login a token out of an answer this
		// process refused to hold (SEC-002, TQ-008).
		const oversized = JSON.stringify({
			access_token: ACCESS_TOKEN,
			expires_in: 3_600,
			pad: "x".repeat(70_000),
		});
		const fake = provider(
			() =>
				new Response(oversized, {
					headers: { "content-type": "application/json" },
				}),
		);
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const state = stateOf(flow);
			expect(
				await callBack(flow.redirectOrigin, {
					code: AUTHORIZATION_CODE,
					state,
				}).then((answer) => answer.status),
			).toBe(200);
			await settle(flow.poll);
			const settled = flow.poll();
			expect(settled.state).toBe("failed");
			if (settled.state !== "failed") throw new Error("the flow succeeded");
			// A declared length above the cap is refused before a byte is read, so the
			// refusal is the endpoint's own 200 that could not be parsed.
			expect((settled.error as StageAuthError).providerCode).toBe("http_200");
			expect(store.peek(roleTokenKey(fake.roleInput))).toBeUndefined();
			// The request that carried the code was made once; nothing was retried.
			expect(fake.calls).toHaveLength(1);
		} finally {
			flow.close();
		}
	});

	test("a streamed answer that passes the cap is cut, and the login fails without a token", async () => {
		const chunk = new Uint8Array(40_000).fill(120);
		const fake = provider(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							// Three 40 KB chunks and no content-length: the reader is what bounds
							// this one.
							controller.enqueue(chunk);
							controller.enqueue(chunk);
							controller.enqueue(chunk);
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const state = stateOf(flow);
			await callBack(flow.redirectOrigin, { code: AUTHORIZATION_CODE, state });
			await settle(flow.poll);
			const settled = flow.poll();
			expect(settled.state).toBe("failed");
			if (settled.state !== "failed") throw new Error("the flow succeeded");
			expect(settled.error).toBeInstanceOf(StageAuthError);
			expect(store.peek(roleTokenKey(fake.roleInput))).toBeUndefined();
		} finally {
			flow.close();
		}
	});

	test("a token the store discards during the exchange is a failed login, not an ok", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = provider(async () => {
			await gate;
			return tokenAnswer();
		});
		const store = new StageTokenStore();
		const flow = await beginAuthorizationCodeLogin(fake.roleInput, store, {
			fetch: fakeEndpointFetch(fake.endpoint),
		});
		try {
			const key = roleTokenKey(fake.roleInput);
			const state = stateOf(flow);
			await callBack(flow.redirectOrigin, {
				code: AUTHORIZATION_CODE,
				state,
			});
			for (let attempt = 0; attempt < 400; attempt += 1) {
				if (fake.calls.length > 0) break;
				await Bun.sleep(5);
			}
			expect(fake.calls).toHaveLength(1);
			// A credential rewrite or a stage reload lands while the token endpoint is
			// still answering: the store discards the token it gets back, so the login
			// did not complete however well the exchange went (CONC-005).
			store.forget(key);
			release?.();
			await settle(flow.poll);
			const settled = flow.poll();
			expect(settled.state).toBe("failed");
			if (settled.state !== "failed") throw new Error("the flow succeeded");
			const failure = settled.error as StageAuthError;
			expect(failure.code).toBe("login-failed");
			expect(failure.providerCode).toBe("interactive_login_required");
			expect(failure.message).toContain("stage_login");
			expect(failure.message).not.toContain(ACCESS_TOKEN);
			expect(store.peek(key)).toBeUndefined();
		} finally {
			flow.close();
		}
	});

	test("a provider whose client id is not set refuses before the window, naming the variable", async () => {
		const fake = provider(() => tokenAnswer());
		const missing = seeded({
			endpoint: fake.endpoint,
			authorizationEndpoint: `${new URL(fake.endpoint).origin}/oauth2/authorize`,
		});
		fs.writeFileSync(path.join(missing, ".env"), "\n");
		const missingRole = roleOf(missing);
		const failure = (await beginAuthorizationCodeLogin(
			missingRole.roleInput,
			new StageTokenStore(),
		).catch((error: unknown) => error)) as StageAuthError;
		expect(failure).toBeInstanceOf(StageAuthError);
		expect(failure.code).toBe("credential-missing");
		expect(failure.message).toContain("STAGE_GRID_INT_CLIENT_ID");
		// No receiver was left listening and no code was asked for.
		expect(fake.calls).toHaveLength(0);
	});
});

/** A fetch that only reaches the fake endpoint, so a stray request fails loudly
 * instead of leaving the machine. */
function fakeEndpointFetch(endpoint: string): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url !== endpoint)
			throw new Error(
				`the flow reached ${url}, which is not the token endpoint`,
			);
		return await fetch(url, init);
	}) as typeof fetch;
}
