// The agent browser routes (`add-agent-browser-sessions`, task 4.1).
//
// The owner-scoped HTTP surface a durable run's `browser_*` tools call. It rides
// the same verified capability as `/api/v1/agent-env/*` (`app.ts` resolves the
// owner before this module runs), so a run can only ever drive *its own*
// sessions and can only resolve an app endpoint it actually holds.
//
// Three bounds apply to everything here:
//
// * **The pool owns isolation and capacity.** A session is one browser context
//   of the shared Chromium, capped by `browser.max_sessions` with FIFO queueing
//   and an idle TTL; the routes never create a context themselves.
// * **A page is never the process.** Scripts and evaluations run inside the
//   session's page and receive only that page and its context — never a server
//   handle — and every one of them is bounded by a timeout.
// * **Evidence is kept by choice.** A screenshot is returned to the model
//   whether or not it is stored; a video is stored with its poster only when the
//   agent asked to keep it, and a discarded recording leaves neither file nor
//   manifest entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserStatusResponse } from "../../contracts/browser.ts";
import type { EvidenceEntry } from "../../contracts/environment.ts";
import {
	BROWSER_MAX_IMAGE_WIDTH,
	type ResolvedBrowserSettings,
} from "../../workflow/effects.ts";
import { workflowEvidenceScope } from "../../workflow/runtime/evidence-store.ts";
import { readJsonBody } from "../auth.ts";
import { environmentSecrets, redact } from "../environment/agent-routes.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import {
	type LocatedEvidenceWorkflow,
	locateEvidenceWorkflow,
} from "../evidence/routes.ts";
import { attachEvidence, EvidenceError } from "../evidence/store.ts";
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
	decodeRouteRequest,
} from "../protocol.ts";
import type { EnvironmentInstanceController } from "../runtime/instances.ts";
import {
	readStageCatalog,
	roleLoginMode,
	type StageCatalog,
	type StageEntry,
	stageByIdent,
	stageCredentialVariables,
	stageRefusalReason,
	stageView,
} from "../stages/catalog.ts";
import { type StageRefusal, sanitizeStageUrl } from "../stages/guard.ts";
import {
	type StageAdmission,
	StageLimitError,
	StageUsageRegistry,
} from "../stages/limits.ts";
import {
	beginAuthorizationCodeLogin,
	pkceSecrets,
	roleToken,
	StageAuthError,
	type StageTokenStore,
	stageTokenStore,
} from "../stages/oauth2.ts";
import { isOAuth2Role, type StageLoginRecipe } from "../stages/schema.ts";
import { BrowserPoolError } from "./errors.ts";
import {
	HANDOFF_MAX_WAIT_MS,
	type LoginHandoffCoordinator,
	type LoginHandoffOutcome,
} from "./handoff.ts";
import type { BrowserInstaller } from "./install.ts";
import {
	fillStageCredential,
	runStageLogin,
	silentLoginCheck,
} from "./login.ts";
import type { BrowserPool } from "./pool.ts";
import { createScriptExpect } from "./script-expect.ts";
import {
	type BrowserSession,
	BrowserSessionError,
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
	type NetworkEntry,
	type StageBearerScope,
	type StageSessionBinding,
} from "./session.ts";

/** The session a call names when it names none. */
export const DEFAULT_BROWSER_SESSION = "default";
/** The default and maximum `browser_run_script` bound. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
const MAX_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
/** How many console/network rows one read returns by default, and at most. */
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 500;
/** JPEG quality for a returned screenshot: readable without being huge. */
const SCREENSHOT_QUALITY = 70;
/** The silent SSO check a promoted session gets before a new hand-off (D2). */
const SILENT_SSO_CHECK_MS = 10_000;
/** The temp root for server-written evidence before it is copied into the
 * workflow's evidence store. Inside the workflow's data root, which is one of
 * the roots the store accepts a source from. */
const EVIDENCE_SCRATCH_DIR = "browser";

