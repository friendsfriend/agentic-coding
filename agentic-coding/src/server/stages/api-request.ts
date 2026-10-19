// `stage_api_request` and `stage_token_info` (`add-stage-oauth2-auth`, tasks
// 3.1–3.2).
//
// One authenticated call to a staged API, and one value-free read of the token
// behind it. Neither can leak a token:
//
// * The request is built from the stage file, never from the agent: the host is
//   the application's configured origin, the path is a path, and the
//   `Authorization` header is the server's own. An agent-supplied
//   `Authorization` is refused rather than overwritten, because "I sent a
//   credential" has to be answered, not silently corrected.
// * The response is bounded, its headers are reduced to an allow-list, and the
//   whole answer goes through the run's redactor — a token a *stage* echoes back
//   in its body is still a token.
// * `stage_token_info` answers four presentation fields (`expiresAt`, `scopes`,
//   `audience`, `issuer`) and nothing else: no claim, no subject, no value.

import { decodeContract } from "../../contracts/decode.ts";
import {
	MAX_STAGE_API_REQUEST_BYTES,
	type StageApiRequest,
	type StageApiRequestResponse,
	type StageTokenInfoRequest,
	type StageTokenInfoResponse,
	stageTokenInfoResponseSchema,
} from "../../contracts/stages.ts";
import type { StageCatalog, StageEntry } from "./catalog.ts";
import {
	readStageCatalog,
	stageByIdent,
	stageRefusalReason,
} from "./catalog.ts";
import { readOnlyRefusal } from "./guard.ts";
import type {
	StageLimitError as StageLimitErrorType,
	StageUsageRegistry,
} from "./limits.ts";
import {
	type ResolvedRoleToken,
	resolveRoleToken,
	roleToken,
	roleTokenFrom,
	roleTokenKey,
	StageAuthError,
	type StageRoleTokenInput,
	type StageTokenStore,
	stageTokenStore,
} from "./oauth2.ts";

/** The most of an answer that is read at all: the rest is dropped at the source,
 * so a misconfigured endpoint cannot stream a gigabyte into this process. */
export const MAX_API_RESPONSE_BYTES = 256 * 1024;

/** How long one call may take. Above it the call is refused with a timeout code
 * rather than left to a hung connection. */
export const STAGE_API_REQUEST_TIMEOUT_MS = 20_000;

/** The response headers a stage may see. A `Set-Cookie` or a custom
 * authorization-shaped header is never among them: the agent reads what the API
 * says, not the session it was handed. */
const ALLOWED_RESPONSE_HEADERS = new Set([
	"cache-control",
	"content-language",
	"content-length",
	"content-type",
	"date",
	"etag",
	"last-modified",
	"location",
	"retry-after",
	"vary",
	"x-request-id",
	"x-correlation-id",
]);

/** A refusal of the two routes below, with the code the contract names. */
export class StageApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		/** How long the caller should wait, for a rate limit. */
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "StageApiError";
	}
}

/** What these two routes read. Structurally a subset of the server's stage deps,
 * so `app.ts` passes the same object it already builds. */
