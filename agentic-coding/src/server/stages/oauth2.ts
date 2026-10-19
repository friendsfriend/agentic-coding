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
import path from "node:path";
import { envReferenceName, loadEnvFile } from "../../env-file.ts";
import {
	resolveStageCredential,
	resolveStageOAuthCredential,
	StageCredentialError,
} from "./catalog.ts";
import type { StageDefinition, StageOAuth2Grant } from "./schema.ts";

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
	readonly grant: "client_credentials" | "refresh_token";
	readonly refreshToken?: string;
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
	private readonly entries = new Map<string, TokenEntry>();
	/** The acquisition in flight per key. */
	private readonly pending = new Map<string, Promise<OAuth2Token>>();
	/** A refresh token the provider rotated, which wins over the `.env` copy for
	 * every later renewal of the same key. */
	private readonly rotated = new Map<string, string>();

	constructor(options: StageTokenStoreOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.entryCap = Math.max(1, options.entryCap ?? DEFAULT_TOKEN_ENTRY_CAP);
		this.absoluteLifetimeMs =
			options.absoluteLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
		this.skewMs = Math.max(0, options.skewMs ?? DEFAULT_TOKEN_SKEW_MS);
	}

	/**
	 * The token for one key, renewed when less than the skew interval remains.
	 *
	 * `acquire` runs at most once per key at a time whatever the number of
	 * callers; a renewal that fails evicts the entry (a token whose renewal was
	 * rejected must not be handed out again) and rethrows the provider's refusal.
	 */
	async token(
		key: OAuth2TokenKey,
		acquire: () => Promise<OAuth2Token>,
	): Promise<OAuth2Token> {
		const id = tokenKey(key);
		const existing = this.entries.get(id);
		if (existing !== undefined && !this.stale(existing.token))
			return existing.token;
		const inFlight = this.pending.get(id);
		if (inFlight !== undefined) return await inFlight;
		const acquisition = (async () => {
			try {
				const acquired = this.clamp(await acquire());
				this.remember(id, key, acquired);
				return acquired;
			} catch (error) {
				this.entries.delete(id);
				this.rotated.delete(id);
				throw error;
			} finally {
				this.pending.delete(id);
			}
		})();
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

	/** The forget action: every entry matching the given parts of a key. Called
	 * when a credential is rewritten, when a stage reloads, and by a run that
	 * stops using a stage. */
	forget(filter: Partial<OAuth2TokenKey> = {}): void {
		for (const [id, entry] of [...this.entries]) {
			if (!matchesFilter(entry.key, filter)) continue;
			this.entries.delete(id);
			this.rotated.delete(id);
		}
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

	private remember(id: string, key: OAuth2TokenKey, token: OAuth2Token): void {
		const rotated = token.refreshToken;
		this.entries.delete(id);
		this.entries.set(id, { key, token });
		if (rotated !== undefined && rotated !== "") this.rotated.set(id, rotated);
		while (this.entries.size > this.entryCap) {
			// The oldest insertion: an entry being renewed has no token yet, so the
			// first key of the map is always one that may go.
			const oldest = this.entries.keys().next();
			if (oldest.done === true) break;
			this.entries.delete(oldest.value);
			this.rotated.delete(oldest.value);
		}
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
	if (role === undefined || role.login !== "oauth2") return undefined;
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
 * Obtain the token of one role (`stage_login`, `stage_api_request`, the browser
 * bearer header).
 *
 * Every refusal is a `StageAuthError`: `credential-missing` names the `.env`
 * variable that is unset (`clientId`, `clientSecret`, `refreshToken`), and
 * `login-failed` carries the provider's `error` code. No value of any kind is
 * part of a message.
 */
export async function roleToken(
	input: StageRoleTokenInput,
	store: StageTokenStore,
	options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<OAuth2Token> {
	const recipe = oauth2RoleOf(input.stage, input.appKey, input.role);
	if (recipe === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} does not declare the oauth2 login recipe`,
		);
	if (recipe.grant === "authorization_code")
		// The one grant that needs a person is `add-stage-oauth2-code-pkce`: the
		// stage file is valid, and this build cannot perform that login yet.
		throw new StageAuthError(
			"login-failed",
			`the authorization_code grant needs the browser hand-off of the add-stage-oauth2-code-pkce change; this build performs client_credentials and refresh_token only`,
			"unsupported_grant",
		);
	const provider = input.stage.oauth2?.providers?.[recipe.provider];
	if (provider === undefined)
		throw new StageAuthError(
			"login-failed",
			`${input.appKey}.${input.role} names the oauth2 provider ${JSON.stringify(recipe.provider)}, which the stage does not declare`,
		);
	// Resolve every reference *before* asking the provider anything, so a missing
	// variable leaves no request and no entry behind.
	let clientId: string;
	let clientSecret: string | undefined;
	let declaredRefreshToken: string | undefined;
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
		if (recipe.grant === "refresh_token")
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
	const key = roleTokenKey(input);
	const secrets: StageTokenSecret[] = [
		...(clientSecret === undefined
			? []
			: [{ name: "stage-client-secret", value: clientSecret }]),
		...(declaredRefreshToken === undefined
			? []
			: [{ name: "stage-refresh-token", value: declaredRefreshToken }]),
	];
	return await store.token(key, async () => {
		const refreshToken = store.refreshTokenFor(key, declaredRefreshToken);
		return await requestToken(
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
				grant: recipe.grant as "client_credentials" | "refresh_token",
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

/** The variable names a role's `oauth2` recipe reads, for a diagnostic that
 * wants to say which `.env` key is unset without resolving it. */
export function oauth2CredentialVariables(
	stage: StageDefinition,
	appKey: string,
	roleName: string,
): Record<"clientId" | "clientSecret" | "refreshToken", string | undefined> {
	const role = stage.apps[appKey]?.roles?.[roleName];
	const provider =
		role?.login === "oauth2"
			? stage.oauth2?.providers?.[role.provider ?? ""]
			: undefined;
	const name = (reference: string | undefined) =>
		reference === undefined ? undefined : envReferenceName(reference);
	return {
		clientId: name(provider?.clientId),
		clientSecret: name(provider?.clientSecret),
		refreshToken: name(role?.refreshToken),
	};
}
