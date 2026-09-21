// Server-side operation handlers for the unified backend
// (expose-unified-bun-backend, task 2.2/2.5/2.6). These are the only entry
// points the HTTP transport calls: the observation dispatcher (the read/artifact
// path the TUI used to reach through the `__dashboard-observe` subprocess) and
// the workflow mutation path (view/action/start/repair/question). Transport,
// authorization and bounds live in `app.ts`; this module is the bounded
// application boundary behind it.
//
// Reads stay observational: every handler here only lists/reads/views and never
// initializes or migrates a store, expires a question or claims an effect.
import type { Schema } from "effect";
import type {
	agentHandoffRequestSchema,
	agentQuestionRequestSchema,
	agentResearchHandoffRequestSchema,
	agentsMutationRequestSchema,
	reviewSaveRequestSchema,
	workflowActionRequestSchema,
	workflowExecuteRequestSchema,
	workflowQuestionRequestSchema,
	workflowRepairRequestSchema,
	workflowStartRequestSchema,
} from "../contracts/actions.ts";
import type { ObservationRequest } from "../contracts/environment.ts";
import type {
	DeveloperReviewComment,
	PlanReviewComment,
	WikiReviewComment,
} from "../contracts/workflow";
import type { WorkflowView } from "../contracts/workflow.ts";
import { runDeveloperQuestion } from "../workflow/cli/commands/dispatch-actions.ts";
import { resolveHandoffIdentity } from "../workflow/cli/identity.ts";
import {
	drainEffects,
	engine as workflowEngineFactory,
} from "../workflow/operations.ts";
import { QUESTION_WAIT_MS } from "../workflow/runtime.ts";
import {
	type AgentsMutation,
	applyAgentsMutation,
	loadAgentConfig,
} from "./config.ts";
import {
	answerWorkflowQuestion,
	dashboardApplication,
	getWorkflowView,
	listWorkflowViews,
	repairWorkflow,
	requestWorkflowExecution,
	runWorkflowAction,
	startWorkflowInProcess,
} from "./operations/engine.ts";
import type { DashboardObservation } from "./operations/observations.ts";
import {
	runLocalObservation,
	saveDeveloperReview,
	savePlanReview,
	saveWikiReview,
} from "./operations/observations.ts";

type ActionRequest = Schema.Schema.Type<typeof workflowActionRequestSchema>;
type StartRequest = Schema.Schema.Type<typeof workflowStartRequestSchema>;
type RepairRequest = Schema.Schema.Type<typeof workflowRepairRequestSchema>;
type QuestionRequest = Schema.Schema.Type<typeof workflowQuestionRequestSchema>;
type ReviewSaveRequest = Schema.Schema.Type<typeof reviewSaveRequestSchema>;
type ExecuteRequest = Schema.Schema.Type<typeof workflowExecuteRequestSchema>;
type AgentHandoffRequest = Schema.Schema.Type<typeof agentHandoffRequestSchema>;
type AgentQuestionRequest = Schema.Schema.Type<
	typeof agentQuestionRequestSchema
>;
type AgentResearchHandoffRequest = Schema.Schema.Type<
	typeof agentResearchHandoffRequestSchema
>;
type AgentsMutationRequest = Schema.Schema.Type<
	typeof agentsMutationRequestSchema
>;

/** The bounded application operations the transport may invoke. Injectable so
 * transport tests never touch the filesystem/Go boundary. */
export interface ServerOperations {
	runObservation(request: ObservationRequest): Promise<unknown>;
	listViews(repo: string): WorkflowView[];
	view(repo: string, workflowId: string): WorkflowView;
	action(request: ActionRequest): WorkflowView;
	start(request: StartRequest): Promise<string>;
	repair(request: RepairRequest): WorkflowView;
	question(request: QuestionRequest): WorkflowView;
	saveReview(request: ReviewSaveRequest): Promise<void>;
	execute(request: ExecuteRequest): void;
	handoff(request: AgentHandoffRequest): Promise<WorkflowView>;
	saveAgents(request: AgentsMutationRequest): void;
	loadAgents(repository?: string): ReturnType<typeof loadAgentConfig>;
	agentQuestion(
		request: AgentQuestionRequest,
		signal: AbortSignal,
		onCreated?: (workflowId: string, revision: number) => void,
	): Promise<string>;
	researchHandoff(request: AgentResearchHandoffRequest): Promise<WorkflowView>;
}

/** Run a workflow action, then re-read the authoritative view so the client
 * renders the committed revision instead of a returned guess. The dispatch
 * itself is revision-guarded and synchronous; the facade returns a JSON string. */
export function runAction(request: ActionRequest): WorkflowView {
	runWorkflowAction(
		request.actionId,
		request.repo,
		request.workflowId,
		request.revision,
		request.input === undefined ? undefined : JSON.stringify(request.input),
	);
	return getWorkflowView(request.repo, request.workflowId);
}

/** Start a workflow and return the bounded acknowledgement string. */
export function startWorkflow(request: StartRequest): Promise<string> {
	return startWorkflowInProcess({
		repo: request.repo,
		ticket: request.ticket ?? "",
		workflowId: request.workflowId,
		task: request.task,
		mode: request.mode,
		workflowType: request.workflowType,
		preset: request.preset,
	});
}

export function repair(request: RepairRequest): WorkflowView {
	return repairWorkflow(
		request.repo,
		request.workflowId,
		request.revision,
		request.targetStep,
		request.reason ?? "",
	);
}