export interface BrowserRouteDeps {
	readonly installer: BrowserInstaller;
	readonly pool: BrowserPool;
	/** `add-stage-interactive-login`: the login hand-off coordinator. Absent in a
	 * test that drives no hand-off, where a role that would need one answers
	 * `login-handoff-unavailable`. */
	readonly handoff?: LoginHandoffCoordinator;
	/** Resolved per request, so a configuration edit applies to the next call. */
	readonly settings: () => ResolvedBrowserSettings;
	readonly apps?: Pick<EnvironmentManager, "getAppByIdent">;
	readonly instances?: EnvironmentInstanceController;
	/** The configuration root the stage catalog is read from. Absent in a test
	 * that drives no stage, where every stage open is `stage-not-configured`. */
	readonly configDir?: string;
	/** The per-workflow stage bounds and leases. The server passes one registry
	 * for the process's life, so a rolling minute survives between requests. */
	readonly stages?: StageUsageRegistry;
	/** Test seam: locate a workflow without the engine. */
	readonly locate?: (workflowId: string) => LocatedEvidenceWorkflow | undefined;
	/** The process's token store (`add-stage-oauth2-auth`): the `oauth2` recipe
	 * acquires into it and every reply is scrubbed with what it holds. Omitted,
	 * the process store is used. */
	readonly tokens?: StageTokenStore;
	/** The fetch a code-grant login's token exchange uses. Absent, the global one;
	 * a test points it at a local token endpoint. */
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

/** The registry of one `BrowserRouteDeps` object, created on first use and kept
 * for that object's life — so a rolling minute is a minute even when a caller
 * did not pass a registry of its own. */
const registries = new WeakMap<BrowserRouteDeps, StageUsageRegistry>();

function stageUsage(deps: BrowserRouteDeps): StageUsageRegistry {
	const existing = deps.stages ?? registries.get(deps);
	if (existing) return existing;
	const created = new StageUsageRegistry({
		...(deps.now ? { now: deps.now } : {}),
		stageSessions: (owner, stage) => deps.pool.stageSessions(owner, stage),
	});
	registries.set(deps, created);
	return created;
}

/** The catalog of this request, read fresh so a stage file the developer just
 * edited applies to the next call. */
function stageCatalog(deps: BrowserRouteDeps): StageCatalog {
	return readStageCatalog(deps.configDir ?? "");
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The install state the Settings section reads. Non-secret by construction:
 * it names paths and phases, never a token. */
export function browserStatusValue(
	installer: BrowserInstaller,
	settings: ResolvedBrowserSettings,
): BrowserStatusResponse {
	const status = installer.status();
	return {
		available: status.available,
		source: status.source,
		...(status.executablePath ? { executablePath: status.executablePath } : {}),
		...(status.channel ? { channel: status.channel } : {}),
		browsersPath: status.browsersPath,
		...(status.systemChrome ? { systemChrome: status.systemChrome } : {}),
		headed: status.headed,
		install: status.install,
		settings: {
			maxSessions: settings.maxSessions,
			idleTtlMs: settings.idleTtlMs,
			viewport: { ...settings.viewport },
		},
	};
}

/** One session a request is using, and the refusal fence it reports from: what
 * the guard recorded *before* this call began is not this call's to report. The
 * two travel together because a session can be used by more than one call at
 * once (a script abandoned by its own timeout keeps running). */
interface SessionUse {
	readonly session: BrowserSession;
	readonly refusalsFrom: number;
}

/** The refusal every agent route answers while the developer holds a session.
 * Value-free: the hand-off's id and deadline, and nothing about the page. */
export function sessionHeldRefusal(session: BrowserSession): BrowserPoolError {
	const hold = session.hold;
	return new BrowserPoolError(
		"session-held-by-user",
		"a login hand-off holds this session while the developer logs in: wait for it with stage_login_wait, or end it with browser_close",
		409,
		undefined,
		hold
			? {
					handoffId: hold.handoffId,
					deadlineAt: new Date(hold.deadlineAt).toISOString(),
				}
			: {},
	);
}

/**
 * The owner-scoped browser routes. Answers `undefined` for a path this module
 * does not own, so `app.ts` can keep handing the rest of the capability prefix
 * to the environment routes.
 */
export async function handleBrowserRoute(
	deps: BrowserRouteDeps,
	request: Request,
	url: URL,
	owner: string,
): Promise<Response | undefined> {
	const method = request.method.toUpperCase();
	const path = url.pathname;
	if (!path.startsWith("/api/v1/agent-env/browser/")) return undefined;
	// Sessions a request uses are marked in flight for its whole duration, so the
	// idle sweep cannot close a page under a running script.
	const used: SessionUse[] = [];
	let status = 200;
	let envelope: Record<string, unknown>;
	try {
		const value = await dispatch(deps, request, path, method, owner, used);
		envelope = { ok: true, value };
	} catch (error) {
		if (error instanceof StageLimitError) {
			status = error.code === "stage-rate-limit" ? 429 : 409;
			envelope = {
				error: {
					code: error.code,
					message: error.message,
					...(error.retryAfterMs === undefined
						? {}
						: { retryAfterMs: error.retryAfterMs }),
				},
			};
		} else if (
			error instanceof BrowserPoolError ||
			error instanceof BrowserSessionError ||
			error instanceof EvidenceError
		) {
			status = error.status;
			envelope = {
				error: {
					code: error.code,
					message: error.message,
					// A value-free sub-reason (`login-handoff-unavailable`), and the extra
					// fields a refusal carries (a hand-off's id and deadline). Both are
					// fixed vocabulary or coordination data — never page content.
					...("reason" in error && error.reason
						? { reason: error.reason }
						: {}),
					...("details" in error && error.details ? error.details : {}),
				},
			};
		} else {
			status = 400;
			envelope = {
				error: { code: "browser-failed", message: message(error) },
			};
		}
	} finally {
		for (const use of used) use.session.endUse(use.refusalsFrom);
	}
	// A stage guard refuses requests the session's *page* made, not the call that
	// triggered them, so what it recorded is reported on this result: an aborted
	// navigation becomes the call's own refusal, and a refusal a page caused on
	// its own is attached for the model to read.
	const refusals = drainRefusals(used);
	const applied = applyRefusals(envelope, refusals, status);
	envelope = applied.envelope;
	status = applied.status;
	// Every browser reply passes the shared redactor (the configuration `.env`
	// values, in plain and URL-encoded form) and the URL sanitizer, so a token in
	// a page's text, in an evaluated value, in a console line or in a redirect's
	// query or fragment cannot reach a tool result, a log or an evidence file.
	const redacted = sanitizeUrlsIn(redact(envelope, redactionSecrets(deps)));
	return json(redacted, status);
}

/** The refusals a request's sessions have to report: its own, plus whatever no
 * result has reported yet. */
function drainRefusals(used: readonly SessionUse[]): RefusalReport {
	const mine: StageRefusal[] = [];
	const unclaimed: StageRefusal[] = [];
	for (const use of used) {
		const report = use.session.claimRefusals(use.refusalsFrom);
		mine.push(...report.mine);
		unclaimed.push(...report.unclaimed);
	}
	return { mine, unclaimed };
}

/** One result's refusals, split by whether the call that reports them owns them.
 *
 * * `mine` — this call's own page work, which is what may turn its answer into
 *   the refusal (a navigation the guard aborted is the call's own failure).
 * * `unclaimed` — recorded before this call began and reported by nothing since:
 *   the spec says the *next* tool result on the session reports the guard's
 *   refusals, so a refusal that arrives between two calls is relayed by the next
 *   one. Relaying is not owning: it never rewrites that call's status. */
interface RefusalReport {
	readonly mine: StageRefusal[];
	readonly unclaimed: StageRefusal[];
}

/** Attach the refusals to one envelope, and let a refused navigation answer
 * with the refusal's own code — and its own status, so a refusal is never
 * reported as a bad request — instead of a bare `net::ERR_ABORTED`. Only a
 * refusal this call produced can do that; a relayed one leaves the status it
 * was given. */
function applyRefusals(
	envelope: Record<string, unknown>,
	report: RefusalReport,
	status: number,
): { readonly envelope: Record<string, unknown>; readonly status: number } {
	const refusals = [...report.mine, ...report.unclaimed];
	if (refusals.length === 0) return { envelope, status };
	const events = refusals.map((refusal) => ({
		code: refusal.code,
		url: refusal.url,
		...(refusal.method ? { method: refusal.method } : {}),
	}));
	const error = envelope.error as
		| { code?: string; message?: string }
		| undefined;
	if (
		report.mine.length > 0 &&
		error?.code === "browser-failed" &&
		looksAborted(error.message ?? "")
	) {
		const refusal = report.mine[report.mine.length - 1] as StageRefusal;
		return {
			// Both refusals are the same answer to the caller — a stage policy said no —
			// so the aborted call is reported as `403`, not as a bad request.
			status: 403,
			envelope: {
				...envelope,
				error: { code: refusal.code, message: refusalMessage(refusal) },
				guardEvents: events,
			},
		};
	}
	return { envelope: { ...envelope, guardEvents: events }, status };
}

/** Both refusals are the same answer to the caller: a stage policy said no. */

function looksAborted(text: string): boolean {
	return text.includes("net::") || text.includes("ERR_ABORTED");
}

/** What `browser_network` reports in place of an `Authorization` header's value
 * (`add-stage-oauth2-auth`, task 2.3). The header's *presence* is useful — it is
 * how a run tells "the request was authenticated" from "it was refused by the
 * gateway" — and its value is never part of any entry, so the placeholder is
 * all a caller can ever read. */
export const AUTHORIZATION_PLACEHOLDER = "«redacted»";

/** One network entry as the agent reads it: a request that carried an
 * `Authorization` header reports the placeholder in place of a header list. */
function networkEntryValue(
	entry: NetworkEntry,
): Omit<NetworkEntry, "hasAuthorization"> & { authorization?: string } {
	const { hasAuthorization, ...rest } = entry;
	return {
		...rest,
		...(hasAuthorization === true
			? { authorization: AUTHORIZATION_PLACEHOLDER }
			: {}),
	};
}

/** One refusal, as prose. The URL is already sanitized (origin and path only),
 * so a refusal can be reported without leaking a query or a fragment. */
export function refusalMessage(refusal: StageRefusal): string {
	if (refusal.code === "stage-read-only")
		return `this stage is read-only, so the ${refusal.method} request to ${refusal.url} was aborted; a declared readOnlyExceptions entry is what allows one`;
	return `${refusal.url} is not in this stage's origin allow-list, so the navigation was aborted; use an origin the stage declares in allowedOrigins`;
}

/** The secret values every browser reply is scrubbed of: the configuration
 * `.env` (all of a stage's credentials come from there), each value also in its
 * URL-encoded form, because a credential reaches a URL encoded far more often
 * than plain. */
function redactionSecrets(
	deps: BrowserRouteDeps,
): ReturnType<typeof environmentSecrets> {
	const base = environmentSecrets(deps.configDir ?? "");
	// The tokens this process holds are secrets too (`add-stage-oauth2-auth`,
	// task 2.3): a page can echo an access token into a console line, a network
	// URL or a snapshot, and an agent-supplied script can print one, so every
	// browser reply is scrubbed with the live token map and not only with `.env`.
	const live = browserTokenStore(deps).secrets();
	// The PKCE values of a code-grant login (`add-stage-oauth2-code-pkce`): the
	// verifier, `state` and the code a receiver took are as secret as the token
	// they lead to, and the callback URL the window lands on carries the code.
	const pkce = pkceSecrets();
	const encoded = [...base, ...live, ...pkce].flatMap((secret) => {
		const value = encodeURIComponent(secret.value);
		return value === secret.value
			? []
			: [{ name: `${secret.name}:url-encoded`, value }];
	});
	return [...base, ...live, ...pkce, ...encoded].sort(
		(left, right) => right.value.length - left.value.length,
	);
}

/** The token store this deps object reads: its own, or the process's. */
function browserTokenStore(deps: BrowserRouteDeps): StageTokenStore {
	return deps.tokens ?? stageTokenStore();
}

/**
 * The origins one stage's browser requests are authenticated for: every `oauth2`
 * role that declared `bearerOrigins`, by the application that declares the role
 * (the token is acquired for *that* role, wherever the session itself lives).
 *
 * The first declaration of an origin wins, so an origin listed by two roles is
 * authenticated once, by the role that asked for it first.
 */
function bearerScopes(entry: StageEntry): StageBearerScope[] {
	const scopes: StageBearerScope[] = [];
	const seen = new Set<string>();
	for (const [appKey, app] of Object.entries(entry.stage.apps)) {
		for (const [role, value] of Object.entries(app.roles ?? {})) {
			if (!isOAuth2Role(value)) continue;
			for (const declared of value.bearerOrigins ?? []) {
				const origin = originOnly(declared);
				if (origin === "" || seen.has(origin)) continue;
				seen.add(origin);
				scopes.push({ origin, app: appKey, role });
			}
		}
	}
	return scopes;
}

/** Query parameters whose value never survives a reported URL. */
const SENSITIVE_URL_PARAM =
	/(^|_)(token|code|secret|password|passwd|pwd|key|session|sessionid|sid|sig|signature|auth|assertion|saml|ticket|state|nonce)($|_)/i;

/**
 * Sanitize every URL-shaped string of a reply: a token-like query parameter is
 * replaced, and a fragment that carries something (an OAuth implicit-flow
 * `#access_token=…`, a callback `#code=…`) is replaced whole. A plain anchor
 * (`#section`) is left alone, and a URL nothing had to be hidden in is returned
 * unchanged, so page content stays byte-identical except where a secret sat.
 */
export function sanitizeUrlsIn(value: string): string;
export function sanitizeUrlsIn(value: unknown): unknown;
export function sanitizeUrlsIn(value: unknown): unknown {
	if (typeof value === "string") return sanitizeUrlTokens(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeUrlsIn(item));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value))
		out[key] = sanitizeUrlsIn(item);
	return out;
}

function sanitizeUrlTokens(text: string): string {
	if (!text.includes("://")) return text;
	return text.replace(/https?:\/\/[^\s"'<>)\\]+/g, (raw) => sanitizeUrl(raw));
}

/** One URL, or the same text when there was nothing to hide. */
function sanitizeUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return raw;
	}
	let changed = false;
	for (const key of [...parsed.searchParams.keys()]) {
		if (!SENSITIVE_URL_PARAM.test(key) || parsed.searchParams.get(key) === "")
			continue;
		parsed.searchParams.set(key, "redacted");
		changed = true;
	}
	const fragment = parsed.hash.slice(1);
	if (fragment !== "" && (fragment.includes("=") || fragment.length >= 16)) {
		parsed.hash = "#redacted";
		changed = true;
	}
	return changed ? parsed.toString() : raw;
}

/** One session URL as an evidence entry may carry it.
 *
 * An evidence entry is written to disk and read long after the call that made it,
 * and the reply redactor runs on the *reply*: a callback URL's token, or a
 * signed `?sig=…`, would otherwise survive in the manifest, in the dashboard's
 * evidence list and in a later report. So the same redactor and the same URL
 * sanitizer every reply passes are applied *before* anything is attached. */
function evidenceUrl(deps: BrowserRouteDeps, url: string): string {
	const redacted = redact(url, redactionSecrets(deps));
	const sanitized = sanitizeUrlsIn(
		typeof redacted === "string" ? redacted : url,
	);
	return typeof sanitized === "string" ? sanitized : url;
}

/**
 * Run one credential-handling call so that nothing its failure carries can reach
 * the caller.
 *
 * The value's own stops already refuse to quote it (`BrowserSession.fillCredential`),
 * but a credential flow is the one place where a *third* party's error could
 * still carry it: a locator failure, a browser-level message, a driver's call
 * log. An error this module defines passes through unchanged — it is value-free
 * by construction — and anything else becomes one that is, with its name as the
 * only detail.
 */
async function withoutCredentialEcho<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof BrowserSessionError ||
			error instanceof BrowserPoolError ||
			error instanceof StageLimitError ||
			error instanceof EvidenceError
		)
			throw error;
		throw new BrowserSessionError(
			"credential-failed",
			`the credential flow failed (${error instanceof Error ? error.name : "Error"}); nothing of the value is reported`,
			502,
		);
	}
}

