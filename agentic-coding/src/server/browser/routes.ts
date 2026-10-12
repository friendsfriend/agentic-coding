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
import { BrowserPoolError } from "./errors.ts";
import type { BrowserInstaller } from "./install.ts";
import type { BrowserPool } from "./pool.ts";
import { createScriptExpect } from "./script-expect.ts";
import {
	type BrowserSession,
	BrowserSessionError,
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
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
/** The temp root for server-written evidence before it is copied into the
 * workflow's evidence store. Inside the workflow's data root, which is one of
 * the roots the store accepts a source from. */
const EVIDENCE_SCRATCH_DIR = "browser";

export interface BrowserRouteDeps {
	readonly installer: BrowserInstaller;
	readonly pool: BrowserPool;
	/** Resolved per request, so a configuration edit applies to the next call. */
	readonly settings: () => ResolvedBrowserSettings;
	readonly apps?: Pick<EnvironmentManager, "getAppByIdent">;
	readonly instances?: EnvironmentInstanceController;
	/** Test seam: locate a workflow without the engine. */
	readonly locate?: (workflowId: string) => LocatedEvidenceWorkflow | undefined;
	readonly now?: () => number;
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
		install: status.install,
		settings: {
			maxSessions: settings.maxSessions,
			idleTtlMs: settings.idleTtlMs,
			viewport: { ...settings.viewport },
		},
	};
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
	const used: BrowserSession[] = [];
	try {
		const value = await dispatch(deps, request, path, method, owner, used);
		return json({ ok: true, value });
	} catch (error) {
		if (
			error instanceof BrowserPoolError ||
			error instanceof BrowserSessionError
		)
			return json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		if (error instanceof EvidenceError)
			return json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		return json(
			{ error: { code: "browser-failed", message: message(error) } },
			400,
		);
	} finally {
		for (const session of used) session.endUse();
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
	used: BrowserSession[],
): Promise<unknown> {
	// Every call releases what the idle TTL has expired, so an abandoned run's
	// sessions cannot hold the cap until a timer nobody owns fires.
	await deps.pool.sweepIdle();
	if (method === "POST" && path === AGENT_BROWSER_OPEN_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserOpenRequest
		>(path, await readJsonBody(request));
		return await openSession(deps, owner, body);
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
			entries: session.networkEntries({
				...(body.status === undefined ? {} : { status: body.status }),
				...(body.url === undefined ? {} : { url: body.url }),
				limit: bounded(body.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
			}),
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
	if (method === "POST" && path === AGENT_BROWSER_CLOSE_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserSessionRequest
		>(path, await readJsonBody(request));
		const name = body.session ?? DEFAULT_BROWSER_SESSION;
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
 * A raw URL is always allowed: an agent already has a shell and a browser it
 * can point at anything, so refusing a URL here would be theatre. An app
 * endpoint is different — it resolves to another workflow's code — so it is
 * allowed only while *this* workflow holds the app, and the refusal names the
 * holder so the agent learns who to ask instead of retrying.
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
): Promise<unknown> {
	const settings = deps.settings();
	const resolved = await resolveOpenUrl(deps, owner, body);
	const session = await deps.pool.acquire({
		owner,
		name: body.session ?? DEFAULT_BROWSER_SESSION,
		viewport: clampViewport(body.viewport, settings.viewport),
		url: resolved.url,
		...(resolved.app ? { app: resolved.app } : {}),
	});
	return {
		session: session.name,
		url: session.url,
		...(session.app ? { app: session.app } : {}),
		viewport: { ...session.viewport },
		sessions: deps.pool.ownedBy(owner).length,
	};
}

async function sessionFor(
	deps: BrowserRouteDeps,
	owner: string,
	name: string | undefined,
	used: BrowserSession[],
): Promise<BrowserSession> {
	const session = deps.pool.session(owner, name ?? DEFAULT_BROWSER_SESSION);
	// In flight for the whole request: the idle sweep must not close this page
	// while a tool is still driving it.
	session.beginUse();
	used.push(session);
	// The recording bound is enforced where a session is used, not by a timer: a
	// recording that outlived it is discarded before anything else happens. The
	// pool serializes this with an explicit stop, so two concurrent requests
	// cannot both stop the same recording.
	await deps.pool.autoStopIfExpired(session);
	return session;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(
	deps: BrowserRouteDeps,
	owner: string,
	used: BrowserSession[],
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
		case "fill":
			if (body.value === undefined)
				throw new BrowserPoolError(
					"value-required",
					"browser_fill needs a value",
					400,
				);
			await session.fill(target, body.value, timeoutMs);
			break;
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
	used: BrowserSession[],
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
		const entry = await storeEvidence(deps, owner, {
			bytes,
			kind: "screenshot",
			caption: body.caption?.trim() || `Screenshot of ${session.url}`,
			url: session.url,
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
	used: BrowserSession[],
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
		// rather than left behind as an empty recording.
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

async function recordStop(
	deps: BrowserRouteDeps,
	owner: string,
	used: BrowserSession[],
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
	const caption = body.caption?.trim() || `Recording of ${result.url}`;
	const poster = result.posterSaved
		? await storeEvidence(deps, owner, {
				file: posterPath,
				kind: "screenshot",
				caption: `${caption} (final frame)`,
				url: result.url,
				extension: "jpg",
				...(session.app ? { app: session.app } : {}),
			})
		: undefined;
	const video = await storeEvidence(deps, owner, {
		file: videoPath,
		kind: "video",
		caption,
		url: result.url,
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
	used: BrowserSession[],
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
		const spec = reproSpec(body.code, session.url);
		const entry = await storeEvidence(deps, owner, {
			text: spec,
			kind: "script",
			caption: body.caption?.trim() || `Repro spec for ${session.url}`,
			url: session.url,
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

export function scriptHandles(session: BrowserSession): {
	readonly page: unknown;
	readonly context: unknown;
} {
	const rawPage = session.page.raw() as object;
	const rawContext = session.context.raw() as object;
	const pages = new WeakMap<object, object>();
	const contexts = new WeakMap<object, object>();
	const locators = new WeakMap<object, object>();

	const wrapLocator = (raw: object): object => {
		const cached = locators.get(raw);
		if (cached) return cached;
		const facade = facadeOf(raw, LOCATOR_METHODS, wrap);
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
		const facade = facadeOf(raw, CONTEXT_METHODS, wrap);
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
		facadeOf(raw, PAGE_METHODS, wrap, {
			// `context` is the session's own context facade, as a function (that is
			// what `page.context()` is); the input devices are facades in their own
			// right, and a real page exposes them as properties.
			context: () => wrapContext(rawContext),
			keyboard: facadeOf(keyboardOf(raw), KEYBOARD_METHODS, wrap),
			mouse: facadeOf(mouseOf(raw), MOUSE_METHODS, wrap),
		});
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

/** Build a frozen allow-list facade over one raw object. */
function facadeOf(
	raw: object,
	names: readonly string[],
	wrap: (value: unknown) => unknown,
	extras: Record<string, unknown> = {},
): object {
	const facade: Record<string, unknown> = {};
	for (const name of names) {
		const value = (raw as Record<string, unknown>)[name];
		if (typeof value !== "function") continue;
		facade[name] = (...args: unknown[]) =>
			wrap((value as (...inner: unknown[]) => unknown).call(raw, ...args));
	}
	// `extras` are literal values, not builders: `context` is a function because
	// that is what `page.context()` is, and the input devices are objects.
	for (const [name, value] of Object.entries(extras)) facade[name] = value;
	return Object.freeze(facade);
}

function keyboardOf(raw: object): object {
	return ((raw as { keyboard?: object }).keyboard ?? {}) as object;
}

function mouseOf(raw: object): object {
	return ((raw as { mouse?: object }).mouse ?? {}) as object;
}

/** The saved repro: the agent's own body, wrapped in a `@playwright/test` spec
 * pinned to the URL the script ran against, so the developer can rerun it. */
export function reproSpec(code: string, url: string): string {
	const indented = code
		.split("\n")
		.map((line) => `\t\t${line}`)
		.join("\n");
	return [
		"// Generated by browser_run_script; rerun with `npx playwright test`.",
		'import { test, expect } from "@playwright/test";',
		"",
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
