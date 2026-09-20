// Action wire contract: workflow action/start/repair/question requests, review
// saves, and the managed-agent requests the CLI forwards. Pure schemas/types.
import { Schema } from "effect";

/** One entry of a required user action: an artifact to read, a workflow to
 * open, a review to answer, or an explicit dismissal. */
export type RequiredUserActionItem =
	| { label: string; kind: "artifact"; value: string }
	| { label: string; kind: "workflow"; value: string }
	| { label: string; kind: "review"; value: string }
	| { label: string; kind: "dismiss" };

/** A blocking human decision the workflow owes the developer. */
export interface RequiredUserAction {
	key: string;
	title: string;
	prompt: string;
	items: RequiredUserActionItem[];
}

export const workflowActionRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	actionId: Schema.String,
	input: Schema.optional(Schema.Unknown),
});

export const workflowStartRequestSchema = Schema.Struct({
	repo: Schema.String,
	ticket: Schema.optional(Schema.String),
	workflowId: Schema.String,
	task: Schema.optional(Schema.String),
	mode: Schema.String,
	workflowType: Schema.optional(Schema.String),
	preset: Schema.optional(Schema.String),
});

export const workflowRepairRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	targetStep: Schema.String,
	reason: Schema.optional(Schema.String),
});

export const workflowQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	questionId: Schema.String,
	answer: Schema.Unknown,
});

export const reviewSaveRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	kind: Schema.Literal("developer", "plan", "wiki"),
	comments: Schema.Array(Schema.Unknown),
});

export const workflowExecuteRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.optional(Schema.String),
});

export const agentHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	outcome: Schema.Literal("complete", "blocked", "failed"),
	artifact: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
	drain: Schema.optional(Schema.Boolean),
});

/** Agent-config mutation: the payload is validated by the typed mutation
 * applier, which rejects unknown kinds and malformed profile/preset tables. */
export const agentsMutationRequestSchema = Schema.Struct({
	repository: Schema.optional(Schema.String),
	/** Revision the client read before editing; the server refuses a write when
	 * the effective agents section changed since (centralize-application-
	 * settings, task 2.3). Omitted by callers that do not track a revision. */
	expectedRevision: Schema.optional(Schema.String),
	mutation: Schema.Unknown,
});

/** Managed-agent developer question across the transport. The request signal
 * bounds the wait; the engine validates the run capability. */
export const agentQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	input: Schema.Unknown,
	timeoutMs: Schema.optional(Schema.Number),
});

/** Managed researcher structured handoff across the transport. */
export const agentResearchHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record({ key: Schema.String, value: Schema.String }),
	handoff: Schema.Unknown,
});

/** The agent configuration read: opaque profile tables plus provenance and the
 * conflict list the settings UI renders. */
export type { AgentsListResponse } from "./gateway.ts";

export const agentsListResponseSchema = Schema.Struct({
	agents: Schema.Unknown,
	provenance: Schema.Unknown,
	conflicts: Schema.Array(Schema.String),
	revision: Schema.optional(Schema.String),
});

/** Decoded request type for `workflowActionRequestSchema`. */
export type WorkflowActionRequest = typeof workflowActionRequestSchema.Type;

/** Decoded request type for `workflowStartRequestSchema`. */
export type WorkflowStartRequest = typeof workflowStartRequestSchema.Type;

/** Decoded request type for `workflowRepairRequestSchema`. */
export type WorkflowRepairRequest = typeof workflowRepairRequestSchema.Type;

/** Decoded request type for `workflowQuestionRequestSchema`. */
export type WorkflowQuestionRequest = typeof workflowQuestionRequestSchema.Type;

/** Decoded request type for `workflowExecuteRequestSchema`. */
export type WorkflowExecuteRequest = typeof workflowExecuteRequestSchema.Type;

/** Decoded request type for `reviewSaveRequestSchema`. */
export type ReviewSaveRequest = typeof reviewSaveRequestSchema.Type;

/** Decoded request type for `agentHandoffRequestSchema`. */
export type AgentHandoffRequest = typeof agentHandoffRequestSchema.Type;

/** Decoded request type for `agentsMutationRequestSchema`. */
export type AgentsMutationRequest = typeof agentsMutationRequestSchema.Type;

/** Decoded request type for `agentQuestionRequestSchema`. */
export type AgentQuestionRequest = typeof agentQuestionRequestSchema.Type;

/** Decoded request type for `agentResearchHandoffRequestSchema`. */
export type AgentResearchHandoffRequest =
	typeof agentResearchHandoffRequestSchema.Type;
