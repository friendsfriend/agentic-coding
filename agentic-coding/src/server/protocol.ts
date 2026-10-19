import type { Schema } from "effect";
import {
	agentHandoffRequestSchema,
	agentQuestionRequestSchema,
	agentResearchHandoffRequestSchema,
	agentsMutationRequestSchema,
	classifierRequestSchema,
	reviewSaveRequestSchema,
	workflowActionRequestSchema,
	workflowBlueprintValidateRequestSchema,
	workflowDeleteRequestSchema,
	workflowExecuteRequestSchema,
	workflowQuestionRequestSchema,
	workflowRepairRequestSchema,
	workflowStartRequestSchema,
} from "../contracts/actions.ts";
import {
	browserActionRequestSchema,
	browserEvalRequestSchema,
	browserInstallRequestSchema,
	browserLogRequestSchema,
	browserOpenRequestSchema,
	browserRecordRequestSchema,
	browserScreenshotRequestSchema,
	browserScriptRequestSchema,
	browserSessionRequestSchema,
	browserStageLoginRequestSchema,
	browserStageLoginWaitRequestSchema,
	browserWaitRequestSchema,
} from "../contracts/browser.ts";
import { credentialRespondSchema } from "../contracts/credential.ts";
import { decodeContract } from "../contracts/decode.ts";
import {
	acquireSlotsRequestSchema,
	agentDbQuerySchema,
	agentEnvironmentAcquireSchema,
	agentEnvironmentAppSchema,
	agentEnvironmentBuildSchema,
	agentHttpRequestSchema,
	agentOtelQuerySchema,
	appSlotOperationRequestSchema,
	environmentOwnerActionRequestSchema,
	environmentTeardownRequestSchema,
	evidenceAttachRequestSchema,
	type ObservationRequest,
	observeRequestSchema,
} from "../contracts/environment.ts";
import { stageCredentialRequestSchema } from "../contracts/stages.ts";
import {
	telemetryPruneRequestSchema,
	telemetryScanRequestSchema,
	telemetrySpansRequestSchema,
	telemetryTracesRequestSchema,
	telemetryWatchRequestSchema,
} from "../contracts/telemetry.ts";
import {
	workflowEventSubscribeRequestSchema,
	workflowEventUnsubscribeRequestSchema,
} from "../contracts/workflow-events.ts";

/** Bumped whenever a breaking wire change lands; clients send it back. */
export const SERVER_API_VERSION = "v1";

export const AGENT_ENVIRONMENT_PREFIX = "/api/v1/agent-env/";

/** The seven agent environment routes. Declared here (the transport manifest)
 * and served by `environment/agent-routes.ts`, so the surface is visible in one
 * place and a client cannot invent a path the server does not own. */
export const AGENT_LIST_PATH = `${AGENT_ENVIRONMENT_PREFIX}list`;
export const AGENT_STATUS_PATH = `${AGENT_ENVIRONMENT_PREFIX}status`;
export const AGENT_LOGS_PATH = `${AGENT_ENVIRONMENT_PREFIX}logs`;
export const AGENT_ACQUIRE_PATH = `${AGENT_ENVIRONMENT_PREFIX}acquire`;
export const AGENT_STOP_PATH = `${AGENT_ENVIRONMENT_PREFIX}stop`;
export const AGENT_BUILD_PATH = `${AGENT_ENVIRONMENT_PREFIX}build`;
export const AGENT_TEST_PATH = `${AGENT_ENVIRONMENT_PREFIX}test`;
/** The evidence surface of one run: attach and list ride the same owner-scoped
 * capability, so the workflow is named by the owner and never by the body. The
 * declared paths live here so the transport manifest owns the whole surface. */
export const AGENT_EVIDENCE_ATTACH_PATH = `${AGENT_ENVIRONMENT_PREFIX}evidence/attach`;
export const AGENT_EVIDENCE_LIST_PATH = `${AGENT_ENVIRONMENT_PREFIX}evidence`;

/** The browser surface of one run (`add-agent-browser-sessions`). Declared here
 * with the rest of the transport manifest: one path per discrete tool, so the
 * wire keeps the tool contract's shape instead of inventing a second one. */
