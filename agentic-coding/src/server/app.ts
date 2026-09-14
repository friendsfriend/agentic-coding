// Bun transport composition for the unified backend (expose-unified-bun-backend,
// task 2.1/2.4). One `fetch` handler owns routing, authorization, bounds,
// event delivery and private Go delegation; the operation handlers behind it
// are pure application calls. This module is transport-only: it never imports
// presentation and never spawns a workflow subprocess.
import {
	AuthorizationError,
	assertBoundedText,
	authorizeRequest,
	type InstanceAuthority,
	isSessionAuthorizedRoute,
	originAllowed,
	PayloadBoundError,
	readBoundedBody,
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
	decodeGitCommandRequest,
	executeGitCommand,
	IntegrationOperationError,
	PRIVATE_GIT_COMMAND_PATH,
} from "./integrations/private-api.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
} from "./integrations/routes.ts";
import {
	agentHandoffRequestSchema,
	agentQuestionRequestSchema,
	agentResearchHandoffRequestSchema,
	agentsMutationRequestSchema,
	credentialRespondSchema,
	decodeRequest,
	MAX_REQUEST_BYTES,
	observeRequestSchema,
	reviewSaveRequestSchema,
	SERVER_API_VERSION,
	telemetryPruneRequestSchema,
	telemetryScanRequestSchema,
	workflowActionRequestSchema,
	workflowExecuteRequestSchema,
	workflowQuestionRequestSchema,
	workflowRepairRequestSchema,
	workflowStartRequestSchema,
} from "./protocol.ts";
import type { WorkflowEventHub } from "./subscriptions.ts";
import type { TelemetryOperations } from "./telemetry.ts";

export interface ServerAppOptions {
	readonly authority: InstanceAuthority;
	readonly events: EventBroker;
	readonly credentials: CredentialRegistry;
	/** Private Go listener base URL (for delegated environment routes, which
	 * stay Go-served until the remaining Go services are ported). A function is
	 * resolved per request, so Bun can start before the child it delegates to
	 * exists (migrated mode starts Bun first because the child needs Bun's
	 * address). */
	readonly environmentBaseUrl?: string | (() => string | undefined);
	/** Private instance token presented to the Go listener. Resolved per
	 * request like `environmentBaseUrl`. */
	readonly environmentToken?: string | (() => string | undefined);
	/** Bun-owned environment state/catalog authority (migrated mode). When set,
	 * the bounded private operations are served in-process and the remaining Go
	 * services have no writable SQLite handle of their own. */
	readonly environment?: EnvironmentAuthority;
	readonly version?: string;
	/** Test/clock override. */
	readonly now?: () => Date;
	/** Bounded response bytes for a delegated Go response. */
	readonly maxDelegatedBytes?: number;
	/** Override the application operations (transport tests). */
	readonly operations?: ServerOperations;
	/** Server-owned telemetry persistence/query operations. */
	readonly telemetry?: TelemetryOperations;
	/** Server-owned workflow refresh subscriptions. */
	readonly hub?: WorkflowEventHub;
	/** Bun-served legacy integration families (Git, providers, repository
	 * search). When absent, every legacy `/api/*` path is delegated. */
	readonly integrations?: IntegrationServices;
}

export interface ServerApp {
	readonly authority: InstanceAuthority;
	readonly events: EventBroker;
	readonly credentials: CredentialRegistry;
	fetch(request: Request): Promise<Response>;
	/** A `CredentialPrompt`-compatible function bound to one client owner. */
	credentialPrompt(
		ownerId: string,
	): (prompt: string, signal?: AbortSignal) => Promise<string>;
}