export interface StageApiDeps {
	readonly configDir: string;
	readonly appIdents?: () => readonly string[];
	/** The process's token store; tests pass their own. */
	readonly tokens?: StageTokenStore;
	/** The rolling-minute registry, shared with the browser routes so one stage
	 * has one rate in this workflow whatever tool sends the call. */
	readonly usage?: StageUsageRegistry;
	/** Test seam: the HTTP client of a stage call. */
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

function tokenStore(deps: StageApiDeps): StageTokenStore {
	return deps.tokens ?? stageTokenStore();
}

/** The catalog of the configuration root these deps name. */
export function apiCatalog(deps: StageApiDeps): StageCatalog {
	return readStageCatalog(deps.configDir, {
		...(deps.appIdents ? { appIdents: deps.appIdents } : {}),
	});
}

/**
 * What one stage-bound session's bearer requests resolve to: the role's token
 * path, resolved once (PERF-001).
 *
 * The catalog read and the resolution are the expensive part of an
 * authenticated page request, and a page issues one per subresource. The cache
 * is keyed by the binding object, which lives exactly as long as the session, so
 * a session resolves each of its roles once; a stage file edited mid-session
 * applies to the next session, exactly as a `.env` value edited mid-session
 * applies to the next renewal. Only entries of *this* stage's applications are
 * ever resolved, and a value is never part of the entry.
 */
const bearerTargets = new WeakMap<
	object,
	Map<string, Promise<ResolvedRoleToken | undefined>>
>();

/** One session's resolution of one bearer scope, cached for the session. */
function bearerTarget(
	deps: StageApiDeps,
	binding: object & { readonly ident: string },
	scope: { readonly app: string; readonly role: string },
): Promise<ResolvedRoleToken | undefined> {
	let byScope = bearerTargets.get(binding);
	if (byScope === undefined) {
		byScope = new Map();
		bearerTargets.set(binding, byScope);
	}
	const id = `${scope.app}\u0000${scope.role}`;
	const cached = byScope.get(id);
	if (cached !== undefined) return cached;
	const resolved = (async () => {
		try {
			const entry = stageByIdent(apiCatalog(deps), binding.ident);
			if (entry === undefined) return undefined;
			return resolveRoleToken({
				stage: entry.stage,
				appKey: scope.app,
				role: scope.role,
				configDir: deps.configDir,
			});
		} catch {
			// A stage that is gone, a role that is not an oauth2 role, a grant this
			// build cannot perform: the request goes out as the page wrote it.
			return undefined;
		}
	})();
	byScope.set(id, resolved);
	return resolved;
}

/**
 * The `Authorization` value of one origin of one stage-bound session
 * (`add-stage-oauth2-auth`, task 3.3).
 *
 * This is what the pool's route handler asks for each request whose origin a
 * role declared in `bearerOrigins`. The role's *resolution* is cached per
 * session and the token itself is cached by the store, so a page load with N
 * requests on that origin costs N map lookups rather than N catalog and `.env`
 * reads (PERF-001, PERF-002). Every refusal answers `undefined` — a page request
 * is never failed because a token could not be obtained, and the token value
 * never leaves this function.
 */
export async function stageBearerToken(
	deps: StageApiDeps,
	binding: { readonly ident: string },
	scope: { readonly app: string; readonly role: string },
): Promise<string | undefined> {
	try {
		const resolved = await bearerTarget(deps, binding, scope);
		if (resolved === undefined) return undefined;
		const token = await roleTokenFrom(resolved, tokenStore(deps), {
			...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
			...(deps.now === undefined ? {} : { now: deps.now }),
		});
		return `Bearer ${token.accessToken}`;
	} catch {
		// A missing variable, an unreachable provider, a stage that is gone: the
		// request goes out as the page wrote it.
		return undefined;
	}
}

/**
 * The stage one call addresses: named, or the only allow-listed one. A call
 * that names no stage when the catalog has several is refused rather than
 * guessed, because the token of the wrong stage is the worst kind of accident.
 */
export function stageOfCall(
	catalog: StageCatalog,
	ident: string | undefined,
): StageEntry {
	if (ident !== undefined) {
		const entry = stageByIdent(catalog, ident);
		if (!entry)
			throw new StageApiError(
				"stage-not-configured",
				stageRefusalReason(catalog, ident),
				404,
			);
		return entry;
	}
	const [only, ...rest] = catalog.entries;
	if (only === undefined)
		throw new StageApiError(
			"stage-not-configured",
			"no allow-listed stage is configured for this run",
			404,
		);
	if (rest.length > 0)
		throw new StageApiError(
			"stage-app-ambiguous",
			`this run knows ${catalog.entries.length} stages (${catalog.entries
				.map((entry) => entry.ident)
				.join(", ")}); name one with the stage field`,
		);
	return only;
}

/**
 * The application one call addresses. `stage_api_request` may only speak to an
 * application of kind `api`: a `ui` app is a page, and its session is what
 * `browser_*` is for.
 */
export function apiAppOfCall(
	entry: StageEntry,
	appKey: string | undefined,
): string {
	const apiApps = Object.entries(entry.stage.apps)
		.filter(([, app]) => app.kind === "api")
		.map(([key]) => key);
	if (appKey !== undefined) {
		const app = entry.stage.apps[appKey];
		if (!app)
			throw new StageApiError(
				"stage-app-unknown",
				`stage ${entry.ident} declares no application ${JSON.stringify(appKey)}`,
				404,
			);
		if (app.kind !== "api")
			throw new StageApiError(
				"stage-app-kind",
				`stage ${entry.ident} application ${JSON.stringify(appKey)} is of kind ${app.kind}; stage_api_request needs an api application`,
			);
		return appKey;
	}
	const [only, ...rest] = apiApps;
	if (only === undefined)
		throw new StageApiError(
			"stage-app-kind",
			`stage ${entry.ident} declares no api application`,
			404,
		);
	if (rest.length > 0)
		throw new StageApiError(
			"stage-app-ambiguous",
			`stage ${entry.ident} declares ${apiApps.length} api applications (${apiApps.join(
				", ",
			)}); name one with the app field`,
		);
	return only;
}

/**
 * The URL of one call, on the application's own origin.
 *
 * A path and nothing else: a full URL, a protocol-relative target or an
 * authority-shaped `//host/path` would move the agent's request — and the role's
 * bearer token — to a host the stage file never named.
 */
export function apiUrl(baseUrl: string, path: string): URL {
	if (!path.startsWith("/") || path.startsWith("//"))
		throw new StageApiError(
			"stage-request-invalid",
			"the path must be a path of the application, starting with a single `/`; a full URL is refused because the host is the one the stage names",
		);
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new StageApiError(
			"stage-request-invalid",
			"this application's url is not a URL",
		);
	}
	let url: URL;
	try {
		url = new URL(path, base);
	} catch {
		throw new StageApiError(
			"stage-request-invalid",
			"the path is not a path this application can serve",
		);
	}
	// Belt and braces: a path that parsed into another origin is exactly what the
	// two checks above exist to prevent.
	if (url.origin !== base.origin)
		throw new StageApiError(
			"stage-request-invalid",
			"the path resolves to another origin than this application's",
		);
	return url;
}