export const AGENT_BROWSER_PREFIX = `${AGENT_ENVIRONMENT_PREFIX}browser/`;
export const AGENT_BROWSER_OPEN_PATH = `${AGENT_BROWSER_PREFIX}open`;
export const AGENT_BROWSER_SNAPSHOT_PATH = `${AGENT_BROWSER_PREFIX}snapshot`;
export const AGENT_BROWSER_ACTION_PATH = `${AGENT_BROWSER_PREFIX}action`;
export const AGENT_BROWSER_WAIT_PATH = `${AGENT_BROWSER_PREFIX}wait`;
export const AGENT_BROWSER_EVAL_PATH = `${AGENT_BROWSER_PREFIX}eval`;
export const AGENT_BROWSER_CONSOLE_PATH = `${AGENT_BROWSER_PREFIX}console`;
export const AGENT_BROWSER_NETWORK_PATH = `${AGENT_BROWSER_PREFIX}network`;
export const AGENT_BROWSER_SCREENSHOT_PATH = `${AGENT_BROWSER_PREFIX}screenshot`;
export const AGENT_BROWSER_RECORD_PATH = `${AGENT_BROWSER_PREFIX}record`;
export const AGENT_BROWSER_SCRIPT_PATH = `${AGENT_BROWSER_PREFIX}script`;
export const AGENT_BROWSER_CLOSE_PATH = `${AGENT_BROWSER_PREFIX}close`;
/** The credential-safe login of a stage-bound session. */
export const AGENT_BROWSER_LOGIN_PATH = `${AGENT_BROWSER_PREFIX}login`;
/** `add-stage-interactive-login`: block in the server while a login hand-off is
 * pending, instead of spending a model turn per poll. */
export const AGENT_BROWSER_LOGIN_WAIT_PATH = `${AGENT_BROWSER_PREFIX}login-wait`;

/** The stage catalog of one run: the same read surface as the dashboard's, with
 * version probes resolved. It rides the owner capability because a run may only
 * be told about the allow-listed stages it is allowed to drive. */
export const AGENT_STAGES_PATH = `${AGENT_ENVIRONMENT_PREFIX}stages`;

/** The instance-authenticated stage surface the dashboard and Settings read: the
 * catalog with credential *status*, and the protected credential flow that
 * writes one referenced key of the configuration `.env`. */
export const STAGES_PATH = "/api/v1/stages";
export const STAGES_CREDENTIAL_PATH = "/api/v1/stages/credential";

/** The debug surface of one run (`add-agent-debug-tools`): the traces its runs
 * exported, the data the infra services it requires hold, and the endpoints of
 * the apps it holds. Declared here with the rest of the transport manifest. */
export const AGENT_DEBUG_PREFIX = `${AGENT_ENVIRONMENT_PREFIX}debug/`;
export const AGENT_OTEL_QUERY_PATH = `${AGENT_DEBUG_PREFIX}otel`;
export const AGENT_DB_QUERY_PATH = `${AGENT_DEBUG_PREFIX}db`;
export const AGENT_HTTP_REQUEST_PATH = `${AGENT_DEBUG_PREFIX}http`;

/** The typed workflow event surface (add-orchestrator-event-subscriptions):
 * the recorded event log read by cursor, and the orchestrator's own
 * subscription registry. Declared here with the rest of the manifest. */
export const WORKFLOW_EVENTS_PATH = "/api/v1/workflow/events";
export const ORCHESTRATOR_SUBSCRIPTIONS_PATH =
	"/api/v1/orchestrator/subscriptions";
export const ORCHESTRATOR_SUBSCRIPTIONS_DELETE_PATH =
	"/api/v1/orchestrator/subscriptions/delete";

/** The instance-authenticated browser install surface, read and driven by the
 * Settings section. No route here is a download on its own: only `install`
 * asks for one, and only when the developer asked it to. */
export const BROWSER_STATUS_PATH = "/api/v1/browser/status";
export const BROWSER_INSTALL_PATH = "/api/v1/browser/install";
export const BROWSER_INSTALL_CANCEL_PATH = "/api/v1/browser/install/cancel";

/** The dashboard's evidence file read, under the instance capability: the
 * recorded bytes of one manifest entry, addressed by workflow and entry id.
 * Declared here with the rest of the transport manifest, so the client and the
 * route can never drift apart. */
export const EVIDENCE_FILE_PREFIX = "/api/v1/evidence/";

/** Bounded request body (a single observation/diff can be a few MiB). */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Bounded textual path/argument length accepted from a client. */
export const MAX_PATH_CHARS = 4096;
/** Bounded event replay window retained per server instance. */
export const EVENT_REPLAY_CAPACITY = 512;
/** Bounded credential interaction lifetime. */
export const CREDENTIAL_TIMEOUT_MS = 120_000;

