// Typed client for the unified Bun backend (expose-unified-bun-backend,
// task 2.5/2.6/3.3). The TUI and CLI use this module instead of reaching
// workflow/telemetry/observation internals: every call is an authenticated,
// bounded HTTP request and every response decodes at this boundary.
//
// The client deliberately imports nothing from the TUI feature tree, so the
// observation module can depend on it without forming a cycle.
import type { TraceSummaryPage } from "../tui/otel/model/types.ts";
import type { WorkflowView } from "../workflow/contracts.ts";
import type { AgentsMutation } from "./config.ts";
import type { ObservationRequest } from "./protocol.ts";
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

export interface DomainEventHandler {
	onEvent(event: unknown): void;
	onResync(reason: string): void;
}

export class BackendClient {
	readonly baseUrl: string;
	readonly token: string;
	readonly ownerId: string;

	constructor(config: BackendClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.token = config.token;
		this.ownerId = config.ownerId;
	}

	private headers(json: boolean): Headers {
		const headers = new Headers();
		headers.set("authorization", `Bearer ${this.token}`);
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
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: this.headers(body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
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
		if (
			parsed &&
			typeof parsed === "object" &&
			"ok" in parsed &&
			(parsed as { ok: boolean }).ok === true
		)
			return (parsed as unknown as { value: unknown }).value;
		return parsed;
	}

	async observe<T>(
		observation: ObservationRequest,
		signal?: AbortSignal,
	): Promise<T> {
		return (await this.request(
			"POST",
			"/api/v1/observe",
			{ observation },
			signal,
		)) as T;
	}

	async listViews(repo: string): Promise<WorkflowView[]> {
		const query = new URLSearchParams({ repo, list: "1" });
		return (await this.request(
			"GET",
			`/api/v1/workflow/view?${query}`,
			undefined,
		)) as WorkflowView[];
	}

	async view(repo: string, workflowId: string): Promise<WorkflowView> {
		const query = new URLSearchParams({ repo, workflowId });
		return (await this.request(
			"GET",
			`/api/v1/workflow/view?${query}`,
			undefined,
		)) as WorkflowView;
	}

	async action(request: {
		repo: string;
		workflowId: string;
		revision: number;
		actionId: string;
		input?: unknown;
	}): Promise<WorkflowView> {
		return (await this.request(
			"POST",
			"/api/v1/workflow/action",
			request,
		)) as WorkflowView;
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
		return (await this.request(
			"POST",
			"/api/v1/workflow/start",
			request,
		)) as string;
	}

	async repair(request: {
		repo: string;
		workflowId: string;
		revision: number;
		targetStep: string;
		reason?: string;
	}): Promise<WorkflowView> {
		return (await this.request(
			"POST",
			"/api/v1/workflow/repair",
			request,
		)) as WorkflowView;
	}

	async question(request: {
		repo: string;
		workflowId: string;
		revision: number;
		questionId: string;
		answer: unknown;
	}): Promise<WorkflowView> {
		return (await this.request(
			"POST",
			"/api/v1/workflow/question",
			request,
		)) as WorkflowView;
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
		return (await this.request(
			"POST",
			"/api/v1/agent/handoff",
			request,
		)) as WorkflowView;
	}

	async agentQuestion(request: {
		repo: string;
		environment: Record<string, string>;
		input: unknown;
		timeoutMs?: number;
	}): Promise<string> {
		return (await this.request(
			"POST",
			"/api/v1/agent/question",
			request,
		)) as string;
	}

	async researchHandoff(request: {
		repo: string;
		environment: Record<string, string>;
		handoff: unknown;
	}): Promise<WorkflowView> {
		return (await this.request(
			"POST",
			"/api/v1/agent/research-handoff",
			request,
		)) as WorkflowView;
	}

	async saveAgents(
		mutation: AgentsMutation,
		repository?: string,
		expectedRevision?: string,
	): Promise<void> {
		await this.request("POST", "/api/v1/config/agents", {
			repository,
			...(expectedRevision ? { expectedRevision } : {}),
			mutation,
		});
	}

	async loadAgents(repository?: string): Promise<{
		agents: unknown;
		provenance: unknown;
		conflicts: string[];
		revision?: string;
	}> {
		const query = repository
			? `?repository=${encodeURIComponent(repository)}`
			: "";
		return (await this.request(
			"GET",
			`/api/v1/config/agents${query}`,
			undefined,
		)) as {
			agents: unknown;
			provenance: unknown;
			conflicts: string[];
			revision?: string;
		};
	}

	async telemetryWorkspaces(): Promise<
		Array<{ changeId: string; path: string; spanCount: number }>
	> {
		const value = (await this.request(
			"GET",
			"/api/v1/telemetry/workspaces",
			undefined,
		)) as {
			workspaces: Array<{ changeId: string; path: string; spanCount: number }>;
		};
		return value.workspaces;
	}

	/** One page of the trace list (workflows, newest first). */
	async telemetryTraces(options: {
		page?: number;
		perPage?: number;
		changeId?: string;
	}): Promise<TraceSummaryPage> {
		return (await this.request(
			"POST",
			"/api/v1/telemetry/traces",
			options,
		)) as TraceSummaryPage;
	}

	/** Bounded span read: one workflow's spans, or the newest spans overall
	 * (`limit`) when no workflow is named. */
	async telemetrySpans(options: {
		changeId?: string;
		limit?: number;
	}): Promise<unknown[]> {
		const value = (await this.request(
			"POST",
			"/api/v1/telemetry/spans",
			options,
		)) as {
			spans: unknown[];
		};
		return value.spans;
	}

	/** Register the server-owned workspace watcher for a repository without
	 * scanning it: boot announces changes instead of ingesting the history. */
	async telemetryWatch(repo: string): Promise<void> {
		await this.request("POST", "/api/v1/telemetry/watch", { repo });
	}

	async telemetryScan(repo: string): Promise<number> {
		const value = (await this.request("POST", "/api/v1/telemetry/scan", {
			repo,
		})) as { scanned: number };
		return value.scanned;
	}

	async telemetryPrune(days?: number): Promise<number> {
		const value = (await this.request("POST", "/api/v1/telemetry/prune", {
			days,
		})) as { removed: number };
		return value.removed;
	}

	async respondCredential(interactionId: string, value: string): Promise<void> {
		await this.request("POST", "/api/v1/credentials/respond", {
			ownerId: this.ownerId,
			interactionId,
			value,
		});
	}

	/** Subscribe to the bounded event stream. Returns an unsubscribe function;
	 * a `resync` event tells the caller to fetch an authoritative snapshot. */
	subscribe(
		handlers: DomainEventHandler,
		cursor?: number,
		signal?: AbortSignal,
	): () => void {
		const controller = new AbortController();
		const localAbort = () => controller.abort();
		signal?.addEventListener("abort", localAbort, { once: true });
		const query = cursor === undefined ? "" : `?cursor=${cursor}`;
		void (async () => {
			try {
				const response = await fetch(`${this.baseUrl}/api/v1/events${query}`, {
					headers: this.headers(false),
					signal: controller.signal,
				});
				if (!response.ok || !response.body)
					throw new BackendClientError(
						response.status,
						"event-stream",
						`event stream unavailable (${response.status})`,
					);
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
						else if (event === "domain") handlers.onEvent(data);
					}
				}
			} catch {
				/* stream closed: the caller's reconnect policy owns recovery */
			}
		})();
		return () => {
			signal?.removeEventListener("abort", localAbort);
			controller.abort();
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
