// In-process dashboard gateway (establish-opencode-boundaries, tasks 3.3-3.5).
//
// The same `DashboardGateway` port the HTTP client implements, backed by the
// server's own application operations, telemetry service, credential registry
// and event broker. Managed/demo startup composes this adapter instead of
// opening a socket; nothing here imports the TUI, and every read and mutation
// goes through the same server-owned boundary the HTTP routes use — so both
// adapters answer with the same contract shapes.

import type { Schema } from "effect";
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
} from "../../contracts/actions.ts";
import type { CredentialRespondRequest } from "../../contracts/credential.ts";
import { ContractFailure, decodeContract } from "../../contracts/decode.ts";
import type {
	ConnectionState,
	EventEnvelope,
	ObservationRequest,
} from "../../contracts/environment.ts";
import type {
	AgentsListResponse,
	DashboardGateway,
	GatewayEventHandlers,
} from "../../contracts/gateway.ts";
import type { TraceSummaryPage } from "../../contracts/telemetry.ts";
import type { WorkflowView } from "../../contracts/workflow.ts";
import type { CredentialRegistry } from "../credentials.ts";
import type { EventBroker } from "../events.ts";
import type { ServerOperations } from "../handlers.ts";
import type { WorkflowEventHub } from "../subscriptions.ts";
import type { TelemetryOperations } from "../telemetry.ts";

export interface InProcessGatewayOptions {
	/** The server's application operations: the same object the HTTP routes call. */
	readonly operations: ServerOperations;
	readonly telemetry: TelemetryOperations;
	readonly credentials: CredentialRegistry;
	readonly events: EventBroker;
	/** Server-owned workflow refresh hub. When present, the in-process gateway
	 * registers a repository on the same mutations the HTTP routes do, so the
	 * server's execution-coordinator events reach the dashboard instead of
	 * leaving it to recover on the periodic safety resync. */
	readonly hub?: WorkflowEventHub;
	/** Aborts an in-flight call when the caller's signal fires. */
	readonly abortError?: (signal: AbortSignal) => Error;
}

function defaultAbortError(): Error {
	return new DOMException("operation cancelled", "AbortError");
}

/** Reject before doing any work when the caller already cancelled. */
function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw defaultAbortError();
}