/** The retired mixed-runtime ownership values are gone: every versioned route is
 * served by this process, and `app.ts` rejects anything the manifest does not
 * cover. */
export type RouteOwner = "bun";

/** Ownership domains a route (or an observation kind) can belong to. */
export const ROUTE_DOMAINS = [
	"health",
	"observe",
	"workflow",
	"telemetry",
	"events",
	"credentials",
	"environment",
	"evidence",
	"browser",
	"stages",
	"integrations",
	"git",
	"wiki",
] as const;
export type RouteDomain = (typeof ROUTE_DOMAINS)[number];

export interface RouteOwnership {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly owner: RouteOwner;
	readonly domain: RouteDomain;
}

/** Static route ownership manifest (design decision 2): the server never
 * guesses an owner and a test can assert the split without a router framework. */
export const ROUTE_OWNERSHIP: readonly RouteOwnership[] = [
	{ method: "GET", path: "/api/v1/health", owner: "bun", domain: "health" },
	{ method: "POST", path: "/api/v1/observe", owner: "bun", domain: "observe" },
	{
		method: "GET",
		path: "/api/v1/workflow/view",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/action",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/start",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: "/api/v1/workflow/steps",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/blueprint/validate",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/repair",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/question",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/review-save",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/execute",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/workflow/delete",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/handoff",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/question",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/agent/research-handoff",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/config/agents",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: "/api/v1/config/agents",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: "/api/v1/classifier/status",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/classifier/install",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: "/api/v1/classifier/install/cancel",
		owner: "bun",
		domain: "workflow",
	},
	// The Settings browser surface: install state, the opt-in install and its
	// cancel. Instance-authenticated like the classifier's own install routes.
	{ method: "GET", path: BROWSER_STATUS_PATH, owner: "bun", domain: "browser" },
	// The stage catalog and its credential flow: instance-authenticated like the
	// browser install surface next to them.
	{ method: "GET", path: STAGES_PATH, owner: "bun", domain: "stages" },
	{
		method: "POST",
		path: STAGES_CREDENTIAL_PATH,
		owner: "bun",
		domain: "stages",
	},
	{
		method: "POST",
		path: BROWSER_INSTALL_PATH,
		owner: "bun",
		domain: "browser",
	},
	{
		method: "POST",
		path: BROWSER_INSTALL_CANCEL_PATH,
		owner: "bun",
		domain: "browser",
	},
	{ method: "GET", path: "/api/v1/events", owner: "bun", domain: "events" },
	// The workflow event catalog and the orchestrator's subscriptions.
	{
		method: "GET",
		path: WORKFLOW_EVENTS_PATH,
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: ORCHESTRATOR_SUBSCRIPTIONS_PATH,
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "POST",
		path: ORCHESTRATOR_SUBSCRIPTIONS_PATH,
		owner: "bun",
		domain: "workflow",
	},
	// The subscription removal is served as its own exact path; the manifest
	// documents the prefix so its wording does not depend on the formatter.
	{
		method: "POST",
		path: "/api/v1/orchestrator/subscriptions/*",
		owner: "bun",
		domain: "workflow",
	},
	{
		method: "GET",
		path: "/api/v1/telemetry/workspaces",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/traces",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/spans",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/watch",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/scan",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/telemetry/prune",
		owner: "bun",
		domain: "telemetry",
	},
	{
		method: "POST",
		path: "/api/v1/credentials/respond",
		owner: "bun",
		domain: "credentials",
	},
	{
		method: "GET",
		path: "/api/v1/environment/apps/slots",
		owner: "bun",
		domain: "environment",
	},
	{
		method: "POST",
		path: "/api/v1/environment/apps/acquire",
		owner: "bun",
		domain: "environment",
	},
	// The owner teardown route is served as its own exact path (the `*` row below
	// covers the release/stop rows), so the manifest names it exactly.
	{
		method: "POST",
		path: "/api/v1/environment/apps/teardown",
		owner: "bun",
		domain: "environment",
	},
	// The workflow runtime's own build/test call (`staged-env-setup-config-root`)
	// is an exact path like the teardown route, so the manifest names it exactly.
	{
		method: "POST",
		path: "/api/v1/environment/apps/action",
		owner: "bun",
		domain: "environment",
	},
	{
		method: "POST",
		path: "/api/v1/environment/apps/*",
		owner: "bun",
		domain: "environment",
	},
	{
		method: "POST",
		path: "/api/v1/environment/private/*",
		owner: "bun",
		domain: "environment",
	},
	// The agent environment surface is one prefix per method: its seven routes
	// live in `environment/agent-routes.ts` and only ever answer to the
	// owner-scoped capability, never to the instance token.
	{
		method: "GET",
		path: `${AGENT_ENVIRONMENT_PREFIX}*`,
		owner: "bun",
		domain: "environment",
	},
	{
		method: "POST",
		path: `${AGENT_ENVIRONMENT_PREFIX}*`,
		owner: "bun",
		domain: "environment",
	},
	// The recorded bytes of one evidence entry, for the local dashboard. The
	// prefix row covers `/api/v1/evidence/{workflowId}/{id}`: the workflow is
	// located from the id through the recorded targets, never from the path.
	{
		method: "GET",
		path: "/api/v1/evidence/*",
		owner: "bun",
		domain: "evidence",
	},
];

