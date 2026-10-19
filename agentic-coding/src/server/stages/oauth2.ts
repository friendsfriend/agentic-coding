// Stage OAuth 2.0 (`add-stage-oauth2-auth`, tasks 2.1–2.3).
//
// Two things live here and nothing else does:
//
// * **One token request** — the two unattended grants (`client_credentials` and
//   `refresh_token`) over `fetch`, with the client authentication the provider
//   declares (HTTP basic or the form body), the requested scope and audience, a
//   bounded timeout, and a provider error mapped to its `error` code only. The
//   provider's error *body* is never handed on: an operator reads it in the
//   provider's own logs, and this server must not be the path a token-shaped
//   value takes to a model.
// * **One in-memory store** — keyed `(stage, app, role, provider, scope-set)`,
//   bounded by an entry cap, an absolute lifetime ceiling and a forget action,
//   renewed shortly before `exp` and single-flight per entry. A token is a
//   secret: it leaves this module only as the value of an `Authorization` header
//   or a request body to its own token endpoint, and `info()`/`list()`/`secrets()`
//   are the only read surfaces.
//
// The store is the seam `add-stage-identity-cache` inherits: the key, the three
// bounds and `forget` are the shape that change takes over, so no call site has
// to move when its bounded in-memory store lands. Until then this module carries
// its own, which is why the bounds are constants here rather than configuration.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { loadEnvFile } from "../../env-file.ts";
import {
	resolveStageCredential,
	resolveStageOAuthCredential,
	StageCredentialError,
} from "./catalog.ts";
import {
	isOAuth2Role,
	type StageDefinition,
	type StageOAuth2Grant,
} from "./schema.ts";

/** How many tokens this process may hold at once. A stage has a handful of
 * roles; the cap is what keeps a misconfigured catalog or a per-scope key from
 * growing the map with the process's whole history. */
export const DEFAULT_TOKEN_ENTRY_CAP = 32;

/** The absolute lifetime ceiling of one entry: a token is never held longer than
 * this, whatever its own `expires_in` says. */
export const DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** How long before `exp` a token is renewed, so a call never rides a token that
 * expires while its own request is in flight. */
export const DEFAULT_TOKEN_SKEW_MS = 60_000;

/** How long one refusal is remembered before the provider is asked again. A
 * provider that is down must not turn every page request of a bearer origin into
 * a round trip that waits for its own timeout (PERF-003); five seconds is short
 * enough that a fixed endpoint is picked up by the next call after it. */
export const DEFAULT_FAILURE_TTL_MS = 5_000;

/** The bound of one token request. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** How much of a token endpoint's answer is read at all. A token response is a
 * few hundred bytes; anything larger is a host that is not a token endpoint. */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** The longest provider error description one message carries. */
const MAX_ERROR_DESCRIPTION_CHARS = 200;

/** One secret-shaped value, in the shape the shared redactor takes. */
export interface StageTokenSecret {
	readonly name: string;
	readonly value: string;
}

/** One acquired access token. This object is the server's own: it is never
 * serialized into a reply, and every read surface below answers a projection
 * that carries no value. */
export interface OAuth2Token {
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** Absolute expiry, epoch milliseconds, already clamped to the ceiling. */
	readonly expiresAt: number;
	readonly scopes: readonly string[];
	readonly audience?: string;
	readonly issuer?: string;
	readonly provider: string;
}

/** What a token is keyed by. The scope set is part of the key: two roles that
 * ask for different scopes have different tokens, even on one provider. */
export interface OAuth2TokenKey {
	readonly stage: string;
	readonly app: string;
	readonly role: string;
	readonly provider: string;
	readonly scope: readonly string[];
}

/** What the agent may learn about a token (`stage_token_info`): four fields and
 * nothing else, in particular no claim, no subject and no value. */
export interface StageTokenInfo {
	readonly expiresAt: number;
	readonly scopes: readonly string[];
	readonly audience?: string;
	readonly issuer?: string;
}

/** A refusal of the token path, in the vocabulary the tools already answer with:
 * `credential-missing` names the `.env` variable to set, `login-failed` carries
 * the provider's `error` code. */
export class StageAuthError extends Error {
	constructor(
		readonly code: "credential-missing" | "login-failed",
		message: string,
		/** The provider's own `error` code, when the refusal came from it. */
		readonly providerCode?: string,
	) {
		super(message);
		this.name = "StageAuthError";
	}
}

// ---------------------------------------------------------------------------
// One token request
// ---------------------------------------------------------------------------

export interface TokenRequestInput {
	readonly provider: string;
	readonly tokenEndpoint: string;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly clientAuth: "basic" | "body";
	readonly scope: readonly string[];
	readonly audience?: string;
	readonly grant: StageOAuth2Grant;
	readonly refreshToken?: string;
	/** The authorization code a `authorization_code` request exchanges, and the
	 * three values that belong to it: the loopback redirect it was issued for and
	 * the PKCE verifier it was bound to (`add-stage-oauth2-code-pkce`). */
	readonly code?: string;
	readonly redirectUri?: string;
	readonly codeVerifier?: string;
}

export interface TokenRequestDeps {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly timeoutMs?: number;
	/** The values the provider's own error description is scrubbed of. */
	readonly secrets?: readonly StageTokenSecret[];
}

/**
 * One token request, in the two grants that need no person.
 *
 * `client_credentials` sends no refresh token; `refresh_token` sends the one it
 * holds and answers a rotated replacement when the provider issues one. The
 * client secret travels either as HTTP basic or in the form body, exactly as the
 * provider's `clientAuth` says — never both, never in a URL.
 */