const DEFAULT_DELEGATED_BYTES = 32 * 1024 * 1024;

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
	const maxDelegated = options.maxDelegatedBytes ?? DEFAULT_DELEGATED_BYTES;
	const operations = options.operations ?? serverOperations;
	const telemetryWatchers = new Map<string, () => void>();

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
		// The review callback authorizes with its own path capability; every
		// other route needs the instance bearer token.
		if (!isSessionAuthorizedRoute(request.method, url.pathname)) {
			try {
				authorizeRequest(request, authority);
			} catch (error) {
				const status = error instanceof AuthorizationError ? error.status : 401;
				return errorResponse(status, "unauthorized", safeMessage(error));
			}
		}

		try {
			return await route(request, url);
		} catch (error) {
			const message = safeMessage(error);
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
			const decoded = decodeRequest(
				"server.observe",
				observeRequestSchema,
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
			const decoded = decodeRequest(
				"server.workflow.action",
				workflowActionRequestSchema,
				await readJsonBody(request),
			);
			const value = operations.action(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.action",
				resource: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/start") {
			const decoded = decodeRequest(
				"server.workflow.start",
				workflowStartRequestSchema,
				await readJsonBody(request),
			);
			const value = await operations.start(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.start",
				resource: decoded.workflowId,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/repair") {
			const decoded = decodeRequest(
				"server.workflow.repair",
				workflowRepairRequestSchema,
				await readJsonBody(request),
			);
			const value = operations.repair(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.repair",
				resource: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/question") {
			const decoded = decodeRequest(
				"server.workflow.question",
				workflowQuestionRequestSchema,
				await readJsonBody(request),
			);
			const value = operations.question(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.question",
				resource: decoded.workflowId,
				revision: decoded.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/workflow/review-save") {
			const decoded = decodeRequest(
				"server.workflow.review-save",
				reviewSaveRequestSchema,
				await readJsonBody(request),
			);
			await operations.saveReview(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.review-save",
				resource: decoded.workflowId,
			});
			return json({ ok: true, value: null });
		}

		if (method === "POST" && path === "/api/v1/workflow/execute") {
			const decoded = decodeRequest(
				"server.workflow.execute",
				workflowExecuteRequestSchema,
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			operations.execute(decoded);
			return json({ ok: true, value: null });
		}

		if (method === "POST" && path === "/api/v1/agent/handoff") {
			const decoded = decodeRequest(
				"server.agent.handoff",
				agentHandoffRequestSchema,
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.handoff(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.handoff",
				resource: value.workflowId,
				revision: value.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/agent/question") {
			const decoded = decodeRequest(
				"server.agent.question",
				agentQuestionRequestSchema,
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.agentQuestion(decoded, request.signal);
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/agent/research-handoff") {
			const decoded = decodeRequest(
				"server.agent.research-handoff",
				agentResearchHandoffRequestSchema,
				await readJsonBody(request),
			);
			options.hub?.watchRepo(decoded.repo);
			const value = await operations.researchHandoff(decoded);
			events.publish({
				domain: "workflow",
				kind: "workflow.research-handoff",
				resource: value.workflowId,
				revision: value.revision,
			});
			return json({ ok: true, value });
		}

		if (method === "POST" && path === "/api/v1/config/agents") {
			const decoded = decodeRequest(
				"server.config.agents",
				agentsMutationRequestSchema,
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
			const decoded = decodeRequest(
				"server.credentials.respond",
				credentialRespondSchema,
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

		if (method === "GET" && path === "/api/v1/telemetry/snapshot") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const changeId = url.searchParams.get("changeId");
			return json({
				ok: true,
				value: options.telemetry.snapshot(changeId ?? undefined),
			});
		}

		if (method === "POST" && path === "/api/v1/telemetry/scan") {
			if (!options.telemetry)
				return errorResponse(
					503,
					"telemetry-unavailable",
					"no telemetry service",
				);
			const decoded = decodeRequest(
				"server.telemetry.scan",
				telemetryScanRequestSchema,
				await readJsonBody(request, 64 * 1024),
			);
			const scanned = await options.telemetry.scan(decoded.repo);
			// Server-owned file watcher: new workspace telemetry is announced on the
			// event stream so clients refresh from the API instead of polling files.
			if (options.telemetry.watch && !telemetryWatchers.has(decoded.repo)) {
				const unwatch = options.telemetry.watch(decoded.repo, () => {
					events.publish({
						domain: "telemetry",
						kind: "telemetry.updated",
						resource: decoded.repo,
					});
				});
				telemetryWatchers.set(decoded.repo, unwatch);
			}
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
			const decoded = decodeRequest(
				"server.telemetry.prune",
				telemetryPruneRequestSchema,
				await readJsonBody(request, 64 * 1024),
			);
			const removed = options.telemetry.prune(decoded.days);
			return json({ ok: true, value: { removed } });
		}

		if (method === "POST" && path === ENVIRONMENT_OPERATION_PATH)
			return environmentOperation(request);

		if (method === "POST" && path === PRIVATE_GIT_COMMAND_PATH)
			return gitCommandOperation(request);

		if (path.startsWith("/api/v1/environment/"))
			return delegateToEnvironment(request, url);

		// The legacy devenv surface: a Bun-owned family is served in-process, and
		// every other legacy path is delegated to the private Go child so the
		// clients keep one base URL while ownership moves family by family.
		if (path.startsWith("/api/") && !path.startsWith("/api/v1/")) {
			if (options.integrations) {
				const handled = await handleLegacyRoute(
					options.integrations,
					request,
					url,
				);
				if (handled) return handled;
			}
			return delegateLegacy(request, url);
		}

		return errorResponse(404, "not-found", "unknown route");
	};

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

	/** Private Go delegation: strip the version prefix, forward the method,
	 * path, query and bounded body, and relay a bounded response. */
	const delegateToEnvironment = async (
		request: Request,
		url: URL,
	): Promise<Response> => {
		const environmentBaseUrl =
			typeof options.environmentBaseUrl === "function"
				? options.environmentBaseUrl()
				: options.environmentBaseUrl;
		if (!environmentBaseUrl)
			return errorResponse(
				503,
				"environment-unavailable",
				"no private environment backend is attached",
			);
		const suffix = url.pathname.slice("/api/v1/environment".length);
		const target = new URL(suffix, environmentBaseUrl);
		target.search = url.search;
		const headers = new Headers();
		const contentType = request.headers.get("content-type");
		if (contentType) headers.set("content-type", contentType);
		headers.set("accept", request.headers.get("accept") ?? "application/json");
		const environmentToken =
			typeof options.environmentToken === "function"
				? options.environmentToken()
				: options.environmentToken;
		if (environmentToken) headers.set("x-instance-token", environmentToken);
		const body =
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: (await readBoundedBody(request, MAX_REQUEST_BYTES)) || undefined;
		const response = await fetch(target, {
			method: request.method,
			headers,
			body,
			signal: request.signal,
		});
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxDelegated)
			return errorResponse(
				502,
				"environment-response-too-large",
				"delegated response exceeded the bound",
			);
		return new Response(buffer, {
			status: response.status,
			headers: {
				"content-type":
					response.headers.get("content-type") ?? "application/json",
				"cache-control": "no-store",
			},
		});
	};

	/** Private Git operation for the still-Go action owner: Bun executes one
	 * argv, the Go owner records the result. No outbound request, so it can
	 * never recurse into the delegated child. */
	const gitCommandOperation = async (request: Request): Promise<Response> => {
		const integrations = options.integrations;
		if (!integrations)
			return errorResponse(
				503,
				"integrations-unavailable",
				"this server does not own the Git capability",
			);
		try {
			const decoded = decodeGitCommandRequest(
				await readJsonBody(request, 256 * 1024),
			);
			const value = await executeGitCommand(
				{ git: integrations.git },
				decoded,
				request.signal,
			);
			return json({ ok: true, value });
		} catch (error) {
			if (error instanceof IntegrationOperationError)
				return errorResponse(error.status, error.code, safeMessage(error));
			throw error;
		}
	};

	/** Legacy delegation: the child serves the same path, so nothing is
	 * rewritten. The response body is streamed, because this surface carries
	 * server-sent event streams that must not be buffered. */
	const delegateLegacy = async (
		request: Request,
		url: URL,
	): Promise<Response> => {
		const environmentBaseUrl =
			typeof options.environmentBaseUrl === "function"
				? options.environmentBaseUrl()
				: options.environmentBaseUrl;
		if (!environmentBaseUrl)
			return errorResponse(
				503,
				"environment-unavailable",
				"no private environment backend is attached",
			);
		const target = new URL(url.pathname, environmentBaseUrl);
		target.search = url.search;
		const headers = new Headers();
		const contentType = request.headers.get("content-type");
		if (contentType) headers.set("content-type", contentType);
		headers.set("accept", request.headers.get("accept") ?? "application/json");
		const environmentToken =
			typeof options.environmentToken === "function"
				? options.environmentToken()
				: options.environmentToken;
		if (environmentToken) headers.set("x-instance-token", environmentToken);
		const body =
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: (await readBoundedBody(request, MAX_REQUEST_BYTES)) || undefined;
		const response = await fetch(target, {
			method: request.method,
			headers,
			body,
			signal: request.signal,
		});
		return new Response(response.body, {
			status: response.status,
			headers: {
				"content-type":
					response.headers.get("content-type") ?? "application/json",
				"cache-control": "no-store",
			},
		});
	};

	return {
		authority,
		events,
		credentials,
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
