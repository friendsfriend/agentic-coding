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
import type {
	BrowserSnapshotDelta,
	BrowserStatusResponse,
	BrowserTiming,
} from "../../contracts/browser.ts";
import { decodeContract } from "../../contracts/decode.ts";
import type {
	EvidenceEntry,
	EvidenceManifest,
} from "../../contracts/environment.ts";
import type {
	ReplayEvent,
	ReplayResult,
} from "../../contracts/stage-replay.ts";
import type { StageJournalEntry } from "../../contracts/stages.ts";
import { STAGE_BLOCK_CATALOG } from "../../stage-blocks/catalog.generated.ts";
import {
	filterCompactCatalog,
	filterFullCatalog,
	type StageBlockCatalog,
} from "../../stage-blocks/catalog.ts";
import {
	canonicalInputsHash,
	STAGE_FLOW_DIRECTORY,
} from "../../stage-blocks/flow.ts";
import { generateFlow } from "../../stage-blocks/flow-generator.ts";
import {
	compactFlowEntry,
	flowEligibility,
	readFlowRegistry,
} from "../../stage-blocks/flow-registry.ts";
import {
	FlowSourceError,
	flowSourceFromStagePlan,
} from "../../stage-blocks/flow-source.ts";
import { buildHealPacket } from "../../stage-blocks/heal.ts";
import {
	blockPlanFromRoute,
	deriveInputSchema,
	type StageBlockPlan,
	type StageBlockPolicy,
	validateStageBlockPlan,
} from "../../stage-blocks/plan.ts";
import { stageBlockRegistry } from "../../stage-blocks/registry.ts";
import { mapReplayToReport } from "../../stage-blocks/replay-report.ts";
import {
	runStageBlockPlan,
	type StageBlockJournalEntry,
} from "../../stage-blocks/runner.ts";
import type { JsonValue } from "../../stage-blocks/schema.ts";
import {
	parseSuiteManifest,
	runSuiteEntries,
	STAGE_SUITE_EXTENSION,
	type SuiteEntryResult,
	type SuiteFlowEntry,
} from "../../stage-blocks/suite.ts";
import { StageTestPlanSchema } from "../../workflow/schema.ts";

type StageTestPlan = typeof StageTestPlanSchema.Type;

import {
	BROWSER_MAX_IMAGE_WIDTH,
	type ResolvedBrowserSettings,
} from "../../workflow/effects.ts";
import { workflowEvidenceScope } from "../../workflow/runtime/evidence-store.ts";
import { readJsonBody } from "../auth.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import { environmentSecrets, redact } from "../environment/secrets.ts";
import {
	appendStageJournalEntry,
	backfillStageJournalVideo,
	clearStageJournalSegment,
	highestStageSegment,
	type JournalRedactor,
	journalSummary,
	writeStageFlowPage,
	writeStageFlowPageUnlocked,
} from "../evidence/journal.ts";
import {
	type LocatedEvidenceWorkflow,
	locateEvidenceWorkflow,
} from "../evidence/routes.ts";
import {
	attachEvidence,
	EVIDENCE_FILE_MAX_BYTES,
	EvidenceError,
} from "../evidence/store.ts";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_EVAL_PATH,
	AGENT_BROWSER_FIND_PATH,
	AGENT_BROWSER_LOGIN_PATH,
	AGENT_BROWSER_LOGIN_WAIT_PATH,
	AGENT_BROWSER_NETWORK_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	AGENT_BROWSER_STAGE_BLOCKS_PATH,
	AGENT_BROWSER_STAGE_FLOWS_PATH,
	AGENT_BROWSER_STAGE_JOURNAL_PATH,
	AGENT_BROWSER_STAGE_REPLAY_PATH,
	AGENT_BROWSER_STAGE_RUN_PATH,
	AGENT_BROWSER_STAGE_STEP_PATH,
	AGENT_BROWSER_STAGE_WAIT_PATH,
	AGENT_BROWSER_WAIT_PATH,
	decodeRouteRequest,
} from "../protocol.ts";
import type { EnvironmentInstanceController } from "../runtime/instances.ts";
import {
	credentialMissingMessage,
	readStageCatalog,
	roleLoginMode,
	type StageCatalog,
	type StageEntry,
	stageByIdent,
	stageCredentialVariables,
	stageRefusalReason,
	stageView,
	undeclaredCredentialMessage,
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
import { type BrowserPool, DEFAULT_RECORDING_MAX_MS } from "./pool.ts";
import { createScriptExpect } from "./script-expect.ts";
import {
	type BrowserSession,
	BrowserSessionError,
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
	type NetworkEntry,
	type SessionSnapshotState,
	type StageBearerScope,
	type StageSessionBinding,
} from "./session.ts";
import {
	diffSnapshotNodes,
	formatSnapshotObservation,
	type SnapshotDeltaEntry,
	type SnapshotNode,
} from "./snapshot.ts";
import { SessionBlockPage, sessionExpect } from "./stage-block-page.ts";
import {
	decodeReplayResult,
	replayEventsFromSteps,
	runReplayProcess,
} from "./stage-replay.ts";

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
/** `stage_wait`'s default poll interval, floor and ceiling, and the bound a
 * session without stage limits gets (`add-stage-flow-evidence`). A wait polls
 * inside the server, so it costs one tool call rather than one per poll. */
const DEFAULT_STAGE_WAIT_INTERVAL_MS = 5_000;
const MIN_STAGE_WAIT_INTERVAL_MS = 5_000;
const MAX_STAGE_WAIT_INTERVAL_MS = 60_000;
const DEFAULT_STAGE_WAIT_MAX_SECONDS = 600;
/** How long one poll's page read may take: a navigation in flight must not make
 * the whole wait hang. */
const STAGE_WAIT_POLL_TIMEOUT_MS = 15_000;

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
	/** The existing server event sink (`browser.tool`). Value-free: a tool name,
	 * timings and counts, never page text or a ref name. */
	readonly telemetry?: (event: BrowserToolTelemetryEvent) => void;
}