export async function requestToken(
	input: TokenRequestInput,
	deps: TokenRequestDeps = {},
): Promise<OAuth2Token> {
	const now = deps.now ?? (() => Date.now());
	const body = new URLSearchParams();
	body.set("grant_type", input.grant);
	body.set("client_id", input.clientId);
	if (input.scope.length > 0) body.set("scope", input.scope.join(" "));
	if (input.audience !== undefined) body.set("audience", input.audience);
	if (input.grant === "refresh_token") {
		if (input.refreshToken === undefined || input.refreshToken === "")
			throw new StageAuthError(
				"login-failed",
				`${input.provider}: this role's refresh_token grant holds no refresh token`,
				"invalid_grant",
			);
		body.set("refresh_token", input.refreshToken);
	}
	if (input.grant === "authorization_code") {
		// The code, the redirect it was issued for and the verifier that binds it:
		// all three stay in this call, and none of them is ever part of a message.
		if (
			input.code === undefined ||
			input.redirectUri === undefined ||
			input.codeVerifier === undefined
		)
			throw new StageAuthError(
				"login-failed",
				`${input.provider}: the authorization_code exchange needs a code, its redirect URI and its PKCE verifier`,
				"invalid_request",
			);
		body.set("code", input.code);
		body.set("redirect_uri", input.redirectUri);
		body.set("code_verifier", input.codeVerifier);
	}
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};
	if (input.clientAuth === "basic") {
		if (input.clientSecret !== undefined)
			headers.authorization = `Basic ${basicCredentials(input.clientId, input.clientSecret)}`;
	} else if (input.clientSecret !== undefined) {
		body.set("client_secret", input.clientSecret);
	}
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(input.tokenEndpoint, {
			method: "POST",
			headers,
			body: body.toString(),
			signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS),
			// A token endpoint is a fixed host: a redirect would move the client
			// secret to wherever it points, so a 3xx is an answer, not a detour.
			redirect: "manual",
		});
	} catch (error) {
		throw new StageAuthError(
			"login-failed",
			`${input.provider}: the token endpoint could not be reached${
				error instanceof Error && error.name === "TimeoutError"
					? " before its timeout"
					: ""
			}`,
			"token_endpoint_unreachable",
		);
	}
	const payload = await readBoundedJson(response);
	if (!response.ok || payload === undefined)
		throw providerError(input, response.status, payload, deps.secrets);
	const answer = payload;
	const accessToken = stringField(answer, "access_token");
	if (accessToken === undefined || accessToken === "")
		throw new StageAuthError(
			"login-failed",
			`${input.provider}: the token endpoint answered without an access_token`,
			"invalid_response",
		);
	const refreshToken = stringField(answer, "refresh_token");
	const scope = stringField(answer, "scope");
	const expiresIn = numberField(answer, "expires_in");
	const audience = audienceOf(input, accessToken);
	const issuer = issuerOf(input, accessToken);
	return {
		accessToken,
		...(refreshToken === undefined || refreshToken === ""
			? {}
			: { refreshToken }),
		// A provider that names no lifetime is treated as a short-lived token: it
		// is renewed on the next call rather than trusted for an hour.
		expiresAt: now() + (expiresIn === undefined ? 0 : expiresIn * 1_000),
		scopes:
			scope === undefined || scope.trim() === ""
				? [...input.scope]
				: scope.split(/\s+/).filter(Boolean),
		...(audience === undefined ? {} : { audience }),
		...(issuer === undefined ? {} : { issuer }),
		provider: input.provider,
	};
}

/**
 * The provider's own refusal, reduced to its status and `error` code.
 *
 * The body of an OAuth error carries `error` and `error_description` beside an
 * echo of the request; the description is scrubbed of every value this module
 * holds and bounded, and a body that is not JSON contributes its status alone.
 * Either way the answer names a code, never a payload.
 */
function providerError(
	input: TokenRequestInput,
	status: number,
	payload: Record<string, unknown> | undefined,
	secrets: readonly StageTokenSecret[] | undefined,
): StageAuthError {
	const code =
		payload === undefined ? undefined : stringField(payload, "error");
	const description =
		payload === undefined
			? undefined
			: stringField(payload, "error_description");
	const scrubbed =
		description === undefined ? undefined : scrub(description, secrets);
	return new StageAuthError(
		"login-failed",
		`${input.provider}: the token endpoint answered ${status}${
			code === undefined ? "" : ` (${code})`
		}${scrubbed === undefined || scrubbed === "" ? "" : `: ${scrubbed}`}`,
		code ?? `http_${status}`,
	);
}

/** Replace every known secret value in one string, then bound it. */
function scrub(
	value: string,
	secrets: readonly StageTokenSecret[] | undefined,
): string {
	let scrubbed = value;
	for (const secret of secrets ?? []) {
		if (secret.value === "") continue;
		scrubbed = scrubbed.split(secret.value).join(`«redacted:${secret.name}»`);
	}
	return scrubbed.length > MAX_ERROR_DESCRIPTION_CHARS
		? `${scrubbed.slice(0, MAX_ERROR_DESCRIPTION_CHARS)}…`
		: scrubbed;
}

async function readBoundedJson(
	response: Response,
): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = (await response.text()).slice(0, MAX_TOKEN_RESPONSE_BYTES);
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function numberField(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) && field > 0
		? field
		: undefined;
}

function basicCredentials(clientId: string, clientSecret: string): string {
	return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

/** The `aud` of a JWT-shaped access token, else the provider's declared
 * audience. Only those two fields are ever read out of a token. */
function audienceOf(
	input: TokenRequestInput,
	accessToken: string,
): string | undefined {
	if (input.audience !== undefined) return input.audience;
	const aud = jwtClaims(accessToken)?.aud;
	if (typeof aud === "string" && aud !== "") return aud.slice(0, 200);
	if (Array.isArray(aud)) {
		const first = aud.find(
			(entry): entry is string => typeof entry === "string",
		);
		return first === undefined ? undefined : first.slice(0, 200);
	}
	return undefined;
}

/** The `iss` of a JWT-shaped access token, else the token endpoint's origin: an
 * opaque token still came from somewhere, and that is all this may say. */
function issuerOf(
	input: TokenRequestInput,
	accessToken: string,
): string | undefined {
	const iss = jwtClaims(accessToken)?.iss;
	if (typeof iss === "string" && iss !== "") return iss.slice(0, 200);
	try {
		return new URL(input.tokenEndpoint).origin;
	} catch {
		return undefined;
	}
}

/** The claims of a JWT-shaped value, decoded and *not* verified: this server
 * reads two presentation fields of a token it holds, never trusts them, and
 * forwards nothing else. */
function jwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const parsed = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
		) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One held token and the key it answers, so an eviction or a `forget` can name
 * the stage and role it belonged to without a second index. */