async function dispatch(
	deps: BrowserRouteDeps,
	request: Request,
	path: string,
	method: string,
	owner: string,
	/** The sessions this request has begun work on, released by the caller when
	 * the request ends. */
	used: SessionUse[],
): Promise<unknown> {
	// Every call releases what the idle TTL has expired, so an abandoned run's
	// sessions cannot hold the cap until a timer nobody owns fires.
	await deps.pool.sweepIdle();
	if (method === "POST" && path === AGENT_BROWSER_OPEN_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserOpenRequest
		>(path, await readJsonBody(request));
		return await openSession(deps, owner, body, used);
	}
	if (method === "POST" && path === AGENT_BROWSER_SNAPSHOT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserSessionRequest
		>(path, await readJsonBody(request));
		const session = await sessionFor(deps, owner, body.session, used);
		const snapshot = await session.snapshot();
		return {
			session: session.name,
			url: session.url,
			snapshot: snapshot.text,
			refs: snapshot.refs.length,
		};
	}
	if (method === "POST" && path === AGENT_BROWSER_ACTION_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserActionRequest
		>(path, await readJsonBody(request));
		return await act(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_WAIT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserWaitRequest
		>(path, await readJsonBody(request));
		const session = await sessionFor(deps, owner, body.session, used);
		const timeoutMs = bounded(
			body.timeoutMs,
			DEFAULT_WAIT_TIMEOUT_MS,
			MAX_WAIT_TIMEOUT_MS,
		);
		const target =
			body.ref !== undefined || body.selector !== undefined
				? {
						...(body.ref === undefined ? {} : { ref: body.ref }),
						...(body.selector === undefined ? {} : { selector: body.selector }),
					}
				: undefined;
		await session.wait({
			...(target ? { target } : {}),
			...(body.text === undefined ? {} : { text: body.text }),
			...(body.url === undefined ? {} : { url: body.url }),
			timeoutMs,
		});
		return { session: session.name, url: session.url, waited: true };
	}
	if (method === "POST" && path === AGENT_BROWSER_EVAL_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserEvalRequest
		>(path, await readJsonBody(request));
		const session = await sessionFor(deps, owner, body.session, used);
		const timeoutMs = bounded(
			body.timeoutMs,
			DEFAULT_WAIT_TIMEOUT_MS,
			MAX_SCRIPT_TIMEOUT_MS,
		);
		const result = await withTimeout(
			session.evaluate(body.code),
			timeoutMs,
			"script-timeout",
			"browser_eval exceeded its timeout; the session is still usable",
		);
		return { session: session.name, result: serializable(result) };
	}
	if (method === "POST" && path === AGENT_BROWSER_CONSOLE_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserLogRequest
		>(path, await readJsonBody(request));
		const session = await sessionFor(deps, owner, body.session, used);
		return {
			session: session.name,
			entries: session.consoleEntries({
				...(body.level === undefined ? {} : { level: body.level }),
				limit: bounded(body.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
			}),
		};
	}
	if (method === "POST" && path === AGENT_BROWSER_NETWORK_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserLogRequest
		>(path, await readJsonBody(request));
		const session = await sessionFor(deps, owner, body.session, used);
		return {
			session: session.name,
			entries: session
				.networkEntries({
					...(body.status === undefined ? {} : { status: body.status }),
					...(body.url === undefined ? {} : { url: body.url }),
					limit: bounded(body.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
				})
				.map(networkEntryValue),
		};
	}
	if (method === "POST" && path === AGENT_BROWSER_SCREENSHOT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserScreenshotRequest
		>(path, await readJsonBody(request));
		return await screenshot(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_RECORD_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserRecordRequest
		>(path, await readJsonBody(request));
		return body.action === "start"
			? await recordStart(deps, owner, used, body)
			: await recordStop(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_SCRIPT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserScriptRequest
		>(path, await readJsonBody(request));
		return await runScript(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_LOGIN_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserStageLoginRequest
		>(path, await readJsonBody(request));
		return await stageLogin(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_LOGIN_WAIT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserStageLoginWaitRequest
		>(path, await readJsonBody(request));
		return await stageLoginWait(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_CLOSE_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserSessionRequest
		>(path, await readJsonBody(request));
		const name = body.session ?? DEFAULT_BROWSER_SESSION;
		// Closing a held session is always allowed, and it aborts the hand-off
		// first: the developer must not be left typing into a context that is about
		// to disappear (`by: "agent"`).
		const held = deps.pool.find(owner, name);
		if (held?.heldByUser) await deps.handoff?.abort(held, "agent");
		const closed = await deps.pool.close(owner, name);
		return { session: name, closed };
	}
	throw new BrowserPoolError("not-found", `unknown browser route ${path}`, 404);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/** The workflow one owner acts as; a browser session belongs to a run. */
function ownerWorkflowId(owner: string): string | undefined {
	const prefix = "workflow:";
	if (!owner.startsWith(prefix)) return undefined;
	const id = owner.slice(prefix.length).trim();
	return id === "" ? undefined : id;
}

/**
 * Resolve what to open.
 *
 * A raw URL is always allowed *for a session that is not stage-bound*: an agent
 * already has a shell and a browser it can point at anything, so refusing a URL
 * there would be theatre. A stage-bound session is different — its allow-list
 * exists to keep a run on one environment — so a raw URL whose origin the stage
 * does not declare is refused with `origin-not-allowed`. An app endpoint is
 * different again: it resolves to another workflow's code, so it is allowed
 * only while *this* workflow holds the app, and the refusal names the holder so
 * the agent learns who to ask instead of retrying.
 */
async function resolveOpenUrl(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/browser.ts").BrowserOpenRequest,
): Promise<{ url: string; app?: string }> {
	if (body.url !== undefined && body.url.trim() !== "")
		return { url: body.url.trim() };
	const app = body.app?.trim();
	const endpoint = body.endpoint?.trim();
	if (!app || !endpoint)
		throw new BrowserPoolError(
			"open-target-required",
			"browser_open needs a url, or an app and endpoint to resolve one",
			400,
		);
	const instances = deps.instances;
	if (!instances)
		throw new BrowserPoolError(
			"instances-unavailable",
			"the environment slot capability is not attached, so an app endpoint cannot be resolved",
			503,
		);
	if (!deps.apps?.getAppByIdent(app))
		throw new BrowserPoolError(
			"app-not-found",
			`app ${JSON.stringify(app)} not found`,
			404,
		);
	const slot = (await instances.slots()).find((entry) => entry.app === app);
	if (!slot)
		throw new BrowserPoolError(
			"app-not-found",
			`app ${JSON.stringify(app)} not found`,
			404,
		);
	if (slot.holder !== owner)
		throw new BrowserPoolError(
			"app-not-held",
			slot.holder
				? `${app} is held by ${slot.holder}; this run does not hold it, so its endpoint is not resolved. Stop it there, or start it here with env_start first.`
				: `${app} is not held by any workflow; start it first with env_start so this run holds it.`,
			409,
		);
	const url = slot.endpoints[endpoint];
	if (!url)
		throw new BrowserPoolError(
			"endpoint-unknown",
			`${app} exports no endpoint ${JSON.stringify(endpoint)}; it exports ${Object.keys(slot.endpoints).join(", ") || "nothing"}`,
			404,
		);
	// Browsing the app is using it: an agent-held app must not be reaped while
	// the run is looking at it.
	instances.touchOwnedActivity(owner, app);
	return { url, app };
}

function clampViewport(
	requested: { width: number; height: number } | undefined,
	fallback: { width: number; height: number },
): { width: number; height: number } {
	if (!requested) return { ...fallback };
	return {
		width: Math.min(4096, Math.max(200, Math.round(requested.width))),
		height: Math.min(4096, Math.max(200, Math.round(requested.height))),
	};
}

async function openSession(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/browser.ts").BrowserOpenRequest,
	used: SessionUse[],
): Promise<unknown> {
	const settings = deps.settings();
	const name = body.session ?? DEFAULT_BROWSER_SESSION;
	// A stage open is resolved from the catalog, and it is the only way to bind a
	// session: an existing session keeps its binding for life.
	const bound = await resolveOpenTarget(deps, owner, body, name);
	// An open navigates, so its page work is its own: the fence is taken here,
	// before the context is created (a session a workflow already holds) or before
	// the first navigation runs (a brand-new one, whose refusal buffer starts
	// empty, so its fence is 0 and every refusal it records is this open's).
	const before = deps.pool.find(owner, name);
	// `browser_open` of a held session name is refused like every other route:
	// the agent cannot reopen, navigate or read the page the developer is on.
	if (before?.heldByUser) throw sessionHeldRefusal(before);
	const fence = before ? before.beginUse() : 0;
	try {
		const session = await deps.pool.acquire({
			owner,
			name,
			viewport: clampViewport(body.viewport, settings.viewport),
			url: bound.url,
			...(bound.app ? { app: bound.app } : {}),
			...(bound.stage ? { stage: bound.stage } : {}),
			// The admission below was skipped because this name already had a session;
			// the pool may then only reuse it. Creating one here would be a context
			// outside the exclusive lease and the stage's session bound.
			...(bound.reuseOnly ? { reuseOnly: true } : {}),
		});
		// The reply carries the refusals the open's own navigation produced, exactly
		// as every other call on the session does. A session the pool had to create
		// is not the one the fence was taken on, and its buffer is fresh.
		used.push({
			session,
			refusalsFrom: session === before ? fence : session.beginUse(),
		});
		return {
			session: session.name,
			url: session.url,
			...(session.app ? { app: session.app } : {}),
			...(session.stage ? { stage: session.stage.ident } : {}),
			viewport: { ...session.viewport },
			sessions: deps.pool.ownedBy(owner).length,
		};
	} finally {
		// The admission is what made this open visible to the stage's lease and to
		// its session bound while the context was being created; from here on the
		// pool's own session count is what holds the slot, on every path.
		bound.admission?.settle();
	}
}

/**
 * The URL one open resolves to, and the stage binding it carries.
 *
 * Three cases, in the order the spec names them: a stage open (resolved from the
 * catalog, with the per-stage session bound and the exclusive lease taken before
 * any context exists), a raw URL or endpoint in an existing stage-bound session
 * (checked against the binding's allow-list), and every other open unchanged.
 */
async function resolveOpenTarget(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/browser.ts").BrowserOpenRequest,
	name: string,
): Promise<{
	url: string;
	app?: string;
	stage?: StageSessionBinding;
	admission?: StageAdmission;
	/** True when the session this open resolves to already exists, so the pool
	 * must reuse it rather than create one without an admission. */
	reuseOnly?: boolean;
}> {
	const existing = deps.pool.find(owner, name);
	const stageIdent = body.stage?.trim();
	if (stageIdent) return resolveStageOpen(deps, owner, body, name, stageIdent);
	const resolved = await resolveOpenUrl(deps, owner, body);
	if (existing?.stage) assertAllowedOrigin(existing.stage, resolved.url);
	return resolved;
}

function resolveStageOpen(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/browser.ts").BrowserOpenRequest,
	name: string,
	ident: string,
): {
	url: string;
	app?: string;
	stage: StageSessionBinding;
	admission?: StageAdmission;
} {
	const entry = stageEntryFor(deps, ident);
	const appKey = body.stageApp?.trim();
	if (!appKey)
		throw new BrowserPoolError(
			"stage-app-unknown",
			`browser_open on stage ${ident} needs a stageApp; the stage declares ${Object.keys(entry.stage.apps).join(", ")}`,
			400,
		);
	const app = entry.stage.apps[appKey];
	if (!app)
		throw new BrowserPoolError(
			"stage-app-unknown",
			`stage ${ident} declares no application ${JSON.stringify(appKey)}; it declares ${Object.keys(entry.stage.apps).join(", ")}`,
			404,
		);
	const existing = deps.pool.find(owner, name);
	if (existing && existing.stage?.ident !== ident)
		throw new BrowserPoolError(
			"stage-mismatch",
			existing.stage
				? `session ${JSON.stringify(name)} is bound to stage ${existing.stage.ident}; a session cannot be re-bound to ${ident}`
				: `session ${JSON.stringify(name)} already exists and is not stage-bound; close it first, or open stage ${ident} under a fresh session name`,
			409,
		);
	const url = joinStagePath(app.url, body.path);
	const bearer = bearerScopes(entry);
	const binding: StageSessionBinding = {
		ident: entry.ident,
		access: entry.stage.access,
		origins: entry.origins,
		readOnlyExceptions: entry.stage.readOnlyExceptions ?? [],
		limits: entry.limits,
		// The origins this session's requests are authenticated for, from the
		// roles that declared them (`add-stage-oauth2-auth`, task 3.3), and the
		// origins a request may be issued *from* to receive one: a foreign-origin
		// document inside this session never gets a stage role's token (SEC-002).
		...(bearer.length === 0 ? {} : { bearer, initiators: [...entry.origins] }),
	};
	assertAllowedOrigin(binding, url);
	// The bounds and the lease are claimed before a context exists, and only for a
	// genuinely new session: re-opening the session a workflow already has on the
	// stage must not count it twice. The admission is what the caller settles once
	// the open has finished, so the stage counts as held for the whole of it.
	const admission = existing
		? undefined
		: stageUsage(deps).open({
				stage: entry.ident,
				exclusive: entry.stage.exclusive === true,
				maxSessions: entry.limits.maxSessions,
				owner,
			});
	return {
		url,
		...(app.app ? { app: app.app } : { app: appKey }),
		stage: binding,
		...(admission ? { admission } : {}),
		...(existing ? { reuseOnly: true } : {}),
	};
}

/** One stage application's URL, with the optional path appended. */
function joinStagePath(base: string, suffix: string | undefined): string {
	const extra = suffix?.trim();
	if (!extra) return base;
	try {
		return new URL(extra, base).toString();
	} catch {
		throw new BrowserPoolError(
			"origin-not-allowed",
			`${JSON.stringify(extra)} is not a path this stage's ${base} can be opened at`,
			400,
		);
	}
}

/** Refuse a URL a stage-bound session must not navigate to. */
function assertAllowedOrigin(binding: StageSessionBinding, url: string): void {
	let origin: string | undefined;
	try {
		origin = new URL(url).origin;
	} catch {
		origin = undefined;
	}
	if (origin && binding.origins.includes(origin)) return;
	throw new BrowserPoolError(
		"origin-not-allowed",
		`${sanitizeStageUrl(url)} is not in stage ${binding.ident}'s origin allow-list (${binding.origins.join(", ")})`,
		403,
	);
}

/** One allow-listed stage of this request's catalog. An unknown ident and an
 * excluded one answer the same code, with the exclusion reason when there is
 * one — a refused stage file must never be silently absent. */
function stageEntryFor(deps: BrowserRouteDeps, ident: string): StageEntry {
	const catalog = stageCatalog(deps);
	const entry = stageByIdent(catalog, ident);
	if (entry) return entry;
	const reason = stageRefusalReason(catalog, ident);
	throw new BrowserPoolError(
		"stage-not-configured",
		`stage ${ident} is not configured in ${catalog.defsDir}\n${reason}`,
		404,
	);
}

async function sessionFor(
	deps: BrowserRouteDeps,
	owner: string,
	name: string | undefined,
	used: SessionUse[],
	options: {
		readonly countAction?: boolean;
		/** `stage_login`, `stage_login_wait` and `browser_close` are the only
		 * routes a held session still answers: rejoining, waiting and aborting. */
		readonly allowHeld?: boolean;
	} = {},
): Promise<BrowserSession> {
	const session = deps.pool.session(owner, name ?? DEFAULT_BROWSER_SESSION);
	// In flight for the whole request: the idle sweep must not close this page
	// while a tool is still driving it. The fence the use answers with is where
	// this call's own refusals start.
	used.push({ session, refusalsFrom: session.beginUse() });
	// The recording bound is enforced where a session is used, not by a timer: a
	// recording that outlived it is discarded before anything else happens. The
	// pool serializes this with an explicit stop, so two concurrent requests
	// cannot both stop the same recording.
	await deps.pool.autoStopIfExpired(session);
	// The hold is checked *before* the stage's rolling minute is charged: a
	// refusal because the developer is logging in is not an action of the run.
	if (session.heldByUser && options.allowHeld !== true)
		throw sessionHeldRefusal(session);
	// One browser call on a stage is one action of the stage's rolling minute.
	if (options.countAction !== false && session.stage)
		stageUsage(deps).countAction({
			stage: session.stage.ident,
			owner,
			maxActionsPerMinute: session.stage.limits.maxActionsPerMinute,
		});
	return session;
}

// ---------------------------------------------------------------------------
// Stage login
// ---------------------------------------------------------------------------

/**
 * `stage_login`: run one role's declared recipe on a stage-bound session.
 *
 * The route carries names only — the server resolves every credential reference
 * itself, at call time — so neither the request, the response, the tool result
 * nor a log line ever holds a value. The one exception the spec names is an
 * application without roles, which answers `login-not-required`.
 */
async function stageLogin(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserStageLoginRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used, {
		allowHeld: true,
	});
	const binding = session.stage;
	if (!binding)
		throw new BrowserSessionError(
			"stage-session-restricted",
			"this session is not stage-bound, so it has no declared login recipe",
			409,
		);
	const entry = stageEntryFor(deps, binding.ident);
	// 1. Recording first, before any hand-off is considered (spec trigger order):
	// a credential must never reach a video.
	if (session.recording)
		throw new BrowserSessionError(
			"recording-active",
			"this session is recording; stop the recording before logging in, so a credential is never written to a video",
			409,
		);
	// 2. A second `stage_login` on a held session rejoins the pending hand-off;
	// it never starts a second one.
	const pending = deps.handoff?.pending(session);
	if (pending)
		return { session: session.name, login: "needs-user", ...pending };

	// The role's facts come from the same view `stage_info` reports, so the
	// decision here and the mode the plan sees can never disagree.
	const view = stageView(entry, deps.configDir ?? "");
	const appView = view.apps.find((candidate) => candidate.key === body.app);
	const roleView = appView?.roles.find(
		(candidate) => candidate.role === body.role,
	);
	const recipe =
		roleView?.login === undefined
			? undefined
			: entry.stage.logins?.[roleView.login];
	// 2b. The `oauth2` recipe (`add-stage-oauth2-auth`, task 3.4): this server
	// obtains a token from the provider itself, so there is no page to type into,
	// no window to open and nothing a person could add. The answer is `ok` the
	// moment an access token exists — and a refusal is the token path's own code:
	// `credential-missing` names the unset variable, `login-failed` carries the
	// provider's error code. The token value never leaves this call.
	if (roleView?.loginKind === "oauth2") {
		// The one grant that needs a person is the hand-off's
		// (`add-stage-oauth2-code-pkce`): PKCE, a single-use loopback receiver and
		// the developer's sign-in in the window the hand-off already opens.
		if (roleView.grant === "authorization_code") {
			// The login mode is the value `stage_info` reports (`roleLoginMode`), so the
			// plan an agent reads and this call can never disagree (D3): a policy that
			// forbids the window and a client id that is not set are both refusals
			// *here*, before a window, an attention record or a receiver exists.
			const mode = roleLoginMode({
				recipeKind: roleView.loginKind,
				grant: roleView.grant,
				credentialStatus: roleView.credentialStatus,
				interactiveLogin: entry.interactiveLogin,
			});
			if (mode !== "handoff")
				throw new BrowserSessionError(
					entry.interactiveLogin === "never"
						? "login-user-unavailable"
						: "credential-missing",
					entry.interactiveLogin === "never"
						? `${body.app}.${body.role} can only be logged in by a person, and stages/policy.json sets interactiveLogin to "never"`
						: `${body.app}.${body.role} signs in with the authorization_code grant, which needs a client id; stage_info names the unset variable`,
					409,
				);
			return await startAuthorizationCodeHandoff({
				deps,
				session,
				entry,
				appKey: body.app,
				appLabel: appView?.label ?? body.app,
				appUrl: appView?.url ?? entry.stage.apps[body.app]?.url ?? "",
				role: body.role,
			});
		}
		try {
			await roleToken(
				{
					stage: entry.stage,
					appKey: body.app,
					role: body.role,
					configDir: deps.configDir ?? "",
				},
				browserTokenStore(deps),
				{ ...(deps.now ? { now: deps.now } : {}) },
			);
		} catch (error) {
			if (error instanceof StageAuthError)
				// The same code and status the declared recipes answer a `.env` gap
				// with: one surface, one meaning for `credential-missing`.
				throw new BrowserSessionError(
					error.code,
					error.message,
					error.code === "credential-missing" ? 409 : 502,
				);
			throw error;
		}
		return {
			session: session.name,
			stage: entry.ident,
			login: "ok",
			via: "token",
			url: sanitizeStageUrl(session.url),
		};
	}
	// A `http-basic` role never hands off: the browser's own authentication dialog
	// does not appear in a window this server launched (spike 0.2, D10), so the
	// automated path keeps the foundation's `credential-missing` answer instead of
	// sending a developer to a window that cannot ask for anything.
	const needsPerson =
		roleView !== undefined &&
		roleView.login !== undefined &&
		roleView.loginKind !== "http-basic" &&
		(roleView.loginKind === "interactive" ||
			roleView.credentialStatus !== "set");
	const reason =
		roleView?.loginKind === "interactive"
			? "unautomatable-step"
			: "no-credentials";

	// 3. The silent SSO check, *before* any hand-off is queued (spec trigger
	// order, D2): a session that already lives in the interactive browser may hold
	// a login another app on the same IdP can use, and reusing it is not a
	// hand-off.
	if (
		entry.interactiveLogin === "local" &&
		session.browserSlot === "interactive" &&
		recipe?.success !== undefined &&
		appView
	) {
		const reused = await silentLoginCheck({
			session,
			recipe,
			url: appView.url,
			timeoutMs: SILENT_SSO_CHECK_MS,
			...(deps.now ? { now: deps.now } : {}),
		});
		if (reused)
			return {
				session: session.name,
				stage: entry.ident,
				login: "ok",
				via: "existing-session",
				verified: true,
				url: sanitizeStageUrl(session.url),
			};
	}

	// 4. The interactive-login policy decides who may be asked (D7).
	if (
		needsPerson &&
		entry.interactiveLogin === "local" &&
		appView &&
		roleView
	) {
		return await startHandoff({
			deps,
			owner,
			session,
			entry,
			appKey: body.app,
			appLabel: appView.label,
			appUrl: appView.url,
			role: body.role,
			reason,
			...(recipe === undefined ? {} : { recipe }),
		});
	}
	if (needsPerson && entry.interactiveLogin === "never") {
		// A missing variable still names itself (the foundation's answer); a role
		// that declares nothing this server could ever use, or one whose login can
		// only be performed by a person, is refused as a policy matter.
		if (
			roleView?.loginKind === "interactive" ||
			roleView?.credentialStatus === "none"
		)
			throw new BrowserSessionError(
				"login-user-unavailable",
				`${body.app}.${body.role} can only be logged in by a person, and stages/policy.json sets interactiveLogin to "never"`,
				409,
			);
	}

	// 5. The automated recipe, unchanged. Under `local`, an MFA step the recipe
	// cannot answer is what triggers an `unautomatable-step` hand-off.
	let result: Awaited<ReturnType<typeof runStageLogin>>;
	try {
		result = await withoutCredentialEcho(
			async () =>
				await runStageLogin({
					session,
					entry,
					appKey: body.app,
					role: body.role,
					configDir: deps.configDir ?? "",
					installHttpCredentials: async (credentials) => {
						await deps.pool.setHttpCredentials(session, credentials);
					},
					...(deps.now ? { now: deps.now } : {}),
				}),
		);
	} catch (error) {
		const mfa =
			error instanceof BrowserSessionError &&
			error.code === "login-mfa-required";
		if (mfa && entry.interactiveLogin === "local" && appView && roleView)
			return await startHandoff({
				deps,
				owner,
				session,
				entry,
				appKey: body.app,
				appLabel: appView.label,
				appUrl: appView.url,
				role: body.role,
				reason: "unautomatable-step",
				...(recipe === undefined ? {} : { recipe }),
			});
		throw error;
	}
	return {
		session: session.name,
		stage: entry.ident,
		url: result.url,
		steps: result.steps,
		...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
		...(result.notRequired
			? { login: "not-required", code: "login-not-required" }
			: { login: "ok" }),
	};
}

/**
 * Start (or rejoin) one login hand-off (task 3.2).
 *
 * The headed capability is checked *before* anything is queued, so a machine
 * that cannot show a window never opens one and never raises an attention
 * record. Everything after that is queued in the server, and `stage_login`
 * answers the non-terminal `login-needs-user` immediately.
 */
async function startHandoff(input: {
	readonly deps: BrowserRouteDeps;
	readonly owner: string;
	readonly session: BrowserSession;
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly appLabel: string;
	readonly appUrl: string;
	readonly role: string;
	readonly reason: "no-credentials" | "unautomatable-step" | "user-identity";
	readonly recipe?: StageLoginRecipe;
}): Promise<unknown> {
	const { deps, session, entry } = input;
	const handoff = requireHandoff(deps);
	const label = entry.stage.displayName;
	const status = await handoff.request({
		session,
		stage: entry.ident,
		stageLabel: label,
		app: input.appKey,
		appLabel: input.appLabel,
		role: input.role,
		reason: input.reason,
		loginUrl: input.appUrl,
		recipe: input.recipe ?? { kind: "form" },
		maxSeconds: entry.limits.maxLoginHandoffSeconds,
		description: `Log in to ${input.appLabel} as ${input.role} on stage ${label}`,
		context: handoffContext(input.reason, input.appUrl, label),
	});
	return { session: session.name, login: "needs-user", ...status };
}

/**
 * The hand-off coordinator, or the refusal a machine without a window answers.
 *
 * Checked *before* anything is queued, so a machine that cannot show a window
 * never opens one and never raises an attention record.
 */
function requireHandoff(deps: BrowserRouteDeps): LoginHandoffCoordinator {
	const handoff = deps.handoff;
	if (!handoff)
		throw new BrowserPoolError(
			"login-handoff-unavailable",
			"this server has no login hand-off capability attached",
			503,
			"headless-only-browser",
		);
	const available = handoff.available();
	if (!available.ok)
		throw new BrowserPoolError(
			"login-handoff-unavailable",
			available.reason === "no-display"
				? "this platform has no display, so a login window cannot be shown"
				: "no browser that can show a window is installed: install Chromium from Settings → Browser (Browser → Install)",
			503,
			available.reason,
		);
	return handoff;
}

/**
 * Start (or rejoin) one `authorization_code` hand-off
 * (`add-stage-oauth2-code-pkce`, task 2.1).
 *
 * The login is the hand-off's: the same record, window, session lock and
 * deadline, and no mechanism of its own. What this adds is the flow behind it —
 * PKCE, `state` and the single-use loopback receiver — and the one origin the
 * window has to be allowed to reach when the provider redirects back. The
 * receiver is released on every ending path, including a failed request, so a
 * login that never starts leaves no port bound.
 */
async function startAuthorizationCodeHandoff(input: {
	readonly deps: BrowserRouteDeps;
	readonly session: BrowserSession;
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly appLabel: string;
	readonly appUrl: string;
	readonly role: string;
}): Promise<unknown> {
	const { deps, session, entry } = input;
	const label = entry.stage.displayName;
	// The caller has already checked the role's login mode — a policy that forbids
	// the window, or a client id that is not set, was refused before this function
	// was reached — so everything from here on opens machinery that a `handoff`
	// can complete.
	const handoff = requireHandoff(deps);
	let flow: Awaited<ReturnType<typeof beginAuthorizationCodeLogin>>;
	try {
		flow = await beginAuthorizationCodeLogin(
			{
				stage: entry.stage,
				appKey: input.appKey,
				role: input.role,
				configDir: deps.configDir ?? "",
			},
			browserTokenStore(deps),
			{
				...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
				...(deps.now === undefined ? {} : { now: deps.now }),
			},
		);
	} catch (error) {
		if (error instanceof StageAuthError)
			throw new BrowserSessionError(
				error.code,
				error.message,
				error.code === "credential-missing" ? 409 : 502,
			);
		throw error;
	}
	// The window has to be allowed to land on the loopback callback before the
	// activation starts; the hand-off's own teardown takes the allowance away
	// again on every ending path.
	deps.pool.allowHandoffRedirect(session, flow.redirectOrigin);
	const release = (): void => {
		deps.pool.clearHandoffRedirect(session, flow.redirectOrigin);
		flow.close();
	};
	try {
		const { status, owned } = await handoff.requestOwned({
			session,
			stage: entry.ident,
			stageLabel: label,
			app: input.appKey,
			appLabel: input.appLabel,
			role: input.role,
			// Nothing is missing and no step failed: the identity at the provider is
			// the developer's own, which is what this role is configured for
			// (USAB-202).
			reason: "user-identity",
			loginUrl: flow.authorizationUrl,
			recipe: { kind: "interactive" },
			maxSeconds: entry.limits.maxLoginHandoffSeconds,
			description: `Log in to ${input.appLabel} as ${input.role} on stage ${label}`,
			context: authorizationCodeContext(flow.authorizationUrl, label),
			completion: {
				poll: flow.poll,
				url: sanitizeStageUrl(input.appUrl),
				close: release,
				land: async () => {
					if (input.appUrl === "") return;
					await session.goto(input.appUrl, DEFAULT_ACTION_TIMEOUT_MS);
				},
			},
		});
		if (!owned) {
			// Another call's hand-off is the pending one: this call's receiver and
			// allowance are nobody's, so they go now instead of listening on until the
			// other hand-off ends (PERF-001). Its allowance is its own origin, so the
			// hand-off that did take the login keeps its own.
			release();
			return { session: session.name, login: "needs-user", ...status };
		}
		return { session: session.name, login: "needs-user", ...status };
	} catch (error) {
		release();
		throw error;
	}
}

/** The attention record's words for a code-grant hand-off: the provider's own
 * origin (never the authorization URL, its `state` or its challenge), what the
 * developer does there, and how the hand-off ends. */
function authorizationCodeContext(
	authorizationUrl: string,
	stageLabel: string,
): string {
	return [
		"Reason: this role signs in with a person's own identity at the provider.",
		`The agent is waiting for ${stageLabel}. Sign in inside the browser window agentic-coding opened for ${originOnly(authorizationUrl)} — do not type into the terminal.`,
		"The hand-off ends by itself as soon as the provider redirects back to this server; Abort ends it without a token, and closing the window aborts it.",
	].join(" ");
}

/** The attention record's context: the reason, the window to look for and how
 * the hand-off ends. The application's *origin* is the only URL in it (D5). The
 * queue position and the deadline are appended by the coordinator, which is the
 * only place that knows them (USAB-101, USAB-102), and the key name is left to
 * the modal footer, which owns keybinds (USAB-104). */
function handoffContext(
	reason: string,
	appUrl: string,
	stageLabel: string,
): string {
	const origin = originOnly(appUrl);
	return [
		`Reason: ${reason === "no-credentials" ? "this role declares no credentials this server can use" : "the login needs a step this server cannot automate"}.`,
		`The agent is waiting for ${stageLabel}. Sign in inside the browser window agentic-coding opened for ${origin} — do not type into the terminal.`,
		"Choose Done when the application has loaded, or Abort to end the hand-off and let the agent continue without a login.",
		"Closing the window aborts the hand-off.",
	].join(" ");
}

/** Just the origin of a configured URL; an unparseable one reports nothing. */
function originOnly(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "the application";
	}
}

/**
 * `stage_login_wait`: block in the server while a hand-off is pending.
 *
 * It answers either the non-terminal `login-needs-user` again (the agent calls
 * it once more) or one terminal outcome. Each call counts as one stage action,
 * which is why the agent waits *inside* the tool instead of spending a turn per
 * poll (D3).
 */
async function stageLoginWait(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserStageLoginWaitRequest,
): Promise<unknown> {
	const handoff = deps.handoff;
	if (!handoff)
		throw new BrowserPoolError(
			"login-handoff-unavailable",
			"this server has no login hand-off capability attached",
			503,
			"headless-only-browser",
		);
	// A hand-off that has already ended is answered from its recorded outcome
	// *before* the session is resolved: a deadline closes the window, which makes
	// the session unusable and the pool refuses to hand it out, so the run would
	// otherwise meet `browser-crashed` instead of learning how its login ended
	// (SEC-002).
	const name = body.session ?? DEFAULT_BROWSER_SESSION;
	const recorded = handoff.recordedOutcome(owner, name);
	if (recorded) return terminalLoginAnswer(recorded, name);
	const session = await sessionFor(deps, owner, body.session, used, {
		allowHeld: true,
	});
	const capMs = Math.min(
		Math.max(1, (body.timeoutSec ?? HANDOFF_MAX_WAIT_MS / 1_000) * 1_000),
		HANDOFF_MAX_WAIT_MS,
	);
	const waited = await handoff.wait(session, capMs);
	const stage = session.stage?.ident;
	if (waited.status)
		return {
			session: session.name,
			...(stage ? { stage } : {}),
			login: "needs-user",
			...waited.status,
		};
	return terminalLoginAnswer(waited.outcome, session.name, stage);
}

/** How one ended hand-off is answered, whether it was waited for or read back
 * from the outcome still recorded for its session. `stage` is unknown on the
 * read-back path: a session whose window the deadline closed is not readable
 * any more, and the outcome is what the run needs. */
function terminalLoginAnswer(
	outcome: LoginHandoffOutcome,
	sessionName: string,
	stage?: string,
): unknown {
	const named = { session: sessionName, ...(stage ? { stage } : {}) };
	switch (outcome.outcome) {
		case "ok":
			return {
				...named,
				login: "ok",
				via: outcome.via,
				verified: outcome.verified,
				url: outcome.url,
			};
		case "unverified":
			throw new BrowserSessionError(
				"login-handoff-unverified",
				"the developer chose Done, but the recipe's success condition did not hold within its grace period; the session is logged in only as far as the window shows",
				409,
				undefined,
				{ url: outcome.url },
			);
		case "timeout":
			throw new BrowserSessionError(
				"login-handoff-timeout",
				`the login hand-off was not completed before ${outcome.deadlineAt}, so its window was closed`,
				408,
				undefined,
				{ deadlineAt: outcome.deadlineAt },
			);
		case "aborted":
			throw new BrowserSessionError(
				"login-handoff-aborted",
				abortMessage(outcome.by),
				409,
				undefined,
				{ by: outcome.by },
			);
		case "failed": {
			// The code grant's own value-free refusal (`add-stage-oauth2-code-pkce`):
			// a `state` mismatch, a provider's `error`, or an exchange the token
			// endpoint refused. The code, the verifier and the tokens are not part of
			// it, and neither is the callback URL.
			const error = outcome.error;
			if (error instanceof StageAuthError)
				throw new BrowserSessionError(
					error.code,
					error.message,
					error.code === "credential-missing" ? 409 : 502,
				);
			throw new BrowserSessionError(
				"login-failed",
				"the sign-in ended without a token; nothing of the attempt is reported",
				502,
			);
		}
		case "unavailable":
			throw new BrowserPoolError(
				"login-handoff-unavailable",
				"the interactive browser could not be launched for this hand-off",
				503,
				"launch-failed",
			);
	}
}

function abortMessage(by: string): string {
	switch (by) {
		case "developer":
			return "the developer aborted the login hand-off";
		case "agent":
			return "the agent closed the held session, which aborted the login hand-off";
		case "window-closed":
			return "the developer closed the login window, which aborted the hand-off";
		default:
			return "the run ended while the login hand-off was pending, which aborted it";
	}
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserActionRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const target = {
		...(body.ref === undefined ? {} : { ref: body.ref }),
		...(body.selector === undefined ? {} : { selector: body.selector }),
	};
	const timeoutMs = bounded(body.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 60_000);
	switch (body.action) {
		case "click":
			await session.click(target, timeoutMs);
			break;
		case "fill": {
			// A stage-bound session can be handed a credential *reference* instead of a
			// value: the server resolves it, types it, and reports nothing of it.
			const credential = body.credential;
			if (credential) {
				const binding = session.stage;
				if (!binding)
					throw new BrowserSessionError(
						"stage-session-restricted",
						"browser_fill with a credential needs a stage-bound session; pass a value instead",
						409,
					);
				await withoutCredentialEcho(() =>
					fillStageCredential({
						session,
						entry: stageEntryFor(deps, binding.ident),
						appKey: credential.app,
						role: credential.role,
						field: credential.field,
						target,
						timeoutMs,
						configDir: deps.configDir ?? "",
					}),
				);
				break;
			}
			if (body.value === undefined)
				throw new BrowserPoolError(
					"value-required",
					"browser_fill needs a value, or a credential on a stage-bound session",
					400,
				);
			await session.fill(target, body.value, timeoutMs);
			break;
		}
		case "press":
			if (!body.key)
				throw new BrowserPoolError(
					"key-required",
					"browser_press needs a key",
					400,
				);
			await session.press(body.key, target, timeoutMs);
			break;
		case "select":
			if (!body.values || body.values.length === 0)
				throw new BrowserPoolError(
					"value-required",
					"browser_select needs at least one value",
					400,
				);
			await session.select(target, body.values, timeoutMs);
			break;
		case "hover":
			await session.hover(target, timeoutMs);
			break;
	}
	return {
		session: session.name,
		action: body.action,
		url: session.url,
		title: await session.title().catch(() => ""),
	};
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function screenshot(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserScreenshotRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const bytes = await session.screenshot(
		{
			type: "jpeg",
			quality: SCREENSHOT_QUALITY,
			fullPage: body.fullPage ?? false,
			...(body.ref === undefined ? {} : { ref: body.ref }),
			...(body.selector === undefined ? {} : { selector: body.selector }),
		},
		BROWSER_MAX_IMAGE_WIDTH,
	);
	const value: Record<string, unknown> = {
		session: session.name,
		url: session.url,
		mediaType: "image/jpeg",
		base64: Buffer.from(bytes).toString("base64"),
		bytes: bytes.byteLength,
	};
	if (body.evidence === true) {
		// The stored entry carries a sanitized URL, and a caption that embeds one
		// carries the same: an evidence entry outlives the call that made it.
		const url = evidenceUrl(deps, session.url);
		const entry = await storeEvidence(deps, owner, {
			bytes,
			kind: "screenshot",
			caption: body.caption?.trim() || `Screenshot of ${url}`,
			url,
			extension: "jpg",
			...(session.app ? { app: session.app } : {}),
		});
		value.evidence = entry;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

async function recordStart(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserRecordRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const scope = evidenceScope(deps, owner);
	// Each recording owns its directory: discarding one can then never remove the
	// WebM another session is still writing.
	const parent = path.join(scope.dataRoot, EVIDENCE_SCRATCH_DIR, "video");
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	const dir = fs.mkdtempSync(path.join(parent, "recording-"));
	try {
		const started = await deps.pool.startRecording(session, { dir });
		return {
			session: session.name,
			recording: true,
			url: started.url,
			startedAt: new Date(started.startedAt).toISOString(),
		};
	} catch (error) {
		// A start that failed owns nothing: the directory it created is removed
		// rather than left behind as an empty recording. Asynchronous, because a
		// failed start (a session that was closed under it, a browser that went
		// away) must not block the event loop on a recursive remove.
		await fs.promises
			.rm(dir, { recursive: true, force: true })
			.catch(() => undefined);
		throw error;
	}
}

async function recordStop(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserRecordRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const keep = body.keep === true;
	if (!session.recording)
		throw new BrowserPoolError(
			"recording-not-active",
			"this session is not recording, so there is nothing to stop",
			409,
		);
	const scope = keep ? evidenceScope(deps, owner) : undefined;
	// `mkdtemp` creates the directory exclusively, so two stops landing in the
	// same millisecond cannot share — and then delete — each other's files.
	const parent = path.join(
		scope?.dataRoot ?? os.tmpdir(),
		EVIDENCE_SCRATCH_DIR,
		"capture",
	);
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	const scratch = fs.mkdtempSync(path.join(parent, "stop-"));
	// The scratch directory is owned by this call and removed on every exit,
	// including the refusal a concurrent stop produces.
	try {
		return await finishRecordingStop(deps, owner, session, body, {
			posterPath: path.join(scratch, "poster.jpg"),
			videoPath: path.join(scratch, "recording.webm"),
		});
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** The body of one `record_stop`, with the caller owning the scratch directory. */
async function finishRecordingStop(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	body: import("../../contracts/browser.ts").BrowserRecordRequest,
	paths: {
		readonly posterPath: string;
		readonly videoPath: string;
	},
): Promise<unknown> {
	const keep = body.keep === true;
	// A kept recording needs somewhere to go: this refuses a workflow that is
	// nowhere recorded *before* the recording is stopped and discarded.
	if (keep) evidenceScope(deps, owner);
	const posterPath = paths.posterPath;
	const videoPath = paths.videoPath;
	const result = await deps.pool.stopRecording(
		session,
		keep ? { posterPath, videoPath } : undefined,
	);
	if (!keep || !result.videoSaved) {
		if (!keep)
			return {
				session: session.name,
				keeper: false,
				video: false,
				notice:
					"the recording was discarded; no video and no evidence entry were kept",
			};
		throw new BrowserPoolError(
			"recording-empty",
			"the recording produced no video file, so nothing was kept",
			500,
		);
	}
	const url = evidenceUrl(deps, result.url);
	const caption = body.caption?.trim() || `Recording of ${url}`;
	const poster = result.posterSaved
		? await storeEvidence(deps, owner, {
				file: posterPath,
				kind: "screenshot",
				caption: `${caption} (final frame)`,
				url,
				extension: "jpg",
				...(session.app ? { app: session.app } : {}),
			})
		: undefined;
	const video = await storeEvidence(deps, owner, {
		file: videoPath,
		kind: "video",
		caption,
		url,
		extension: "webm",
		...(session.app ? { app: session.app } : {}),
		...(poster ? { poster: poster.id } : {}),
	});
	return {
		session: session.name,
		kept: true,
		video,
		...(poster ? { poster } : {}),
		...(result.autoStopped
			? {
					notice:
						"the recording reached its maximum length and was closed at the limit",
				}
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/** The one shape a scripted page is handed: its own page and context, and an
 * `expect`. Nothing else of the server is reachable from the body. */
type AsyncScript = (
	page: unknown,
	context: unknown,
	expect: unknown,
) => Promise<unknown>;

async function runScript(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserScriptRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const timeoutMs = bounded(
		body.timeoutMs,
		DEFAULT_SCRIPT_TIMEOUT_MS,
		MAX_SCRIPT_TIMEOUT_MS,
	);
	let script: AsyncScript;
	try {
		// The agent's own code. It is trusted — an agent already holds a shell and
		// the server's globals are reachable from any `Function` body — so this is
		// a *guard*, not a sandbox: the script receives this session's page and
		// context, and the browser object that would let it enumerate and drive
		// every other run's contexts is refused.
		const AsyncFunction = Object.getPrototypeOf(async () => {})
			.constructor as new (
			...args: string[]
		) => AsyncScript;
		script = new AsyncFunction("page", "context", "expect", body.code);
	} catch (error) {
		throw new BrowserPoolError(
			"script-invalid",
			`the script is not valid JavaScript: ${message(error)}`,
			400,
		);
	}
	let result: unknown;
	const handles = scriptHandles(session);
	try {
		result = await withTimeout(
			script(handles.page, handles.context, createScriptExpect()),
			timeoutMs,
			"script-timeout",
			`browser_run_script exceeded ${timeoutMs} ms and was abandoned; the session is still usable`,
		);
	} finally {
		// Nothing to unwind: the script holds only the session's page, which
		// survives a timeout by design.
	}
	const value: Record<string, unknown> = {
		session: session.name,
		url: session.url,
		result: serializable(result),
	};
	if (body.save === true) {
		// The spec text is built from the *sanitized* URL and then redacted before
		// it is stored: an evidence entry is written to disk and read long after the
		// call, so a callback token in the URL the script ran on must be gone before
		// the file exists, not only from the reply.
		const url = evidenceUrl(deps, session.url);
		const spec = redact(
			reproSpec(body.code, url, {
				...(session.stage
					? {
							credentialVariables: stageCredentialNames(
								deps.configDir ?? "",
								session.stage.ident,
							),
						}
					: {}),
			}),
			redactionSecrets(deps),
		);
		const entry = await storeEvidence(deps, owner, {
			text: typeof spec === "string" ? sanitizeUrlsIn(spec) : "",
			kind: "script",
			caption: body.caption?.trim() || `Repro spec for ${url}`,
			url,
			extension: "spec.ts",
			...(session.app ? { app: session.app } : {}),
		});
		value.evidence = entry;
	}
	return value;
}

/**
 * The page and context one `browser_run_script` body receives.
 *
 * One Chromium serves every run, so a raw Playwright handle is a path from a
 * script into *other* runs' sessions: `context.browser()` reaches the single
 * browser, and `context.pages()` reaches the raw pages the guard was meant to
 * protect. A deny-list cannot hold — every raw object handed back carries
 * further unenumerated references — so the handles are an **allow-list facade**:
 *
 * * only the named operations exist, and each one is a bound function over the
 *   real object;
 * * every result is sanitized: a page or context becomes the session's own
 *   facade, a locator becomes a locator facade, an array is mapped, and anything
 *   else (a string, a number, a serialized `evaluate` result, a screenshot
 *   buffer) passes through;
 * * the facades are frozen, so a script can neither add an escape hatch nor
 *   replace a method.
 *
 * This is a guard against the ordinary Playwright path, not a sandbox: a script
 * body still runs with the server process's globals, which the tool's own
 * documentation says and which is why the tool is only offered to runs that
 * already hold a shell.
 *
 * A facade is a `Proxy` over the frozen allow-list, so a method that is not on
 * the list *fails with the list* instead of arriving as `undefined` and being
 * discovered as `TypeError: page.waitForFunction is not a function` — the
 * failure mode that cost an end-to-end debug run a whole call
 * (`fix-env-tool-defects-from-e2e`).
 */
const PAGE_METHODS = [
	"goto",
	"reload",
	"goBack",
	"goForward",
	"url",
	"title",
	"content",
	"setViewportSize",
	"viewportSize",
	"waitForLoadState",
	"waitForURL",
	"waitForTimeout",
	"waitForSelector",
	"waitForFunction",
	"click",
	"fill",
	"press",
	"selectOption",
	"hover",
	"textContent",
	"innerText",
	"inputValue",
	"isVisible",
	"isEnabled",
	"screenshot",
	"evaluate",
	"locator",
	"getByRole",
	"getByText",
	"getByLabel",
	"getByPlaceholder",
	"getByTestId",
	"getByTitle",
	"getByAltText",
] as const;

const CONTEXT_METHODS = [
	"newPage",
	"pages",
	"cookies",
	"addCookies",
	"clearCookies",
	"storageState",
	"setDefaultTimeout",
	"setDefaultNavigationTimeout",
	"waitForTimeout",
] as const;

const LOCATOR_METHODS = [
	"click",
	"dblclick",
	"check",
	"uncheck",
	"fill",
	"clear",
	"press",
	"pressSequentially",
	"type",
	"selectOption",
	"hover",
	"focus",
	"textContent",
	"innerText",
	"inputValue",
	"getAttribute",
	"isVisible",
	"isHidden",
	"isEnabled",
	"isDisabled",
	"isEditable",
	"isChecked",
	"count",
	"boundingBox",
	"allTextContents",
	"allInnerTexts",
	"waitFor",
	"screenshot",
	"evaluate",
	"nth",
	"first",
	"last",
	"locator",
	"getByRole",
	"getByText",
	"getByLabel",
	"getByPlaceholder",
	"getByTestId",
	"getByTitle",
	"getByAltText",
] as const;

const KEYBOARD_METHODS = ["press", "type", "insertText", "down", "up"] as const;
const MOUSE_METHODS = ["move", "click", "down", "up", "wheel"] as const;

/** The largest `page.content()` a script receives. Real app HTML is unbounded,
 * so the value is cut rather than handed to the model whole. */
export const MAX_SCRIPT_CONTENT_CHARS = 20_000;

/** The bounds a facade method's own result carries, by method name. Only the
 * reads whose result grows with the page are bounded; everything else is data
 * the script asked for and passes through `wrap` unchanged. */
const PAGE_RESULT_BOUNDS: Record<string, number> = {
	content: MAX_SCRIPT_CONTENT_CHARS,
};

/** The method names one facade exposes, as an error message lists them. */
function supportedMethods(
	names: readonly string[],
	extras: Record<string, unknown>,
): string {
	return [...names, ...Object.keys(extras)].sort().join(", ");
}

/** A Playwright page: it navigates and it can build locators. A locator has
 * `click`/`fill` too, which is why the page test has to come first. */
function isPageLike(value: object): boolean {
	const candidate = value as {
		goto?: unknown;
		locator?: unknown;
		url?: unknown;
	};
	return (
		typeof candidate.goto === "function" &&
		typeof candidate.locator === "function" &&
		typeof candidate.url === "function"
	);
}

/** A Playwright browser context: it opens pages and holds cookies. */
function isContextLike(value: object): boolean {
	const candidate = value as { newPage?: unknown; cookies?: unknown };
	return (
		typeof candidate.newPage === "function" &&
		typeof candidate.cookies === "function"
	);
}

/** A Playwright locator: it carries `click` and `fill` but does not navigate. */
function isLocatorLike(value: object): boolean {
	const candidate = value as { click?: unknown; fill?: unknown };
	return (
		!isPageLike(value) &&
		typeof candidate.click === "function" &&
		typeof candidate.fill === "function"
	);
}

/** The context methods a stage-bound session refuses a script (`task 3.7`): the
 * session's own cookies and storage are how a login's identity is carried, and
 * an agent that read them out would be reading a credential by another name. */
const STAGE_CONTEXT_RESTRICTED: Record<string, string> = {
	cookies: "stage-session-restricted",
	storageState: "stage-session-restricted",
	addCookies: "stage-session-restricted",
	clearCookies: "stage-session-restricted",
};

/** One stage-bound session's refusals, as the facade raises them. */
export function stageRestrictedCode(
	stageBound: boolean,
	method: string,
): string | undefined {
	return stageBound ? STAGE_CONTEXT_RESTRICTED[method] : undefined;
}

export function scriptHandles(session: BrowserSession): {
	readonly page: unknown;
	readonly context: unknown;
} {
	const rawPage = session.page.raw() as object;
	const rawContext = session.context.raw() as object;
	const stageBound = session.stage !== undefined;
	/** A stage-bound session masks the screenshot either way: the mask a script's
	 * own `page.screenshot()` (or a locator's) has to carry is this session's
	 * credential fills. */
	const screenshotFixups: FacadeArgumentFixups = stageBound
		? {
				screenshot: (args) =>
					maskedScreenshotOptions(session.maskLocators(), args),
			}
		: {};
	const pages = new WeakMap<object, object>();
	const contexts = new WeakMap<object, object>();
	const locators = new WeakMap<object, object>();

	const wrapLocator = (raw: object): object => {
		const cached = locators.get(raw);
		if (cached) return cached;
		const facade = facadeOf(
			raw,
			"locator",
			LOCATOR_METHODS,
			wrap,
			{},
			{},
			{},
			screenshotFixups,
		);
		locators.set(raw, facade);
		return facade;
	};
	const wrapPage = (raw: object): object => {
		if (raw === rawPage) return pageFacade();
		const cached = pages.get(raw);
		if (cached) return cached;
		const facade = pageFacadeOf(raw);
		pages.set(raw, facade);
		return facade;
	};
	const wrapContext = (raw: object): object => {
		const cached = contexts.get(raw);
		if (cached) return cached;
		const facade = facadeOf(
			raw,
			"context",
			stageBound
				? CONTEXT_METHODS.filter((name) => !(name in STAGE_CONTEXT_RESTRICTED))
				: CONTEXT_METHODS,
			wrap,
			{},
			{},
			stageBound ? STAGE_CONTEXT_RESTRICTED : {},
		);
		contexts.set(raw, facade);
		return facade;
	};
	/**
	 * Sanitize one result of a facade method.
	 *
	 * This is **deny by default**, which is the only rule a Playwright object
	 * graph cannot be enumerated around: `page.goto()` resolves to a `Response`,
	 * `evaluateHandle` to a `JSHandle`, and each of those walks back
	 * (`response.frame().page().context().browser()`) to every other run's
	 * contexts. So the known facades and primitives pass, and everything else is
	 * refused unless it is plain JSON data — the shape `storageState()`,
	 * `cookies()` and `evaluate()` results truly have.
	 */
	const wrap = (value: unknown): unknown => {
		if (value === null || typeof value !== "object")
			return typeof value === "function" ? undefined : value;
		// Every facade method is asynchronous, so the result of one is usually a
		// promise: resolve it first, or `context.newPage()` would hand back the raw
		// page the facade exists to avoid.
		if (typeof (value as PromiseLike<unknown>).then === "function")
			return (value as Promise<unknown>).then((resolved) => wrap(resolved));
		if (value === rawContext) return wrapContext(rawContext);
		if (pages.has(value)) return pages.get(value);
		if (locators.has(value)) return locators.get(value);
		if (Array.isArray(value)) return value.map((item) => wrap(item));
		if (isPageLike(value)) return wrapPage(value);
		// Only this session's own context is reachable through the facade.
		if (isContextLike(value)) return undefined;
		if (isLocatorLike(value)) return wrapLocator(value);
		// A screenshot: bytes are data, not a handle.
		if (value instanceof Uint8Array) return value;
		return sanitizeData(value, 0);
	};
	const isPlainObject = (value: object): boolean => {
		const prototype = Object.getPrototypeOf(value) as object | null;
		return prototype === Object.prototype || prototype === null;
	};
	/** Plain JSON data, copied. A class instance (a Response, a JSHandle, a Frame)
	 * is not data and is refused. */
	const sanitizeData = (value: unknown, depth: number): unknown => {
		if (depth > 8) return undefined;
		if (value === null || typeof value !== "object")
			return typeof value === "function" ? undefined : value;
		if (value instanceof Uint8Array) return value;
		if (Array.isArray(value))
			return value.map((item) => sanitizeData(item, depth + 1));
		if (!isPlainObject(value)) return undefined;
		const data: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value))
			data[key] = sanitizeData(item, depth + 1);
		return data;
	};
	/** The page facade is built directly, never through `wrapPage`: routing the
	 * session's own page back through the wrapper would recurse for ever. */
	const pageFacadeOf = (raw: object): object =>
		facadeOf(
			raw,
			"page",
			PAGE_METHODS,
			wrap,
			{
				// `context` is the session's own context facade, as a function (that is
				// what `page.context()` is); the input devices are facades in their own
				// right, and a real page exposes them as properties.
				context: () => wrapContext(rawContext),
				keyboard: facadeOf(keyboardOf(raw), "keyboard", KEYBOARD_METHODS, wrap),
				mouse: facadeOf(mouseOf(raw), "mouse", MOUSE_METHODS, wrap),
			},
			PAGE_RESULT_BOUNDS,
			{},
			screenshotFixups,
		);
	let page: object | undefined;
	const pageFacade = (): object => {
		if (page) return page;
		page = pageFacadeOf(rawPage);
		pages.set(rawPage, page);
		return page;
	};
	const context = wrapContext(rawContext);
	return { page: pageFacade(), context };
}

/** A per-facade argument fixup, by method name: what this session has to add to
 * one method's arguments before the raw object sees them. */
type FacadeArgumentFixups = Record<string, (args: unknown[]) => unknown[]>;

/** The screenshot options one stage-bound session has to carry, so a frame a
 * *script* takes covers what was typed into it exactly as `browser_screenshot`
 * does: a credential is masked by one rule, not by whichever tool asked. */
function maskedScreenshotOptions(
	mask: readonly unknown[],
	args: unknown[],
): unknown[] {
	if (mask.length === 0) return args;
	const options = args[0];
	if (options === undefined) return [{ mask: [...mask] }, ...args.slice(1)];
	if (options === null || typeof options !== "object") return args;
	const existing = (options as { mask?: unknown }).mask;
	return [
		{
			...(options as Record<string, unknown>),
			mask: [...mask, ...(Array.isArray(existing) ? existing : [])],
		},
		...args.slice(1),
	];
}

/** Build a frozen allow-list facade over one raw object.
 *
 * Only the named operations exist, each one a bound function over the real
 * object; every result passes through `wrap` and, where the method's result
 * grows with the page, through its own bound. Anything else fails loudly: a
 * `Proxy` answers a supported name from the list and throws for an unknown one
 * with the names that are supported, so an agent learns the surface from the
 * error rather than from a bare `TypeError`.
 */
function facadeOf(
	raw: object,
	label: string,
	names: readonly string[],
	wrap: (value: unknown) => unknown,
	extras: Record<string, unknown> = {},
	bounds: Record<string, number> = {},
	/** Methods this facade refuses with a named code instead of a bare "not
	 * available" (a stage session's cookie and storage reads). */
	restricted: Record<string, string> = {},
	/** Arguments one supported method needs before the raw object sees them (a
	 * stage-bound screenshot's mask). */
	fixups: FacadeArgumentFixups = {},
): object {
	const facade: Record<string, unknown> = {};
	for (const name of names) {
		const value = (raw as Record<string, unknown>)[name];
		if (typeof value !== "function") continue;
		const bound = bounds[name];
		const fixup = fixups[name];
		facade[name] = (...args: unknown[]) => {
			const callArgs = fixup ? fixup(args) : args;
			const wrapped = wrap(
				(value as (...inner: unknown[]) => unknown).call(raw, ...callArgs),
			);
			if (bound === undefined) return wrapped;
			const cut = (input: unknown): unknown =>
				typeof input === "string" && input.length > bound
					? `${input.slice(0, bound)}…`
					: input;
			return typeof (wrapped as PromiseLike<unknown> | undefined)?.then ===
				"function"
				? (wrapped as Promise<unknown>).then(cut)
				: cut(wrapped);
		};
	}
	// `extras` are literal values, not builders: `context` is a function because
	// that is what `page.context()` is, and the input devices are objects.
	for (const [name, value] of Object.entries(extras)) facade[name] = value;
	const supported = supportedMethods(names, extras);
	return new Proxy(Object.freeze(facade), {
		get(target, property, receiver) {
			// A symbol is never a Playwright method (`Symbol.toStringTag` and the
			// inspect hook describe the object), and `then` must stay absent or a
			// facade would look like a thenable and `wrap` would resolve a result to
			// the facade itself.
			if (typeof property !== "string" || property === "then") return undefined;
			if (property in target) return Reflect.get(target, property, receiver);
			const code = restricted[property];
			if (code)
				throw new BrowserSessionError(
					code,
					`${label}.${property} is refused on a stage-bound session: a login lives in this session's cookies and storage, and reading them out would be reading a credential`,
					409,
				);
			throw new Error(
				`${label}.${property} is not available; the supported ${label} methods are: ${supported}`,
			);
		},
	});
}

function keyboardOf(raw: object): object {
	return ((raw as { keyboard?: object }).keyboard ?? {}) as object;
}

function mouseOf(raw: object): object {
	return ((raw as { mouse?: object }).mouse ?? {}) as object;
}

/** The credential *variable names* of one stage, for a repro spec's preamble:
 * names only, resolved from the catalog and never from a value. */
export function stageCredentialNames(
	configDir: string,
	ident: string,
): string[] {
	const variables = stageCredentialVariables(readStageCatalog(configDir));
	return [...variables.entries()]
		.filter(([, source]) => source.stage === ident)
		.map(([name]) => name)
		.sort();
}

/** The saved repro: the agent's own body, wrapped in a `@playwright/test` spec
 * pinned to the URL the script ran against, so the developer can rerun it.
 *
 * A spec saved from a stage-bound session begins with a login preamble that
 * reads the stage's credential *variable names* from the process environment:
 * the spec therefore carries the shape of the login and no value of it. */
export function reproSpec(
	code: string,
	url: string,
	options: { readonly credentialVariables?: readonly string[] } = {},
): string {
	const variables = options.credentialVariables ?? [];
	const variablesBlock =
		variables.length === 0
			? []
			: [
					"// Stage login. These variables are read from the process environment; no",
					"// credential value is written into this file.",
					"const stageCredentials: Record<string, string> = {",
					...variables.map((name) => `\t${name}: required("${name}"),`),
					"};",
					"void stageCredentials;",
					"",
					"function required(name: string): string {",
					"\tconst value = process.env[name];",
					"\tif (value === undefined) throw new Error(`$${name} is not set`);",
					"\treturn value;",
					"}",
				];
	const indented = code
		.split("\n")
		.map((line) => `\t\t${line}`)
		.join("\n");
	return [
		"// Generated by browser_run_script; rerun with `npx playwright test`.",
		'import { test, expect } from "@playwright/test";',
		"",
		...variablesBlock,
		`const baseURL = ${JSON.stringify(url)};`,
		"",
		'test("repro", async ({ page, context }) => {',
		"\tawait page.goto(baseURL);",
		"\tawait (async (page, context, expect) => {",
		indented,
		"\t})(page, context, expect);",
		"});",
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function evidenceScope(
	deps: BrowserRouteDeps,
	owner: string,
): ReturnType<typeof workflowEvidenceScope> {
	const workflowId = ownerWorkflowId(owner);
	if (!workflowId)
		throw new BrowserPoolError(
			"evidence-path",
			`browser evidence belongs to a workflow run; ${JSON.stringify(owner)} is not one`,
			403,
		);
	const location = (deps.locate ?? locateEvidenceWorkflow)(workflowId);
	if (!location)
		throw new BrowserPoolError(
			"evidence-missing",
			`no workflow ${JSON.stringify(workflowId)} is recorded, so it has no evidence store to write to`,
			404,
		);
	return workflowEvidenceScope({ ...location, workflowId });
}

/** Write one server-produced artifact into the workflow's own scratch area and
 * attach it, so the store's path rules apply to a file the server owns rather
 * than to a path a caller chose. */
async function storeEvidence(
	deps: BrowserRouteDeps,
	owner: string,
	input: {
		readonly bytes?: Uint8Array;
		readonly file?: string;
		readonly text?: string;
		readonly kind: "screenshot" | "video" | "script";
		readonly caption: string;
		readonly url: string;
		readonly extension: string;
		readonly app?: string;
		readonly poster?: string;
	},
): Promise<EvidenceEntry> {
	const scope = evidenceScope(deps, owner);
	const directory = path.join(scope.dataRoot, EVIDENCE_SCRATCH_DIR);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const suffix = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
	const file = path.join(directory, `capture-${suffix}.${input.extension}`);
	if (input.bytes) await Bun.write(file, input.bytes);
	else if (input.text !== undefined) await Bun.write(file, input.text);
	else if (input.file) {
		// The recorded video bytes are copied from the server's own recording file;
		// both live inside the workflow's scratch area and are only used once.
		await Bun.write(file, Bun.file(input.file));
	}
	try {
		return await attachEvidence(scope, {
			path: file,
			kind: input.kind,
			caption: input.caption,
			url: input.url,
			...(input.app === undefined ? {} : { app: input.app }),
			...(input.poster === undefined ? {} : { poster: input.poster }),
		});
	} finally {
		fs.rmSync(file, { force: true });
	}
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** A caller's bound, clamped: never longer than the tool allows, never below
 * the floor, and the fallback when it named none. */
function bounded(
	value: number | undefined,
	fallback: number | undefined,
	maximum: number,
): number {
	if (value === undefined || !Number.isFinite(value)) {
		if (fallback === undefined) return maximum;
		return fallback;
	}
	return Math.min(maximum, Math.max(1, Math.round(value)));
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	code: string,
	detail: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new BrowserPoolError(code, detail, 408)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** A script's return value, as something the tool result can carry. */
function serializable(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return String(value);
	}
}