export function createInProcessGateway(
	options: InProcessGatewayOptions,
): DashboardGateway {
	const { operations, telemetry, credentials, events } = options;
	const abortError = options.abortError ?? defaultAbortError;
	// Register a repository with the server-owned refresh hub exactly like the
	// HTTP routes: idempotent, and a no-op when no hub was installed.
	const watchRepo = (repo: string): void => options.hub?.watchRepo(repo);
	const publishWorkflow = (
		kind: string,
		repo: string,
		workflowId?: string,
		revision?: number,
	): void => {
		events.publish({
			domain: "workflow",
			kind,
			resource: repo,
			...(workflowId ? { runId: workflowId } : {}),
			...(revision !== undefined ? { revision } : {}),
		});
	};

	/** Await a value but reject as soon as the caller aborts. */
	const withSignal = <T>(
		work: Promise<T>,
		signal?: AbortSignal,
	): Promise<T> => {
		assertNotAborted(signal);
		if (!signal) return work;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(abortError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			work.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	};

	return {
		kind: "in-process",

		// An in-process call has no connection to lose.
		connectionState: (): ConnectionState => "open",

		async listViews(repo: string, signal?: AbortSignal) {
			assertNotAborted(signal);
			return operations.listViews(repo);
		},

		async view(repo: string, workflowId: string, signal?: AbortSignal) {
			assertNotAborted(signal);
			return operations.view(repo, workflowId);
		},

		async observe<T>(
			observation: ObservationRequest,
			// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
			schema: Schema.Schema<any, any, never>,
			signal?: AbortSignal,
		): Promise<T> {
			const value = await withSignal(
				operations.runObservation(observation),
				signal,
			);
			// The HTTP adapter decodes the response with the same schema, so a
			// malformed in-process payload fails here too instead of reaching a
			// projection.
			try {
				return decodeContract<T>(
					`core.observation.${observation.kind}`,
					schema,
					value,
				);
			} catch (error) {
				if (error instanceof ContractFailure)
					throw new Error(
						`in-process observation returned an invalid core.observation.${observation.kind} payload (${error.message})`,
					);
				throw error;
			}
		},

		async loadAgents(repository?: string): Promise<AgentsListResponse> {
			return operations.loadAgents(repository);
		},

		// -- mutations: the operations own revision guards and re-reads --------
		async action(request: WorkflowActionRequest): Promise<WorkflowView> {
			watchRepo(request.repo);
			const view = operations.action(request);
			publishWorkflow(
				"workflow.action",
				request.repo,
				request.workflowId,
				request.revision,
			);
			return view;
		},

		async start(request: WorkflowStartRequest): Promise<string> {
			watchRepo(request.repo);
			const workflowId = await operations.start(request);
			publishWorkflow("workflow.start", request.repo, workflowId);
			return workflowId;
		},

		async repair(request: WorkflowRepairRequest): Promise<WorkflowView> {
			watchRepo(request.repo);
			const view = operations.repair(request);
			publishWorkflow(
				"workflow.repair",
				request.repo,
				request.workflowId,
				request.revision,
			);
			return view;
		},

		async question(request: WorkflowQuestionRequest): Promise<WorkflowView> {
			watchRepo(request.repo);
			const view = operations.question(request);
			publishWorkflow(
				"workflow.question",
				request.repo,
				request.workflowId,
				request.revision,
			);
			return view;
		},

		async execute(request: WorkflowExecuteRequest): Promise<void> {
			watchRepo(request.repo);
			operations.execute(request);
		},

		async saveReview(request: ReviewSaveRequest): Promise<void> {
			await operations.saveReview(request);
			publishWorkflow("workflow.review-save", request.repo, request.workflowId);
		},

		async agentHandoff(request: AgentHandoffRequest): Promise<WorkflowView> {
			watchRepo(request.repo);
			const view = await operations.handoff(request);
			publishWorkflow(
				"workflow.handoff",
				request.repo,
				view.workflowId,
				view.revision,
			);
			return view;
		},

		async agentQuestion(
			request: AgentQuestionRequest,
			signal?: AbortSignal,
		): Promise<string> {
			watchRepo(request.repo);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				return await operations.agentQuestion(
					request,
					controller.signal,
					(workflowId, revision) =>
						publishWorkflow(
							"workflow.question",
							request.repo,
							workflowId,
							revision,
						),
				);
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},

		async researchHandoff(
			request: AgentResearchHandoffRequest,
		): Promise<WorkflowView> {
			watchRepo(request.repo);
			const view = await operations.researchHandoff(request);
			publishWorkflow(
				"workflow.research-handoff",
				request.repo,
				view.workflowId,
				view.revision,
			);
			return view;
		},

		async saveAgents(request: AgentsMutationRequest): Promise<void> {
			operations.saveAgents(request);
		},

		async respondCredential(request: CredentialRespondRequest): Promise<void> {
			const outcome = credentials.respond(
				request.ownerId,
				request.interactionId,
				request.value,
			);
			if (!outcome.accepted)
				throw new Error(
					`credential response rejected: ${outcome.reason ?? "unknown reason"}`,
				);
		},

		// -- telemetry ---------------------------------------------------------
		async telemetryTraces(gatewayOptions: {
			page?: number;
			perPage?: number;
			changeId?: string;
		}): Promise<TraceSummaryPage> {
			return telemetry.summaries(gatewayOptions);
		},

		async telemetrySpans(spansOptions: {
			changeId?: string;
			limit?: number;
		}): Promise<unknown[]> {
			return spansOptions.changeId
				? telemetry.traceSpans(spansOptions.changeId)
				: telemetry.recentSpans(spansOptions.limit);
		},

		async telemetryWorkspaces() {
			return telemetry.workspaces();
		},

		async telemetryWatch(repo: string): Promise<void> {
			// The watcher is server-owned; registering it twice is a no-op.
			telemetry.watch?.(repo, () => {});
		},

		async telemetryScan(repo: string): Promise<number> {
			return telemetry.scan(repo);
		},

		async telemetryPrune(days?: number): Promise<number> {
			return telemetry.prune(days);
		},

		// -- events ------------------------------------------------------------
		subscribe(
			handlers: GatewayEventHandlers,
			cursor?: number,
			signal?: AbortSignal,
		): () => void {
			const subscription = events.open(
				cursor === undefined ? {} : { after: cursor },
				(event: EventEnvelope) => handlers.onEvent(event),
				() => handlers.onResync("subscriber overflowed the replay queue"),
			);
			handlers.onConnectionChange?.("open");
			// The HTTP stream reports a gap as a `resync` frame; the in-process
			// adapter reports the same condition from the broker's replay window.
			if (subscription.snapshotRequired)
				handlers.onResync("cursor outside the retained event window");
			for (const event of subscription.replay) handlers.onEvent(event);
			const unsubscribe = () => {
				subscription.unsubscribe();
				signal?.removeEventListener("abort", unsubscribe);
				handlers.onConnectionChange?.("closed");
			};
			signal?.addEventListener("abort", unsubscribe, { once: true });
			return unsubscribe;
		},
	};
}