interface TokenEntry {
	readonly key: OAuth2TokenKey;
	readonly token: OAuth2Token;
}

export interface StageTokenStoreOptions {
	readonly now?: () => number;
	readonly entryCap?: number;
	readonly absoluteLifetimeMs?: number;
	readonly skewMs?: number;
	readonly failureTtlMs?: number;
}

/** One remembered refusal: the provider is not asked again before `until`. */
interface TokenFailure {
	readonly until: number;
	readonly error: unknown;
}

/**
 * The server's in-memory tokens.
 *
 * Nothing is written anywhere: an entry lives in this map until it is forgotten,
 * evicted by the cap, or rejected by a failed renewal. `token()` is the only way
 * to obtain one and it is single-flight per key, so a burst of concurrent
 * callers produces exactly one request to the provider.
 */
export class StageTokenStore {
	private readonly now: () => number;
	private readonly entryCap: number;
	private readonly absoluteLifetimeMs: number;
	private readonly skewMs: number;
	private readonly failureTtlMs: number;
	private readonly entries = new Map<string, TokenEntry>();
	/** The acquisition in flight per key. */
	private readonly pending = new Map<string, Promise<OAuth2Token>>();
	/** A refresh token the provider rotated, which wins over the `.env` copy for
	 * every later renewal of the same key. */
	private readonly rotated = new Map<string, string>();
	/** A refusal, remembered for the failure TTL so an unreachable provider is
	 * asked once per window instead of once per request (PERF-003). */
	private readonly failures = new Map<string, TokenFailure>();
	/** Every key id this store has seen, with its parts, so a `forget` filter can
	 * be matched against the side tables of a key that has no entry right now
	 * (a rotated refresh token, a remembered refusal, an acquisition in flight). */
	private readonly ids = new Map<string, OAuth2TokenKey>();
	/** How many times a key was forgotten or expired. An acquisition that started
	 * under an older generation is not written back: the credential it used is the
	 * one a `forget` just replaced (QA-003). */
	private readonly generations = new Map<string, number>();

	constructor(options: StageTokenStoreOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.entryCap = Math.max(1, options.entryCap ?? DEFAULT_TOKEN_ENTRY_CAP);
		this.absoluteLifetimeMs =
			options.absoluteLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
		this.skewMs = Math.max(0, options.skewMs ?? DEFAULT_TOKEN_SKEW_MS);
		this.failureTtlMs = Math.max(
			0,
			options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS,
		);
	}

	/**
	 * The token for one key, renewed when less than the skew interval remains.
	 *
	 * `acquire` runs at most once per key at a time whatever the number of
	 * callers; a renewal that fails evicts the entry (a token whose renewal was
	 * rejected must not be handed out again) and rethrows the provider's refusal.
	 * A `forget` or an `expire` while the acquisition runs discards its result
	 * instead of writing a token built from a credential that is gone.
	 */
	async token(
		key: OAuth2TokenKey,
		acquire: () => Promise<OAuth2Token>,
	): Promise<OAuth2Token> {
		const id = tokenKey(key);
		this.ids.set(id, key);
		const existing = this.entries.get(id);
		if (existing !== undefined && !this.stale(existing.token))
			return existing.token;
		const failed = this.recentFailure(id);
		if (failed !== undefined) throw failed;
		const inFlight = this.pending.get(id);
		if (inFlight !== undefined) return await inFlight;
		const generation = this.generationOf(id);
		let promise: Promise<OAuth2Token> | undefined;
		const acquisition = (async () => {
			try {
				const acquired = this.clamp(await acquire());
				// A `forget` or an `expire` moved the generation on: this token was
				// built from a credential that is no longer the current one. The caller
				// still gets it (it asked before the change); the store does not keep it.
				if (this.generationOf(id) === generation)
					this.remember(id, key, acquired);
				this.failures.delete(id);
				return acquired;
			} catch (error) {
				if (this.generationOf(id) === generation) {
					this.entries.delete(id);
					this.rotated.delete(id);
					this.rememberFailure(id, error);
				}
				throw error;
			} finally {
				if (this.pending.get(id) === promise) this.pending.delete(id);
			}
		})();
		promise = acquisition;
		this.pending.set(id, acquisition);
		return await acquisition;
	}

	/** The entry this key currently holds, without acquiring one. */
	peek(key: OAuth2TokenKey): OAuth2Token | undefined {
		const id = tokenKey(key);
		const entry = this.entries.get(id);
		if (entry === undefined) return undefined;
		if (this.stale(entry.token)) {
			this.entries.delete(id);
			return undefined;
		}
		return entry.token;
	}

	/** The value-free projection `stage_token_info` answers. */
	info(key: OAuth2TokenKey): StageTokenInfo | undefined {
		const token = this.peek(key);
		if (token === undefined) return undefined;
		return {
			expiresAt: token.expiresAt,
			scopes: [...token.scopes],
			...(token.audience === undefined ? {} : { audience: token.audience }),
			...(token.issuer === undefined ? {} : { issuer: token.issuer }),
		};
	}

	/**
	 * The forget action: every entry matching the given parts of a key. Called
	 * when a credential is rewritten, when a stage reloads, and by a run that
	 * stops using a stage. The rotated refresh token goes with the entry, because
	 * the credential it was derived from is the one that changed.
	 */
	forget(filter: Partial<OAuth2TokenKey> = {}): void {
		for (const [id, key] of [...this.ids])
			if (matchesFilter(key, filter)) this.invalidate(id);
	}

	/**
	 * Drop one entry so the next `token()` call renews it, keeping everything the
	 * credential still needs: the rotated refresh token (the provider keeps only
	 * the one it last issued, so a `401` retry has to present it — QA-002) and the
	 * generation that keeps a running acquisition from writing the rejected token
	 * back.
	 */
	expire(key: OAuth2TokenKey): void {
		const id = tokenKey(key);
		this.entries.delete(id);
		this.failures.delete(id);
		this.pending.delete(id);
		this.generations.set(id, this.generationOf(id) + 1);
	}

