// Typed client for the unified Bun backend (expose-unified-bun-backend,
// task 2.5/2.6/3.3). The TUI and CLI use this module instead of reaching
// workflow/telemetry/observation internals: every call is an authenticated,
// bounded HTTP request and every response decodes at this boundary.
//
// The client deliberately imports nothing from the TUI feature tree, so the
// observation module can depend on it without forming a cycle.
import type { Schema } from "effect";
import {
	type AgentsListResponse,
	type AgentsMutationRequest,
	agentsListResponseSchema,
} from "../contracts/actions.ts";
import type { CredentialRespondRequest } from "../contracts/credential.ts";
import { ContractFailure, decodeContract } from "../contracts/decode.ts";
import {
	type ConnectionState,
	type EventEnvelope,
	type ObservationRequest,
	wireEnvelopeSchema,
} from "../contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../contracts/gateway.ts";
import {
	type TraceSummaryPage,
	telemetryCountSchema,
	telemetryRemovedSchema,
	telemetrySpansSchema,
	telemetryWorkspacesSchema,
	traceSummaryPageSchema,
} from "../contracts/telemetry.ts";
import {
	type WorkflowView,
	workflowIdResponseSchema,
	workflowViewListSchema,
	workflowViewSchema,
} from "../contracts/workflow.ts";
import { instanceTokenFileForUrl, readInstanceTokenFile } from "./auth.ts";
import { SERVER_API_VERSION } from "./protocol.ts";

export interface BackendClientConfig {
	readonly baseUrl: string;
	readonly token: string;
	readonly ownerId: string;
}

export class BackendClientError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class BackendClient implements DashboardGateway {
	readonly kind = "http" as const;
	readonly baseUrl: string;
	readonly token: string;
	readonly ownerId: string;
	private state: ConnectionState = "closed";
	private readonly stateListeners = new Set<(state: ConnectionState) => void>();

	connectionState(): ConnectionState {
		return this.state;
	}

	private setState(state: ConnectionState): void {
		if (this.state === state) return;
		this.state = state;
		for (const listener of this.stateListeners) listener(state);
	}

	constructor(config: BackendClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.token = config.token;
		this.ownerId = config.ownerId;
	}

	/** Decode one response value with its contract schema. A malformed body is
	 * an `invalid-response` failure, never a value the caller has to re-check. */
	private decode<T>(
		id: string,
		// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
		schema: Schema.Schema<any, any, never>,
		value: unknown,
		status = 200,
	): T {
		try {
			return decodeContract<T>(id, schema, value);
		} catch (error) {
			if (error instanceof ContractFailure)
				throw new BackendClientError(
					status,
					"invalid-response",
					`backend returned an invalid ${id} payload (${error.message})`,
				);
			throw error;
		}
	}

	private authToken(): string {
		const file = instanceTokenFileForUrl(this.baseUrl);
		return (file && readInstanceTokenFile(file)) ?? this.token;
	}

	private headers(json: boolean, token = this.authToken()): Headers {
		const headers = new Headers();
		headers.set("authorization", `Bearer ${token}`);
		headers.set("x-api-version", SERVER_API_VERSION);
		headers.set("x-client-owner", this.ownerId);
		if (json) headers.set("content-type", "application/json");
		return headers;
	}

