// Bun transport composition for the unified backend (single-Bun-application).
// One `fetch` handler owns routing, authorization, bounds and event delivery;
// the operation handlers behind it are pure application calls. This module is
// transport-only: it never imports presentation and never spawns a second
// runtime. Since the Go backend was retired there is no delegation: every route
// is answered in this process or is 404.

import { resolveConfigRoot } from "../config-root.ts";
import type {
	AgentHandoffRequest,
	AgentQuestionRequest,
	AgentResearchHandoffRequest,
	AgentsMutationRequest,
	ReviewSaveRequest,
	WorkflowActionRequest,
	WorkflowBlueprintValidateRequest,
	WorkflowDeleteRequest,
	WorkflowExecuteRequest,
	WorkflowQuestionRequest,
	WorkflowRepairRequest,
	WorkflowStartRequest,
} from "../contracts/actions.ts";
import type { CredentialRespondRequest } from "../contracts/credential.ts";
import type {
	AcquireSlotsRequest,
	AppSlotOperationRequest,
	EnvironmentOwnerActionRequest,
	EnvironmentTeardownRequest,
	ObserveRequest,
} from "../contracts/environment.ts";
import type {
	TelemetryPruneRequest,
	TelemetryScanRequest,
	TelemetrySpansRequest,
	TelemetryTracesRequest,
	TelemetryWatchRequest,
} from "../contracts/telemetry.ts";
import type {
	WorkflowEventSubscribeRequest,
	WorkflowEventSubscriptionFilter,
	WorkflowEventUnsubscribeRequest,
} from "../contracts/workflow-events.ts";
import { WorkflowRuntimeError } from "../workflow/contracts.ts";
import { runAppBuildTestAction } from "./actions/routes.ts";
import {
	AuthorizationError,
	assertBoundedText,
	authorizeEnvironmentRequest,
	authorizeRequest,
	type InstanceAuthority,
	isPublicRoute,
	originAllowed,
	PayloadBoundError,
	type Principal,
	readJsonBody,
} from "./auth.ts";
import { workflowLoginHandoffAttention } from "./browser/attention.ts";
import { type BrowserRouteDeps, handleBrowserRoute } from "./browser/routes.ts";
import { type BrowserRuntime, browserRuntime } from "./browser/runtime.ts";
import type { CredentialRegistry } from "./credentials.ts";
import { type DebugRouteDeps, handleDebugRoute } from "./debug/routes.ts";
import type { LogIndex, TraceIndex } from "./debug/trace-index.ts";
import {
	type AgentEnvironmentDeps,
	handleAgentEnvironmentRoute,
} from "./environment/agent-routes.ts";
import {
	ENVIRONMENT_OPERATION_PATH,
	type EnvironmentAuthority,
	EnvironmentOperationError,
	executeEnvironmentOperation,
} from "./environment/private-api.ts";
import type { EventBroker } from "./events.ts";
import {
	EVIDENCE_FILE_PREFIX,
	handleEvidenceFileRoute,
	handleEvidenceRoute,
} from "./evidence/routes.ts";
import { type ServerOperations, serverOperations } from "./handlers.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
} from "./integrations/routes.ts";
import {
	orchestratorActionRefusal,
	orchestratorRouteAllowed,
} from "./orchestrator-policy.ts";
import {
	AGENT_ENVIRONMENT_PREFIX,
	BROWSER_INSTALL_CANCEL_PATH,
	BROWSER_INSTALL_PATH,
	decodeRouteRequest,
	MAX_REQUEST_BYTES,
	SERVER_API_VERSION,
} from "./protocol.ts";
import { EnvironmentInstanceError } from "./runtime/instances.ts";
import { stageBearerToken } from "./stages/api-request.ts";
import { StageUsageRegistry } from "./stages/limits.ts";
import { stageTokenStore } from "./stages/oauth2.ts";
import {
	handleStageCredentialRoute,
	handleStageIdentityRoute,
	handleStageRoute,
	type StageRouteDeps,
	stagesStatusValue,
} from "./stages/routes.ts";
import type { WorkflowEventHub } from "./subscriptions.ts";
import type { TelemetryOperations } from "./telemetry.ts";
import {
	MonitorOffError,
	StoreUnreadableError,
	SubscriptionLimitError,
	UnknownSessionError,
	UnknownWorkflowError,
	type WorkflowEventBus,
} from "./workflow-event-bus.ts";

export interface ServerAppOptions {
	readonly authority: InstanceAuthority;
	readonly events: EventBroker;
	readonly credentials: CredentialRegistry;
	/** Bun-owned environment state/catalog authority. When set, the bounded
	 * private operations are served in-process. */
	readonly environment?: EnvironmentAuthority;
	readonly version?: string;
	/** Environment root reported by the health route. */
	readonly homeDir?: string;
	readonly configDir?: string;
	/** Test/clock override. */
	readonly now?: () => Date;
	/** Override the application operations (transport tests). */
	readonly operations?: ServerOperations;
	/** Server-owned telemetry persistence/query operations. */
	readonly telemetry?: TelemetryOperations;
	/** Server-owned workflow refresh subscriptions. */
	readonly hub?: WorkflowEventHub;
	/** Server-owned workflow event catalog and subscription registry
	 * (add-orchestrator-event-subscriptions). Absent: the event routes answer
	 * that the stream is not attached. */
	readonly eventBus?: WorkflowEventBus;
	/** The browser runtime (installer + pool). Absent: the process-wide one for
	 * the server's own configuration directory is used. */
	readonly browser?: BrowserRuntime;
	/** Bun-served legacy integration families (Git, providers, repository
	 * search). When absent the legacy `/api/*` surface answers 503. */
	readonly integrations?: IntegrationServices;
	/** The live trace index the telemetry receivers feed, so an agent can query
	 * the spans its own runs exported (`otel_query`). Absent: the process owns no
	 * receivers and answers that no trace is queryable. */
	readonly traceIndex?: TraceIndex;
	/** The live log index the receivers feed, for `otel_query`'s logs mode. */
	readonly logIndex?: LogIndex;
}