	/** The refresh token to send for this key: the rotated one when the provider
	 * issued one, else the declared `.env` value. */
	refreshTokenFor(
		key: OAuth2TokenKey,
		declared: string | undefined,
	): string | undefined {
		return this.rotated.get(tokenKey(key)) ?? declared;
	}

	/** What this store holds, as metadata only (`browser_network`-style reads and
	 * the redaction test both rely on this carrying no value). */
	list(): Array<OAuth2TokenKey & StageTokenInfo> {
		return [...this.entries.values()].map((entry) => ({
			...entry.key,
			expiresAt: entry.token.expiresAt,
			scopes: [...entry.token.scopes],
			...(entry.token.audience === undefined
				? {}
				: { audience: entry.token.audience }),
			...(entry.token.issuer === undefined
				? {}
				: { issuer: entry.token.issuer }),
		}));
	}

	/** Every value the redactor has to scrub: each access and refresh token, and
	 * every base64url segment of a JWT-shaped token that is long enough to be
	 * worth matching on its own. */
	secrets(): StageTokenSecret[] {
		return tokenSecrets([...this.entries.values()].map((entry) => entry.token));
	}

	/** Whether this entry has to be renewed before it is used again. */
	private stale(token: OAuth2Token): boolean {
		return token.expiresAt - this.now() <= this.skewMs;
	}

	/** Never hold a token longer than the ceiling: a provider that answers a
	 * 30-day `expires_in` still gets an entry of at most eight hours. */
	private clamp(token: OAuth2Token): OAuth2Token {
		return {
			...token,
			expiresAt: Math.min(
				token.expiresAt,
				this.now() + this.absoluteLifetimeMs,
			),
		};
	}

	private generationOf(id: string): number {
		return this.generations.get(id) ?? 0;
	}

	/** Drop everything one key id holds, and make a running acquisition of it
	 * discard its result. */
	private invalidate(id: string): void {
		this.entries.delete(id);
		this.rotated.delete(id);
		this.failures.delete(id);
		this.pending.delete(id);
		this.generations.set(id, this.generationOf(id) + 1);
	}

	private recentFailure(id: string): unknown {
		const failure = this.failures.get(id);
		if (failure === undefined) return undefined;
		if (failure.until > this.now()) return failure.error;
		this.failures.delete(id);
		return undefined;
	}

	private rememberFailure(id: string, error: unknown): void {
		if (this.failureTtlMs === 0) return;
		this.failures.delete(id);
		this.failures.set(id, { until: this.now() + this.failureTtlMs, error });
		while (this.failures.size > this.entryCap) {
			const oldest = this.failures.keys().next();
			if (oldest.done === true) break;
			this.failures.delete(oldest.value);
		}
	}

	private remember(id: string, key: OAuth2TokenKey, token: OAuth2Token): void {
		const rotated = token.refreshToken;
		this.entries.delete(id);
		this.entries.set(id, { key, token });
		if (rotated !== undefined && rotated !== "") this.rotated.set(id, rotated);
		while (this.entries.size > this.entryCap) {
			const evicted = this.evictionCandidate();
			if (evicted === undefined) break;
			this.entries.delete(evicted);
			// A key whose renewal is in flight keeps its rotated refresh token: that
			// value is the only one the provider still accepts, and the acquisition
			// about to answer needs it (CONC-002).
			if (!this.pending.has(evicted)) this.rotated.delete(evicted);
		}
	}

	/** The entry to evict: the one expiring soonest, never a key whose renewal is
	 * in flight. `undefined` when every entry is being renewed, which is a cap of
	 * momentarily more entries rather than a lost token. */
	private evictionCandidate(): string | undefined {
		let candidate: string | undefined;
		let earliest = Number.POSITIVE_INFINITY;
		for (const [id, entry] of this.entries) {
			if (this.pending.has(id)) continue;
			if (entry.token.expiresAt < earliest) {
				earliest = entry.token.expiresAt;
				candidate = id;
			}
		}
		return candidate;
	}
}

function matchesFilter(
	key: OAuth2TokenKey,
	filter: Partial<OAuth2TokenKey>,
): boolean {
	if (filter.stage !== undefined && filter.stage !== key.stage) return false;
	if (filter.app !== undefined && filter.app !== key.app) return false;
	if (filter.role !== undefined && filter.role !== key.role) return false;
	if (filter.provider !== undefined && filter.provider !== key.provider)
		return false;
	if (filter.scope === undefined) return true;
	return [...filter.scope].sort().join(" ") === [...key.scope].sort().join(" ");
}

/** The map key of one entry: every part, with the scope set normalized so two
 * roles that ask for the same scopes in another order share one token. */
export function tokenKey(key: OAuth2TokenKey): string {
	return [
		key.stage,
		key.app,
		key.role,
		key.provider,
		[...key.scope].sort().join(" "),
	].join("\u0000");
}

/** The secret values of these tokens: the access token, the refresh token and
 * the segments of a JWT-shaped access token (`add-stage-oauth2-auth`, D4). */
export function tokenSecrets(
	tokens: readonly OAuth2Token[],
): StageTokenSecret[] {
	const secrets: StageTokenSecret[] = [];
	for (const token of tokens) {
		secrets.push({ name: "stage-access-token", value: token.accessToken });
		if (token.refreshToken !== undefined && token.refreshToken !== "")
			secrets.push({ name: "stage-refresh-token", value: token.refreshToken });
		const parts = token.accessToken.split(".");
		if (parts.length !== 3) continue;
		// A segment shorter than 20 characters is not a credential on its own
		// (the JOSE header of an HS256 token is not), and redacting it would
		// rewrite ordinary page text wherever that short string appeared.
		for (const [index, part] of parts.entries())
			if (part.length >= 20)
				secrets.push({
					name: `stage-access-token:jwt-${index + 1}`,
					value: part,
				});
	}
	// Longest first: a segment of a token is replaced before the token itself
	// would be, so no partial replacement can leave a recognisable fragment.
	return secrets.sort((left, right) => right.value.length - left.value.length);
}