	private async request(
		method: string,
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		let response: Response;
		const token = this.authToken();
		const send = (authorization: string) =>
			fetch(`${this.baseUrl}${path}`, {
				method,
				headers: this.headers(body !== undefined, authorization),
				body: body === undefined ? undefined : JSON.stringify(body),
				...(signal ? { signal } : {}),
			});
		try {
			response = await send(token);
			// A stale fallback token can survive while a loopback server restarts.
			// Retry once with configured token for callers attached to a server that
			// does not publish a local token file.
			if (response.status === 401 && token !== this.token)
				response = await send(this.token);
		} catch (error) {
			// A cancelled call reports one stable error shape regardless of what
			// the runtime threw, so both adapters behave identically (task 3.6).
			if (signal?.aborted)
				throw new DOMException("operation cancelled", "AbortError");
			throw error;
		}
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			throw new BackendClientError(
				response.status,
				"invalid-response",
				"backend returned a non-JSON response",
			);
		}
		if (!response.ok) {
			const envelope = parsed as {
				error?: { code?: string; message?: string };
			};
			throw new BackendClientError(
				response.status,
				envelope.error?.code ?? "request-failed",
				envelope.error?.message ??
					`backend rejected the request (${response.status})`,
			);
		}
		// Every JSON response is an envelope: decode it, so a body that is
		// neither a value nor a structured error fails here.
		try {
			const envelope = decodeContract<{ ok: boolean; value?: unknown }>(
				"core.wire-envelope",
				wireEnvelopeSchema,
				parsed,
			);
			if (!envelope.ok) {
				// a 2xx response that carries a failure envelope is an error, not
				// an absent value
				const failure = (
					envelope as { error?: { code?: string; message?: string } }
				).error;
				throw new BackendClientError(
					response.status,
					failure?.code ?? "request-failed",
					failure?.message ?? "backend reported a failure",
				);
			}
			return envelope.value;
		} catch (error) {
			if (error instanceof ContractFailure)
				throw new BackendClientError(
					response.status,
					"invalid-response",
					`backend returned a malformed envelope (${error.message})`,
				);
			throw error;
		}
	}

	/** Observations return a kind-specific value; the caller owns the schema
	 * (the data layer passes the contract schema for the kind it asked for). */
	async observe<T>(
		observation: ObservationRequest,
		// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
		schema: Schema.Schema<any, any, never>,
		signal?: AbortSignal,
	): Promise<T> {
		return this.decode<T>(
			`core.observation.${observation.kind}`,
			schema,
			await this.request("POST", "/api/v1/observe", { observation }, signal),
		);
	}

	async listViews(repo: string, signal?: AbortSignal): Promise<WorkflowView[]> {
		const query = new URLSearchParams({ repo, list: "1" });
		return this.decode<WorkflowView[]>(
			"core.workflow-view-list",
			workflowViewListSchema,
			await this.request(
				"GET",
				`/api/v1/workflow/view?${query}`,
				undefined,
				signal,
			),
		);
	}

	async view(
		repo: string,
		workflowId: string,
		signal?: AbortSignal,
	): Promise<WorkflowView> {
		const query = new URLSearchParams({ repo, workflowId });
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request(
				"GET",
				`/api/v1/workflow/view?${query}`,
				undefined,
				signal,
			),
		);
	}

	async action(request: {
		repo: string;
		workflowId: string;
		revision: number;
		actionId: string;
		input?: unknown;
	}): Promise<WorkflowView> {
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request("POST", "/api/v1/workflow/action", request),
		);
	}

	async start(request: {
		repo: string;
		workflowId: string;
		mode: string;
		ticket?: string;
		task?: string;
		workflowType?: string;
		preset?: string;
	}): Promise<string> {
		return this.decode<string>(
			"core.workflow-id",
			workflowIdResponseSchema,
			await this.request("POST", "/api/v1/workflow/start", request),
		);
	}

	async repair(request: {
		repo: string;
		workflowId: string;
		revision: number;
		targetStep: string;
		reason?: string;
	}): Promise<WorkflowView> {
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request("POST", "/api/v1/workflow/repair", request),
		);
	}

	async question(request: {
		repo: string;
		workflowId: string;
		revision: number;
		questionId: string;
		answer: unknown;
	}): Promise<WorkflowView> {
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request("POST", "/api/v1/workflow/question", request),
		);
	}

	async saveReview(request: {
		repo: string;
		workflowId: string;
		kind: "developer" | "plan" | "wiki";
		comments: readonly unknown[];
	}): Promise<void> {
		await this.request("POST", "/api/v1/workflow/review-save", request);
	}

	async execute(request: { repo: string; workflowId?: string }): Promise<void> {
		await this.request("POST", "/api/v1/workflow/execute", request);
	}

	async agentHandoff(request: {
		repo: string;
		environment: Record<string, string>;
		outcome: "complete" | "blocked" | "failed";
		artifact?: string;
		message?: string;
		drain?: boolean;
	}): Promise<WorkflowView> {
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request("POST", "/api/v1/agent/handoff", request),
		);
	}

	async agentQuestion(
		request: {
			repo: string;
			environment: Record<string, string>;
			input: unknown;
			timeoutMs?: number;
		},
		signal?: AbortSignal,
	): Promise<string> {
		return this.decode<string>(
			"core.workflow-id",
			workflowIdResponseSchema,
			await this.request("POST", "/api/v1/agent/question", request, signal),
		);
	}

	async researchHandoff(request: {
		repo: string;
		environment: Record<string, string>;
		handoff: unknown;
	}): Promise<WorkflowView> {
		return this.decode<WorkflowView>(
			"core.workflow-view",
			workflowViewSchema,
			await this.request("POST", "/api/v1/agent/research-handoff", request),
		);
	}

	async saveAgents(request: AgentsMutationRequest): Promise<void> {
		await this.request("POST", "/api/v1/config/agents", request);
	}

	async loadAgents(repository?: string): Promise<AgentsListResponse> {
		const query = repository
			? `?repository=${encodeURIComponent(repository)}`
			: "";
		return this.decode(
			"core.agents-list",
			agentsListResponseSchema,
			await this.request("GET", `/api/v1/config/agents${query}`, undefined),
		);
	}

	async telemetryWorkspaces(): Promise<
		Array<{ changeId: string; path: string; spanCount: number }>
	> {
		const value = this.decode<{
			workspaces: Array<{ changeId: string; path: string; spanCount: number }>;
		}>(
			"core.telemetry-workspaces",
			telemetryWorkspacesSchema,
			await this.request("GET", "/api/v1/telemetry/workspaces", undefined),
		);
		return value.workspaces;
	}

	/** One page of the trace list (workflows, newest first). */
	async telemetryTraces(options: {
		page?: number;
		perPage?: number;
		changeId?: string;
	}): Promise<TraceSummaryPage> {
		return this.decode<TraceSummaryPage>(
			"core.telemetry-traces",
			traceSummaryPageSchema,
			await this.request("POST", "/api/v1/telemetry/traces", options),
		);
	}

	/** Bounded span read: one workflow's spans, or the newest spans overall
	 * (`limit`) when no workflow is named. */
	async telemetrySpans(options: {
		changeId?: string;
		limit?: number;
	}): Promise<unknown[]> {
		const value = this.decode<{ spans: unknown[] }>(
			"core.telemetry-spans",
			telemetrySpansSchema,
			await this.request("POST", "/api/v1/telemetry/spans", options),
		);
		return value.spans;
	}

	/** Register the server-owned workspace watcher for a repository without
	 * scanning it: boot announces changes instead of ingesting the history. */
	async telemetryWatch(repo: string): Promise<void> {
		await this.request("POST", "/api/v1/telemetry/watch", { repo });
	}

	async telemetryScan(repo: string): Promise<number> {
		const value = this.decode<{ scanned: number }>(
			"core.telemetry-scan",
			telemetryCountSchema,
			await this.request("POST", "/api/v1/telemetry/scan", { repo }),
		);
		return value.scanned;
	}

	async telemetryPrune(days?: number): Promise<number> {
		const value = this.decode<{ removed: number }>(
			"core.telemetry-prune",
			telemetryRemovedSchema,
			await this.request("POST", "/api/v1/telemetry/prune", { days }),
		);
		return value.removed;
	}

	async respondCredential(request: CredentialRespondRequest): Promise<void> {
		await this.request("POST", "/api/v1/credentials/respond", {
			...request,
			ownerId: request.ownerId || this.ownerId,
		});
	}

	/** Subscribe to the bounded event stream. Returns an unsubscribe function;
	 * a `resync` event tells the caller to fetch an authoritative snapshot. */
	subscribe(
		handlers: GatewayEventHandlers,
		cursor?: number,
		signal?: AbortSignal,
	): () => void {
		const controller = new AbortController();
		const localAbort = () => controller.abort();
		signal?.addEventListener("abort", localAbort, { once: true });
		const query = cursor === undefined ? "" : `?cursor=${cursor}`;
		this.setState("connecting");
		this.stateListeners.add(handlers.onConnectionChange ?? (() => {}));
		void (async () => {
			try {
				const token = this.authToken();
				let response = await fetch(`${this.baseUrl}/api/v1/events${query}`, {
					headers: this.headers(false, token),
					signal: controller.signal,
				});
				if (response.status === 401 && token !== this.token)
					response = await fetch(`${this.baseUrl}/api/v1/events${query}`, {
						headers: this.headers(false, this.token),
						signal: controller.signal,
					});
				if (!response.ok || !response.body)
					throw new BackendClientError(
						response.status,
						"event-stream",
						`event stream unavailable (${response.status})`,
					);
				this.setState("open");
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let boundary = buffer.indexOf("\n\n");
					while (boundary >= 0) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						boundary = buffer.indexOf("\n\n");
						const eventMatch = /^event: (.+)$/m.exec(frame);
						const dataMatch = /^data: (.*)$/m.exec(frame);
						if (!dataMatch) continue;
						const event = eventMatch?.[1] ?? "message";
						const data = JSON.parse(dataMatch[1] ?? "null");
						if (event === "resync")
							handlers.onResync(
								(data as { reason?: string }).reason ?? "resync required",
							);
						else if (event === "domain")
							handlers.onEvent(data as EventEnvelope);
					}
				}
			} catch {
				/* stream closed: the caller's reconnect policy owns recovery */
				if (!controller.signal.aborted) this.setState("reconnecting");
			}
		})();
		return () => {
			signal?.removeEventListener("abort", localAbort);
			controller.abort();
			this.stateListeners.delete(handlers.onConnectionChange ?? (() => {}));
			this.setState("closed");
		};
	}
}

let configured: BackendClient | undefined;

/** Install the backend client for this process (TUI/CLI entry point). */
export function configureBackendClient(
	config: BackendClientConfig,
): BackendClient {
	configured = new BackendClient(config);
	return configured;
}

export function backendClient(): BackendClient | undefined {
	return configured;
}

/** Build a client from the server handoff env a parent shell exports to its
 * managed child processes (`AGENTIC_WORKFLOW_URL`/`AGENTIC_WORKFLOW_TOKEN`).
 * Absent in a plain terminal/test run, so the CLI falls back in-process. */
export function backendClientFromEnv(): BackendClient | undefined {
	const url = process.env.AGENTIC_WORKFLOW_URL;
	const token = process.env.AGENTIC_WORKFLOW_TOKEN;
	if (!url || !token) return undefined;
	return new BackendClient({
		baseUrl: url,
		token,
		ownerId: `cli-${process.pid}`,
	});
}

export function clearBackendClient(): void {
	configured = undefined;
}