/** The URL of one call: the path rule of `apiUrl`, plus the optional `query`
 * object. A path that already carries a query string and a `query` object are
 * refused together, so one request cannot express two different queries. */
export function apiCallUrl(
	baseUrl: string,
	path: string,
	query: Record<string, string> | undefined,
): URL {
	const url = apiUrl(baseUrl, path);
	if (query === undefined || Object.keys(query).length === 0) return url;
	if (path.includes("?"))
		throw new StageApiError(
			"stage-request-invalid",
			"the path already carries a query string; send the parameters in `query` or in `path`, not both",
		);
	for (const [name, value] of Object.entries(query))
		url.searchParams.append(name, value);
	return url;
}

/** The headers of one call, without a credential the agent supplied. */
function requestHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lower = name.toLowerCase();
		if (lower === "authorization")
			throw new StageApiError(
				"stage-auth-header",
				"an Authorization header is refused: the server attaches the role's own token, and an agent-supplied credential would be sent in its place",
			);
		if (lower === "host" || lower === "content-length")
			throw new StageApiError(
				"stage-request-invalid",
				`the ${lower} header is set by the server and cannot be supplied`,
			);
		result[lower] = value;
	}
	return result;
}

/** Read at most the response bound, then stop: the rest never enters this
 * process. */
async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<{
	readonly body: string;
	readonly bytes: number;
	readonly truncated: boolean;
}> {
	const declared = Number(response.headers.get("content-length") ?? "");
	const reader = response.body?.getReader();
	if (reader === undefined) return { body: "", bytes: 0, truncated: false };
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			chunks.push(
				value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes))),
			);
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(value);
	}
	const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	return {
		body: buffer.toString("utf8"),
		// A chunked answer declares no length: the bytes actually read are what the
		// caller is told about, plus the header when it is larger.
		bytes: Number.isFinite(declared) && declared > bytes ? declared : bytes,
		truncated: truncated || (Number.isFinite(declared) && declared > maxBytes),
	};
}

/**
 * One authenticated call (`stage_api_request`, task 3.1).
 *
 * Every guard runs before anything is sent: the stage, the application, the
 * path, an agent-supplied credential, the origin allow-list, the read-only
 * method rule and the stage's action rate. A `401` costs exactly one renewal and
 * one retry — a provider that keeps refusing is not asked a third time.
 */