// ---------------------------------------------------------------------------
// One role's token
// ---------------------------------------------------------------------------

export interface StageRoleTokenInput {
	readonly stage: StageDefinition;
	readonly appKey: string;
	readonly role: string;
	readonly configDir: string;
}

/** The provider and grant one role's `oauth2` recipe selects. `undefined` means
 * the role is not an OAuth 2.0 role at all. */
export function oauth2RoleOf(
	stage: StageDefinition,
	appKey: string,
	roleName: string,
): { readonly grant: StageOAuth2Grant; readonly provider: string } | undefined {
	const role = stage.apps[appKey]?.roles?.[roleName];
	// The new fields decide, never the bare recipe name: `oauth2` stays a legal
	// name for a declared recipe of an existing stage file (MIG-001).
	if (role === undefined || !isOAuth2Role(role)) return undefined;
	if (role.grant === undefined || role.provider === undefined) return undefined;
	return { grant: role.grant, provider: role.provider };
}

/**
 * The key one role's token is stored under. The scope set comes from the
 * provider's declaration, so a provider whose scopes an operator edited gets a
 * token for the new set instead of one that is merely still valid.
 */
export function roleTokenKey(input: StageRoleTokenInput): OAuth2TokenKey {
	const role = input.stage.apps[input.appKey]?.roles?.[input.role];
	const providerName = role?.provider ?? "";
	const provider = input.stage.oauth2?.providers?.[providerName];
	return {
		stage: input.stage.ident,
		app: input.appKey,
		role: input.role,
		provider: providerName,
		scope: [...(provider?.scope ?? [])],
	};
}

/**
 * One role's token path, resolved from the catalog alone (`add-stage-oauth2-auth`,
 * tasks 1.1 and 2.1).
 *
 * Nothing here reads the configuration `.env`: the resolution is what the
 * browser's per-request path caches per session (PERF-001), and the references
 * are resolved inside the acquisition instead, so a cache hit reads no file at
 * all (PERF-002).
 */
export interface ResolvedRoleToken {
	readonly input: StageRoleTokenInput;
	readonly key: OAuth2TokenKey;
	readonly provider: string;
	readonly tokenEndpoint: string;
	readonly clientAuth: "basic" | "body";
	/** Whether the provider declares a client secret reference; a public
	 * `authorization_code` client need not. */
	readonly confidential: boolean;
	readonly audience?: string;
	readonly grant: StageOAuth2Grant;
}

/**
 * Resolve one role's `oauth2` recipe: the grant, the provider and the key its
 * token is stored under. Every refusal is a `StageAuthError`, and none of them
 * quotes a value.
 */
export function resolveRoleToken(
	input: StageRoleTokenInput,
): ResolvedRoleToken {
	const recipe = oauth2RoleOf(input.stage, input.appKey, input.role);
	if (recipe === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} does not declare the oauth2 login recipe`,
		);
	// The `authorization_code` grant resolves here like any other: its token is
	// obtained by `stage_login`'s hand-off and held by the same store, so the
	// paths that only *use* a token (`stage_api_request`, `stage_token_info`, the
	// browser's bearer header) read it exactly as they read an unattended one.
	// Only an acquisition refuses to start a sign-in by itself (`roleTokenFrom`).
	const provider = input.stage.oauth2?.providers?.[recipe.provider];
	if (provider === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} names the oauth2 provider ${JSON.stringify(recipe.provider)}, which the stage does not declare`,
		);
	return {
		input,
		key: roleTokenKey(input),
		provider: recipe.provider,
		tokenEndpoint: provider.tokenEndpoint,
		clientAuth: provider.clientAuth ?? "basic",
		confidential: provider.clientSecret !== undefined,
		...(provider.audience === undefined ? {} : { audience: provider.audience }),
		grant: recipe.grant,
	};
}

/**
 * Obtain the token of one resolved role (`stage_login`, `stage_api_request`, the
 * browser bearer header).
 *
 * Every refusal is a `StageAuthError`: `credential-missing` names the `.env`
 * variable that is unset (`clientId`, `clientSecret`, `refreshToken`), and
 * `login-failed` carries the provider's `error` code. No value of any kind is
 * part of a message.
 */
