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
	/** A custom-shaped blueprint the server compiles, stores and starts instead
	 * of a built-in type (add-orchestrator-blueprint-workflows). `Unknown` so an
	 * undecodable document reaches the compiler's own diagnostics rather than
	 * failing the route with an opaque schema error; the two shapes are
	 * mutually exclusive. A request that names neither keeps its historical
	 * meaning (the `openspec` family). */
	blueprint: Schema.optional(Schema.Unknown),
	preset: Schema.optional(Schema.String),
	/** Only the rebase type reads these: the branch that gets rebased and the
	 * ref it is rebased onto, both chosen from a branch list rather than typed. */
	sourceBranch: Schema.optional(Schema.String),
	targetBranch: Schema.optional(Schema.String),
}).pipe(
	Schema.filter(
		(request) =>
			request.workflowType === undefined || request.blueprint === undefined,
		{
			message: () =>
				"a start request cannot name both a workflowType and a blueprint",
		},
	),
);

/** One blueprint validation request (add-orchestrator-blueprint-workflows): the
 * document is compiled without side effects and answered with its summary and
 * diagnostics, so it is deliberately undecoded here (`Unknown`). */
export const workflowBlueprintValidateRequestSchema = Schema.Struct({
	blueprint: Schema.Unknown,
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

/** Delete one durable workflow and its worktree; the branch is kept. */
export const workflowDeleteRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
});

/** Result of deleting one workflow: the store rows are always gone when the
 * request succeeds, and the worktree is reported separately because its removal
 * is a filesystem boundary that can fail on its own. */
export interface WorkflowDeletion {
	/** True when the worktree directory was removed, or was already gone. */
	readonly worktreeRemoved: boolean;
	/** Why the worktree could not be removed, when it was not. */
	readonly worktreeError?: string;
}

export const workflowDeletionSchema = Schema.Struct({
	worktreeRemoved: Schema.Boolean,
	worktreeError: Schema.optional(Schema.String),
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
	/** The server-enforced orchestrator launch ceiling, resolved from the
	 * user-level configuration with no project overlay. */
	orchestratorLimits: Schema.optional(
		Schema.Struct({
			maxActive: Schema.Number,
			maxStartsPerDay: Schema.Number,
		}),
	),
	/** True when the user-level configuration set a bound. */
	orchestratorLimitsConfigured: Schema.optional(Schema.Boolean),
});

/** Classifier status read: provider selection plus local-model state. */
export type { ClassifierStatusResponse } from "./gateway.ts";

export const classifierStatusResponseSchema = Schema.Struct({
	provider: Schema.String,
	providers: Schema.Array(
		Schema.Struct({ id: Schema.String, label: Schema.String }),
	),
	local: Schema.Struct({
		installed: Schema.Boolean,
		running: Schema.Boolean,
		modelPath: Schema.optional(Schema.String),
		bytes: Schema.optional(Schema.Number),
		binary: Schema.optional(Schema.String),
		error: Schema.optional(Schema.String),
		job: Schema.optional(Schema.Unknown),
	}),
});

/** The classifier install/cancel requests carry no fields: acquisition is
 * server-owned and idempotent, and the provider is never named in the body. */
export const classifierRequestSchema = Schema.Struct({});

/** Decoded request type for `workflowActionRequestSchema`. */
export type WorkflowActionRequest = typeof workflowActionRequestSchema.Type;

/** Decoded request type for `workflowStartRequestSchema`. */
export type WorkflowStartRequest = typeof workflowStartRequestSchema.Type;

/** Decoded request type for `workflowBlueprintValidateRequestSchema`. */
export type WorkflowBlueprintValidateRequest =
	typeof workflowBlueprintValidateRequestSchema.Type;

/** Decoded request type for `workflowRepairRequestSchema`. */
export type WorkflowRepairRequest = typeof workflowRepairRequestSchema.Type;

/** Decoded request type for `workflowQuestionRequestSchema`. */
export type WorkflowQuestionRequest = typeof workflowQuestionRequestSchema.Type;

/** Decoded request type for `workflowExecuteRequestSchema`. */
export type WorkflowExecuteRequest = typeof workflowExecuteRequestSchema.Type;

/** Decoded request type for `workflowDeleteRequestSchema`. */
export type WorkflowDeleteRequest = typeof workflowDeleteRequestSchema.Type;

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