/** One browser tool's value-free telemetry event. */
export interface BrowserToolTelemetryEvent {
	readonly domain: "browser";
	readonly kind: "browser.tool";
	readonly tool:
		| "snapshot"
		| "find"
		| "click"
		| "fill"
		| "press"
		| "select"
		| "hover"
		| "wait"
		| "script";
	/** The session name, never its page content or URL. */
	readonly session?: string;
	/** A stable refusal code when the call failed; never the message. */
	readonly errorCode?: string;
	readonly snapshotMs: number;
	readonly actionMs: number;
	readonly observeMs: number;
	readonly totalMs: number;
	readonly chars: number;
	readonly refs: number;
	readonly changed: boolean;
	readonly truncated: boolean;
	readonly snapshotRequired: boolean;
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

/** Settle one session's recording grant: nothing is kept by a discard, by an
 * expired segment or by a refused keep, and a kept segment charges what it ran.
 * Keyed by the session, so a settle can only ever release the grant its own
 * segment took. */
function settleSessionRecording(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	keptMs: number,
): void {
	if (!session.stage) return;
	stageUsage(deps).settleRecording({
		stage: session.stage.ident,
		owner,
		session: session.name,
		keptMs,
	});
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

/** Milliseconds since a `performance.now()` mark, rounded to 0.1 ms so a
 * telemetry row stays readable. */
function elapsedMs(startedAt: number): number {
	return Math.round((performance.now() - startedAt) * 10) / 10;
}

function browserTiming(input: {
	readonly snapshotMs?: number;
	readonly actionMs?: number;
	readonly observeMs?: number;
	readonly chars: number;
	readonly refs: number;
	readonly changed: boolean;
	readonly truncated: boolean;
}): BrowserTiming {
	const snapshotMs = input.snapshotMs ?? 0;
	const actionMs = input.actionMs ?? 0;
	const observeMs = input.observeMs ?? 0;
	return {
		snapshotMs,
		actionMs,
		observeMs,
		totalMs: Math.round((snapshotMs + actionMs + observeMs) * 10) / 10,
		chars: input.chars,
		refs: input.refs,
		changed: input.changed,
		truncated: input.truncated,
	};
}

/** Emit one value-free `browser.tool` event through the server's existing
 * event sink. Telemetry must never turn a successful browser call into a
 * failure. */
function browserErrorCode(error: unknown): string | undefined {
	if (error instanceof BrowserSessionError) return error.code;
	if (error instanceof BrowserPoolError) return error.code;
	return undefined;
}

function emitBrowserTelemetry(
	deps: BrowserRouteDeps,
	tool: BrowserToolTelemetryEvent["tool"],
	timing: BrowserTiming,
	snapshotRequired: boolean,
	extra: { readonly session?: string; readonly errorCode?: string } = {},
): void {
	try {
		deps.telemetry?.({
			domain: "browser",
			kind: "browser.tool",
			tool,
			...(extra.session === undefined ? {} : { session: extra.session }),
			...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
			snapshotMs: timing.snapshotMs,
			actionMs: timing.actionMs,
			observeMs: timing.observeMs,
			totalMs: timing.totalMs,
			chars: timing.chars,
			refs: timing.refs,
			changed: timing.changed,
			truncated: timing.truncated,
			snapshotRequired,
		});
	} catch {
		// A monitor that throws is not this call's failure.
	}
}

function emitBrowserFailure(
	deps: BrowserRouteDeps,
	tool: BrowserToolTelemetryEvent["tool"],
	session: BrowserSession,
	startedAt: number,
	error: unknown,
): void {
	const timing = browserTiming({
		observeMs: elapsedMs(startedAt),
		chars: session.snapshotState?.chars ?? 0,
		refs: session.snapshotState?.refs.length ?? 0,
		changed: false,
		truncated: false,
	});
	emitBrowserTelemetry(deps, tool, timing, false, {
		session: session.name,
		...(browserErrorCode(error) === undefined
			? {}
			: { errorCode: browserErrorCode(error) }),
	});
}

function deltaValue(
	delta: import("./snapshot.ts").SnapshotDelta | undefined,
): BrowserSnapshotDelta | undefined {
	if (delta === undefined) return undefined;
	return {
		added: [...delta.added],
		removed: [...delta.removed],
		changed: [...delta.changed],
	};
}

function nodeEntry(node: SnapshotNode): SnapshotDeltaEntry {
	return {
		...(node.ref === undefined ? {} : { ref: node.ref }),
		role: node.role,
		...(node.name === undefined ? {} : { name: node.name }),
		...(node.text === undefined ? {} : { text: node.text }),
		...(node.checked === undefined ? {} : { checked: node.checked }),
		...(node.disabled === undefined ? {} : { disabled: node.disabled }),
	};
}

interface ActionObservationResult {
	readonly snapshotId?: string;
	readonly observation: string;
	readonly changed: boolean;
	readonly snapshotRequired: boolean;
	readonly delta?: BrowserSnapshotDelta;
	readonly deltaTruncated: boolean;
	readonly timing: BrowserTiming;
}

/** The post-action read: one snapshot, a compact delta against the state the
 * action started from, and either the new id or a clear instruction to take a
 * snapshot after a navigation/failed read. The full tree is never returned. */
async function observeAfterAction(
	session: BrowserSession,
	before: SessionSnapshotState | undefined,
	actionMs: number,
): Promise<ActionObservationResult> {
	const snapshotStart = performance.now();
	let after: SessionSnapshotState;
	try {
		after = await session.snapshot();
	} catch {
		// The action itself may have succeeded. Its refs are still untrustworthy,
		// so invalidate them and answer with a snapshot instruction rather than an
		// error that would hide the action's outcome.
		session.invalidateSnapshot();
		const snapshotMs = elapsedMs(snapshotStart);
		const observation = [
			`url: ${session.url}`,
			"action completed, but the post-action snapshot failed",
			"take a browser_snapshot for the current refs",
		].join("\n");
		return {
			observation,
			changed: false,
			snapshotRequired: true,
			deltaTruncated: false,
			timing: browserTiming({
				snapshotMs,
				actionMs,
				chars: 0,
				refs: 0,
				changed: false,
				truncated: false,
			}),
		};
	}
	const snapshotMs = elapsedMs(snapshotStart);
	const observeStart = performance.now();
	const title = await session.title().catch(() => "");
	const navigation = before !== undefined && before.url !== after.url;
	const delta =
		before === undefined || navigation
			? undefined
			: diffSnapshotNodes(before.nodes, after.nodes);
	const noBaseline = before === undefined;
	const changed =
		navigation ||
		(delta?.totals.added ?? 0) +
			(delta?.totals.removed ?? 0) +
			(delta?.totals.changed ?? 0) >
			0;
	const snapshotRequired = navigation || noBaseline;
	const observation = formatSnapshotObservation({
		url: after.url,
		...(title === "" ? {} : { title }),
		...(delta === undefined ? {} : { delta }),
		...(navigation ? { navigation: true } : {}),
		...(noBaseline ? { noBaseline: true } : {}),
		snapshotRequired,
	});
	const observeMs = elapsedMs(observeStart);
	return {
		snapshotId: after.id,
		observation,
		changed,
		snapshotRequired,
		...(delta === undefined ? {} : { delta: deltaValue(delta) }),
		deltaTruncated: delta?.truncated ?? false,
		timing: browserTiming({
			snapshotMs,
			actionMs,
			observeMs,
			chars: after.chars,
			refs: after.refs.length,
			changed,
			truncated: after.truncated || (delta?.truncated ?? false),
		}),
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
	if (refusal.code === "stage-plan-write-not-approved")
		return `the approved stage-test plan permits POST for planned data creation only; the ${refusal.method} request to ${refusal.url} was aborted`;
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
	// Every value the identity cache holds is a credential too
	// (`add-stage-identity-cache`, SEC): a sign-on cookie or a cached JWT echoed
	// into a title, a console line or a URL is masked by the same scrubber. The
	// values a live context *installed* are included even after their entry is
	// gone (forgotten, expired, evicted): the browser still carries them, so an
	// echo of one is still an echo of a credential.
	const identity = identityRedactionSecrets(deps);
	// The PKCE values of a code-grant login (`add-stage-oauth2-code-pkce`): the
	// verifier, `state` and the code a receiver took are as secret as the token
	// they lead to, and the callback URL the window lands on carries the code.
	const pkce = pkceSecrets();
	// Both halves are already longest-first, so merging is linear: the identity set
	// can hold hundreds of values and sorting it again on every reply is what a
	// stage application's `localStorage` would otherwise cost the server (PERF).
	// The encoded copies of the other three sources are derived here, small and per
	// reply, so no source loses its URL-encoded form to the memoisation (SEC-002).
	const listed = [...base, ...live, ...pkce];
	return mergeByLength(
		sortByLength([...listed, ...encodedVariants(listed)]),
		identity,
	);
}

/** Each value also in its URL-encoded form, because a credential reaches a URL
 * encoded far more often than plain. A value `encodeURIComponent` leaves alone
 * contributes nothing. */
function encodedVariants(
	secrets: ReturnType<typeof environmentSecrets>,
): ReturnType<typeof environmentSecrets> {
	return secrets.flatMap((secret) => {
		const value = encodeURIComponent(secret.value);
		return value === secret.value
			? []
			: [{ name: `${secret.name}:url-encoded`, value }];
	});
}

/** The identity part of the scrubber, memoised per pool state.
 *
 * Every browser reply asks for it, and the set only changes when a capture, an
 * install, a forget or a close touches it — `secretRevision()` names exactly
 * those events. The URL-encoded copies are derived once per change rather than
 * once per reply. */
let identitySecretCache:
	| {
			readonly pool: unknown;
			readonly revision: number;
			readonly values: ReturnType<typeof environmentSecrets>;
	  }
	| undefined;

function identityRedactionSecrets(
	deps: BrowserRouteDeps,
): ReturnType<typeof environmentSecrets> {
	const pool = deps.pool;
	const revision = pool.secretRevision();
	if (
		identitySecretCache !== undefined &&
		identitySecretCache.pool === pool &&
		identitySecretCache.revision === revision
	)
		return identitySecretCache.values;
	const plain = [
		...pool.identityStore().secrets(),
		...pool.installedIdentitySecrets(),
	];
	const values = sortByLength([...plain, ...encodedVariants(plain)]);
	identitySecretCache = { pool, revision, values };
	return values;
}

function sortByLength(
	secrets: ReturnType<typeof environmentSecrets>,
): ReturnType<typeof environmentSecrets> {
	return [...secrets].sort(
		(left, right) => right.value.length - left.value.length,
	);
}

/** Merge two longest-first lists into one without re-sorting either. */
function mergeByLength(
	left: ReturnType<typeof environmentSecrets>,
	right: ReturnType<typeof environmentSecrets>,
): ReturnType<typeof environmentSecrets> {
	const merged: ReturnType<typeof environmentSecrets> = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		const a = left[i];
		const b = right[j];
		if (
			a !== undefined &&
			(b === undefined || a.value.length >= b.value.length)
		) {
			merged.push(a);
			i += 1;
		} else if (b !== undefined) {
			merged.push(b);
			j += 1;
		}
	}
	for (; i < left.length; i += 1) {
		const value = left[i];
		if (value !== undefined) merged.push(value);
	}
	for (; j < right.length; j += 1) {
		const value = right[j];
		if (value !== undefined) merged.push(value);
	}
	return merged;
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
	const workflowId = ownerWorkflowId(owner);
	const workflow = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	const replayTool =
		path === AGENT_BROWSER_STAGE_REPLAY_PATH ||
		path === AGENT_BROWSER_STAGE_FLOWS_PATH ||
		path === AGENT_BROWSER_STAGE_JOURNAL_PATH;
	// The planner may read the static block catalog (`stage_blocks`) and
	// discover saved flows (`stage_flows`) — neither opens a browser, touches
	// stage access or writes the journal — while choosing a block or a flowId
	// and binding its inputs (`add-stage-flow-blocks` task 8.2,
	// `add-stage-flow-replay` task 5.2). Every other stage tool stays
	// restricted to the tester during execute/replay.
	const plannerDiscoveryTool =
		(path === AGENT_BROWSER_STAGE_FLOWS_PATH ||
			path === AGENT_BROWSER_STAGE_BLOCKS_PATH) &&
		workflow?.currentStep === "stage.plan" &&
		workflow.selectedRoles?.includes("stage-planner") === true;
	if (
		workflow?.definitionId === "stage-test" &&
		path !== AGENT_BROWSER_CLOSE_PATH &&
		!plannerDiscoveryTool &&
		((workflow.currentStep !== "stage.execute" &&
			!(replayTool && workflow.currentStep === "stage.replay")) ||
			!workflow.selectedRoles?.includes("stage-tester"))
	)
		throw new BrowserPoolError(
			"stage-test-tool-restricted",
			"stage browser tools are available to stage-tester only during stage.execute or stage.replay",
			403,
		);
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
			import("../../contracts/browser.ts").BrowserSnapshotRequest
		>(path, await readJsonBody(request));
		return await snapshotRoute(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_FIND_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserFindRequest
		>(path, await readJsonBody(request));
		return await findRoute(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_ACTION_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserActionRequest
		>(path, await readJsonBody(request));
		return await act(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_STEP_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserStageStepRequest
		>(path, await readJsonBody(request));
		return await stageStep(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_JOURNAL_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserStageJournalRequest
		>(path, await readJsonBody(request));
		return await stageJournalRead(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_WAIT_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/browser.ts").BrowserStageWaitRequest
		>(path, await readJsonBody(request));
		return await stageWait(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_BLOCKS_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/stage-blocks.ts").StageBlocksRequest
		>(path, await readJsonBody(request));
		return stageBlocks(body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_RUN_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/stage-blocks.ts").StageRunRequest
		>(path, await readJsonBody(request));
		return await stageRun(deps, owner, used, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_FLOWS_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/stage-replay.ts").StageFlowsRequest
		>(path, await readJsonBody(request));
		return stageFlows(deps, owner, body);
	}
	if (method === "POST" && path === AGENT_BROWSER_STAGE_REPLAY_PATH) {
		const body = decodeRouteRequest<
			import("../../contracts/stage-replay.ts").StageReplayRequest
		>(path, await readJsonBody(request));
		if (body.suiteId !== undefined)
			return await stageReplaySuite(deps, owner, {
				...body,
				suiteId: body.suiteId,
			});
		if (body.flowId === undefined)
			throw new BrowserPoolError(
				"stage-replay-invalid",
				"a replay request needs flowId or suiteId",
				400,
			);
		return await stageReplay(deps, owner, { ...body, flowId: body.flowId });
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
		const before = session.snapshotState;
		const actionStarted = performance.now();
		await session.wait({
			...(target ? { target } : {}),
			...(body.text === undefined ? {} : { text: body.text }),
			...(body.url === undefined ? {} : { url: body.url }),
			timeoutMs,
		});
		const actionMs = elapsedMs(actionStarted);
		if (body.observe === true) {
			const observed = await observeAfterAction(session, before, actionMs);
			emitBrowserTelemetry(
				deps,
				"wait",
				observed.timing,
				observed.snapshotRequired,
				{ session: session.name },
			);
			return {
				session: session.name,
				url: session.url,
				waited: true,
				...(observed.snapshotId === undefined
					? {}
					: { snapshotId: observed.snapshotId }),
				observation: observed.observation,
				changed: observed.changed,
				snapshotRequired: observed.snapshotRequired,
				...(observed.delta === undefined ? {} : { delta: observed.delta }),
				deltaTruncated: observed.deltaTruncated,
				timing: observed.timing,
			};
		}
		const timing = browserTiming({
			actionMs,
			chars: before?.chars ?? 0,
			refs: before?.refs.length ?? 0,
			changed: false,
			truncated: false,
		});
		emitBrowserTelemetry(deps, "wait", timing, false, {
			session: session.name,
		});
		return {
			session: session.name,
			url: session.url,
			waited: true,
			timing,
		};
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
			...(bound.identityRole ? { identityRole: bound.identityRole } : {}),
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
			// The names only: which role this session's login belongs to, and whether
			// a cached entry was installed into its context before the first
			// navigation (`add-stage-identity-cache`). A value is never reported.
			...(session.identity ? { stageRole: session.identity.role } : {}),
			...(session.identity?.cacheInstalled ? { identityInstalled: true } : {}),
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
	/** The role whose cached identity this open installs
	 * (`add-stage-identity-cache`): the pool needs it before the first
	 * navigation, so it cannot be deferred to `stage_login`. */
	identityRole?: string;
	/** True when the session this open resolves to already exists, so the pool
	 * must reuse it rather than create one without an admission. */
	reuseOnly?: boolean;
}> {
	const existing = deps.pool.find(owner, name);
	const stageIdent = body.stage?.trim();
	const workflowId = ownerWorkflowId(owner);
	const location = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	if (location?.definitionId === "stage-test") {
		if (
			body.url !== undefined ||
			body.app !== undefined ||
			body.endpoint !== undefined
		)
			throw new BrowserPoolError(
				"stage-test-browsing-restricted",
				"stage-test browser opens cannot use a raw URL or an application endpoint; use the pinned stage and a declared stageApp",
				403,
			);
		if (!stageIdent)
			throw new BrowserPoolError(
				"stage-test-browsing-restricted",
				"stage-test browser sessions must be opened with the workflow's pinned stage and a declared stageApp",
				403,
			);
		if (!location.stage || stageIdent !== location.stage)
			throw new BrowserPoolError(
				"stage-mismatch",
				"stage-test browser open must use the exact stage pinned by this workflow",
				403,
			);
	}
	if (stageIdent) return resolveStageOpen(deps, owner, body, name, stageIdent);
	const resolved = await resolveOpenUrl(deps, owner, body);
	if (existing?.stage) assertAllowedOrigin(existing.stage, resolved.url);
	return resolved;
}

function assertStageTestRoute(
	workflow: LocatedEvidenceWorkflow | undefined,
	app: string,
	role: string | undefined,
): void {
	if (workflow?.definitionId !== "stage-test") return;
	const plan = workflow.stageTestPlan as
		| {
				route?: readonly { application?: string; role?: string }[];
		  }
		| undefined;
	if (
		!plan?.route?.some(
			(route) =>
				route.application === app && (route.role ?? undefined) === role,
		)
	)
		throw new BrowserPoolError(
			"stage-route-not-approved",
			`stage application and role must match the approved test plan; the plan routes ${JSON.stringify(app)} as ${
				[
					...new Set(
						(plan?.route ?? [])
							.filter((route) => route.application === app)
							.map((route) => route.role ?? "(no role)"),
					),
				]
					.map((planned) =>
						planned === "(no role)"
							? "no role (omit stageRole)"
							: `stageRole ${JSON.stringify(planned)}`,
					)
					.join(" or ") || "nothing (the application is not in the plan)"
			}`,
			403,
		);
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
	identityRole?: string;
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
	// The role is optional and names-only: it decides whose cached identity this
	// context starts from (`add-stage-identity-cache`). A role the application
	// does not declare is refused here, so a plan cannot ask for an identity no
	// login of this stage could ever establish.
	const roleKey = body.stageRole?.trim();
	if (roleKey !== undefined && roleKey !== "") {
		if (app.roles?.[roleKey] === undefined)
			throw new BrowserPoolError(
				"stage-role-unknown",
				`stage ${ident} declares no role ${JSON.stringify(roleKey)} of ${appKey}; it declares ${Object.keys(app.roles ?? {}).join(", ") || "none"}`,
				404,
			);
	}
	const identityRole =
		roleKey === undefined || roleKey === "" ? undefined : roleKey;
	const workflowId = ownerWorkflowId(owner);
	const workflow = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	assertStageTestRoute(workflow, appKey, identityRole);
	const plan = workflow?.stageTestPlan as { createsData?: boolean } | undefined;
	const stageTestPlan = workflow?.definitionId === "stage-test";
	const writeAllowed =
		!stageTestPlan ||
		(workflow?.stageAccess === "writable" && plan?.createsData === true);
	// A writable stage whose plan approved no creation is narrowed to read-only
	// as its own policy, not merely a false `writeAllowed`: the refusal must not
	// fall through to the stage's read-only exceptions (SEC-002).
	const planNarrowed =
		stageTestPlan && workflow?.stageAccess === "writable" && !writeAllowed;
	const bearer = bearerScopes(entry);
	const binding: StageSessionBinding = {
		ident: entry.ident,
		access: entry.stage.access,
		origins: entry.origins,
		readOnlyExceptions: entry.stage.readOnlyExceptions ?? [],
		limits: entry.limits,
		...(stageTestPlan
			? {
					writeAllowed,
					planNarrowed,
					writeMethods: ["POST"],
				}
			: {}),
		// The stage's identity-cache bounds and the origins one entry covers: the
		// applications and the login recipes, never a third-party host.
		identity: entry.identity,
		identityOrigins: entry.identityOrigins,
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
		...(identityRole === undefined ? {} : { identityRole }),
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
	const expired = await deps.pool.autoStopIfExpired(session);
	// The pool stops a recording that outlived its bound and discards it: this is
	// the only place that learns of it, so it is where the grant that segment held
	// is given back (a stop that never comes would otherwise hold the budget for
	// the segment's own bound).
	if (expired !== undefined) settleSessionRecording(deps, owner, session, 0);
	// The hold is checked *before* the stage's rolling minute is charged: a
	// refusal because the developer is logging in is not an action of the run.
	if (session.heldByUser && options.allowHeld !== true)
		throw sessionHeldRefusal(session);
	// A living session re-captures its identity when its refresh interval has
	// passed (`add-stage-identity-cache`, D5): a rotated refresh token has to
	// reach the cache while the run that rotated it is still going. It is bound
	// to use rather than to a timer, so a server with no stage session runs
	// nothing, and a capture never fails the call that triggered it.
	await deps.pool.refreshIdentity(session).catch(() => false);
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
	const workflowId = ownerWorkflowId(owner);
	const workflow = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	if (workflow?.definitionId === "stage-test") {
		// `session.app` is the application the stage key maps to (`apps.<key>.app`,
		// or the key itself): the plan and the tool speak the stage key, so compare
		// through the same mapping `resolveStageOpen` used when it set the field.
		const declared = entry.stage.apps[body.app];
		if (declared === undefined || (declared.app ?? body.app) !== session.app)
			throw new BrowserPoolError(
				"stage-app-unknown",
				"stage login application must match the stage-bound session",
				403,
			);
		assertStageTestRoute(workflow, body.app, body.role);
	}
	// The role is remembered on the session from here on, so a successful login of
	// any path — the cached one, the silent SSO check, the recipe, the hand-off —
	// captures into the right key (`add-stage-identity-cache`). `cacheInstalled`
	// is kept for the same role and dropped for a different one: an identity of
	// another role was never installed into this context.
	session.identity = {
		...session.identity,
		role: body.role,
		// Every role this context logs in as is remembered, not only the one it was
		// installed for: a second login of a *different* role leaves one jar holding
		// two users, and `captureIdentity` refuses to file such a context under
		// either key (SEC-001).
		loggedRoles: [
			...new Set([...(session.identity?.loggedRoles ?? []), body.role]),
		],
		cacheInstalled:
			session.identity?.role === body.role &&
			session.identity.cacheInstalled === true,
	};
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
			if (mode !== "handoff") {
				// `credentialStatus` is the first unset variable among the role's own
				// credential views — for this grant the provider's client id and, when it
				// declares one, its client secret — so the refusal names the credential that
				// is actually missing instead of assuming it is the client id (USAB-206). A
				// provider cannot declare no client id at all — the stage file is refused at
				// load with that field named — so the fallback only has to keep this refusal
				// and the deeper one saying the same thing, rather than promise a `.env`
				// remedy for a missing declaration (USAB-208).
				const missing = roleView.credentialStatus.startsWith("missing ")
					? roleView.credentialStatus.slice("missing ".length)
					: undefined;
				const provider = roleView.provider ?? "<provider>";
				const remedy =
					missing === undefined
						? undeclaredCredentialMessage(
								`oauth2.providers.${provider}.clientId`,
							)
						: credentialMissingMessage(missing);
				throw new BrowserSessionError(
					entry.interactiveLogin === "never"
						? "login-user-unavailable"
						: "credential-missing",
					entry.interactiveLogin === "never"
						? `${body.app}.${body.role} can only be logged in by a person, and stages/policy.json sets interactiveLogin to "never"`
						: remedy,
					409,
				);
			}
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
	// 2c. The cached identity (`add-stage-identity-cache`, D3): this context was
	// created with this role's entry installed, so the login may already be done.
	// The recipe's declared success condition decides — never the cache alone —
	// and a rejection evicts the entry and lets the normal path run, which is the
	// whole difference between "a hint" and "a credential this server trusts".
	if (
		appView !== undefined &&
		appView.url !== "" &&
		recipe?.success !== undefined &&
		session.identity?.role === body.role &&
		session.identity.cacheInstalled
	) {
		const accepted = await silentLoginCheck({
			session,
			recipe,
			url: appView.url,
			timeoutMs: SILENT_SSO_CHECK_MS,
			...(deps.now ? { now: deps.now } : {}),
		});
		if (accepted) {
			// The accepted entry is re-captured: the identity provider may have rotated
			// its cookie on this very visit, and the newest state is what the next
			// session has to start from.
			await deps.pool.captureIdentity(session, "cache");
			return {
				session: session.name,
				stage: entry.ident,
				login: "ok",
				via: "cache",
				identity: "cache",
				verified: true,
				url: sanitizeStageUrl(session.url),
			};
		}
		// Rejected: the entry is evicted *before* the fallback runs, so a login this
		// call performs is never discredited by the entry it replaced.
		deps.pool.forgetIdentity({ stage: entry.ident, role: body.role });
		session.identity = {
			...session.identity,
			role: body.role,
			cacheInstalled: false,
		};
	}
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
		if (reused) {
			// The state another application's sign-in left in this window is worth
			// keeping too, and it was the developer's login.
			await deps.pool.captureIdentity(session, "user");
			return {
				session: session.name,
				stage: entry.ident,
				login: "ok",
				via: "existing-session",
				identity: "user",
				verified: true,
				url: sanitizeStageUrl(session.url),
			};
		}
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
	// Step 6: keep what the login established (`add-stage-identity-cache`, D2). A
	// login that declared nothing to do established nothing to capture.
	if (!result.notRequired) await deps.pool.captureIdentity(session, "recipe");
	return {
		session: session.name,
		stage: entry.ident,
		url: result.url,
		steps: result.steps,
		...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
		...(result.notRequired
			? { login: "not-required", code: "login-not-required" }
			: { login: "ok", identity: "recipe" }),
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
	// The role this login belongs to is recorded on the session *before* the
	// developer is asked: the hand-off ends in `stage_login_wait`, which has the
	// session and its role but not this request, and that is what the cache is
	// keyed by when the login succeeds (`add-stage-identity-cache`).
	session.identity = {
		...session.identity,
		role: input.role,
		cacheInstalled:
			session.identity?.role === input.role &&
			session.identity.cacheInstalled === true,
	};
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
	// The role is recorded on the session before the developer is asked, for the
	// same reason `startHandoff` does it: the wait is where the identity of a
	// successful `authorization_code` login is captured
	// (`add-stage-identity-cache`).
	session.identity = {
		...session.identity,
		role: input.role,
		cacheInstalled: false,
	};
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
	// A hand-off that ended `ok` is a login the developer performed, so this is
	// where its identity is captured (`add-stage-identity-cache`, D2). The read-back
	// path above has no live session and therefore no context to read. One capture
	// per outcome: the attempt stamps the refresh interval, so a second one would
	// only reset it.
	if (waited.outcome?.outcome === "ok" && session.identity?.role !== undefined)
		await deps.pool.captureIdentity(session, "user");
	if (waited.status)
		return {
			session: session.name,
			...(stage ? { stage } : {}),
			login: "needs-user",
			...waited.status,
		};
	return terminalLoginAnswer(
		waited.outcome,
		session.name,
		stage,
		waited.outcome.outcome === "ok" ? "user" : undefined,
	);
}

/** How one ended hand-off is answered, whether it was waited for or read back
 * from the outcome still recorded for its session. `stage` is unknown on the
 * read-back path: a session whose window the deadline closed is not readable
 * any more, and the outcome is what the run needs. */
function terminalLoginAnswer(
	outcome: LoginHandoffOutcome,
	sessionName: string,
	stage?: string,
	identity?: "user",
): unknown {
	const named = { session: sessionName, ...(stage ? { stage } : {}) };
	switch (outcome.outcome) {
		case "ok":
			return {
				...named,
				login: "ok",
				via: outcome.via,
				...(identity === undefined ? {} : { identity }),
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

async function snapshotRoute(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserSnapshotRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const wantsDiff = body.diff === true || body.since !== undefined;
	if (wantsDiff && body.within !== undefined)
		throw new BrowserPoolError(
			"snapshot-options-conflict",
			"a diff reads the stored state; it cannot be combined with within",
			400,
		);
	if (wantsDiff) {
		const startedAt = performance.now();
		const diff = session.diffSnapshot(body.since);
		const observation = formatSnapshotObservation({
			url: diff.to.url,
			delta: diff.delta,
		});
		const changed =
			diff.delta.totals.added +
				diff.delta.totals.removed +
				diff.delta.totals.changed >
			0;
		const timing = browserTiming({
			observeMs: elapsedMs(startedAt),
			chars: observation.length,
			refs: diff.to.refs.length,
			changed,
			truncated: diff.delta.truncated,
		});
		emitBrowserTelemetry(deps, "snapshot", timing, false, {
			session: session.name,
		});
		return {
			session: session.name,
			url: diff.to.url,
			snapshotId: diff.to.id,
			since: diff.from.id,
			observation,
			changed,
			delta: deltaValue(diff.delta),
			deltaTruncated: diff.delta.truncated,
			timing,
		};
	}
	const startedAt = performance.now();
	const state = await session.snapshot({
		...(body.within === undefined ? {} : { within: body.within }),
		...(body.depth === undefined ? {} : { depth: body.depth }),
		...(body.maxChars === undefined ? {} : { maxChars: body.maxChars }),
	});
	const timing = browserTiming({
		snapshotMs: elapsedMs(startedAt),
		chars: state.chars,
		refs: state.refs.length,
		changed: false,
		truncated: state.truncated,
	});
	emitBrowserTelemetry(deps, "snapshot", timing, false, {
		session: session.name,
	});
	return {
		session: session.name,
		url: session.url,
		snapshotId: state.id,
		snapshot: state.text,
		refs: state.refs.length,
		timing,
	};
}

async function findRoute(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserFindRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const query = body.query.trim();
	if (query === "")
		throw new BrowserPoolError(
			"query-required",
			"browser_find needs a non-empty query",
			400,
		);
	const startedAt = performance.now();
	const found = await session.findSnapshot({
		query,
		...(body.role === undefined ? {} : { role: body.role }),
		...(body.name === undefined ? {} : { name: body.name }),
		...(body.within === undefined ? {} : { within: body.within }),
		limit: Math.min(20, body.limit ?? 20),
	});
	const matches = found.matches.map(nodeEntry);
	const timing = browserTiming({
		observeMs: elapsedMs(startedAt),
		chars: JSON.stringify(matches).length,
		refs: session.snapshotState?.refs.length ?? 0,
		changed: false,
		truncated: found.truncated,
	});
	emitBrowserTelemetry(deps, "find", timing, false, {
		session: session.name,
	});
	return {
		session: session.name,
		snapshotId: found.snapshotId,
		matches,
		total: found.total,
		truncated: found.truncated,
		timing,
	};
}

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
	// Refuse a stale snapshot/ref before the page is touched. The session checks
	// again inside every action, but doing it here makes the failure independent
	// of which branch the action takes (a credential fill included).
	try {
		session.assertAction(body.snapshotId, target);
	} catch (error) {
		emitBrowserFailure(deps, body.action, session, performance.now(), error);
		throw error;
	}
	const before = session.snapshotState;
	const actionStarted = performance.now();
	try {
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
	} catch (error) {
		emitBrowserFailure(deps, body.action, session, actionStarted, error);
		throw error;
	}
	const actionMs = elapsedMs(actionStarted);
	const observed = await observeAfterAction(session, before, actionMs);
	emitBrowserTelemetry(
		deps,
		body.action,
		observed.timing,
		observed.snapshotRequired,
		{ session: session.name },
	);
	return {
		session: session.name,
		action: body.action,
		url: session.url,
		title: await session.title().catch(() => ""),
		observedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
		...(observed.snapshotId === undefined
			? {}
			: { snapshotId: observed.snapshotId }),
		observation: observed.observation,
		changed: observed.changed,
		snapshotRequired: observed.snapshotRequired,
		...(observed.delta === undefined ? {} : { delta: observed.delta }),
		deltaTruncated: observed.deltaTruncated,
		timing: observed.timing,
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
	const keeping = body.evidence === true;
	// A screenshot that is stored but not returned is the flow test's way of
	// documenting a step without paying for the image in the model's context
	// (`add-stage-flow-evidence`, spec "Screenshot context control"). It only
	// makes sense together with `evidence: true`: a `view: false` that stored
	// nothing would answer with nothing at all.
	if (body.view === false && !keeping)
		throw new BrowserPoolError(
			"view-requires-evidence",
			"`view: false` stores the screenshot instead of returning it, so it needs `evidence: true`",
			400,
		);
	// The screenshot bound is *reserved* before the capture, in one synchronous
	// step: a check that refused before the capture and charged after it would let
	// two overlapping calls each pass the same bound during their captures, store
	// one screenshot too many, and answer one of them a refusal for a file it did
	// store. A capture or attach that fails gives the reservation back, so nothing
	// is stored beyond the bound and the refusal only ever answers a call that
	// stored nothing.
	const reservation =
		keeping && session.stage
			? stageUsage(deps).reserveScreenshot({
					stage: session.stage.ident,
					owner,
					maxScreenshots: session.stage.limits.maxScreenshots,
				})
			: undefined;
	const release = () => {
		if (reservation !== undefined)
			stageUsage(deps).releaseScreenshot(reservation);
	};
	let bytes: Uint8Array;
	try {
		bytes = await session.screenshot(
			{
				type: "jpeg",
				quality: SCREENSHOT_QUALITY,
				// The whole page unless the agent asks for the viewport: an
				// investigation reads the page below the fold too (a viewport-height
				// shot is the exception, not the default).
				fullPage: body.fullPage ?? true,
				...(body.ref === undefined ? {} : { ref: body.ref }),
				...(body.selector === undefined ? {} : { selector: body.selector }),
			},
			BROWSER_MAX_IMAGE_WIDTH,
		);
	} catch (error) {
		release();
		throw error;
	}
	const value: Record<string, unknown> = {
		session: session.name,
		url: session.url,
		mediaType: "image/jpeg",
		...(body.view === false
			? {}
			: {
					base64: Buffer.from(bytes).toString("base64"),
					bytes: bytes.byteLength,
				}),
	};
	if (keeping) {
		// The stored entry carries a sanitized URL, and a caption that embeds one
		// carries the same: an evidence entry outlives the call that made it.
		const url = evidenceUrl(deps, session.url);
		try {
			value.evidence = await storeEvidence(deps, owner, {
				bytes,
				kind: "screenshot",
				caption: body.caption?.trim() || `Screenshot of ${url}`,
				url,
				extension: "jpg",
				...(session.app ? { app: session.app } : {}),
			});
		} catch (error) {
			release();
			throw error;
		}
	}
	if (body.view === false)
		value.notice =
			"the screenshot was stored as evidence and not returned to this call";
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
	// A second start on a recording session is refused for what it is — this
	// session already has a segment — rather than by the budget below, which the
	// live grant has (correctly) already spent.
	if (session.recording)
		throw new BrowserPoolError(
			"recording-active",
			"this session is already recording; stop it before starting another",
			409,
		);
	// The stage's kept minutes are a workflow-wide budget
	// (`add-stage-flow-evidence`, spec "Flow segments carry offsets"): what is
	// left of it bounds this segment, so a flow test can never keep more video
	// than the stage allows. The grant is reserved under this session until the
	// stop settles it, so two sessions of one workflow cannot both be told the
	// same remainder — and a start that is refused *after* reserving gives back
	// exactly its own grant, never a live segment's.
	let allowanceMs: number | undefined;
	if (session.stage) {
		allowanceMs = stageUsage(deps).recordingAllowance({
			stage: session.stage.ident,
			owner,
			session: session.name,
			maxRecordingMinutes: session.stage.limits.maxRecordingMinutes,
			maxSegmentMs: DEFAULT_RECORDING_MAX_MS,
		});
	}
	try {
		const started = await deps.pool.startRecording(session, {
			dir,
			// A segment number is a reference the journal's steps carry, so it is only
			// ever issued above the highest one this workflow's journal already names —
			// a resumed run shares that directory, and a reused number would link a new
			// recording into an old segment's steps.
			minSegment: highestStageSegment(scope) + 1,
			// What is left of the budget bounds the segment, so the minutes this
			// recording may keep are the minutes that were reserved for it.
			...(allowanceMs === undefined
				? {}
				: { maxMs: Math.min(DEFAULT_RECORDING_MAX_MS, allowanceMs) }),
		});
		return {
			session: session.name,
			recording: true,
			url: started.url,
			startedAt: new Date(started.startedAt).toISOString(),
			segment: started.segment,
		};
	} catch (error) {
		// A start that failed keeps nothing: the minutes it actually reserved are
		// given back — and nothing at all when it never reserved any — and the
		// directory it created is removed rather than left behind as an empty
		// recording. Asynchronous, because a failed start (a session that was closed
		// under it, a browser that went away) must not block the event loop on a
		// recursive remove.
		if (allowanceMs !== undefined)
			settleSessionRecording(deps, owner, session, 0);
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
		if (!keep) {
			// A discarded recording spends no minutes but gives its grant back, and its
			// steps lose the segment they were filed under: the spec is explicit that a
			// discarded recording leaves no segment reference behind, so neither the
			// journal nor the panel can point at a video nobody has.
			settleSessionRecording(deps, owner, session, 0);
			await clearRecordingSegment(deps, owner, session, {
				segment: result.segment,
			});
			return {
				session: session.name,
				kept: false,
				video: false,
				segment: result.segment,
				notice:
					"the recording was discarded; no video and no evidence entry were kept, and its steps no longer name a segment",
			};
		}
		// A stop that kept nothing at all must still give its grant back, or the
		// budget would read as spent for a video nobody has.
		settleSessionRecording(deps, owner, session, 0);
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
		// The segment is what links the kept recording to the journal steps that
		// were written while it ran.
		segment: result.segment,
	});
	// A kept recording is charged against the stage's recording minutes — settling
	// the grant the start reserved — and the journal's own steps of this segment
	// learn its evidence id so the flow page can seek each one into the video.
	settleSessionRecording(deps, owner, session, result.elapsedMs);
	await backfillRecordingSegment(deps, owner, session, {
		segment: result.segment,
		video: video.id,
	});
	return {
		session: session.name,
		kept: true,
		segment: result.segment,
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
// Stage flow: the step journal and the server-side wait
// (`add-stage-flow-evidence`)
// ---------------------------------------------------------------------------

/** The redactor the journal and the flow page are written through: the same
 * secret set every browser reply is scrubbed with, *and* the same URL sanitizer.
 *
 * Redaction alone masks only the values the configuration knows as secrets, so an
 * application's own `?ticket=…` or `?sessionid=…` — or a fragment carrying a code
 * — would survive in a step's free text. A journal entry outlives the call that
 * wrote it, so a value it carries is scrubbed exactly like a reply.
 */
function journalRedactor(deps: BrowserRouteDeps): JournalRedactor {
	const secrets = redactionSecrets(deps);
	return (value: string) => {
		const redacted = redact(value, secrets);
		const sanitized = sanitizeUrlsIn(
			typeof redacted === "string" ? redacted : value,
		);
		return typeof sanitized === "string" ? sanitized : value;
	};
}

/** Apply a string redactor to every string in a JSON-shaped value. The replay
 * child can include a filled value in a Playwright error, so a report or heal
 * packet must be scrubbed structurally, not only at the top level. */
function redactDeep(
	value: unknown,
	redact: (value: string) => string,
): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value))
		return value.map((entry) => redactDeep(entry, redact));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				redactDeep(entry, redact),
			]),
		);
	return value;
}

/** Regenerate the flow page. A workflow that never wrote a step has no page, and
 * the writer answers that itself — under the evidence root lock, so no listing
 * here can disagree with the write it guards. */
async function refreshFlowPage(
	deps: BrowserRouteDeps,
	scope: ReturnType<typeof workflowEvidenceScope>,
	preloaded: {
		readonly entries?: readonly StageJournalEntry[];
		readonly manifest?: EvidenceManifest;
	} = {},
): Promise<void> {
	const redact = journalRedactor(deps);
	// A caller that just parsed the journal and the manifest hands them in: the page
	// is then rendered from that snapshot instead of a second read of the same two
	// files, which is what makes one step cost one parse rather than two.
	if (preloaded.entries !== undefined || preloaded.manifest !== undefined)
		await writeStageFlowPageUnlocked(scope, redact, preloaded);
	else await writeStageFlowPage(scope, redact);
}

/** Back-fill one kept segment's video onto its journal steps, then re-render the
 * page that links them. A journal without a step in that segment is untouched. */
async function backfillRecordingSegment(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	input: { readonly segment: number; readonly video: string },
): Promise<void> {
	const scope = evidenceScope(deps, owner);
	const changed = await backfillStageJournalVideo(
		scope,
		{ segment: input.segment, video: input.video, session: session.name },
		// The rewrite already holds the entries it wrote, and it owns the lock: the
		// page is rendered inside it from those entries rather than from a second read.
		async ({ entries }) => {
			await refreshFlowPage(deps, scope, { entries });
		},
	);
	if (changed === 0) return;
}

/** Drop one discarded segment's reference from its steps, then re-render the page
 * so no section stands for a recording nobody kept. */
async function clearRecordingSegment(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	input: { readonly segment: number },
): Promise<void> {
	const scope = evidenceScope(deps, owner);
	const changed = await clearStageJournalSegment(
		scope,
		{ segment: input.segment, session: session.name },
		async ({ entries }) => {
			await refreshFlowPage(deps, scope, { entries });
		},
	);
	if (changed === 0) return;
}

/** `stage_step`: append one server-timestamped step. Everything the server knows
 * — the time, the session's application and role, the sanitized URL, and the
 * recording segment and offset the step was written at — is filled in here; the
 * caller supplies only its own text. */
async function stageStep(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserStageStepRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const scope = evidenceScope(deps, owner);
	const recording = session.recording;
	const segment = recording?.segment;
	const now = deps.now?.() ?? Date.now();
	let answered: StageJournalEntry | undefined;
	const entry = await appendStageJournalEntry(
		scope,
		{
			session: session.name,
			...(session.app ? { app: session.app } : {}),
			...(session.identity?.role ? { role: session.identity.role } : {}),
			// Sanitized like any evidence URL: the journal outlives the call, so a
			// token in a query string must never reach it.
			url: evidenceUrl(deps, session.url),
			label: body.label,
			...(body.expected === undefined ? {} : { expected: body.expected }),
			...(body.observed === undefined ? {} : { observed: body.observed }),
			...(body.captures === undefined ? {} : { captures: body.captures }),
			...(body.evidence === undefined ? {} : { evidence: body.evidence }),
			...(body.knowledge === undefined ? {} : { knowledge: body.knowledge }),
			...(recording
				? {
						segment: recording.segment,
						offsetMs: Math.max(0, now - recording.startedAt),
					}
				: {}),
		},
		journalRedactor(deps),
		// The append owns the lock and has both the entries and the manifest in
		// hand, so the page is rendered from them here: one step then costs one read
		// of the journal and one of the manifest, and no other writer of this
		// workflow's evidence waits behind a second read outside this section.
		async ({ entries, manifest }) => {
			// A segment can end between this step's read of the recording and its
			// commit: `record_stop` finalises segment N's steps and then this line
			// lands, naming a segment a video was already kept for — or one that was
			// just discarded. The read below is the same tick as the write, so the
			// correction is only ever taken when the segment really did end under it;
			// the step keeps its sequence number and everything else, and is grouped
			// as a step without a recording, which is what it now is.
			const written = entries[entries.length - 1];
			const open = session.recording?.segment;
			const stillOpen =
				segment === undefined ? open === undefined : open === segment;
			const corrected =
				stillOpen || written === undefined
					? entries
					: entries.map((each) =>
							each.seq === written.seq
								? (Object.fromEntries(
										Object.entries(each).filter(
											([key]) => key !== "segment" && key !== "offsetMs",
										),
									) as StageJournalEntry)
								: each,
						);
			answered = corrected.find((each) => each.seq === written?.seq) ?? entry;
			await refreshFlowPage(deps, scope, {
				entries: corrected,
				manifest,
			});
		},
	);
	const step = answered ?? entry;
	return {
		session: session.name,
		step,
		...(step.segment === undefined
			? {}
			: { segment: step.segment, offsetMs: step.offsetMs }),
	};
}

// ---------------------------------------------------------------------------
// Typed stage blocks (`add-stage-flow-blocks`)
// ---------------------------------------------------------------------------

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `stage_blocks`: the generated catalog, compact by default and full for one
 * id. The generated artifact is the review surface; the registry only executes
 * a block whose metadata is already in it. */
function stageBlocks(
	body: import("../../contracts/stage-blocks.ts").StageBlocksRequest,
): import("../../contracts/stage-blocks.ts").StageBlocksResponse {
	const catalog = STAGE_BLOCK_CATALOG as unknown as StageBlockCatalog;
	const filter = {
		...(body.query === undefined ? {} : { query: body.query }),
		...(body.app === undefined ? {} : { app: body.app }),
		...(body.effect === undefined ? {} : { effect: body.effect }),
	};
	if (body.id !== undefined) {
		const blocks = filterFullCatalog(catalog, {
			...filter,
			id: body.id,
			limit: 1,
		});
		if (blocks.length === 0)
			throw new BrowserPoolError(
				"block-unknown",
				`block ${body.id} is not in the stage-block catalog`,
				404,
			);
		return {
			version: 1,
			mode: "full",
			blocks:
				blocks as unknown as import("../../contracts/stage-blocks.ts").StageBlocksResponse["blocks"],
			total: blocks.length,
		};
	}
	const total = filterCompactCatalog(catalog, {
		...filter,
		limit: 100,
	}).length;
	const mode = body.full === true ? "full" : "compact";
	const blocks =
		body.full === true
			? filterFullCatalog(catalog, { ...filter, limit: body.limit ?? 20 })
			: filterCompactCatalog(catalog, { ...filter, limit: body.limit ?? 20 });
	return {
		version: 1,
		mode,
		blocks:
			blocks as unknown as import("../../contracts/stage-blocks.ts").StageBlocksResponse["blocks"],
		total,
	};
}

/** Capture one bounded text artifact through the same evidence store as a
 * screenshot. Used for failure snapshots and log tails, never for a success
 * path where the model should read the live page instead. */
async function storeTextEvidence(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	input: {
		readonly text: string;
		readonly caption: string;
		readonly kind: "trace" | "log" | "other";
	},
): Promise<string> {
	const redact = journalRedactor(deps);
	const entry = await storeEvidence(deps, owner, {
		text: redact(input.text),
		kind: input.kind,
		caption: redact(input.caption),
		url: evidenceUrl(deps, session.url),
		extension: "txt",
		...(session.app ? { app: session.app } : {}),
	});
	return entry.id;
}

/** Failure evidence is deliberately small: one screenshot, one bounded
 * snapshot, and the newest console/network lines. A failed block must leave
 * enough to diagnose without turning the run result into a page dump. */
async function captureBlockFailureEvidence(
	deps: BrowserRouteDeps,
	owner: string,
	session: BrowserSession,
	host: {
		capture(
			label: string,
			options?: { readonly ref?: string; readonly view?: boolean },
		): Promise<string>;
	},
): Promise<{ evidenceIds: string[] }> {
	const evidenceIds: string[] = [];
	try {
		evidenceIds.push(await host.capture("Block failure screenshot"));
	} catch {
		// The page may already be gone; the remaining evidence is still useful.
	}
	try {
		const state = await session.snapshot({ depth: 6, maxChars: 8_000 });
		evidenceIds.push(
			await storeTextEvidence(deps, owner, session, {
				text: state.text,
				caption: "Bounded page snapshot at block failure",
				kind: "log",
			}),
		);
	} catch {
		// Snapshots can be unavailable after a crash.
	}
	try {
		const consoleTail = session.consoleEntries({ limit: 20 });
		if (consoleTail.length > 0)
			evidenceIds.push(
				await storeTextEvidence(deps, owner, session, {
					text: consoleTail
						.map((entry) => `${entry.at} ${entry.level}: ${entry.text}`)
						.join("\n"),
					caption: "Console tail at block failure",
					kind: "log",
				}),
			);
	} catch {
		// Console history is best-effort failure evidence.
	}
	try {
		const networkTail = session.networkEntries({ limit: 20 });
		if (networkTail.length > 0)
			evidenceIds.push(
				await storeTextEvidence(deps, owner, session, {
					text: networkTail
						.map((entry) =>
							`${entry.method} ${entry.status ?? ""} ${entry.url}`.trim(),
						)
						.join("\n"),
					caption: "Network tail at block failure",
					kind: "log",
				}),
			);
	} catch {
		// Network history is best-effort failure evidence.
	}
	return { evidenceIds };
}

/** `stage_run`: validate first, then execute the block plan against exactly one
 * stage-bound session. The result is compact; the journal and evidence files
 * hold the detail. */
async function stageRun(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/stage-blocks.ts").StageRunRequest,
): Promise<unknown> {
	const raw = body.plan;
	if (!isRecordValue(raw))
		throw new BrowserPoolError(
			"stage-plan-invalid",
			"the plan must be an object",
			400,
		);
	const secretValues = redactionSecrets(deps).map((secret) => secret.value);
	let stagePlan: StageTestPlan | undefined;
	let missing: string[] = [];
	let blockPlan: StageBlockPlan;
	if (Array.isArray(raw.route)) {
		stagePlan = decodeContract<StageTestPlan>(
			"core.stage-test-plan",
			StageTestPlanSchema,
			raw,
		);
		const workflowId = ownerWorkflowId(owner);
		const projected = blockPlanFromRoute(
			stagePlan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{
				...(workflowId === undefined
					? {}
					: {
							planId: `stage-${workflowId}-r${body.approvedRevision ?? 0}`,
						}),
				...(stagePlan.flowId === undefined ? {} : { flowId: stagePlan.flowId }),
				...(body.approvedRevision === undefined
					? {}
					: { revision: body.approvedRevision }),
				...(stagePlan.inputs === undefined
					? {}
					: {
							inputs: stagePlan.inputs as Readonly<Record<string, JsonValue>>,
						}),
			},
		);
		blockPlan = projected.plan;
		missing = [...projected.missing];
		if (body.save === true && missing.length > 0)
			throw new BrowserPoolError(
				"flow-mixed-plan",
				`a saved flow needs a block on every route step; ${missing.join(", ")} have none`,
				400,
			);
	} else {
		blockPlan = raw as unknown as StageBlockPlan;
		if (body.save === true && blockPlan.flowId === undefined)
			throw new BrowserPoolError(
				"flow-identity-missing",
				"saving a flow needs the approved stage plan with a flowId; a standalone block plan is run-only",
				400,
			);
	}
	if (body.save === true && stagePlan === undefined)
		throw new BrowserPoolError(
			"flow-identity-missing",
			"saving a flow needs the approved stage plan, not a standalone block plan",
			400,
		);

	if (body.dryRun === true) {
		const validation = validateStageBlockPlan(blockPlan, {
			registry: stageBlockRegistry,
			secretValues,
		});
		const derived = deriveInputSchema(blockPlan, stageBlockRegistry);
		const issues = [...validation.issues, ...derived.issues];
		return {
			planId: validation.plan?.planId ?? "plan-dry-run",
			...(blockPlan.flowId === undefined ? {} : { flowId: blockPlan.flowId }),
			...(body.approvedRevision === undefined
				? {}
				: { revision: body.approvedRevision }),
			inputsHash: validation.plan?.inputsHash ?? "sha256:dry-run",
			stage: body.stage ?? "unopened",
			status: issues.length === 0 ? "passed" : "failed",
			steps: [],
			versions: validation.plan?.versions ?? {},
			durationMs: 0,
			dryRun: {
				ok: issues.length === 0,
				issues: issues.slice(0, 20),
				versions: validation.plan?.versions ?? {},
				inputSchema: derived.schema,
			},
		};
	}

	const session = await sessionFor(deps, owner, body.session, used);
	const binding = session.stage;
	if (binding === undefined)
		throw new BrowserPoolError(
			"stage-session-required",
			"stage_run needs a stage-bound session; open one with browser_open({stage, stageApp}) first",
			400,
		);
	const entry = stageEntryFor(deps, binding.ident);
	if (
		body.stageApp !== undefined &&
		entry.stage.apps[body.stageApp] === undefined
	)
		throw new BrowserPoolError(
			"stage-app-unknown",
			`stage ${binding.ident} does not declare application ${body.stageApp}`,
			404,
		);
	const catalog = stageCatalog(deps);
	const resolvedRole = body.role ?? session.identity?.role;
	const apps: Record<string, { roles: readonly string[] }> = {};
	for (const [key, app] of Object.entries(entry.stage.apps))
		apps[key] = { roles: Object.keys(app.roles ?? {}) };
	const policy: StageBlockPolicy = {
		stage: binding.ident,
		access: binding.access,
		writeAllowed: binding.writeAllowed === true,
		...(resolvedRole === undefined ? {} : { role: resolvedRole }),
		apps,
	};
	const validation = validateStageBlockPlan(blockPlan, {
		registry: stageBlockRegistry,
		policy,
		secretValues,
	});
	const derived = deriveInputSchema(blockPlan, stageBlockRegistry);
	const issues = [...validation.issues, ...derived.issues];
	if (!validation.ok || issues.length > 0)
		throw new BrowserPoolError(
			"stage-plan-invalid",
			`the block plan is not valid: ${issues
				.slice(0, 5)
				.map((issue) => issue.message)
				.join("; ")}`,
			400,
			undefined,
			{
				issues: issues.slice(0, 20),
				versions: validation.plan?.versions ?? {},
			},
		);
	const normalized = validation.plan;
	if (normalized === undefined)
		throw new BrowserPoolError(
			"stage-plan-invalid",
			"the plan is not executable",
			400,
		);

	// The approved plan revision is the one the workflow currently holds. A
	// caller that hands in an older revision gets a re-approval refusal rather
	// than silently driving a different plan.
	const workflowId = ownerWorkflowId(owner);
	const located = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	if (
		body.approvedRevision !== undefined &&
		located?.revision !== undefined &&
		body.approvedRevision !== located.revision
	)
		throw new BrowserPoolError(
			"stage-plan-stale",
			`the plan is approved at revision ${body.approvedRevision}, but the workflow is at revision ${located.revision}; request a fresh plan review`,
			409,
			undefined,
			{ approvedRevision: body.approvedRevision, revision: located.revision },
		);

	const scope = evidenceScope(deps, owner);
	const redact = journalRedactor(deps);
	const credentials = stageCredentialVariables(catalog);
	const env = new Map(
		environmentSecrets(deps.configDir ?? "").map((secret) => [
			secret.name,
			secret.value,
		]),
	);
	const journal = {
		append: async (event: StageBlockJournalEntry) => {
			const written = await appendStageJournalEntry(
				scope,
				{
					session: session.name,
					...(session.app ? { app: session.app } : {}),
					...(resolvedRole === undefined ? {} : { role: resolvedRole }),
					url: evidenceUrl(deps, session.url),
					label: event.subStep,
					planId: event.planId,
					routeStepId: event.routeStepId,
					block: event.block,
					blockVersion: event.version,
					subStep: event.subStep,
					status: event.status,
					...(event.expected === undefined ? {} : { expected: event.expected }),
					...(event.observed === undefined ? {} : { observed: event.observed }),
					...(event.captures === undefined ? {} : { captures: event.captures }),
					evidence: event.evidence,
					...(event.knowledge === undefined
						? {}
						: { knowledge: event.knowledge }),
					...(session.recording
						? {
								segment: session.recording.segment,
								offsetMs: Math.max(
									0,
									(deps.now?.() ?? Date.now()) - session.recording.startedAt,
								),
							}
						: {}),
				},
				redact,
				async ({ entries, manifest }) => {
					await refreshFlowPage(deps, scope, { entries, manifest });
				},
			);
			return { seq: written.seq };
		},
	};

	const result = await runStageBlockPlan({
		plan: normalized,
		stage: binding.ident,
		contextFor: async (step) => {
			const requestedApp =
				step.definition.app === "*"
					? (body.stageApp ??
						Object.keys(entry.stage.apps)[0] ??
						session.app ??
						"")
					: step.definition.app;
			const app = entry.stage.apps[requestedApp];
			if (app === undefined)
				throw new BrowserPoolError(
					"stage-app-unknown",
					`stage ${binding.ident} does not declare application ${requestedApp}`,
					404,
				);
			const page = new SessionBlockPage(session, {
				assertUrl: (url) => assertAllowedOrigin(binding, url),
			});
			const capture = async (
				label: string,
				options?: { readonly ref?: string; readonly view?: boolean },
			): Promise<string> => {
				const reservation = stageUsage(deps).reserveScreenshot({
					stage: binding.ident,
					owner,
					maxScreenshots: binding.limits.maxScreenshots,
				});
				try {
					const bytes = await session.screenshot(
						{
							type: "jpeg",
							quality: SCREENSHOT_QUALITY,
							fullPage: true,
							...(options?.ref === undefined ? {} : { ref: options.ref }),
						},
						BROWSER_MAX_IMAGE_WIDTH,
					);
					const url = evidenceUrl(deps, session.url);
					const stored = await storeEvidence(deps, owner, {
						bytes,
						kind: "screenshot",
						caption: redact(label) || `Block capture of ${url}`,
						url,
						extension: "jpg",
						...(requestedApp === "" ? {} : { app: requestedApp }),
					});
					return stored.id;
				} catch (error) {
					stageUsage(deps).releaseScreenshot(reservation);
					throw error;
				}
			};
			return {
				page,
				expect: sessionExpect,
				app: requestedApp,
				...(resolvedRole === undefined ? {} : { role: resolvedRole }),
				stage: binding.ident,
				appUrl: app.url,
				secret: (name: string) => {
					if (credentials.get(name)?.stage !== binding.ident)
						throw new Error(
							`stage-secret-undeclared: ${name} is not a credential of stage ${binding.ident}`,
						);
					const value = env.get(name);
					if (value === undefined)
						throw new Error(
							`stage-secret-missing: ${name} is declared by stage ${binding.ident} but is not set`,
						);
					return value;
				},
				capture,
				close: () => undefined,
			};
		},
		journal,
		failureEvidence: async ({ context }) =>
			await captureBlockFailureEvidence(deps, owner, session, context),
	});
	const resultIssues = [
		...(result.issues ?? []),
		...missing.map((routeStepId) => ({
			code: "plan-route-gap",
			message: `route step ${routeStepId} has no block; run it with the exploratory browser tools`,
			routeStepId,
		})),
	];
	let saved: import("../../contracts/stage-blocks.ts").StageRunResponse["saved"];
	if (
		body.save === true &&
		result.status === "passed" &&
		stagePlan !== undefined
	) {
		if (located?.worktree === undefined)
			throw new BrowserPoolError(
				"flow-workspace-missing",
				"saving a flow needs the workflow's own checkout",
				409,
			);
		try {
			const source = flowSourceFromStagePlan({
				stagePlan,
				plan: normalized,
				stage: binding.ident,
				planId: normalized.planId,
				...(body.approvedRevision === undefined
					? {}
					: { revision: body.approvedRevision }),
			});
			const generated = await generateFlow({
				root: located.worktree,
				source,
				registry: stageBlockRegistry,
				secretValues,
			});
			if (generated.manifest === undefined || generated.issues.length > 0)
				throw new BrowserPoolError(
					"flow-invalid",
					`the flow could not be generated: ${generated.issues
						.slice(0, 5)
						.map((issue) => issue.message)
						.join("; ")}`,
					400,
					undefined,
					{ issues: generated.issues.slice(0, 20) },
				);
			saved = {
				flowId: generated.manifest.flowId,
				specPath: generated.specPath ?? "",
				manifestPath: generated.manifestPath ?? "",
				routeHash: generated.routeHash ?? generated.manifest.routeHash,
				specHash: generated.specHash ?? generated.manifest.specHash,
				inputsHash: generated.inputsHash ?? normalized.inputsHash,
				...(generated.existing === true ? { existing: true } : {}),
			};
		} catch (error) {
			if (error instanceof FlowSourceError)
				throw new BrowserPoolError(error.code, error.message, 400);
			throw error;
		}
	}
	return {
		...result,
		...(resultIssues.length === 0 ? {} : { issues: resultIssues.slice(0, 20) }),
		...(saved === undefined ? {} : { saved }),
	};
}

/** `stage_flows`: list the checked-in compiled flows of this stage's checkout.
 * It never opens a browser and never returns an input value. */
function stageFlows(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/stage-replay.ts").StageFlowsRequest,
): unknown {
	const workflowId = ownerWorkflowId(owner);
	const located = workflowId
		? (deps.locate ?? locateEvidenceWorkflow)(workflowId)
		: undefined;
	if (located?.worktree === undefined)
		return {
			version: 1 as const,
			flows: [],
			total: 0,
			issues: [
				{
					code: "flow-workspace-missing",
					message: "the workflow has no checkout with stage-flows",
				},
			],
		};
	const registry = readFlowRegistry(located.worktree);
	const stage = body.stage ?? located.stage;
	const query = body.query?.trim().toLowerCase();
	const flows = registry.entries
		.filter(
			(entry) =>
				(stage === undefined ||
					entry.manifest.stage === stage ||
					entry.manifest.stages?.includes(stage) === true) &&
				(query === undefined ||
					query === "" ||
					entry.manifest.flowId.includes(query) ||
					entry.manifest.title.toLowerCase().includes(query) ||
					entry.manifest.applications.some((app) => app.includes(query))),
		)
		.slice(0, Math.min(body.limit ?? 50, 100))
		.map((entry) => compactFlowEntry(entry.manifest));
	return {
		version: 1 as const,
		flows,
		total: flows.length,
		issues: registry.issues.slice(0, 50),
	};
}

function replayApprovedInputs(
	plan: StageTestPlan,
): Readonly<Record<string, JsonValue>> {
	return (plan.inputs ?? {}) as Readonly<Record<string, JsonValue>>;
}

function replayPlanId(
	workflowId: string,
	revision: number | undefined,
): string {
	return `stage-${workflowId}-r${revision ?? 0}`;
}

function replayEntryFor(
	root: string,
	flowId: string,
): ReturnType<typeof readFlowRegistry>["entries"][number] | undefined {
	return readFlowRegistry(root).entries.find(
		(entry) => entry.manifest.flowId === flowId,
	);
}

function replayApps(
	entry: ReturnType<typeof stageEntryFor>,
): Record<string, { roles: readonly string[] }> {
	const apps: Record<string, { roles: readonly string[] }> = {};
	for (const [key, app] of Object.entries(entry.stage.apps))
		apps[key] = { roles: Object.keys(app.roles ?? {}) };
	return apps;
}

function replayResponseSteps(
	result: ReplayResult,
	journalIds: ReadonlyMap<number, readonly number[]>,
	evidenceIds: ReadonlyMap<number, readonly string[]>,
	fileIds: ReadonlyMap<string, string>,
): import("../../contracts/stage-replay.ts").StageReplayStepResponse[] {
	return result.steps.map((step) => ({
		index: step.index,
		routeStepId: step.routeStepId,
		block: step.block,
		version: step.version,
		status: step.status,
		durationMs: step.durationMs,
		...(step.outputs === undefined
			? {}
			: { outputs: step.outputs as Readonly<Record<string, unknown>> }),
		journalIds: journalIds.get(step.index) ?? [],
		evidenceIds: [
			...new Set([
				...(step.evidence ?? []).flatMap((name) => {
					const id = fileIds.get(name);
					return id === undefined ? [] : [id];
				}),
				...(evidenceIds.get(step.index) ?? []),
			]),
		],
		...(step.error === undefined ? {} : { error: step.error }),
	}));
}

/** `stage_replay`: validate the approved plan against the checked-in manifest,
 * then run the generated spec in a separate Playwright process. No model and no
 * per-step browser tool sits in this route. */
async function stageReplay(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/stage-replay.ts").StageReplayRequest & {
		flowId: string;
	},
): Promise<import("../../contracts/stage-replay.ts").StageReplayResponse> {
	const workflowId = ownerWorkflowId(owner);
	if (workflowId === undefined)
		throw new BrowserPoolError(
			"stage-plan-missing",
			"stage replay belongs to a workflow run",
			403,
		);
	const located = (deps.locate ?? locateEvidenceWorkflow)(workflowId);
	if (located?.stageTestPlan === undefined)
		throw new BrowserPoolError(
			"stage-plan-missing",
			"the workflow holds no approved stage-test plan",
			409,
		);
	const stage = body.stage ?? located.stage;
	if (stage === undefined)
		throw new BrowserPoolError(
			"stage-mismatch",
			"the workflow has no pinned stage",
			409,
		);
	if (located.stage !== undefined && stage !== located.stage)
		throw new BrowserPoolError(
			"stage-mismatch",
			`the workflow is pinned to ${located.stage}, not ${stage}`,
			409,
		);
	if (
		body.approvedRevision !== undefined &&
		located.revision !== undefined &&
		body.approvedRevision !== located.revision
	)
		throw new BrowserPoolError(
			"stage-plan-stale",
			`the plan is approved at revision ${body.approvedRevision}, but the workflow is at revision ${located.revision}`,
			409,
		);
	if (located.worktree === undefined)
		throw new BrowserPoolError(
			"flow-workspace-missing",
			"stage replay needs the workflow's checkout with stage-flows",
			409,
		);
	const revision = body.approvedRevision ?? located.revision;
	const stagePlan = decodeContract<StageTestPlan>(
		"core.stage-test-plan",
		StageTestPlanSchema,
		located.stageTestPlan,
	);
	if (stagePlan.flowId === undefined)
		throw new BrowserPoolError(
			"flow-identity-missing",
			"the approved plan does not name a flowId",
			409,
		);
	if (stagePlan.flowId !== body.flowId)
		throw new BrowserPoolError(
			"flow-id-mismatch",
			`the approved plan names ${stagePlan.flowId}, not ${body.flowId}`,
			409,
		);
	const entry = stageEntryFor(deps, stage);
	const projected = blockPlanFromRoute(
		stagePlan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: replayPlanId(workflowId, revision),
			flowId: stagePlan.flowId,
			...(revision === undefined ? {} : { revision }),
			...(stagePlan.inputs === undefined
				? {}
				: { inputs: stagePlan.inputs as Readonly<Record<string, JsonValue>> }),
		},
	);
	if (projected.missing.length > 0)
		throw new BrowserPoolError(
			"flow-not-fully-blocked",
			`the approved plan has no block on ${projected.missing.join(", ")}`,
			409,
		);
	const role =
		body.role ?? stagePlan.route.find((step) => step.role !== undefined)?.role;
	const writeAllowed =
		entry.stage.access === "writable" && stagePlan.createsData === true;
	const policy: StageBlockPolicy = {
		stage,
		access: entry.stage.access,
		writeAllowed,
		...(role === undefined ? {} : { role }),
		apps: replayApps(entry),
	};
	const secretValues = redactionSecrets(deps).map((secret) => secret.value);
	const validation = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy,
		secretValues,
	});
	if (!validation.ok || validation.plan === undefined)
		throw new BrowserPoolError(
			"flow-invalid-plan",
			`the approved replay plan is not valid: ${validation.issues
				.slice(0, 5)
				.map((issue) => issue.message)
				.join("; ")}`,
			400,
			undefined,
			{ issues: validation.issues.slice(0, 20) },
		);
	const normalized = validation.plan;
	let source: import("../../stage-blocks/flow.ts").FlowSource;
	try {
		source = flowSourceFromStagePlan({
			stagePlan,
			plan: normalized,
			stage,
			planId: normalized.planId,
			...(revision === undefined ? {} : { revision }),
		});
	} catch (error) {
		if (error instanceof FlowSourceError)
			throw new BrowserPoolError(error.code, error.message, 409);
		throw error;
	}
	const manifestEntry = replayEntryFor(located.worktree, body.flowId);
	if (manifestEntry === undefined)
		throw new BrowserPoolError(
			"flow-not-found",
			`flow ${body.flowId} is not saved under stage-flows`,
			409,
		);
	const eligibility = flowEligibility({
		flowId: body.flowId,
		root: located.worktree,
		stage,
		source,
		registry: stageBlockRegistry,
		apps: replayApps(entry),
		...(role === undefined ? {} : { role }),
	});
	const approvedInputs = replayApprovedInputs(stagePlan);
	const proposedInputs = (body.inputs ?? approvedInputs) as Readonly<
		Record<string, JsonValue>
	>;
	const approvedHash = canonicalInputsHash(approvedInputs);
	const proposedHash = canonicalInputsHash(proposedInputs);
	if (body.dryRun === true) {
		const drySource = { ...source, inputs: proposedInputs };
		const dryEligibility = flowEligibility({
			flowId: body.flowId,
			root: located.worktree,
			stage,
			source: drySource,
			registry: stageBlockRegistry,
			apps: replayApps(entry),
			...(role === undefined ? {} : { role }),
		});
		const issues = [...dryEligibility.issues];
		if (proposedHash !== approvedHash)
			issues.push({
				code: "flow-inputs-unapproved",
				message:
					"the proposed inputs differ from the approved plan; a new plan revision is required before execution",
			});
		return {
			flowId: body.flowId,
			...(normalized.planId === undefined ? {} : { planId: normalized.planId }),
			...(revision === undefined ? {} : { revision }),
			inputsHash: proposedHash,
			routeHash: manifestEntry.manifest.routeHash,
			specHash: manifestEntry.manifest.specHash,
			stage,
			status: issues.length === 0 ? "passed" : "failed",
			startedAt: new Date().toISOString(),
			durationMs: 0,
			steps: [],
			dryRun: {
				eligible: dryEligibility.eligible,
				approved: proposedHash === approvedHash,
				issues: issues.slice(0, 50),
				inputSchema: manifestEntry.manifest.inputSchema as unknown as Readonly<
					Record<string, unknown>
				>,
				proposedInputsHash: proposedHash,
			},
		};
	}
	if (body.inputs !== undefined && proposedHash !== approvedHash)
		throw new BrowserPoolError(
			"flow-inputs-unapproved",
			"the supplied inputs differ from the approved plan revision; a new plan review is required",
			409,
		);
	if (!eligibility.eligible)
		throw new BrowserPoolError(
			"flow-not-eligible",
			`flow ${body.flowId} is not replay-eligible: ${eligibility.issues
				.slice(0, 5)
				.map((issue) => issue.message)
				.join("; ")}`,
			409,
			undefined,
			{ issues: eligibility.issues.slice(0, 50) },
		);
	const appUrls = Object.fromEntries(
		Object.entries(entry.stage.apps).map(([key, app]) => [key, app.url]),
	);
	const catalog = stageCatalog(deps);
	const stageVariables = [...stageCredentialVariables(catalog).entries()]
		.filter((entry) => entry[1].stage === stage)
		.map((entry) => entry[0]);
	const configuredSecrets = environmentSecrets(deps.configDir ?? "");
	const availableSecrets = new Map(
		configuredSecrets.map((secret) => [secret.name, secret.value]),
	);
	const credentials = Object.fromEntries(
		stageVariables
			.filter((name) => availableSecrets.has(name))
			.map((name) => [name, availableSecrets.get(name) as string]),
	);
	const redact = journalRedactor(deps);
	const startedAt = new Date();
	const started = Date.now();
	const processResult = await runReplayProcess({
		root: located.worktree,
		specPath: manifestEntry.specPath,
		flowId: body.flowId,
		stage,
		...(role === undefined ? {} : { role }),
		apps: appUrls,
		inputs: approvedInputs,
		...(normalized.planId === undefined ? {} : { planId: normalized.planId }),
		...(revision === undefined ? {} : { revision }),
		routeHash: manifestEntry.manifest.routeHash,
		inputsHash: approvedHash,
		writeAllowed,
		dataRoot: evidenceScope(deps, owner).dataRoot,
		...(deps.installer?.installedChromium() === undefined
			? {}
			: { executablePath: deps.installer.installedChromium() }),
		credentials,
		secretNames: stageVariables,
		hiddenEnvNames: [
			...configuredSecrets
				.map((secret) => secret.name)
				.filter((name) => !stageVariables.includes(name)),
			"AGENTIC_ENV_TOKEN",
			"HERDR_RUN_TOKEN",
			"AGENTIC_WORKFLOW_TOKEN",
		],
	});
	const durationMs = Date.now() - started;
	if (processResult.timedOut)
		return {
			flowId: body.flowId,
			...(normalized.planId === undefined ? {} : { planId: normalized.planId }),
			...(revision === undefined ? {} : { revision }),
			inputsHash: approvedHash,
			routeHash: manifestEntry.manifest.routeHash,
			specHash: manifestEntry.manifest.specHash,
			stage,
			status: "failed",
			startedAt: startedAt.toISOString(),
			durationMs,
			steps: [],
			issues: [
				{
					code: "replay-timeout",
					message: redact(
						`the replay process exceeded its overall timeout; partial output: ${processResult.stderr.slice(0, 500) || processResult.stdout.slice(0, 500)}`,
					),
				},
			],
		};
	const result = decodeReplayResult(
		processResult.resultPath,
		{
			flowId: body.flowId,
			routeHash: manifestEntry.manifest.routeHash,
			inputsHash: approvedHash,
		},
		processResult.exitCode,
		redact,
		{ stdout: processResult.stdout, stderr: processResult.stderr },
	);
	const scope = evidenceScope(deps, owner);
	const fileIds = new Map<string, string>();
	const journalIds = new Map<number, number[]>();
	const evidenceIds = new Map<number, string[]>();
	const events: readonly ReplayEvent[] = replayEventsFromSteps(result);
	for (const event of events) {
		const route = manifestEntry.manifest.routeSteps.find(
			(step) => step.routeStepId === event.routeStepId,
		);
		if (
			route === undefined ||
			route.block !== event.block ||
			event.subStep.trim() === ""
		)
			throw new BrowserPoolError(
				"replay-result-invalid",
				`the replay event for ${event.routeStepId} does not match the manifest`,
				502,
			);
		const eventEvidence: string[] = [];
		for (const name of event.evidence ?? []) {
			let id = fileIds.get(name);
			if (id === undefined) {
				const absolute = path.resolve(processResult.evidenceDir, name);
				if (
					!absolute.startsWith(
						`${path.resolve(processResult.evidenceDir)}${path.sep}`,
					) ||
					!fs.existsSync(absolute) ||
					!fs.statSync(absolute).isFile() ||
					fs.statSync(absolute).size > EVIDENCE_FILE_MAX_BYTES
				)
					throw new BrowserPoolError(
						"replay-result-invalid",
						`replay evidence ${name} is missing, outside the run directory or too large`,
						502,
					);
				stageUsage(deps).reserveScreenshot({
					stage,
					owner,
					maxScreenshots: entry.limits.maxScreenshots,
				});
				const stored = await storeEvidence(deps, owner, {
					file: absolute,
					kind: "screenshot",
					caption: redact(
						`Replay ${body.flowId} ${event.routeStepId}: ${event.subStep}`,
					),
					url: evidenceUrl(deps, event.url ?? ""),
					extension: path.extname(absolute).replace(".", "") || "jpg",
					...(event.app === undefined ? {} : { app: event.app }),
				});
				id = stored.id;
				fileIds.set(name, id);
			}
			eventEvidence.push(id);
		}
		const written = await appendStageJournalEntry(
			scope,
			{
				session: "replay",
				...(event.app === undefined ? {} : { app: event.app }),
				...(event.role === undefined ? {} : { role: event.role }),
				...(event.url === undefined
					? {}
					: { url: evidenceUrl(deps, event.url) }),
				label: event.subStep,
				planId: normalized.planId,
				routeStepId: event.routeStepId,
				block: event.block,
				blockVersion: event.version,
				subStep: event.subStep,
				status: event.status,
				...(event.expected === undefined ? {} : { expected: event.expected }),
				...(event.observed === undefined ? {} : { observed: event.observed }),
				...(event.captures === undefined ? {} : { captures: event.captures }),
				evidence: eventEvidence,
				flowId: body.flowId,
				...(revision === undefined ? {} : { revision }),
				inputsHash: approvedHash,
				replayRunId: processResult.runId,
				source: "replay",
			},
			redact,
			async ({ entries, manifest }) => {
				await refreshFlowPage(deps, scope, { entries, manifest });
			},
		);
		const perJournal = journalIds.get(event.index) ?? [];
		perJournal.push(written.seq);
		journalIds.set(event.index, perJournal);
		const perEvidence = evidenceIds.get(event.index) ?? [];
		perEvidence.push(...eventEvidence);
		evidenceIds.set(event.index, perEvidence);
	}
	const stepResponses = replayResponseSteps(
		result,
		journalIds,
		evidenceIds,
		fileIds,
	);
	const facts = result.steps.map((step) => ({
		index: step.index,
		journalIds: journalIds.get(step.index) ?? [],
		evidenceIds: [
			...new Set([
				...(evidenceIds.get(step.index) ?? []),
				...(step.evidence ?? []).flatMap((name) => {
					const id = fileIds.get(name);
					return id === undefined ? [] : [id];
				}),
			]),
		],
	}));
	const failedStep = result.steps.find((step) => step.status === "failed");
	const failedEvents = events.filter(
		(event) =>
			event.routeStepId === failedStep?.routeStepId &&
			event.status === "failed",
	);
	const failedEvent = failedEvents.at(-1);
	const heal =
		failedStep === undefined
			? undefined
			: buildHealPacket({
					manifest: manifestEntry.manifest,
					result,
					registry: stageBlockRegistry,
					evidenceIds:
						facts.find((fact) => fact.index === failedStep.index)
							?.evidenceIds ?? [],
					journalIds:
						facts.find((fact) => fact.index === failedStep.index)?.journalIds ??
						[],
					...(processResult.tracePath === undefined
						? {}
						: { tracePath: processResult.tracePath }),
					scopedRegion: {
						routeStepId: failedStep.routeStepId,
						block: failedStep.block,
						...(failedEvent === undefined
							? {}
							: { subStep: failedEvent.subStep }),
					},
				});
	let healWithEvidence: Readonly<Record<string, unknown>> | undefined;
	if (heal !== undefined) {
		const redactedHeal = redactDeep(heal, redact) as Readonly<
			Record<string, unknown>
		>;
		const stored = await storeEvidence(deps, owner, {
			text: `${JSON.stringify(redactedHeal, null, 2)}\n`,
			kind: "log",
			caption: `Stage heal packet for ${body.flowId}`,
			url: "",
			extension: "json",
		});
		healWithEvidence = { ...redactedHeal, evidenceId: stored.id };
		try {
			fs.writeFileSync(
				path.join(processResult.runDir, "stage-heal.json"),
				`${JSON.stringify(healWithEvidence, null, 2)}\n`,
				{ mode: 0o600 },
			);
		} catch {
			// The attached evidence is authoritative; the file is a convenience.
		}
	}
	const mapped = mapReplayToReport(
		manifestEntry.manifest,
		result,
		stagePlan,
		facts,
	);
	const redactedReport = redactDeep(mapped.report, redact) as Readonly<
		Record<string, unknown>
	>;
	let reportEvidenceId: string | undefined;
	if (mapped.complete) {
		const stored = await storeEvidence(deps, owner, {
			text: `${JSON.stringify(redactedReport, null, 2)}\n`,
			kind: "log",
			caption: `Stage replay report for ${body.flowId}`,
			url: "",
			extension: "json",
		});
		reportEvidenceId = stored.id;
	}
	let resultEvidenceId: string | undefined;
	try {
		const stored = await storeEvidence(deps, owner, {
			text: `${JSON.stringify(redactDeep(result, redact), null, 2)}\n`,
			kind: "log",
			caption: `Stage replay result for ${body.flowId}`,
			url: "",
			extension: "json",
		});
		resultEvidenceId = stored.id;
	} catch {
		// A result that cannot be attached is not a reason to discard the
		// journal and screenshots the replay already produced.
	}
	const issues: Array<{ code: string; message: string; field?: string }> = [];
	if (!mapped.complete)
		issues.push({
			code: "flow-expectation-uncovered",
			message:
				"the replay does not cover every planned expectation; route to the normal tester",
		});
	const redactedSteps = stepResponses.map((step) => ({
		...step,
		...(step.error === undefined ? {} : { error: redact(step.error) }),
	}));
	return {
		flowId: body.flowId,
		...(normalized.planId === undefined ? {} : { planId: normalized.planId }),
		...(revision === undefined ? {} : { revision }),
		inputsHash: approvedHash,
		routeHash: manifestEntry.manifest.routeHash,
		specHash: manifestEntry.manifest.specHash,
		stage,
		status: result.status,
		startedAt: startedAt.toISOString(),
		durationMs,
		steps: redactedSteps,
		blockVersions: manifestEntry.manifest.blockVersions,
		blockDigests: manifestEntry.manifest.blockDigests,
		...(failedStep === undefined
			? {}
			: {
					failure: {
						index: failedStep.index,
						routeStepId: failedStep.routeStepId,
						block: failedStep.block,
						version: failedStep.version,
						message: redact(
							failedEvent?.error ??
								failedStep.error ??
								result.error ??
								"the replay failed",
						),
						retryable: heal?.retryable ?? false,
					},
				}),
		...(healWithEvidence === undefined ? {} : { heal: healWithEvidence }),
		...(mapped.complete ? { report: redactedReport } : {}),
		...(reportEvidenceId === undefined ? {} : { reportEvidenceId }),
		...(resultEvidenceId === undefined ? {} : { resultEvidenceId }),
		...(issues.length === 0 ? {} : { issues }),
	};
}

/** `stage_replay({ suiteId })`: an independent-flow-entries regression batch
 * (`add-stage-flow-replay`, design D7). Every entry goes through exactly the
 * same approval/eligibility/execution path a lone `flowId` call would (the
 * single-flow `stageReplay` above, reused per entry), so the suite adds only
 * manifest loading, bounded concurrency and aggregation — never a second
 * approval rule and never a `core.stage-test-plan` report mapping. */
async function stageReplaySuite(
	deps: BrowserRouteDeps,
	owner: string,
	body: import("../../contracts/stage-replay.ts").StageReplayRequest & {
		suiteId: string;
	},
): Promise<import("../../contracts/stage-replay.ts").StageSuiteResponse> {
	const workflowId = ownerWorkflowId(owner);
	if (workflowId === undefined)
		throw new BrowserPoolError(
			"stage-plan-missing",
			"stage replay belongs to a workflow run",
			403,
		);
	const located = (deps.locate ?? locateEvidenceWorkflow)(workflowId);
	if (located?.worktree === undefined)
		throw new BrowserPoolError(
			"flow-workspace-missing",
			"stage replay needs the workflow's checkout with stage-flows",
			409,
		);
	const stage = body.stage ?? located.stage;
	if (stage === undefined)
		throw new BrowserPoolError(
			"stage-mismatch",
			"the workflow has no pinned stage",
			409,
		);
	const manifestPath = path.join(
		located.worktree,
		STAGE_FLOW_DIRECTORY,
		`${body.suiteId}${STAGE_SUITE_EXTENSION}`,
	);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new BrowserPoolError(
			"suite-not-found",
			`suite ${body.suiteId} is not saved under stage-flows (${error instanceof Error ? error.message : String(error)})`,
			409,
		);
	}
	const { manifest, issues } = parseSuiteManifest(raw);
	if (manifest === undefined)
		throw new BrowserPoolError(
			"suite-manifest-invalid",
			`the suite manifest is not valid: ${issues
				.slice(0, 5)
				.map((issue) => issue.message)
				.join("; ")}`,
			409,
			undefined,
			{ issues: issues.slice(0, 50) },
		);
	if (manifest.suiteId !== body.suiteId)
		throw new BrowserPoolError(
			"suite-id-mismatch",
			`the manifest names suite ${manifest.suiteId}, not ${body.suiteId}`,
			409,
		);
	const startedAt = new Date();
	const started = Date.now();
	// Bounded by the pool's own session cap and a fixed suite ceiling, so a
	// large suite cannot launch more concurrent browser processes than the
	// stage's configured `browser.max_sessions` (task 9.3).
	const maxWorkers = Math.max(1, Math.min(deps.settings().maxSessions, 4));
	const run = async (entry: SuiteFlowEntry): Promise<SuiteEntryResult> => {
		try {
			const response = await stageReplay(deps, owner, {
				flowId: entry.flowId,
				...(entry.inputs === undefined ? {} : { inputs: entry.inputs }),
				stage,
				...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
				...(body.approvedRevision === undefined
					? {}
					: { approvedRevision: body.approvedRevision }),
				...(body.role === undefined ? {} : { role: body.role }),
			});
			const evidenceIds = [
				...new Set(response.steps.flatMap((step) => step.evidenceIds ?? [])),
			];
			return {
				id: entry.id,
				flowId: entry.flowId,
				status: response.status === "passed" ? "passed" : "failed",
				inputsHash: response.inputsHash,
				routeHash: response.routeHash,
				...(evidenceIds.length === 0 ? {} : { evidenceIds }),
				...(response.reportEvidenceId === undefined
					? {}
					: { reportEvidenceId: response.reportEvidenceId }),
				...(response.resultEvidenceId === undefined
					? {}
					: { resultEvidenceId: response.resultEvidenceId }),
				...(response.failure === undefined
					? {}
					: { error: response.failure.message }),
			};
		} catch (error) {
			if (error instanceof BrowserPoolError)
				return {
					id: entry.id,
					flowId: entry.flowId,
					status: "refused",
					code: error.code,
					error: error.message,
				};
			throw error;
		}
	};
	const outcome = await runSuiteEntries(manifest, run, { maxWorkers });
	const durationMs = Date.now() - started;
	const redact = journalRedactor(deps);
	const redacted = redactDeep(outcome, redact) as typeof outcome;
	let resultEvidenceId: string | undefined;
	try {
		const stored = await storeEvidence(deps, owner, {
			text: `${JSON.stringify(redacted, null, 2)}\n`,
			kind: "log",
			caption: `Stage suite result for ${body.suiteId}`,
			url: "",
			extension: "json",
		});
		resultEvidenceId = stored.id;
	} catch {
		// Aggregate evidence is a convenience; every entry already recorded its
		// own result/report evidence through the reused single-flow path.
	}
	return {
		suiteId: body.suiteId,
		stage,
		parallel: manifest.parallel,
		stopOnFailure: manifest.stopOnFailure,
		status: redacted.status,
		startedAt: startedAt.toISOString(),
		durationMs,
		entries: redacted.entries,
		...(resultEvidenceId === undefined ? {} : { resultEvidenceId }),
	};
}

/** `stage_journal`: read the latest steps back, bounded and optionally narrowed
 * to one session or application. */
async function stageJournalRead(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserStageJournalRequest,
): Promise<unknown> {
	// Naming a session resolves it (and refuses one this run does not hold), but a
	// read is not an action of the stage: it drives no page.
	const session =
		body.session === undefined
			? undefined
			: await sessionFor(deps, owner, body.session, used, {
					countAction: false,
				});
	const scope = evidenceScope(deps, owner);
	return journalSummary(scope, {
		...(session === undefined ? {} : { session: session.name }),
		...(body.app === undefined ? {} : { app: body.app }),
		...(body.limit === undefined ? {} : { limit: body.limit }),
	});
}

/** Whether a URL matches a `stage_wait` pattern: a glob in which `*` matches any
 * run of characters, matched against the whole URL. A pattern without a `*` is a
 * substring, which is what an operator writes for "somewhere on this route". */
function urlMatchesPattern(url: string, pattern: string): boolean {
	if (!pattern.includes("*")) return url.includes(pattern);
	const parts = pattern.split("*");
	const first = parts[0] ?? "";
	const last = parts[parts.length - 1] ?? "";
	const anchoredStart = !pattern.startsWith("*");
	const anchoredEnd = !pattern.endsWith("*");
	if (anchoredStart && !url.startsWith(first)) return false;
	// The tail is what the walk may not run past, so a pattern like `*a*b` cannot
	// consume the `b` it has to end with.
	const end = anchoredEnd ? url.length - last.length : url.length;
	if (anchoredEnd && (end < 0 || !url.endsWith(last))) return false;
	const middle = parts.slice(
		anchoredStart ? 1 : 0,
		anchoredEnd ? -1 : undefined,
	);
	let at = anchoredStart ? first.length : 0;
	for (const part of middle) {
		if (at > end) return false;
		if (part === "") continue;
		const found = url.indexOf(part, at);
		if (found < 0 || found + part.length > end) return false;
		at = found + part.length;
	}
	return at <= end;
}

/** The one shape a mail-catcher read answers with, as much of it as this module
 * reads: Mailpit's search endpoint reports a `total` (and the messages). */
async function mailCaught(
	deps: BrowserRouteDeps,
	session: BrowserSession,
	condition: import("../../contracts/browser.ts").StageWaitMail,
): Promise<{ met: boolean; detail?: string }> {
	if (!session.stage)
		throw new StageLimitError(
			"stage-mail-unsupported",
			"a `mail` wait reads the stage's mail catcher, and this session is not bound to a stage",
		);
	const entry = stageByIdent(stageCatalog(deps), session.stage.ident);
	// A session's `app` is the stage app's key *or*, when the stage app links a
	// configured ident, that ident (`resolveOpenTarget`): both name the same app, so
	// the catcher is found by either rather than by the key alone.
	const app =
		entry === undefined
			? undefined
			: (Object.entries(entry.stage.apps).find(
					([key, candidate]) =>
						key === session.app || candidate.app === session.app,
				) ?? [])[1];
	if (!entry || !app || app.kind !== "mail-catcher" || app.api !== "mailpit")
		throw new StageLimitError(
			"stage-mail-unsupported",
			`a \`mail\` wait needs a mail-catcher application speaking mailpit; open one of the stage's mail-catcher apps (this session is on ${JSON.stringify(session.app ?? "no app")})`,
		);
	if (condition.to === undefined && condition.subject === undefined)
		throw new BrowserPoolError(
			"mail-condition-empty",
			"a `mail` wait needs `to` or `subject` to search by",
			400,
		);
	// The search query is Mailpit's own syntax: a field prefix per term, quoted so
	// a subject's spaces stay one term.
	const terms: string[] = [];
	if (condition.to !== undefined) terms.push(`to:${quotedTerm(condition.to)}`);
	if (condition.subject !== undefined)
		terms.push(`subject:${quotedTerm(condition.subject)}`);
	let url: URL;
	try {
		url = new URL("/api/v1/search", app.url);
	} catch {
		throw new BrowserPoolError(
			"mail-catcher-unreachable",
			`the mail catcher's url ${JSON.stringify(app.url)} is not a URL`,
			500,
		);
	}
	url.searchParams.set("query", terms.join(" "));
	url.searchParams.set("limit", "1");
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(STAGE_WAIT_POLL_TIMEOUT_MS),
		});
	} catch {
		// A catcher that is not up yet is a condition that does not hold, not a
		// failure of the wait: the next poll tries again.
		return { met: false };
	}
	if (!response.ok) return { met: false };
	const body = (await response.json().catch(() => undefined)) as
		| { total?: unknown; messages?: unknown }
		| undefined;
	const total = typeof body?.total === "number" ? body.total : undefined;
	const messages = Array.isArray(body?.messages) ? body.messages.length : 0;
	return { met: (total ?? messages) > 0 };
}

/** One search term, quoted for Mailpit's query syntax with any quote removed so
 * a term cannot end its own quoting. */
function quotedTerm(value: string): string {
	const cleaned = value.replace(/"/g, "").trim();
	return cleaned.includes(" ") ? `"${cleaned}"` : cleaned;
}

/** Whether the one condition holds right now. Never throws for a condition that
 * simply is not true yet. */
async function waitConditionMet(
	deps: BrowserRouteDeps,
	session: BrowserSession,
	until: import("../../contracts/browser.ts").StageWaitCondition,
): Promise<{ met: boolean; url: string }> {
	if (until.mail !== undefined) {
		const mail = await mailCaught(deps, session, until.mail);
		return { met: mail.met, url: session.url };
	}
	if (until.selector !== undefined) {
		const selector = until.selector;
		const found = await session
			.evaluate(
				`(() => { try { return document.querySelector(${JSON.stringify(selector)}) !== null; } catch { return false; } })()`,
			)
			.catch(() => false);
		return { met: found === true, url: session.url };
	}
	if (until.text !== undefined) {
		const text = until.text;
		const found = await session
			.evaluate(
				`(() => { try { return (document.body && document.body.innerText ? document.body.innerText : "").includes(${JSON.stringify(text)}); } catch { return false; } })()`,
			)
			.catch(() => false);
		return { met: found === true, url: session.url };
	}
	return {
		met: urlMatchesPattern(session.url, until.url ?? ""),
		url: session.url,
	};
}

/**
 * The bounded timing of one `stage_wait`: the requested timeout clamped to the
 * stage's own `limits.maxWaitSeconds`, and the poll interval clamped to the floor
 * and ceiling the tool allows. Pure, so the clamps are testable without a clock,
 * and the floor is the one a run is told about: a poll tighter than five seconds
 * is a page being hammered, not a flow being observed.
 */
export function stageWaitTiming(
	limits: { readonly maxWaitSeconds?: number } | undefined,
	body: {
		readonly timeoutSeconds?: number;
		readonly intervalSeconds?: number;
	},
): { timeoutMs: number; intervalMs: number; timeoutSeconds: number } {
	const maxSeconds = Math.max(
		1,
		limits?.maxWaitSeconds ?? DEFAULT_STAGE_WAIT_MAX_SECONDS,
	);
	const timeoutSeconds =
		body.timeoutSeconds === undefined
			? maxSeconds
			: Math.min(maxSeconds, Math.max(1, Math.round(body.timeoutSeconds)));
	const intervalMs = Math.min(
		MAX_STAGE_WAIT_INTERVAL_MS,
		Math.max(
			MIN_STAGE_WAIT_INTERVAL_MS,
			Math.round(
				(body.intervalSeconds ?? DEFAULT_STAGE_WAIT_INTERVAL_MS / 1_000) *
					1_000,
			),
		),
	);
	return { timeoutMs: timeoutSeconds * 1_000, intervalMs, timeoutSeconds };
}

/**
 * `stage_wait`: poll one condition *here*, until it holds or the bound elapses,
 * and answer once.
 *
 * The bound is the stage's `maxWaitSeconds` (a session without a stage gets the
 * default), so a wait can never outlast what the stage allows; `reload` re-opens
 * the session's current URL between polls, which is what a mail-driven flow needs
 * when the page must be re-read to show the message's effect.
 *
 * Every step is bounded and every step re-checks the session, because the wait is
 * the one tool that holds a page for minutes: a page that never answers a
 * `document.querySelector` would otherwise hold the call past its own bound, and a
 * session the developer closed underneath it would be driven forever. The answer
 * is still exactly one, and it names which of the two ended the wait.
 */
async function stageWait(
	deps: BrowserRouteDeps,
	owner: string,
	used: SessionUse[],
	body: import("../../contracts/browser.ts").BrowserStageWaitRequest,
): Promise<unknown> {
	const session = await sessionFor(deps, owner, body.session, used);
	const { timeoutMs, intervalMs, timeoutSeconds } = stageWaitTiming(
		session.stage?.limits,
		body,
	);
	const started = deps.now?.() ?? Date.now();
	const now = () => deps.now?.() ?? Date.now();
	let met = false;
	/** Set when the session went away under the wait: the one end that is not the
	 * bound and not the condition. */
	let closed = false;
	let url = session.url;
	for (;;) {
		const remaining = timeoutMs - (now() - started);
		const answer = await withPollTimeout(
			waitConditionMet(deps, session, body.until),
			Math.min(STAGE_WAIT_POLL_TIMEOUT_MS, Math.max(1, remaining)),
		);
		// A closed or swept session is not a condition that has not held yet: the
		// next poll would drive a page nobody owns, so the wait ends here.
		if (deps.pool.find(owner, session.name) !== session) {
			closed = true;
			break;
		}
		if (answer !== "timeout") {
			url = answer.url;
			if (answer.met) {
				met = true;
				break;
			}
		}
		const elapsed = now() - started;
		if (elapsed >= timeoutMs) break;
		await sleep(Math.min(intervalMs, timeoutMs - elapsed));
		// A reload of the page the session is on, bounded like any navigation, and
		// skipped once the bound has passed: the last poll must not open a page it
		// then has to abandon.
		if (body.reload === true && now() - started < timeoutMs)
			await withPollTimeout(
				session.goto(session.url, STAGE_WAIT_POLL_TIMEOUT_MS).catch(() => null),
				STAGE_WAIT_POLL_TIMEOUT_MS,
			);
	}
	const elapsedMs = Math.max(0, now() - started);
	const notice = closed
		? "the session was closed while waiting; open it again to continue the flow"
		: met
			? undefined
			: `the condition did not hold within ${timeoutSeconds}s; the session is still usable`;
	return {
		session: session.name,
		met,
		// The bound is named explicitly, so a caller does not have to read `!met`
		// as a failure of the session: it is the wait that ended, nothing else.
		timeout: !met && !closed,
		...(closed ? { closed: true } : {}),
		elapsedMs,
		condition: body.until,
		url,
		...(notice === undefined ? {} : { notice }),
	};
}

/**
 * Bound one poll step. The abandoned promise is not cancelled — a page that never
 * answers is a page the session keeps working with, and the next poll re-checks —
 * so a hung `evaluate` cannot hold `stage_wait` past its own bound.
 */
async function withPollTimeout<T>(
	work: Promise<T>,
	ms: number,
): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), Math.max(1, ms));
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Sleep for a bounded stretch without blocking the event loop. */
async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
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
	const before = session.snapshotState;
	const actionStarted = performance.now();
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
	const actionMs = elapsedMs(actionStarted);
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
	if (body.observe === true) {
		const observed = await observeAfterAction(session, before, actionMs);
		emitBrowserTelemetry(
			deps,
			"script",
			observed.timing,
			observed.snapshotRequired,
			{
				session: session.name,
			},
		);
		value.url = session.url;
		if (observed.snapshotId !== undefined)
			value.snapshotId = observed.snapshotId;
		value.observation = observed.observation;
		value.changed = observed.changed;
		value.snapshotRequired = observed.snapshotRequired;
		if (observed.delta !== undefined) value.delta = observed.delta;
		value.deltaTruncated = observed.deltaTruncated;
		value.timing = observed.timing;
	} else {
		const timing = browserTiming({
			actionMs,
			chars: before?.chars ?? 0,
			refs: before?.refs.length ?? 0,
			changed: false,
			truncated: false,
		});
		emitBrowserTelemetry(deps, "script", timing, false, {
			session: session.name,
		});
		value.timing = timing;
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
		readonly kind:
			| "screenshot"
			| "video"
			| "script"
			| "trace"
			| "log"
			| "other";
		readonly caption: string;
		readonly url: string;
		readonly extension: string;
		readonly app?: string;
		readonly poster?: string;
		readonly segment?: number;
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
	let entry: EvidenceEntry;
	try {
		entry = await attachEvidence(scope, {
			path: file,
			kind: input.kind,
			caption: input.caption,
			url: input.url,
			...(input.app === undefined ? {} : { app: input.app }),
			...(input.poster === undefined ? {} : { poster: input.poster }),
			...(input.segment === undefined ? {} : { segment: input.segment }),
		});
	} finally {
		fs.rmSync(file, { force: true });
	}
	// An evidence attach can change what the flow page shows (a caption, a new
	// poster, a kept recording), so a workflow that has a journal gets its page
	// re-rendered here — and one that has none gets no page at all.
	await refreshFlowPage(deps, scope).catch(() => undefined);
	return entry;
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