/** Resolve the owner of a method+path, longest prefix first so a wildcard
 * route never shadows an exact one. */
export function routeOwner(
	method: string,
	pathname: string,
): RouteOwnership | undefined {
	const normalized = method.toUpperCase();
	const matches = ROUTE_OWNERSHIP.filter((route) => {
		if (route.method !== normalized) return false;
		if (!route.path.includes("*")) return route.path === pathname;
		return pathname.startsWith(route.path.slice(0, route.path.indexOf("*")));
	});
	matches.sort((a, b) => b.path.length - a.path.length);
	return matches[0];
}

// ---------------------------------------------------------------------------
// Request-schema manifest
// ---------------------------------------------------------------------------
// The route's request contract lives here, not at the call site: a route whose
// body is not decoded through a contract schema cannot be registered, and a
// test can assert the manifest and the served routes agree.

export interface RouteRequestSchema {
	readonly path: string;
	/** Contract id used in decode diagnostics. */
	readonly schemaId: string;
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
	readonly schema: Schema.Schema<any, any, never>;
}

export const ROUTE_REQUESTS: readonly RouteRequestSchema[] = [
	{
		path: "/api/v1/observe",
		schemaId: "server.observe",
		schema: observeRequestSchema,
	},
	{
		path: "/api/v1/environment/apps/acquire",
		schemaId: "server.environment.apps.acquire",
		schema: acquireSlotsRequestSchema,
	},
	{
		path: "/api/v1/environment/apps/teardown",
		schemaId: "server.environment.apps.teardown",
		schema: environmentTeardownRequestSchema,
	},
	{
		path: "/api/v1/environment/apps/action",
		schemaId: "server.environment.apps.action",
		schema: environmentOwnerActionRequestSchema,
	},
	{
		path: "/api/v1/environment/apps/{app}/release",
		schemaId: "server.environment.apps.release",
		schema: appSlotOperationRequestSchema,
	},
	{
		path: "/api/v1/environment/apps/{app}/stop",
		schemaId: "server.environment.apps.stop",
		schema: appSlotOperationRequestSchema,
	},
	{
		path: "/api/v1/workflow/action",
		schemaId: "server.workflow.action",
		schema: workflowActionRequestSchema,
	},
	{
		path: "/api/v1/workflow/start",
		schemaId: "server.workflow.start",
		schema: workflowStartRequestSchema,
	},
	{
		path: "/api/v1/workflow/blueprint/validate",
		schemaId: "server.workflow.blueprint.validate",
		schema: workflowBlueprintValidateRequestSchema,
	},
	{
		path: "/api/v1/workflow/repair",
		schemaId: "server.workflow.repair",
		schema: workflowRepairRequestSchema,
	},
	{
		path: "/api/v1/workflow/question",
		schemaId: "server.workflow.question",
		schema: workflowQuestionRequestSchema,
	},
	{
		path: "/api/v1/workflow/review-save",
		schemaId: "server.workflow.review-save",
		schema: reviewSaveRequestSchema,
	},
	{
		path: "/api/v1/workflow/execute",
		schemaId: "server.workflow.execute",
		schema: workflowExecuteRequestSchema,
	},
	{
		path: "/api/v1/workflow/delete",
		schemaId: "server.workflow.delete",
		schema: workflowDeleteRequestSchema,
	},
	{
		path: "/api/v1/agent/handoff",
		schemaId: "server.agent.handoff",
		schema: agentHandoffRequestSchema,
	},
	{
		path: "/api/v1/agent/question",
		schemaId: "server.agent.question",
		schema: agentQuestionRequestSchema,
	},
	{
		path: "/api/v1/agent/research-handoff",
		schemaId: "server.agent.research-handoff",
		schema: agentResearchHandoffRequestSchema,
	},
	{
		path: "/api/v1/config/agents",
		schemaId: "server.config.agents",
		schema: agentsMutationRequestSchema,
	},
	{
		path: "/api/v1/classifier/install",
		schemaId: "server.classifier.install",
		schema: classifierRequestSchema,
	},
	{
		path: "/api/v1/classifier/install/cancel",
		schemaId: "server.classifier.install.cancel",
		schema: classifierRequestSchema,
	},
	{
		path: "/api/v1/credentials/respond",
		schemaId: "server.credentials.respond",
		schema: credentialRespondSchema,
	},
	{
		path: "/api/v1/telemetry/traces",
		schemaId: "server.telemetry.traces",
		schema: telemetryTracesRequestSchema,
	},
	{
		path: "/api/v1/telemetry/spans",
		schemaId: "server.telemetry.spans",
		schema: telemetrySpansRequestSchema,
	},
	{
		path: "/api/v1/telemetry/watch",
		schemaId: "server.telemetry.watch",
		schema: telemetryWatchRequestSchema,
	},
	{
		path: "/api/v1/telemetry/scan",
		schemaId: "server.telemetry.scan",
		schema: telemetryScanRequestSchema,
	},
	{
		path: "/api/v1/telemetry/prune",
		schemaId: "server.telemetry.prune",
		schema: telemetryPruneRequestSchema,
	},
	{
		path: AGENT_ACQUIRE_PATH,
		schemaId: "server.agent-env.acquire",
		schema: agentEnvironmentAcquireSchema,
	},
	{
		path: AGENT_STOP_PATH,
		schemaId: "server.agent-env.stop",
		schema: agentEnvironmentAppSchema,
	},
	{
		path: AGENT_BUILD_PATH,
		schemaId: "server.agent-env.build",
		schema: agentEnvironmentBuildSchema,
	},
	{
		path: AGENT_TEST_PATH,
		schemaId: "server.agent-env.test",
		schema: agentEnvironmentBuildSchema,
	},
	{
		path: AGENT_EVIDENCE_ATTACH_PATH,
		schemaId: "server.agent-env.evidence.attach",
		schema: evidenceAttachRequestSchema,
	},
	{
		path: AGENT_BROWSER_OPEN_PATH,
		schemaId: "server.agent-env.browser.open",
		schema: browserOpenRequestSchema,
	},
	{
		path: AGENT_BROWSER_SNAPSHOT_PATH,
		schemaId: "server.agent-env.browser.snapshot",
		schema: browserSessionRequestSchema,
	},
	{
		path: AGENT_BROWSER_ACTION_PATH,
		schemaId: "server.agent-env.browser.action",
		schema: browserActionRequestSchema,
	},
	{
		path: AGENT_BROWSER_WAIT_PATH,
		schemaId: "server.agent-env.browser.wait",
		schema: browserWaitRequestSchema,
	},
	{
		path: AGENT_BROWSER_EVAL_PATH,
		schemaId: "server.agent-env.browser.eval",
		schema: browserEvalRequestSchema,
	},
	{
		path: AGENT_BROWSER_CONSOLE_PATH,
		schemaId: "server.agent-env.browser.console",
		schema: browserLogRequestSchema,
	},
	{
		path: AGENT_BROWSER_NETWORK_PATH,
		schemaId: "server.agent-env.browser.network",
		schema: browserLogRequestSchema,
	},
	{
		path: AGENT_BROWSER_SCREENSHOT_PATH,
		schemaId: "server.agent-env.browser.screenshot",
		schema: browserScreenshotRequestSchema,
	},
	{
		path: AGENT_BROWSER_RECORD_PATH,
		schemaId: "server.agent-env.browser.record",
		schema: browserRecordRequestSchema,
	},
	{
		path: AGENT_BROWSER_SCRIPT_PATH,
		schemaId: "server.agent-env.browser.script",
		schema: browserScriptRequestSchema,
	},
	{
		path: AGENT_BROWSER_CLOSE_PATH,
		schemaId: "server.agent-env.browser.close",
		schema: browserSessionRequestSchema,
	},
	{
		path: AGENT_BROWSER_LOGIN_PATH,
		schemaId: "server.agent-env.browser.login",
		schema: browserStageLoginRequestSchema,
	},
	{
		path: AGENT_BROWSER_LOGIN_WAIT_PATH,
		schemaId: "server.agent-env.browser.login-wait",
		schema: browserStageLoginWaitRequestSchema,
	},
	{
		path: AGENT_OTEL_QUERY_PATH,
		schemaId: "server.agent-env.debug.otel",
		schema: agentOtelQuerySchema,
	},
	{
		path: AGENT_DB_QUERY_PATH,
		schemaId: "server.agent-env.debug.db",
		schema: agentDbQuerySchema,
	},
	{
		path: AGENT_HTTP_REQUEST_PATH,
		schemaId: "server.agent-env.debug.http",
		schema: agentHttpRequestSchema,
	},
	{
		path: BROWSER_INSTALL_PATH,
		schemaId: "server.browser.install",
		schema: browserInstallRequestSchema,
	},
	{
		path: STAGES_CREDENTIAL_PATH,
		schemaId: "server.stages.credential",
		schema: stageCredentialRequestSchema,
	},
	{
		path: BROWSER_INSTALL_CANCEL_PATH,
		schemaId: "server.browser.install.cancel",
		schema: browserInstallRequestSchema,
	},
	{
		path: ORCHESTRATOR_SUBSCRIPTIONS_PATH,
		schemaId: "server.orchestrator.subscriptions.create",
		schema: workflowEventSubscribeRequestSchema,
	},
	{
		path: ORCHESTRATOR_SUBSCRIPTIONS_DELETE_PATH,
		schemaId: "server.orchestrator.subscriptions.delete",
		schema: workflowEventUnsubscribeRequestSchema,
	},
];