export async function stageApiRequestValue(
	deps: StageApiDeps,
	body: StageApiRequest,
	owner: string,
	redact: (value: unknown) => unknown,
): Promise<StageApiRequestResponse> {
	const catalog = apiCatalog(deps);
	const entry = stageOfCall(catalog, body.stage);
	const appKey = apiAppOfCall(entry, body.app);
	const app = entry.stage.apps[appKey];
	if (app === undefined)
		throw new StageApiError(
			"stage-app-unknown",
			"this application is gone",
			404,
		);
	const url = apiCallUrl(app.url, body.path, body.query);
	const headers = requestHeaders(body.headers);
	// The request bound, in bytes: the contract bounds the field's characters, so a
	// multi-byte body still has to be measured before it is sent (QA-005).
	if (body.body !== undefined) {
		const bytes = Buffer.byteLength(body.body, "utf8");
		if (bytes > MAX_STAGE_API_REQUEST_BYTES)
			throw new StageApiError(
				"stage-request-invalid",
				`the body is ${bytes} bytes; a stage call may carry at most ${MAX_STAGE_API_REQUEST_BYTES}`,
				413,
			);
	}
	// The origin rule is the path rule: the URL is built on this application's own
	// configured origin and a path that resolved anywhere else is refused by
	// `apiUrl`, so there is nothing left for a second allow-list check to catch
	// (TQV-007 — see design.md).
	const refusal = readOnlyRefusal(
		{
			ident: entry.ident,
			access: entry.stage.access,
			origins: entry.origins,
			readOnlyExceptions: entry.stage.readOnlyExceptions ?? [],
			limits: entry.limits,
		},
		url,
		body.method,
	);
	if (refusal !== undefined)
		throw new StageApiError(
			refusal.code,
			`stage ${entry.ident} is read-only, so a ${refusal.method} request to ${refusal.url} is refused; a declared readOnlyExceptions entry is what allows one`,
		);
	countAction(deps, entry, owner);
	const response = await send(deps, {
		entry,
		appKey,
		role: body.role,
		url,
		method: body.method,
		headers,
		body: body.body,
		redact,
	});
	return response;
}

/** Count one call against the stage's rolling minute, or refuse it. */
function countAction(
	deps: StageApiDeps,
	entry: StageEntry,
	owner: string,
): void {
	if (deps.usage === undefined) return;
	try {
		deps.usage.countAction({
			stage: entry.ident,
			owner,
			maxActionsPerMinute: entry.limits.maxActionsPerMinute,
		});
	} catch (error) {
		const limit = error as StageLimitErrorType;
		if (limit?.code !== "stage-rate-limit") throw error;
		throw new StageApiError(limit.code, limit.message, 429, limit.retryAfterMs);
	}
}

interface SendInput {
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly role: string;
	readonly url: URL;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string | undefined;
	readonly redact: (value: unknown) => unknown;
}

/** Send one authenticated call, renewing once on a `401`. */
async function send(
	deps: StageApiDeps,
	input: SendInput,
): Promise<StageApiRequestResponse> {
	const tokens = tokenStore(deps);
	const roleInput = {
		stage: input.entry.stage,
		appKey: input.appKey,
		role: input.role,
		configDir: deps.configDir,
	};
	let renewals = 0;
	let token = await acquire(deps, tokens, roleInput);
	let answer = await exchange(deps, input, token.accessToken);
	if (answer.status === 401) {
		// One renewal, one retry: the token was refused, which is the one case the
		// server can fix by itself. The `401` is not reported when the retry
		// succeeds, because the call is what the agent asked about. `expire` and not
		// `forget`: the rotated refresh token the provider issued is the only one it
		// still accepts (QA-002).
		renewals = 1;
		tokens.expire(roleTokenKey(roleInput));
		token = await acquire(deps, tokens, roleInput);
		answer = await exchange(deps, input, token.accessToken);
	}
	const headersOut = [...answer.response.headers.entries()]
		.filter(([name]) => ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase()))
		.map(([name, value]) => ({ name: name.toLowerCase(), value }));
	const redactedHeaders = input.redact(headersOut) as typeof headersOut;
	return {
		stage: input.entry.ident,
		app: input.appKey,
		role: input.role,
		method: input.method,
		url: input.url.toString(),
		status: answer.status,
		statusText: answer.statusText,
		headers: redactedHeaders,
		body: input.redact(answer.body) as string,
		truncated: answer.truncated,
		bytes: answer.bytes,
		renewals,
	};
}