export async function roleTokenFrom(
	resolved: ResolvedRoleToken,
	store: StageTokenStore,
	options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<OAuth2Token> {
	const { input, key } = resolved;
	// The code grant is obtained by `stage_login`'s hand-off, never by a request
	// that merely needs a token: a page load, a `stage_api_request` or a
	// `stage_token_info` must not start an interactive sign-in. The check is
	// *outside* the store, so a refusal here is never remembered as a provider
	// failure and the token the hand-off stored is used from the moment it exists.
	if (resolved.grant === "authorization_code" && store.peek(key) === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} logs in with the authorization_code grant: call stage_login on a stage-bound session first, and its token is used here afterwards`,
			"interactive_login_required",
		);
	return await store.token(key, async () => {
		// The references are resolved *inside* the acquisition: they run before the
		// request, so a missing variable still leaves no request and no entry behind,
		// while a cache hit never touches the `.env` at all (PERF-002).
		let clientId: string;
		let clientSecret: string | undefined;
		let declaredRefreshToken: string | undefined;
		try {
			clientId = resolveStageOAuthCredential(
				input.stage,
				resolved.provider,
				"clientId",
				input.configDir,
			);
			if (resolved.confidential)
				clientSecret = resolveStageOAuthCredential(
					input.stage,
					resolved.provider,
					"clientSecret",
					input.configDir,
				);
			if (resolved.grant === "refresh_token")
				declaredRefreshToken = resolveStageCredential(
					input.stage,
					input.appKey,
					input.role,
					"refreshToken",
					input.configDir,
				);
		} catch (error) {
			if (error instanceof StageCredentialError)
				throw new StageAuthError("credential-missing", error.message);
			throw error;
		}
		// The value that is actually sent wins: after a rotation the request carries
		// the store's refresh token, and that is the one a provider's error
		// description can echo back (SEC-001).
		const refreshToken = store.refreshTokenFor(key, declaredRefreshToken);
		const secrets: StageTokenSecret[] = [
			...(clientSecret === undefined
				? []
				: [{ name: "stage-client-secret", value: clientSecret }]),
			...(declaredRefreshToken === undefined
				? []
				: [{ name: "stage-refresh-token", value: declaredRefreshToken }]),
			...(refreshToken === undefined || refreshToken === declaredRefreshToken
				? []
				: [{ name: "stage-refresh-token:rotated", value: refreshToken }]),
		];
		return await requestToken(
			{
				provider: resolved.provider,
				tokenEndpoint: resolved.tokenEndpoint,
				clientId,
				...(clientSecret === undefined ? {} : { clientSecret }),
				clientAuth: resolved.clientAuth,
				scope: key.scope,
				...(resolved.audience === undefined
					? {}
					: { audience: resolved.audience }),
				grant: resolved.grant,
				...(refreshToken === undefined ? {} : { refreshToken }),
			},
			{
				...(options.fetch === undefined ? {} : { fetch: options.fetch }),
				...(options.now === undefined ? {} : { now: options.now }),
				secrets,
			},
		);
	});
}

/** One role's token, resolving the role first. The browser's hot path resolves a
 * role once per session and calls `roleTokenFrom` (PERF-001). */
export async function roleToken(
	input: StageRoleTokenInput,
	store: StageTokenStore,
	options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<OAuth2Token> {
	return await roleTokenFrom(resolveRoleToken(input), store, options);
}

// ---------------------------------------------------------------------------
// The authorization code grant (`add-stage-oauth2-code-pkce`)
// ---------------------------------------------------------------------------
//
// The third grant is the only one a person performs: the browser has to visit the
// provider's authorization endpoint, the developer signs in there, and the
// provider redirects back to this server. Three things live here:
//
// * **PKCE and `state`** — a verifier, its S256 challenge and an opaque `state`,
//   built with `node:crypto` and never reported. The verifier is what makes a
//   stolen code useless, and `state` is what makes a callback from anywhere but
//   this login useless.
// * **The loopback receiver** — a single-use `node:http` server bound to
//   `127.0.0.1` on an ephemeral port. It takes exactly one callback, validates
//   `state` in constant time, and closes on every path (success, mismatch,
//   deadline, abort), so no port stays bound after a login.
// * **The exchange** — the code, its redirect URI and the verifier go to the
//   token endpoint through the same bounded request the unattended grants use.
//
// The code, the verifier, `state` and the tokens are registered in the redaction
// set while the login runs (`pkceSecrets`), so no reply, log line, telemetry
// attribute or evidence file can carry one.

/** The host the loopback receiver binds: the loopback interface only, never a
 * wildcard address, so no other machine can reach a callback that carries an
 * authorization code. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The one path the receiver answers, and the redirect URI's path. */
export const LOOPBACK_CALLBACK_PATH = "/callback";

/** How many PKCE values the redaction set remembers. A login in flight owns two
 * (the verifier and `state`); the code a receiver took stays behind after its
 * flow ended, one-shot and short-lived, so the cap is what keeps a long-lived
 * server from growing the list with the history of every login. */
const PKCE_SECRET_CAP = 64;

/** The PKCE values of the logins this process ran, oldest first. */
const pkceSecretsSeen = new Map<string, StageTokenSecret>();

/** Every PKCE value the redactor has to scrub, longest first so a verifier is
 * replaced before a shorter value that contains it. */
export function pkceSecrets(): StageTokenSecret[] {
	return [...pkceSecretsSeen.values()].sort(
		(left, right) => right.value.length - left.value.length,
	);
}

function rememberPkceSecret(secret: StageTokenSecret): void {
	if (secret.value === "") return;
	// Re-inserting moves the value to the young end, so the cap drops what is
	// actually oldest rather than what was first seen.
	pkceSecretsSeen.delete(secret.value);
	pkceSecretsSeen.set(secret.value, secret);
	while (pkceSecretsSeen.size > PKCE_SECRET_CAP) {
		const oldest = pkceSecretsSeen.keys().next();
		if (oldest.done === true) break;
		pkceSecretsSeen.delete(oldest.value);
	}
}

/** Keep one value out of every reply while the login that owns it runs. */
function guardPkceSecret(name: string, value: string): () => void {
	rememberPkceSecret({ name, value });
	return () => {
		pkceSecretsSeen.delete(value);
	};
}

/** One RFC 7636 code verifier: 32 random bytes as unpadded base64url, which is
 * 43 characters of the RFC's unreserved alphabet (inside its 43–128 bound). */
export function createCodeVerifier(
	random: (size: number) => Uint8Array = randomBytes,
): string {
	return Buffer.from(random(32)).toString("base64url");
}

/** `base64url(SHA-256(ASCII(verifier)))`, unpadded: the PKCE `S256` challenge. */
export function codeChallengeS256(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** The opaque, unguessable `state` this login's callback is matched on. */
export function createAuthorizationState(
	random: (size: number) => Uint8Array = randomBytes,
): string {
	return Buffer.from(random(32)).toString("base64url");
}

export interface AuthorizationUrlInput {
	readonly authorizationEndpoint: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly codeChallenge: string;
	readonly scope: readonly string[];
	readonly audience?: string;
}

/**
 * The provider's authorization URL, as the hand-off window opens it.
 *
 * It carries the client id, the redirect URI, the scopes, the audience, `state`
 * and the S256 challenge — and nothing else. No client secret goes into a URL,
 * and the code and the tokens only exist after the callback.
 */
export function authorizationUrl(input: AuthorizationUrlInput): string {
	const url = new URL(input.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (input.scope.length > 0)
		url.searchParams.set("scope", input.scope.join(" "));
	if (input.audience !== undefined)
		url.searchParams.set("audience", input.audience);
	return url.toString();
}

/** One single-use loopback receiver. */
export interface LoopbackReceiver {
	/** `http://127.0.0.1:<ephemeral>/callback`: the redirect URI the provider is
	 * asked for. It never carries a value. */
	readonly redirectUri: string;
	/** The same URI's origin, which is the one main-frame navigation a stage
	 * session has to allow while the hand-off runs. */
	readonly origin: string;
	/** The authorization code, once a callback with the right `state` arrived. */
	readonly code: Promise<string>;
	/** Refuse every later callback and release the port. Idempotent, and safe on
	 * every ending path. */
	close(): void;
}

export interface LoopbackReceiverOptions {
	readonly state: string;
	/** The interface to bind. Only a test ever passes anything but loopback. */
	readonly host?: string;
}

/** How much of a provider's own error code one refusal keeps. */
const MAX_PROVIDER_CODE_CHARS = 60;

/**
 * Start the single-use receiver of one login (`add-stage-oauth2-code-pkce`, D2).
 *
 * It accepts exactly one callback. A callback whose `state` does not match never
 * reaches the token endpoint: the receiver answers a page that says the sign-in
 * did not complete, refuses the code, and closes. A provider's own `error` is
 * mapped to a value-free `login-failed` carrying its code, after bounding. Every
 * page it answers is this module's own text — no parameter is ever reflected
 * into it, so a provider cannot use the callback page to show a value.
 */
export async function startLoopbackReceiver(
	options: LoopbackReceiverOptions,
): Promise<LoopbackReceiver> {
	const host = options.host ?? LOOPBACK_HOST;
	const sockets = new Set<Socket>();
	let settle: {
		resolve: (code: string) => void;
		reject: (error: unknown) => void;
	} = { resolve: () => {}, reject: () => {} };
	let finished = false;
	const code = new Promise<string>((resolve, reject) => {
		settle = { resolve, reject };
	});
	// A receiver that never hands out its code (its port could not be bound, so no
	// caller ever awaited it) must not surface as an unhandled rejection: the
	// refusal reaches the caller as the `startLoopbackReceiver` throw.
	void code.catch(() => {});
	const server: Server = createServer((request, response) => {
		const answer = (status: number, body: string): void => {
			response.writeHead(status, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			response.end(body);
		};
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://${host}`);
		} catch {
			answer(400, page("This sign-in could not be read."));
			return;
		}
		if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
			answer(404, page("This address is not a login callback."));
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			answer(405, page("This address answers a sign-in redirect only."));
			return;
		}
		if (finished) {
			// Single use: the second callback of a login is refused, and it cannot
			// replace or re-open the code the first one took.
			answer(410, page("This sign-in has already completed."));
			return;
		}
		const receivedState = url.searchParams.get("state") ?? "";
		if (!stateMatches(options.state, receivedState)) {
			answer(400, failedPage);
			finish(
				new StageAuthError(
					"login-failed",
					"the login callback did not match this sign-in (`state` mismatch), so no code was exchanged",
					"state_mismatch",
				),
			);
			return;
		}
		const providerError = url.searchParams.get("error");
		if (providerError !== null && providerError !== "") {
			answer(400, failedPage);
			finish(
				new StageAuthError(
					"login-failed",
					`the provider ended the sign-in (${boundedCode(providerError)}), so no code was exchanged`,
					boundedCode(providerError),
				),
			);
			return;
		}
		const received = url.searchParams.get("code");
		if (received === null || received === "") {
			answer(400, failedPage);
			finish(
				new StageAuthError(
					"login-failed",
					"the login callback carried no authorization code",
					"invalid_response",
				),
			);
			return;
		}
		answer(200, successPage);
		finish(undefined, received);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	/** End the receiver exactly once: answer the code promise and release the port.
	 * The connections a browser kept alive are destroyed *after* the response that
	 * ended the receiver had its chance to flush — killing them now would reset
	 * the very page the developer is looking at — and the timer is unref'd, so a
	 * lingering socket never holds the process. */
	const finish = (error?: unknown, value?: string): void => {
		if (finished) return;
		finished = true;
		if (server.listening) server.close();
		const timer = setTimeout(() => {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		}, 250);
		(timer as unknown as { unref?: () => void }).unref?.();
		if (error !== undefined) settle.reject(error);
		else settle.resolve(value ?? "");
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, host, () => {
				server.removeListener("error", reject);
				// A listener from here on: an error on a bound server is not a reason to
				// take the process down, and the login's own deadline bounds the wait.
				server.on("error", () => {});
				resolve();
			});
		});
	} catch (error) {
		finish(
			new StageAuthError(
				"login-failed",
				`a loopback receiver for the sign-in could not be opened (${
					error instanceof Error ? boundedCode(error.name) : "error"
				})`,
				"receiver_unavailable",
			),
		);
		throw new StageAuthError(
			"login-failed",
			"a loopback receiver for the sign-in could not be opened on 127.0.0.1",
			"receiver_unavailable",
		);
	}
	const address = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const redirectUri = `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`;
	return {
		redirectUri,
		origin: `http://${LOOPBACK_HOST}:${port}`,
		code,
		close: () =>
			finish(
				new StageAuthError(
					"login-failed",
					"the login hand-off ended before the provider called back, so no code was exchanged",
					"login_aborted",
				),
			),
	};
}