/** Decode a route body through the schema the manifest declares for it. */
export function decodeRouteRequest<T>(path: string, value: unknown): T {
	const route = ROUTE_REQUESTS.find((entry) => entry.path === path);
	if (!route) throw new Error(`no request contract registered for ${path}`);
	return decodeRequest<T>(route.schemaId, route.schema, value);
}

// ---------------------------------------------------------------------------
// Observation ownership
// ---------------------------------------------------------------------------
// Git and wiki reads travel as observation kinds on the versioned
// observe route; each kind names the ownership domain it belongs to, so a
// domain cannot be served without appearing in the manifest.

export interface ObservationOwnership {
	readonly kind: ObservationRequest["kind"];
	readonly domain: RouteDomain;
}

export const OBSERVATION_OWNERSHIP: readonly ObservationOwnership[] = [
	{ kind: "workflows", domain: "workflow" },
	{ kind: "projects", domain: "environment" },
	{ kind: "dashboard", domain: "workflow" },
	{ kind: "artifacts", domain: "workflow" },
	{ kind: "artifact-content", domain: "workflow" },
	{ kind: "wiki-changes", domain: "wiki" },
	{ kind: "wiki-diff", domain: "wiki" },
	// The env-setup approval diff: the drafts against the live configuration.
	// It belongs to the environment domain, which owns the configuration root.
	{ kind: "setup-changes", domain: "environment" },
	{ kind: "setup-diff", domain: "environment" },
	{ kind: "local-changes", domain: "git" },
	{ kind: "local-diff", domain: "git" },
	{ kind: "changes", domain: "git" },
	{ kind: "verifier-findings", domain: "workflow" },
	{ kind: "verifier-report", domain: "workflow" },
	{ kind: "developer-review-findings", domain: "workflow" },
	{ kind: "repair-preview", domain: "workflow" },
	{ kind: "evidence", domain: "evidence" },
	// The delegated debug requests of one workflow: they are durable workflow
	// rows, so they belong to the workflow domain.
	{ kind: "debug-requests", domain: "workflow" },
];

/** Decode a request body through its schema, throwing `ContractFailure`.
 * `onExcessProperty: error` keeps an unknown field from being silently
 * ignored and smuggled past the typed boundary. */
export function decodeRequest<T>(
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
	schema: Schema.Schema<T, any, never>,
	value: unknown,
): T {
	return decodeContract<T>(id, schema, value, { onExcessProperty: "error" });
}