export interface ServerApp {
	readonly authority: InstanceAuthority;
	readonly events: EventBroker;
	readonly credentials: CredentialRegistry;
	/** The application operations and telemetry service this server serves.
	 * Exposed so the composition root can build an in-process gateway over the
	 * *same* instances instead of opening a socket to itself. */
	readonly operations: ServerOperations;
	readonly telemetry?: TelemetryOperations;
	/** Server-owned workflow refresh hub. Exposed so the in-process gateway can
	 * register a repository exactly like the HTTP routes do, instead of the
	 * dashboard waiting on the periodic safety resync for every status change. */
	readonly hub?: WorkflowEventHub;
	/** The server-owned workflow event catalog and subscription registry
	 * (add-orchestrator-event-subscriptions), so the in-process gateway answers
	 * the subscription reads over the same instance the routes serve. */
	readonly eventBus?: WorkflowEventBus;
	fetch(request: Request): Promise<Response>;
	/** A `CredentialPrompt`-compatible function bound to one client owner. */
	credentialPrompt(
		ownerId: string,
	): (prompt: string, signal?: AbortSignal) => Promise<string>;
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

function errorResponse(
	status: number,
	code: string,
	message: string,
): Response {
	return json({ error: { code, message } }, status);
}

function instanceErrorResponse(error: unknown): Response {
	if (error instanceof EnvironmentInstanceError)
		return errorResponse(error.status, error.code, safeMessage(error));
	return errorResponse(500, "instance-error", safeMessage(error));
}

/** Bounded diagnostic text: never echo a supplied token or raw body. */
function safeMessage(error: unknown): string {
	if (error instanceof AuthorizationError) return error.reason;
	if (error instanceof PayloadBoundError) return error.reason;
	if (error instanceof Error) return error.message.slice(0, 512);
	return String(error).slice(0, 512);
}

/** Decode the workflow-event read filters from the query string. Absent fields
 * mean "every event in scope", exactly like the subscription filter. */
function filterFromQuery(
	url: URL,
): WorkflowEventSubscriptionFilter | undefined {
	const list = (key: string): string[] | undefined => {
		const raw = url.searchParams.get(key);
		if (raw === null || raw === "") return undefined;
		return raw
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	};
	const scope = url.searchParams.get("scope");
	const minSeverity = url.searchParams.get("minSeverity");
	const fields = [
		"workflowIds",
		"repositories",
		"eventIds",
		"categories",
		"reasons",
		"roles",
	];
	// A query with no recognised field at all is an unfiltered read; every other
	// answer keeps the fields it was given, so no field is silently dropped.
	if (
		scope === null &&
		minSeverity === null &&
		!fields.some((field) => list(field) !== undefined)
	)
		return undefined;
	return {
		// An absent scope is the documented `mine` default, so naming only ids
		// can never widen a read into every workflow.
		scope: scope === "all" ? "all" : "mine",
		...(list("workflowIds") ? { workflowIds: list("workflowIds") } : {}),
		...(list("repositories") ? { repositories: list("repositories") } : {}),
		...(list("eventIds") ? { eventIds: list("eventIds") } : {}),
		...(list("categories") ? { categories: list("categories") } : {}),
		...(list("reasons") ? { reasons: list("reasons") } : {}),
		...(list("roles") ? { roles: list("roles") } : {}),
		...(minSeverity === "info" ||
		minSeverity === "warning" ||
		minSeverity === "critical"
			? { minSeverity }
			: {}),
	};
}

/** One error vocabulary for the event surface, so a tool can tell "the monitor
 * is off" from "that workflow does not exist" from "too many subscriptions". */
function eventErrorResponse(error: unknown): Response {
	if (error instanceof MonitorOffError)
		return errorResponse(409, "monitor-off", error.message);
	if (error instanceof StoreUnreadableError)
		return errorResponse(409, "store-unreadable", error.message);
	if (error instanceof UnknownSessionError)
		return errorResponse(409, "session-unknown", error.message);
	if (error instanceof UnknownWorkflowError)
		return errorResponse(400, "unknown-workflow", error.message);
	if (error instanceof SubscriptionLimitError)
		return errorResponse(400, "subscription-limit", error.message);
	return errorResponse(400, "bad-request", safeMessage(error));
}

export function createServerApp(options: ServerAppOptions): ServerApp {
	const { authority, events, credentials } = options;
	const operations = options.operations ?? serverOperations;
	const eventBus = options.eventBus;
	const telemetryWatchers = new Map<string, () => void>();
	// One browser runtime per server process: one Chromium, one session cap, one
	// opt-in install, shared by every run this server hosts.
	const browser =
		options.browser ??
		browserRuntime(
			options.configDir ?? resolveConfigRoot(),
			// A hand-off raises its developer dialogue through the workflow engine,
			// so the two halves are wired here, once per server process.
			workflowLoginHandoffAttention(),
			// The bearer token a stage-bound session adds to the origins its role
			// declared (`add-stage-oauth2-auth`, task 3.3). Resolved through the same
			// catalog and token store as `stage_api_request`, so one login serves both.
			(binding, scope) => stageBearerToken(stageDeps(), binding, scope),
		);

	/** One server-owned file watcher per repository, registered on first use
	 * (scan or the explicit watch route) and announced on the event stream so
	 * clients refresh from the API instead of polling workspace files. */
	const registerTelemetryWatch = (repo: string): void => {
		if (!options.telemetry?.watch || telemetryWatchers.has(repo)) return;
		const unwatch = options.telemetry.watch(repo, () => {
			events.publish({
				domain: "telemetry",
				kind: "telemetry.updated",
				resource: repo,
			});
		});
		telemetryWatchers.set(repo, unwatch);
	};

	/** What the owner-scoped agent environment routes read. Every capability is
	 * optional so a server without the environment slot controller or the action
	 * engine answers 503 for that operation instead of inventing a result. */
	const agentEnvironmentDeps = (): AgentEnvironmentDeps => ({
		configDir: options.configDir ?? "",
		...(options.environment?.manager
			? { apps: options.environment.manager }
			: {}),
		// The `env_list` listing names the configured infrastructure too: an
		// env-setup author sees the services its drafted app depends on, not only
		// the apps (fix-env-tools-for-all-runs).
		...(options.environment?.manager
			? {
					infraServices: () =>
						options.environment?.manager.getInfraServices() ?? [],
				}
			: {}),
		...(options.integrations?.instances
			? { instances: options.integrations.instances }
			: {}),
		...(options.integrations?.actions?.registry
			? { registry: options.integrations.actions.registry }
			: {}),
		...(options.integrations?.actions
			? { actions: options.integrations.actions }
			: {}),
		...(options.integrations?.runtime
			? { runtime: options.integrations.runtime }
			: {}),
		...(options.integrations?.resolveOwnerCheckout
			? {
					resolveOwnerCheckout: options.integrations.resolveOwnerCheckout,
				}
			: {}),
		...(options.integrations?.resolveOwnerOverlay
			? { resolveOwnerOverlay: options.integrations.resolveOwnerOverlay }
			: {}),
	});

	const browserDeps = (): BrowserRouteDeps => ({
		installer: browser.installer,
		pool: browser.pool,
		settings: browser.settings,
		...(options.configDir ? { configDir: options.configDir } : {}),
		// One registry for the process's life: a rolling minute has to survive
		// between two requests, and the pool it reads is the same pool.
		stages: stageUsage,
		handoff: browser.handoff,
		...(options.environment?.manager
			? { apps: options.environment.manager }
			: {}),
		...(options.integrations?.instances
			? { instances: options.integrations.instances }
			: {}),
	});

	/** The stage bound of one process: the sessions of this pool are the source
	 * of truth, so a lease and a session cap end with the sessions themselves. */
	const stageUsage = new StageUsageRegistry({
		stageSessions: (owner, stage) => browser.pool.stageSessions(owner, stage),
	});

	/** What both stage read surfaces and the credential flow read: the catalog of
	 * the canonical configuration root, never a repository overlay. */
	const stageDeps = (): StageRouteDeps => ({
		configDir: options.configDir ?? "",
		...(options.environment?.manager ? { appIdents: () => appIdents() } : {}),
		// One token store and one rolling minute for the whole process
		// (`add-stage-oauth2-auth`): the token a `stage_login` acquired is the one
		// `stage_api_request` and the browser bearer header use, and a browser call
		// spends the same rate as an API call.
		tokens: stageTokenStore(),
		usage: stageUsage,
	});

	/** The app idents a stage may link, read from the same configuration root. */
	const appIdents = (): readonly string[] =>
		(options.environment?.manager.getApps() ?? []).map((app) => app.ident);

	/** What the owner-scoped debug routes read: the trace index this process's
	 * receivers feed, the app slots a held-app precondition is checked against,
	 * and the configured infra services a query connection is declared on. */
	const debugDeps = (): DebugRouteDeps => ({
		...(options.traceIndex ? { traceIndex: options.traceIndex } : {}),
		...(options.logIndex ? { logIndex: options.logIndex } : {}),
		configDir: options.configDir ?? "",
		...(options.environment?.manager
			? { apps: options.environment.manager }
			: {}),
		...(options.environment?.manager
			? {
					infraServices: () =>
						options.environment?.manager.getInfraServices() ?? [],
				}
			: {}),
		...(options.integrations?.instances
			? { instances: options.integrations.instances }
			: {}),
		...(options.integrations?.resolveOwnerCheckout
			? { resolveOwnerCheckout: options.integrations.resolveOwnerCheckout }
			: {}),
		...(options.integrations?.resolveOwnerOverlay
			? { resolveOwnerOverlay: options.integrations.resolveOwnerOverlay }
			: {}),
	});

	const handle = async (request: Request): Promise<Response> => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return errorResponse(400, "bad-request", "invalid request URL");
		}
		try {
			assertBoundedText("path", url.pathname);
		} catch (error) {
			return errorResponse(414, "path-bound", safeMessage(error));
		}
		// Origin is checked before authorization so a browser request from a
		// foreign origin never reaches a route (or a Go mutation) at all.
		if (!originAllowed(request.headers.get("origin")))
			return errorResponse(403, "origin", "untrusted origin");
		// The agent environment surface authenticates with the owner-scoped
		// capability a durable run holds, never with the instance token, so it is
		// decided before the instance authorization below. The owner the capability
		// names is verified here, before any route runs, so a request can never act
		// on behalf of another workflow.
		if (url.pathname.startsWith(AGENT_ENVIRONMENT_PREFIX)) {
			let owner: string;
			try {
				owner = authorizeEnvironmentRequest(request, authority);
			} catch (error) {
				const status = error instanceof AuthorizationError ? error.status : 401;
				return errorResponse(status, "unauthorized", safeMessage(error));
			}
			// The evidence surface rides the same owner-scoped capability but owns
			// its own paths; it is asked first so it never depends on the
			// environment router's own 404.
			const evidence = await handleEvidenceRoute({}, request, url, owner);
			if (evidence) return evidence;
			// The browser surface rides the same capability: a run drives its own
			// sessions and resolves only the app endpoints it holds.
			const browsed = await handleBrowserRoute(
				browserDeps(),
				request,
				url,
				owner,
			);
			if (browsed) return browsed;
			// The debug surface rides the same capability too: it reads the traces of
			// this workflow's runs, the data an app it holds requires, and the
			// endpoints of the apps it holds.
			const debugged = await handleDebugRoute(debugDeps(), request, url, owner);
			if (debugged) return debugged;
			// The stage surface rides the same capability: a run reads the stages its
			// own configuration allows, and nothing else.
			const stages = await handleStageRoute(stageDeps(), request, url, owner);
			if (stages) return stages;
			return (
				(await handleAgentEnvironmentRoute(
					agentEnvironmentDeps(),
					request,
					url,
					owner,
				)) ?? errorResponse(404, "not-found", "unknown route")
			);
		}
		// The liveness probe is public (no secret in it); every other route needs
		// the instance bearer token.
		let principal: Principal = "operator";
		if (!isPublicRoute(request.method, url.pathname)) {
			try {
				principal = authorizeRequest(request, authority);
			} catch (error) {
				const status = error instanceof AuthorizationError ? error.status : 401;
				return errorResponse(status, "unauthorized", safeMessage(error));
			}
		}