async function acquire(
	deps: StageApiDeps,
	tokens: StageTokenStore,
	roleInput: StageRoleTokenInput,
) {
	try {
		return await roleToken(roleInput, tokens, {
			...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
			...(deps.now === undefined ? {} : { now: deps.now }),
		});
	} catch (error) {
		if (error instanceof StageAuthError)
			throw new StageApiError(
				error.code,
				error.message,
				error.code === "credential-missing" ? 400 : 502,
			);
		throw error;
	}
}

async function exchange(
	deps: StageApiDeps,
	input: SendInput,
	accessToken: string,
): Promise<{
	readonly response: Response;
	readonly status: number;
	readonly statusText: string;
	readonly body: string;
	readonly bytes: number;
	readonly truncated: boolean;
}> {
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(input.url.toString(), {
			method: input.method,
			headers: { ...input.headers, authorization: `Bearer ${accessToken}` },
			...(input.body === undefined ? {} : { body: input.body }),
			signal: AbortSignal.timeout(STAGE_API_REQUEST_TIMEOUT_MS),
			// A 3xx is an answer: following it would move the token to another host.
			redirect: "manual",
		});
	} catch (error) {
		throw new StageApiError(
			"stage-request-failed",
			`${input.url.origin}${input.url.pathname} answered nothing${
				error instanceof Error && error.name === "TimeoutError"
					? " before the call's timeout"
					: ""
			}`,
			502,
		);
	}
	let bounded: Awaited<ReturnType<typeof readBounded>>;
	try {
		bounded = await readBounded(response, MAX_API_RESPONSE_BYTES);
	} catch {
		throw new StageApiError(
			"stage-request-failed",
			`${input.url.origin}${input.url.pathname} closed its answer before this server read it`,
			502,
		);
	}
	return {
		response,
		status: response.status,
		statusText: response.statusText,
		body: bounded.body,
		bytes: bounded.bytes,
		truncated: bounded.truncated,
	};
}

/**
 * The four fields an agent may learn about a role's token (`stage_token_info`,
 * task 3.2).
 *
 * The token is acquired when there is none, so a developer can ask "is this role
 * actually able to get a token" without spending a request on the API. The
 * answer is validated through the contract, which is what makes "nothing else
 * comes back" a property of the code rather than of this function's care.
 */
export async function stageTokenInfoValue(
	deps: StageApiDeps,
	body: StageTokenInfoRequest,
): Promise<StageTokenInfoResponse> {
	const catalog = apiCatalog(deps);
	const entry = stageOfCall(catalog, body.stage);
	const role = body.role;
	const roleInput = {
		stage: entry.stage,
		appKey: body.app ?? appOfRole(entry, role),
		role,
		configDir: deps.configDir,
	};
	const tokens = tokenStore(deps);
	const key = roleTokenKey(roleInput);
	// The token `acquire` answers is the one reported: reading it back out of the
	// store would report nothing for a provider whose lifetime is already inside
	// the renewal skew (QA-001).
	const held = tokens.peek(key) ?? (await acquire(deps, tokens, roleInput));
	return decodeContract<StageTokenInfoResponse>(
		"server.agent-env.stage-token-info",
		stageTokenInfoResponseSchema,
		{
			expiresAt: held.expiresAt,
			scopes: [...held.scopes],
			...(held.audience === undefined ? {} : { audience: held.audience }),
			...(held.issuer === undefined ? {} : { issuer: held.issuer }),
		},
	);
}

/** The one application that declares this role, when a call does not name it. */
function appOfRole(entry: StageEntry, role: string): string {
	const holders = Object.entries(entry.stage.apps)
		.filter(([, app]) => app.roles?.[role] !== undefined)
		.map(([key]) => key);
	const [only, ...rest] = holders;
	if (only === undefined)
		throw new StageApiError(
			"stage-role-unknown",
			`stage ${entry.ident} declares no role ${JSON.stringify(role)}`,
			404,
		);
	if (rest.length > 0)
		throw new StageApiError(
			"stage-app-ambiguous",
			`stage ${entry.ident} declares ${JSON.stringify(role)} on ${holders.join(
				", ",
			)}; name the application with the app field`,
		);
	return only;
}