export function question(request: QuestionRequest): WorkflowView {
	return answerWorkflowQuestion(
		request.repo,
		request.workflowId,
		request.revision,
		request.questionId,
		request.answer as
			| { kind: "option" | "custom" | "cancel"; value?: string }
			| {
					groupId: string;
					responses: Array<{
						questionId: string;
						kind: "option" | "custom";
						value: string;
					}>;
			  }
			| { groupId: string; kind: "cancel" },
	);
}

export function listWorkflowViewsFor(repo: string): WorkflowView[] {
	return listWorkflowViews(repo);
}

/** Persist a review-comment set server-side (the client sends comments, not a
 * filesystem mutation). */
export function saveReview(request: ReviewSaveRequest): Promise<void> {
	switch (request.kind) {
		case "developer":
			return saveDeveloperReview(
				request.repo,
				request.workflowId,
				request.comments as DeveloperReviewComment[],
			);
		case "plan":
			return savePlanReview(
				request.repo,
				request.workflowId,
				request.comments as PlanReviewComment[],
			);
		case "wiki":
			return saveWikiReview(
				request.repo,
				request.workflowId,
				request.comments as WikiReviewComment[],
			);
	}
}

/** Ask the server-owned execution coordinator to drain pending effects. */
export function execute(request: ExecuteRequest): void {
	requestWorkflowExecution(request.repo, request.workflowId);
}

/** Managed-agent handoff: resolve the caller's run identity server-side, let the
 * engine independently validate the run capability, then drain and return the
 * authoritative view. The instance session token and the agent run capability
 * are both required, so neither authority is weakened by the transport. */
export async function handoff(
	request: AgentHandoffRequest,
): Promise<WorkflowView> {
	const engine = workflowEngineFactory(dashboardApplication);
	const identity = resolveHandoffIdentity(
		engine,
		request.repo,
		dashboardApplication,
		request.environment,
	);
	const artifact = identity.outputPath ?? request.artifact;
	engine.dispatch(request.repo, {
		type: "agent.handoff",
		runId: identity.runId,
		generation: identity.generation,
		token: identity.token,
		outcome: request.outcome,
		...(artifact ? { artifact } : {}),
		...(request.message ? { message: request.message } : {}),
	} as never);
	if (request.drain !== false) await drainEffects(engine, request.repo);
	return getWorkflowView(request.repo, identity.workflowId);
}

/** Apply an agent-config mutation server-side (no view writes the file). */
export function saveAgents(request: AgentsMutationRequest): void {
	const mutation = request.mutation as AgentsMutation | undefined;
	if (
		!mutation ||
		!["set-profile", "set-preset", "delete-profile", "delete-preset"].includes(
			mutation.kind,
		)
	)
		throw new Error("unknown agents mutation");
	applyAgentsMutation(mutation, request.repository, request.expectedRevision);
}

/** Read the effective agents config server-side (no view reads the file). */
export function loadAgents(
	repository?: string,
): ReturnType<typeof loadAgentConfig> {
	return loadAgentConfig(repository);
}
/** Managed-agent developer question: resolve identity server-side, dispatch and
 * wait (bounded by the request signal) for the answer. */
export function agentQuestion(
	request: AgentQuestionRequest,
	signal: AbortSignal,
	onCreated?: (workflowId: string, revision: number) => void,
): Promise<string> {
	const engine = workflowEngineFactory(dashboardApplication);
	return runDeveloperQuestion(
		engine,
		request.repo,
		request.input as Parameters<typeof runDeveloperQuestion>[2],
		request.timeoutMs ?? QUESTION_WAIT_MS,
		QUESTION_WAIT_MS,
		dashboardApplication,
		request.environment,
		signal,
		onCreated,
	);
}

/** Managed researcher structured handoff: identity + capability server-side. */
export function researchHandoff(
	request: AgentResearchHandoffRequest,
): Promise<WorkflowView> {
	const engine = workflowEngineFactory(dashboardApplication);
	const identity = resolveHandoffIdentity(
		engine,
		request.repo,
		dashboardApplication,
		request.environment,
	);
	if (identity.stepId !== "core.research" || identity.role !== "researcher")
		return Promise.reject(
			new Error(
				"research-handoff is only available to the active core.research researcher run",
			),
		);
	engine.dispatch(request.repo, {
		type: "agent.research-handoff",
		workflowId: identity.workflowId,
		runId: identity.runId,
		stepId: identity.stepId,
		role: identity.role,
		token: identity.token,
		handoff: request.handoff,
	} as never);
	requestWorkflowExecution(request.repo, identity.workflowId);
	return Promise.resolve(getWorkflowView(request.repo, identity.workflowId));
}

/** Production application operations behind the transport. */
export const serverOperations: ServerOperations = {
	runObservation,
	listViews: listWorkflowViewsFor,
	view: workflowView,
	action: runAction,
	start: startWorkflow,
	repair,
	question,
	saveReview,
	execute,
	handoff,
	saveAgents,
	loadAgents,
	agentQuestion,
	researchHandoff,
};

export function workflowView(repo: string, workflowId: string): WorkflowView {
	return getWorkflowView(repo, workflowId);
}

/** Execute the observation request behind the typed transport. Reads are
 * observational; the shared local dispatcher owns the observation semantics. */
export async function runObservation(
	request: ObservationRequest,
): Promise<unknown> {
	return runLocalObservation(request as unknown as DashboardObservation);
}
