// Dashboard gateway port (establish-opencode-boundaries, task 3.1).
//
// One interface for every dashboard read and mutation, implemented twice: the
// authenticated HTTP client (`server/client.ts`) and the in-process adapter
// (`server/gateway/inProcess.ts`) backed by the server's own operations. Data
// modules depend on this port and never branch on which transport is active.
//
// Pure types only: no runtime value, no I/O, no transport import.
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
} from "./actions.ts";
import type { CredentialRespondRequest } from "./credential.ts";
import type {
	ConnectionState,
	EventEnvelope,
	ObservationRequest,
} from "./environment.ts";
import type { TraceSummaryPage } from "./telemetry.ts";
import type { WorkflowView } from "./workflow.ts";

/** Which adapter is in use. Presentation never switches on this: it exists for
 * diagnostics, connection banners and tests. */
export type GatewayKind = "http" | "in-process";

/** Subscription callbacks. `onResync` is called when the cursor predates the
 * retained event window (or the adapter lost the stream): the caller must
 * refresh from an authoritative snapshot instead of assuming continuity. */
export interface GatewayEventHandlers {
	onEvent(event: EventEnvelope): void;
	onResync(reason: string): void;
	onConnectionChange?(state: ConnectionState): void;
}

/** Agent configuration read: opaque profile tables plus provenance and the
 * conflict list the settings surface renders. */
export interface AgentsListResponse {
	readonly agents: unknown;
	readonly provenance: unknown;
	readonly conflicts: string[];
	readonly revision?: string;
}

/** The dashboard's whole data surface. Reads take an `AbortSignal` where a
 * result can outlive the view that asked for it; mutations carry the revision
 * the caller rendered, so a stale action is refused rather than applied. */
export interface DashboardGateway {
	readonly kind: GatewayKind;

	/** Current connection state. In-process is always `open`. */
	connectionState(): ConnectionState;

	// -- reads ---------------------------------------------------------------
	listViews(repo: string, signal?: AbortSignal): Promise<WorkflowView[]>;
	view(
		repo: string,
		workflowId: string,
		signal?: AbortSignal,
	): Promise<WorkflowView>;
	/** Observation reads (dashboard, Git, wiki, Herdr, artifacts, reviews) with
	 * the caller's contract schema, so both adapters decode identically. */
	observe<T>(
		observation: ObservationRequest,
		// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types; mirror decodeContract.
		schema: Schema.Schema<any, any, never>,
		signal?: AbortSignal,
	): Promise<T>;
	loadAgents(repository?: string): Promise<AgentsListResponse>;

	// -- mutations -----------------------------------------------------------
	action(request: WorkflowActionRequest): Promise<WorkflowView>;
	start(request: WorkflowStartRequest): Promise<string>;
	repair(request: WorkflowRepairRequest): Promise<WorkflowView>;
	question(request: WorkflowQuestionRequest): Promise<WorkflowView>;
	execute(request: WorkflowExecuteRequest): Promise<void>;
	saveReview(request: ReviewSaveRequest): Promise<void>;
	agentHandoff(request: AgentHandoffRequest): Promise<WorkflowView>;
	agentQuestion(
		request: AgentQuestionRequest,
		signal?: AbortSignal,
	): Promise<string>;
	researchHandoff(request: AgentResearchHandoffRequest): Promise<WorkflowView>;
	saveAgents(request: AgentsMutationRequest): Promise<void>;
	respondCredential(request: CredentialRespondRequest): Promise<void>;

	// -- telemetry -----------------------------------------------------------
	telemetryTraces(options: {
		page?: number;
		perPage?: number;
		changeId?: string;
	}): Promise<TraceSummaryPage>;
	telemetrySpans(options: {
		changeId?: string;
		limit?: number;
	}): Promise<unknown[]>;
	telemetryWorkspaces(): Promise<
		Array<{ changeId: string; path: string; spanCount: number }>
	>;
	telemetryWatch(repo: string): Promise<void>;
	telemetryScan(repo: string): Promise<number>;
	telemetryPrune(days?: number): Promise<number>;

	// -- events --------------------------------------------------------------
	/** Subscribe to the bounded event stream. Returns an unsubscribe function. */
	subscribe(
		handlers: GatewayEventHandlers,
		cursor?: number,
		signal?: AbortSignal,
	): () => void;
}