		// The orchestrator capability is confined to its route policy before any
		// handler runs; its action/start limits are applied inside `route`.
		if (
			principal === "orchestrator" &&
			!orchestratorRouteAllowed(request.method, url.pathname)
		)
			return errorResponse(
				403,
				"orchestrator-forbidden",
				`${request.method.toUpperCase()} ${url.pathname} is not available to the orchestrator`,
			);

		try {
			return await route(request, url, principal);
		} catch (error) {
			// An engine failure keeps its own code (a stale revision must not
			// degrade into "bad-request"); anything else is a malformed request.
			const message = safeMessage(error);
			if (error instanceof WorkflowRuntimeError)
				return errorResponse(409, error.code, message);
			return errorResponse(400, "bad-request", message);
		}
	};

	const route = async (
		request: Request,
		url: URL,
		principal: Principal,
	): Promise<Response> => {
		const method = request.method.toUpperCase();
		const path = url.pathname;

		if (method === "GET" && path === "/api/v1/health") {
			return json({
				status: "ok",
				apiVersion: SERVER_API_VERSION,
				instance: authority.instance,
				version: options.version ?? null,
				sequence: events.currentSequence,
				at: (options.now?.() ?? new Date()).toISOString(),
			});
		}

		// The recorded bytes of one evidence entry, served to the local dashboard
		// under the instance capability. The workflow is located from the path's
		// own id through the recorded targets, so no repo is taken from a request.
		if (method === "GET" && path.startsWith(EVIDENCE_FILE_PREFIX))
			return await handleEvidenceFileRoute({}, request, url);

		if (method === "POST" && path === "/api/v1/observe") {
			const body = await readJsonBody(request);
			const decoded = decodeRouteRequest<ObserveRequest>(
				"/api/v1/observe",
				body,
			);
			const value = await operations.runObservation(decoded.observation);
			return json({ ok: true, value });
		}

		const instances = () => options.integrations?.instances;

		if (method === "GET" && path === "/api/v1/environment/apps/slots") {
			const appSlots = instances();
			if (!appSlots)
				return errorResponse(
					503,
					"instances-unavailable",
					"environment instance capability is not attached",
				);
			try {
				return json({ ok: true, value: await appSlots.slots() });
			} catch (error) {
				return instanceErrorResponse(error);
			}
		}

		if (method === "POST" && path === "/api/v1/environment/apps/acquire") {
			const appSlots = instances();
			if (!appSlots)
				return errorResponse(
					503,
					"instances-unavailable",
					"environment instance capability is not attached",
				);
			const decoded = decodeRouteRequest<AcquireSlotsRequest>(
				path,
				await readJsonBody(request),
			);
			try {
				return json({ ok: true, value: await appSlots.acquire(decoded) });
			} catch (error) {
				return instanceErrorResponse(error);
			}
		}

		if (method === "POST" && path === "/api/v1/environment/apps/action") {
			// The workflow runtime's own build/test call
			// (`staged-env-setup-config-root`): the owner is named by the request
			// because the caller is the runtime, not an agent capability, and the
			// server resolves that owner's configuration view and checkout so the
			// env-setup validation gate runs the real `env_build`/`env_test` path
			// against the staged configuration root instead of a second
			// implementation of it.
			const actions = options.integrations?.actions;
			if (!actions)
				return errorResponse(
					503,
					"actions-unavailable",
					"the environment action engine is not attached",
				);
			const decoded = decodeRouteRequest<EnvironmentOwnerActionRequest>(
				path,
				await readJsonBody(request),
			);
			const configured = options.integrations?.apps?.getAppByIdent(decoded.app);
			if (!configured)
				return errorResponse(
					404,
					"app-not-found",
					`app ${JSON.stringify(decoded.app)} is not configured`,
				);
			const owner = decoded.owner as `workflow:${string}`;
			const configuredApp =
				configured as unknown as import("./environment/config.ts").App;
			const overlay = options.integrations?.resolveOwnerOverlay?.(
				owner,
				configuredApp,
			);
			const checkout = await options.integrations?.resolveOwnerCheckout?.(
				owner,
				configuredApp,
			);
			if (!checkout)
				return errorResponse(
					409,
					"owner-checkout-unavailable",
					`no managed checkout is available for ${decoded.owner}`,
				);
			try {
				const value = await runAppBuildTestAction(actions, {
					app: configured,
					action: decoded.action,
					checkoutDir: checkout,
					...(overlay ? { configOverlay: overlay } : {}),
					...(decoded.target ? { target: decoded.target } : {}),
					...(decoded.profile ? { profile: decoded.profile } : {}),
				});
				return json({
					ok: true,
					value: {
						owner: decoded.owner,
						app: configured.ident,
						action: decoded.action,
						...value,
					},
				});
			} catch (error) {
				return errorResponse(
					500,
					"action-failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		if (method === "POST" && path === "/api/v1/environment/apps/teardown") {
			const appSlots = instances();
			if (!appSlots)
				return errorResponse(
					503,
					"instances-unavailable",
					"environment instance capability is not attached",
				);
			const decoded = decodeRouteRequest<EnvironmentTeardownRequest>(
				path,
				await readJsonBody(request),
			);
			try {
				const value = await appSlots.stopByOwner(decoded.owner);
				// A run that ends takes its browser sessions with it: the pool is
				// released here, where the run's own apps are released, so nothing keeps a
				// browser slot for a workflow that is over.
				await browser.pool.closeOwner(decoded.owner);
				// The run's rolling rate windows go with its sessions: they can never be
				// read again, so holding them would grow the registry for the life of the
				// process.
				stageUsage.release(decoded.owner);
				return json({ ok: true, value });
			} catch (error) {
				return instanceErrorResponse(error);
			}
		}

		if (
			method === "POST" &&
			path.startsWith("/api/v1/environment/apps/") &&
			(path.endsWith("/release") || path.endsWith("/stop"))
		) {
			const appSlots = instances();
			if (!appSlots)
				return errorResponse(
					503,
					"instances-unavailable",
					"environment instance capability is not attached",
				);
			const release = path.endsWith("/release");
			// Decoding through the manifest keeps the wire contract enforced even
			// though both operations act on the app in the path.
			decodeRouteRequest<AppSlotOperationRequest>(
				release
					? "/api/v1/environment/apps/{app}/release"
					: "/api/v1/environment/apps/{app}/stop",
				await readJsonBody(request),
			);
			const app = decodeURIComponent(
				path.slice(
					"/api/v1/environment/apps/".length,
					release ? -"/release".length : -"/stop".length,
				),
			);
			if (!app || app.includes("/"))
				return errorResponse(404, "app-not-found", "app not found");
			try {
				return json({
					ok: true,
					value: release
						? await appSlots.release(app)
						: await appSlots.stopApp(app),
				});
			} catch (error) {
				return instanceErrorResponse(error);
			}
		}

		if (method === "GET" && path === "/api/v1/workflow/view") {
			const repo = url.searchParams.get("repo") ?? "";
			const workflowId = url.searchParams.get("workflowId") ?? "";
			if (url.searchParams.get("list") === "1")
				return json({ ok: true, value: operations.listViews(repo) });
			return json({ ok: true, value: operations.view(repo, workflowId) });
		}

		// The typed workflow event catalog and the orchestrator's own
		// subscriptions (add-orchestrator-event-subscriptions): a cursor read of the
		// recorded events, and the subscription registry the orchestrator tools
		// manage. The orchestrator capability's allowlist names all three paths.
		if (method === "GET" && path === "/api/v1/workflow/events") {
			if (!eventBus)
				return errorResponse(
					503,
					"event-stream-unavailable",
					"this server does not own the workflow event stream",
				);
			try {
				const after = url.searchParams.get("after");
				const limit = url.searchParams.get("limit");
				const filter = filterFromQuery(url);
				return json({
					ok: true,
					value: eventBus.readEvents({
						...(after === null ? {} : { after: Number(after) }),
						...(limit === null ? {} : { limit: Number(limit) }),
						...(filter ? { filter } : {}),
					}),
				});
			} catch (error) {
				return eventErrorResponse(error);
			}
		}

		if (method === "GET" && path === "/api/v1/orchestrator/subscriptions") {
			if (!eventBus)
				return errorResponse(
					503,
					"event-stream-unavailable",
					"this server does not own the workflow event stream",
				);
			return json({
				ok: true,
				value: { subscriptions: eventBus.listSubscriptions() },
			});
		}

		if (method === "POST" && path === "/api/v1/orchestrator/subscriptions") {
			if (!eventBus)
				return errorResponse(
					503,
					"event-stream-unavailable",
					"this server does not own the workflow event stream",
				);
			const decoded = decodeRouteRequest<WorkflowEventSubscribeRequest>(
				path,
				await readJsonBody(request, 64 * 1024),
			);
			try {
				return json({ ok: true, value: eventBus.subscribe(decoded) });
			} catch (error) {
				return eventErrorResponse(error);
			}
		}

		if (
			method === "POST" &&
			path === "/api/v1/orchestrator/subscriptions/delete"
		) {
			if (!eventBus)
				return errorResponse(
					503,
					"event-stream-unavailable",
					"this server does not own the workflow event stream",
				);
			const decoded = decodeRouteRequest<WorkflowEventUnsubscribeRequest>(
				path,
				await readJsonBody(request, 64 * 1024),
			);
			try {
				return json({
					ok: true,
					value: { removed: eventBus.unsubscribe(decoded.subscriptionId) },
				});
			} catch (error) {
				return eventErrorResponse(error);
			}
		}

		if (method === "POST" && path === "/api/v1/workflow/action") {
			const decoded = decodeRouteRequest<WorkflowActionRequest>(
				"/api/v1/workflow/action",
				await readJsonBody(request),
			);
			if (principal === "orchestrator") {
				const refusal = orchestratorActionRefusal(
					decoded.actionId,
					operations.view(decoded.repo, decoded.workflowId).currentStep.id,
				);
				if (refusal)
					return errorResponse(403, "orchestrator-forbidden", refusal);
			}
			// The principal is decided here and handed over as an option, so the
			// event records the orchestrator without the wire being able to
			// claim (or suppress) the attribution.
			const value = operations.action(decoded, { principal });
			events.publish({
				domain: "workflow",
				kind: "workflow.action",
				resource: decoded.repo,
				runId: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/start") {
			const decoded = decodeRouteRequest<WorkflowStartRequest>(
				"/api/v1/workflow/start",
				await readJsonBody(request),
			);
			// An `env-setup` workflow drafts the environment definitions of one
			// *configured* application, and the orchestrator has to be told which one
			// (fix-env-tools-for-all-runs): an ident no configuration knows is refused
			// here, before a workflow exists, instead of failing later in the start
			// guard. A server with no environment authority cannot check, so it does
			// not pretend to.
			const requestedApp = decoded.app?.trim();
			if (
				requestedApp &&
				options.environment &&
				!options.environment.manager.getAppByIdent(requestedApp)
			)
				return errorResponse(
					400,
					"app-not-configured",
					`app ${JSON.stringify(requestedApp)} is not a configured application`,
				);
			// Orchestrator-started work keeps every human review: the server pins
			// the plan, developer and wiki gates to `always`, whatever the preset.
			// The same principal pins `startedBy` for the workflow's lifetime.
			const value = await operations.start(decoded, {
				...(principal === "orchestrator"
					? { enforceHumanReviewGates: true }
					: {}),
				principal,
			});
			events.publish({
				domain: "workflow",
				kind: "workflow.start",
				resource: decoded.repo,
				runId: decoded.workflowId,
			});
			return json({ ok: true, value });
		}

		if (method === "GET" && path === "/api/v1/workflow/steps") {
			// The blueprint step catalog is small and static per binary; it is a
			// read, so it never initializes a store.
			return json({ ok: true, value: operations.blueprintSteps() });
		}

		if (method === "POST" && path === "/api/v1/workflow/blueprint/validate") {
			const decoded = decodeRouteRequest<WorkflowBlueprintValidateRequest>(
				"/api/v1/workflow/blueprint/validate",
				await readJsonBody(request),
			);
			// Side-effect free: the operation only compiles, so the answer is the
			// compiled summary/digest or the compiler's diagnostics.
			return json({
				ok: true,
				value: operations.validateBlueprint(decoded.blueprint),
			});
		}

		if (method === "POST" && path === "/api/v1/workflow/repair") {
			const decoded = decodeRouteRequest<WorkflowRepairRequest>(
				"/api/v1/workflow/repair",
				await readJsonBody(request),
			);
			const value = operations.repair(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.repair",
				resource: decoded.repo,
				runId: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/question") {
			const decoded = decodeRouteRequest<WorkflowQuestionRequest>(
				"/api/v1/workflow/question",
				await readJsonBody(request),
			);
			const value = operations.question(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.question",
				resource: decoded.repo,
				runId: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/review-save") {
			const decoded = decodeRouteRequest<ReviewSaveRequest>(
				"/api/v1/workflow/review-save",
				await readJsonBody(request),
			);
			await operations.saveReview(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.review-save",
				resource: decoded.repo,
				runId: decoded.workflowId,
			});
			return json({ ok: true, value: null });
		}

		if (method === "POST" && path === "/api/v1/workflow/execute") {
			const decoded = decodeRouteRequest<WorkflowExecuteRequest>(
				"/api/v1/workflow/execute",
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			operations.execute(decoded);
			return json({ ok: true, value: null });
		}

		if (method === "POST" && path === "/api/v1/workflow/delete") {
			const decoded = decodeRouteRequest<WorkflowDeleteRequest>(
				"/api/v1/workflow/delete",
				await readJsonBody(request),
			);
			const value = await operations.deleteWorkflow(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.delete",
				resource: decoded.repo,
				runId: decoded.workflowId,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/agent/handoff") {
			const decoded = decodeRouteRequest<AgentHandoffRequest>(
				"/api/v1/agent/handoff",
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.handoff(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.handoff",
				resource: decoded.repo,
				runId: value.workflowId,
				revision: value.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/agent/question") {
			const decoded = decodeRouteRequest<AgentQuestionRequest>(
				"/api/v1/agent/question",
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.agentQuestion(
				decoded,
				request.signal,
				(workflowId, revision) =>
					events.publish({
						domain: "workflow",
						kind: "workflow.question",
						resource: decoded.repo,
						runId: workflowId,
						revision,
					}),
			);
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/agent/research-handoff") {
			const decoded = decodeRouteRequest<AgentResearchHandoffRequest>(
				"/api/v1/agent/research-handoff",
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.researchHandoff(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.research-handoff",
				resource: decoded.repo,
				runId: value.workflowId,
				revision: value.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/config/agents") {
			const decoded = decodeRouteRequest<AgentsMutationRequest>(
				"/api/v1/config/agents",
				await readJsonBody(request),
			);
			operations.saveAgents(decoded);
			events.publish({ domain: "workflow", kind: "config.agents" });
			return json({ ok: true, value: null });
		}

		if (method === "GET" && path === "/api/v1/config/agents") {
			const repository = url.searchParams.get("repository") ?? undefined;
			return json({ ok: true, value: operations.loadAgents(repository) });
		}

		if (method === "GET" && path === "/api/v1/classifier/status") {
			const repository = url.searchParams.get("repository") ?? undefined;
			return json({
				ok: true,
				value: await operations.classifierStatus(repository),
			});
		}

		if (method === "POST" && path === "/api/v1/classifier/install") {
			decodeRouteRequest(
				"/api/v1/classifier/install",
				await readJsonBody(request),
			);
			const value = await operations.installClassifier(
				url.searchParams.get("repository") ?? undefined,
			);
			events.publish({ domain: "workflow", kind: "classifier.install" });
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/classifier/install/cancel") {
			decodeRouteRequest(
				"/api/v1/classifier/install/cancel",
				await readJsonBody(request),
			);
			const value = await operations.cancelClassifierInstall(
				url.searchParams.get("repository") ?? undefined,
			);
			events.publish({ domain: "workflow", kind: "classifier.install.cancel" });
			return json({ ok: true, value });
		}

		// The literal paths are the manifest's own (`protocol.ts` declares
		// `BROWSER_*_PATH`), and the manifest test asserts the two agree.
		if (method === "GET" && path === "/api/v1/browser/status")
			return json({ ok: true, value: await operations.browserStatus() });

		if (method === "POST" && path === "/api/v1/browser/install") {
			// The only path that downloads. It runs only because this request exists,
			// and the body must be empty: nothing here takes a URL or a version to
			// fetch. The operations facade owns it, so this route, the dashboard's
			// in-process adapter and its HTTP client all cross one seam.
			decodeRouteRequest(BROWSER_INSTALL_PATH, await readJsonBody(request));
			const value = await operations.installBrowser();
			events.publish({ domain: "workflow", kind: "browser.install" });
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/browser/install/cancel") {
			decodeRouteRequest(
				BROWSER_INSTALL_CANCEL_PATH,
				await readJsonBody(request),
			);
			const value = await operations.cancelBrowserInstall();
			events.publish({ domain: "workflow", kind: "browser.install.cancel" });
			return json({ ok: true, value });
		}

		// The stage surfaces (`protocol.ts` declares `STAGES_PATH` and
		// `STAGES_CREDENTIAL_PATH`), instance-authenticated like every other
		// dashboard read: the operator sees the allow-list, and only a referenced
		// variable is written.
		if (method === "GET" && path === "/api/v1/stages")
			return json({ ok: true, value: stagesStatusValue(stageDeps()) });

		if (method === "POST" && path === "/api/v1/stages/credential") {
			const written = await handleStageCredentialRoute(stageDeps(), request);
			// The write is the only stage change a dashboard can make here, so it is
			// announced like the browser install is.
			if (written.status === 200)
				events.publish({ domain: "stages", kind: "stages.credential" });
			return written;
		}

		// The identity cache (`add-stage-identity-cache`): the value-free listing and
		// the forget action. Reading the cache is an ordinary dashboard read; a
		// forget changes what the *next* stage session starts from, so it is
		// announced like the credential write is.
		if (method === "GET" && path === "/api/v1/stages/identity") {
			const listed = await handleStageIdentityRoute(stageDeps(), request, path);
			if (listed === undefined)
				throw new Error("the identity cache route did not answer its listing");
			return listed;
		}
		if (method === "POST" && path === "/api/v1/stages/identity/forget") {
			const forgotten = await handleStageIdentityRoute(
				stageDeps(),
				request,
				path,
			);
			if (forgotten === undefined)
				throw new Error("the identity cache route did not answer the forget");
			if (forgotten.status === 200)
				events.publish({ domain: "stages", kind: "stages.identity" });
			return forgotten;
		}

		if (method === "POST" && path === "/api/v1/credentials/respond") {
			const decoded = decodeRouteRequest<CredentialRespondRequest>(
				"/api/v1/credentials/respond",
				await readJsonBody(request, 64 * 1024),
			);
			const outcome = credentials.respond(
				decoded.ownerId,
				decoded.interactionId,
				decoded.value,
			);
			if (!outcome.accepted)
				return errorResponse(409, "credential-rejected", outcome.reason);
			return json({ ok: true });
		}

		if (method === "GET" && path === "/api/v1/events")
			return eventStream(request, url);

		if (method === "GET" && path === "/api/v1/telemetry/workspaces") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			return json({
				ok: true,
				value: { workspaces: options.telemetry.workspaces() },
			});
		}

		if (method === "POST" && path === "/api/v1/telemetry/traces") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRouteRequest<TelemetryTracesRequest>(
				"/api/v1/telemetry/traces",
				await readJsonBody(request, 64 * 1024),
			);
			return json({ ok: true, value: options.telemetry.summaries(decoded) });
		}

		if (method === "POST" && path === "/api/v1/telemetry/spans") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRouteRequest<TelemetrySpansRequest>(
				"/api/v1/telemetry/spans",
				await readJsonBody(request, 64 * 1024),
			);
			const spans = decoded.changeId
				? options.telemetry.traceSpans(decoded.changeId)
				: options.telemetry.recentSpans(decoded.limit);
			return json({ ok: true, value: { spans } });
		}

		if (method === "POST" && path === "/api/v1/telemetry/watch") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRouteRequest<TelemetryWatchRequest>(
				"/api/v1/telemetry/watch",
				await readJsonBody(request, 64 * 1024),
			);
			registerTelemetryWatch(decoded.repo);
			return json({ ok: true, value: { watched: true } });
		}

		if (method === "POST" && path === "/api/v1/telemetry/scan") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRouteRequest<TelemetryScanRequest>(
				"/api/v1/telemetry/scan",
				await readJsonBody(request, 64 * 1024),
			);
			const scanned = await options.telemetry.scan(decoded.repo);
			// Server-owned file watcher: new workspace telemetry is announced on the
			// event stream so clients refresh from the API instead of polling files.
			registerTelemetryWatch(decoded.repo);
			events.publish({
				domain: "telemetry",
				kind: "telemetry.scan",
				resource: decoded.repo,
			});
			return json({ ok: true, value: { scanned } });
		}

		if (method === "POST" && path === "/api/v1/telemetry/prune") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRouteRequest<TelemetryPruneRequest>(
				"/api/v1/telemetry/prune",
				await readJsonBody(request, 64 * 1024),
			);
			const removed = options.telemetry.prune(decoded.days);
			return json({ ok: true, value: { removed } });
		}

		if (method === "POST" && path === ENVIRONMENT_OPERATION_PATH)
			return environmentOperation(request);

		// The legacy devenv surface, served by the same process. `/api/health` is
		// the liveness/identity probe every client and launcher uses, so it answers
		// here instead of being a special case in another runtime.
		if (path.startsWith("/api/") && !path.startsWith("/api/v1/")) {
			if (method === "GET" && path === "/api/health") return health();
			if (options.integrations) {
				const handled = await handleLegacyRoute(
					options.integrations,
					request,
					url,
				);
				if (handled) return handled;
			}
			return errorResponse(404, "not-found", "unknown route");
		}

		return errorResponse(404, "not-found", "unknown route");
	};

	/** Instance identity for clients and for `attach` readiness. The instance id
	 * and the environment roots are what distinguish this process from any other
	 * server on the same loopback port. */
	const health = (): Response =>
		json({
			status: "ok",
			apiVersion: SERVER_API_VERSION,
			instance: authority.instance,
			version: options.version ?? null,
			pid: process.pid,
			homeDir: options.homeDir ?? null,
			configDir: options.configDir ?? null,
			sequence: events.currentSequence,
			at: (options.now?.() ?? new Date()).toISOString(),
		});

	/** SSE stream: bounded replay first, then live events. A cursor outside the
	 * retained window emits `resync` and the client must fetch a snapshot. */
	const eventStream = (request: Request, url: URL): Response => {
		const raw = url.searchParams.get("cursor");
		const cursor = raw === null ? undefined : Number(raw);
		if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0))
			return errorResponse(400, "bad-cursor", "invalid event cursor");
		const encoder = new TextEncoder();
		let subscription: ReturnType<EventBroker["open"]> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (event: string, data: unknown) => {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				};
				send("hello", {
					instance: authority.instance,
					apiVersion: SERVER_API_VERSION,
				});
				subscription = events.open(
					cursor === undefined ? {} : { after: cursor },
					(event) => send("domain", event),
					() =>
						send("resync", { reason: "client fell outside the replay window" }),
				);
				if (subscription.snapshotRequired)
					send("resync", { reason: "cursor outside replay window" });
				for (const event of subscription.replay) send("domain", event);
			},
			cancel() {
				subscription?.unsubscribe();
				subscription = undefined;
			},
		});
		request.signal.addEventListener(
			"abort",
			() => subscription?.unsubscribe(),
			{
				once: true,
			},
		);
		return new Response(stream, {
			status: 200,
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
			},
		});
	};

	/** Bun-owned private environment operation. Serves the store/manager the
	 * remaining Go services call; it never performs an outbound request, so it
	 * cannot recurse back into the Go child. */
	const environmentOperation = async (request: Request): Promise<Response> => {
		const environment = options.environment;
		if (!environment)
			return errorResponse(
				503,
				"environment-unavailable",
				"this server does not own the environment state",
			);
		try {
			const value = executeEnvironmentOperation(
				environment,
				await readJsonBody(request, MAX_REQUEST_BYTES),
			);
			return json({ ok: true, value });
		} catch (error) {
			if (error instanceof EnvironmentOperationError)
				return errorResponse(error.status, error.code, safeMessage(error));
			throw error;
		}
	};

	return {
		authority,
		events,
		credentials,
		operations,
		telemetry: options.telemetry,
		...(options.hub ? { hub: options.hub } : {}),
		...(eventBus ? { eventBus } : {}),
		fetch: handle,
		credentialPrompt: (ownerId) => async (prompt, signal) => {
			const answer = credentials.request(ownerId, signal);
			// Correlate the prompt with the interaction id the response must use.
			const interactionId = credentials.newestFor(ownerId);
			events.publish({
				domain: "credentials",
				kind: "credentials.requested",
				resource: interactionId,
				payload: { ownerId, interactionId, prompt },
			});
			return answer;
		},
	};
}