/** Compare `state` without letting the comparison's duration say how much of a
 * guess was right. */
function stateMatches(expected: string, received: string): boolean {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(received, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** A provider's `error` code, bounded and stripped of anything that is not a
 * code: the value is a third party's text, and only its code is reported. */
function boundedCode(value: string): string {
	const code = value
		.replace(/[^A-Za-z0-9_.-]/g, "")
		.slice(0, MAX_PROVIDER_CODE_CHARS);
	return code === "" ? "provider_error" : code;
}

function page(message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in</title></head><body><p>${message}</p></body></html>`;
}

/** The page a callback that took no code answers. It says nothing about why
 * beyond "did not complete": the reason is a refusal code in the server, never
 * a value on a page. */
const failedPage = page(
	"The sign-in did not complete, so no token was obtained. You can close this window.",
);

/** The page a completed callback answers. */
const successPage = page(
	"You can close this window: the sign-in completed and the agent continues.",
);

/** What one in-flight code login has done so far. */
export type AuthorizationCodeState =
	| { readonly state: "pending" }
	| { readonly state: "ok" }
	| { readonly state: "failed"; readonly error: unknown };

/** One login the hand-off drives: the URL its window opens, the loopback origin
 * it needs to reach, and what it has done so far. */
export interface AuthorizationCodeFlow {
	readonly authorizationUrl: string;
	readonly redirectOrigin: string;
	poll(): AuthorizationCodeState;
	/** Stop the receiver, forget the PKCE values and refuse every later callback.
	 * Idempotent; called on every ending path of the hand-off. */
	close(): void;
}

/**
 * Begin one `authorization_code` login for a role: PKCE, `state`, the receiver,
 * the authorization URL, and the exchange that runs when the callback lands. The
 * token is written to the store on success and nowhere else.
 *
 * Every refusal before the window opens is a `StageAuthError` —
 * `credential-missing` names the `.env` variable, `login-failed` carries a
 * provider code — and none of them quotes a value.
 */
export async function beginAuthorizationCodeLogin(
	input: StageRoleTokenInput,
	store: StageTokenStore,
	options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<AuthorizationCodeFlow> {
	const recipe = oauth2RoleOf(input.stage, input.appKey, input.role);
	if (recipe === undefined || recipe.grant !== "authorization_code")
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} does not declare the authorization_code grant`,
		);
	const provider = input.stage.oauth2?.providers?.[recipe.provider];
	if (provider === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} names the oauth2 provider ${JSON.stringify(recipe.provider)}, which the stage does not declare`,
		);
	const authorizationEndpoint = provider.authorizationEndpoint;
	if (authorizationEndpoint === undefined)
		throw new StageAuthError(
			"login-failed",
			`the oauth2 provider ${JSON.stringify(recipe.provider)} declares no authorizationEndpoint, which the authorization_code grant needs`,
		);
	let clientId: string;
	let clientSecret: string | undefined;
	try {
		clientId = resolveStageOAuthCredential(
			input.stage,
			recipe.provider,
			"clientId",
			input.configDir,
		);
		if (provider.clientSecret !== undefined)
			clientSecret = resolveStageOAuthCredential(
				input.stage,
				recipe.provider,
				"clientSecret",
				input.configDir,
			);
	} catch (error) {
		if (error instanceof StageCredentialError)
			throw new StageAuthError("credential-missing", error.message);
		throw error;
	}
	const key = roleTokenKey(input);
	const verifier = createCodeVerifier();
	const state = createAuthorizationState();
	const forgetPkce = [
		guardPkceSecret("stage-oauth2-code-verifier", verifier),
		guardPkceSecret("stage-oauth2-state", state),
	];
	const receiver = await startLoopbackReceiver({ state });
	const url = authorizationUrl({
		authorizationEndpoint,
		clientId,
		redirectUri: receiver.redirectUri,
		state,
		codeChallenge: codeChallengeS256(verifier),
		scope: key.scope,
		...(provider.audience === undefined ? {} : { audience: provider.audience }),
	});
	let settled: AuthorizationCodeState = { state: "pending" };
	let closed = false;
	const token = (async () => {
		const code = await receiver.code;
		// The code is a one-shot credential: registered before it is used, so it can
		// never appear in a reply or a log line, and kept past the flow so a replay is
		// scrubbed too.
		rememberPkceSecret({
			name: "stage-oauth2-authorization-code",
			value: code,
		});
		return await store.token(
			key,
			async () =>
				await requestToken(
					{
						provider: recipe.provider,
						tokenEndpoint: provider.tokenEndpoint,
						clientId,
						...(clientSecret === undefined ? {} : { clientSecret }),
						clientAuth: provider.clientAuth ?? "basic",
						scope: key.scope,
						...(provider.audience === undefined
							? {}
							: { audience: provider.audience }),
						grant: "authorization_code",
						code,
						redirectUri: receiver.redirectUri,
						codeVerifier: verifier,
					},
					{
						...(options.fetch === undefined ? {} : { fetch: options.fetch }),
						...(options.now === undefined ? {} : { now: options.now }),
						// The provider's own error description is scrubbed of everything this
						// login holds, the code and the verifier included.
						secrets: [
							{ name: "stage-oauth2-code-verifier", value: verifier },
							{ name: "stage-oauth2-state", value: state },
							{ name: "stage-oauth2-authorization-code", value: code },
							...(clientSecret === undefined
								? []
								: [{ name: "stage-client-secret", value: clientSecret }]),
						],
					},
				),
		);
	})();
	// Both outcomes end the polling, not the process: a listener keeps an
	// unobserved flow quiet until the hand-off asks about it.
	void token.then(
		() => {
			if (!closed) settled = { state: "ok" };
		},
		(error: unknown) => {
			if (!closed) settled = { state: "failed", error };
		},
	);
	return {
		authorizationUrl: url,
		redirectOrigin: receiver.origin,
		poll: () => settled,
		close: () => {
			if (closed) return;
			closed = true;
			for (const forget of forgetPkce) forget();
			receiver.close();
		},
	};
}

// ---------------------------------------------------------------------------
// The process's store
// ---------------------------------------------------------------------------

let processStore: StageTokenStore | undefined;

/** The one store this server process uses. Tests build their own with
 * `new StageTokenStore(...)` and pass it through the route deps. */
export function stageTokenStore(): StageTokenStore {
	processStore ??= new StageTokenStore();
	return processStore;
}

/** Drop the tokens a credential rewrite or a stage reload invalidated. */
export function forgetStageTokens(
	filter: Partial<OAuth2TokenKey> = {},
	store: StageTokenStore = stageTokenStore(),
): void {
	store.forget(filter);
}

/** Every `.env` value of a configuration root, in the shape the redactor takes:
 * the client id, client secret and refresh token of a provider are `.env` values
 * like any other, and a token endpoint's error description can echo them. */
export function stageEnvSecrets(configDir: string): StageTokenSecret[] {
	if (configDir.trim() === "") return [];
	const secrets: StageTokenSecret[] = [];
	for (const [name, value] of loadEnvFile(path.join(configDir, ".env")))
		if (value.trim() !== "") secrets.push({ name, value });
	// Longest first, so a value that contains another is replaced as a whole.
	return secrets.sort((left, right) => right.value.length - left.value.length);
}
