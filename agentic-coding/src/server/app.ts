// Bun transport composition for the unified backend (single-Bun-application).
// One `fetch` handler owns routing, authorization, bounds and event delivery;
// the operation handlers behind it are pure application calls. This module is
// transport-only: it never imports presentation and never spawns a second
// runtime. Since the Go backend was retired there is no delegation: every route
// is answered in this process or is 404.

import type {
	AgentHandoffRequest,
	AgentQuestionRequest,
	AgentResearchHandoffRequest,
	AgentsMutationRequest,
	ReviewSaveRequest,
	WorkflowActionRequest,
	WorkflowExecuteRequest,
	WorkflowQuestionRequest,
	WorkflowRepairRequest,
	WorkflowStartRequest,
} from "../contracts/actions.ts";
import type { CredentialRespondRequest } from "../contracts/credential.ts";
import type { ObserveRequest } from "../contracts/environment.ts";
import type {
	TelemetryPruneRequest,
	TelemetryScanRequest,
	TelemetrySpansRequest,
	TelemetryTracesRequest,
	TelemetryWatchRequest,
} from "../contracts/telemetry.ts";
import { WorkflowRuntimeError } from "../workflow/contracts.ts";
import {
	AuthorizationError,
	assertBoundedText,
	authorizeRequest,
	type InstanceAuthority,
	isPublicRoute,
	isSessionAuthorizedRoute,
	originAllowed,
	PayloadBoundError,
	readJsonBody,
} from "./auth.ts";
import type { CredentialRegistry } from "./credentials.ts";
import {
	ENVIRONMENT_OPERATION_PATH,
	type EnvironmentAuthority,
	EnvironmentOperationError,
	executeEnvironmentOperation,
} from "./environment/private-api.ts";
import type { EventBroker } from "./events.ts";
import { type ServerOperations, serverOperations } from "./handlers.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
} from "./integrations/routes.ts";
import {
	decodeRouteRequest,
	MAX_REQUEST_BYTES,
	SERVER_API_VERSION,
} from "./protocol.ts";
import type { WorkflowEventHub } from "./subscriptions.ts";
import type { TelemetryOperations } from "./telemetry.ts";

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
	/** Bun-served legacy integration families (Git, providers, repository
	 * search). When absent the legacy `/api/*` surface answers 503. */
	readonly integrations?: IntegrationServices;
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

/** Bounded diagnostic text: never echo a supplied token or raw body. */
function safeMessage(error: unknown): string {
	if (error instanceof AuthorizationError) return error.reason;
	if (error instanceof PayloadBoundError) return error.reason;
	if (error instanceof Error) return error.message.slice(0, 512);
	return String(error).slice(0, 512);
}

export function createServerApp(options: ServerAppOptions): ServerApp {
	const { authority, events, credentials } = options;
	const operations = options.operations ?? serverOperations;
	const telemetryWatchers = new Map<string, () => void>();

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
		// The review callback authorizes with its own path capability and the
		// liveness probe is public (no secret in it); every other route needs the
		// instance bearer token.
		if (!isSessionAuthorizedRoute(request.method, url.pathname)) {
			if (!isPublicRoute(request.method, url.pathname)) {
				try {
					authorizeRequest(request, authority);
				} catch (error) {
					const status =
						error instanceof AuthorizationError ? error.status : 401;
					return errorResponse(status, "unauthorized", safeMessage(error));
				}
			}
		}

		try {
			return await route(request, url);
		} catch (error) {
			// An engine failure keeps its own code (a stale revision must not
			// degrade into "bad-request"); anything else is a malformed request.
			const message = safeMessage(error);
			if (error instanceof WorkflowRuntimeError)
				return errorResponse(409, error.code, message);
			return errorResponse(400, "bad-request", message);
		}
	};

	const route = async (request: Request, url: URL): Promise<Response> => {
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

		if (method === "POST" && path === "/api/v1/observe") {
			const body = await readJsonBody(request);
			const decoded = decodeRouteRequest<ObserveRequest>(
				"/api/v1/observe",
				body,
			);
			const value = await operations.runObservation(decoded.observation);
			return json({ ok: true, value });
		}

		if (method === "GET" && path === "/api/v1/workflow/view") {
			const repo = url.searchParams.get("repo") ?? "";
			const workflowId = url.searchParams.get("workflowId") ?? "";
			if (url.searchParams.get("list") === "1")
				return json({ ok: true, value: operations.listViews(repo) });
			return json({ ok: true, value: operations.view(repo, workflowId) });
		}

		if (method === "POST" && path === "/api/v1/workflow/action") {
			const decoded = decodeRouteRequest<WorkflowActionRequest>(
				"/api/v1/workflow/action",
				await readJsonBody(request),
			);
			const value = operations.action(decoded);
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
			const value = await operations.start(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.start",
				resource: decoded.repo,
				runId: decoded.workflowId,
			});
			return json({ ok: true, value });
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
