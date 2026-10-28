// Action wire contract: workflow action/start/repair/question requests, review
// saves, and the managed-agent requests the CLI forwards. Pure schemas/types.
import { Schema } from "effect";
import { recoveryInputSchema } from "./workflow.ts";

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

/** The task bound of a start, in characters. Inline text, a change reference
 * assembled on the server and a `taskRef.previousMessage` substitution all
 * enter the same start, so they answer to the same bound: a reference never
 * starts a workflow the typed task could not. */
export const TASK_CHAR_BOUND = 16_000;

export const workflowStartRequestSchema = Schema.Struct({
	repo: Schema.String,
	ticket: Schema.optional(Schema.String),
	workflowId: Schema.String,
	task: Schema.optional(Schema.String),
	/** A task reference instead of inline `task` text (efficiency backlog item
	 * 21): an OpenSpec change of the target repository, which the server
	 * resolves into that change's task. Exactly one of `task`/`taskRef` is
	 * accepted, so a reference can never silently override typed text. */
	taskRef: Schema.optional(Schema.Struct({ change: Schema.String })),
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
	/** Only the env-setup type reads this: the configured app whose environment
	 * definitions the workflow drafts. */
	app: Schema.optional(Schema.String),
	/** The operator-selected hosted stage for a stage-test workflow. */
	stage: Schema.optional(Schema.String),
}).pipe(
	Schema.check(
		Schema.makeFilter(
			(request) =>
				request.workflowType === undefined || request.blueprint === undefined,
			{
				message:
					"a start request cannot name both a workflowType and a blueprint",
			},
		),
	),
	Schema.check(
		Schema.makeFilter(
			(request) => request.task === undefined || request.taskRef === undefined,
			{
				message:
					"a start request cannot carry both a task and a taskRef; send exactly one",
			},
		),
	),
);

/** One blueprint validation request (add-orchestrator-blueprint-workflows): the
 * document is compiled without side effects and answered with its summary and
 * diagnostics, so it is deliberately undecoded here (`Unknown`). */
export const workflowBlueprintValidateRequestSchema = Schema.Struct({
	blueprint: Schema.optionalKey(Schema.Unknown),
});

export const workflowRecoveryPreviewRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
});
export type WorkflowRecoveryPreviewRequest =
	typeof workflowRecoveryPreviewRequestSchema.Type;
export const workflowRepairRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	targetStep: Schema.String,
	reason: Schema.optional(Schema.String),
	recovery: Schema.optional(recoveryInputSchema),
});

export const workflowQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	revision: Schema.Number,
	questionId: Schema.String,
	answer: Schema.optionalKey(Schema.Unknown),
});

export const reviewSaveRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
	kind: Schema.Literals(["developer", "plan", "wiki"]),
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
	/**
	 * Why the workflow's app slots were not confirmed released before its rows
	 * were removed. The delete removes the workflow's outbox with it, so a
	 * teardown the environment server never answered is reported here instead of
	 * being retried afterwards.
	 */
	readonly teardownError?: string;
}

export const workflowDeletionSchema = Schema.Struct({
	worktreeRemoved: Schema.Boolean,
	worktreeError: Schema.optional(Schema.String),
	teardownError: Schema.optional(Schema.String),
});

export const agentHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record(Schema.String, Schema.String),
	outcome: Schema.Literals(["complete", "blocked", "failed"]),
	artifact: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
	/** Records the handoff as a developer abort: the parked run keeps its
	 * capability so the developer's next message can reopen it. */
	aborted: Schema.optional(Schema.Boolean),
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
	mutation: Schema.optionalKey(Schema.Unknown),
});

/** Managed-agent developer question across the transport. The request signal
 * bounds the wait; the engine validates the run capability. */
export const agentQuestionRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record(Schema.String, Schema.String),
	input: Schema.optionalKey(Schema.Unknown),
	timeoutMs: Schema.optional(Schema.Number),
});

/** Managed researcher structured handoff across the transport. */
export const agentResearchHandoffRequestSchema = Schema.Struct({
	repo: Schema.String,
	environment: Schema.Record(Schema.String, Schema.String),
	handoff: Schema.optionalKey(Schema.Unknown),
});

/** Developer-authorized recovery for one parked native task. The server resolves
 * the host capability from its in-memory launcher registry. */
export const agentTaskRetryRequestSchema = Schema.Struct({
	runId: Schema.String,
	conversationId: Schema.String,
	taskId: Schema.String,
	generation: Schema.Number,
});

export const agentTaskRetryResultSchema = Schema.Struct({
	taskId: Schema.String,
	status: Schema.Literals([
		"retried",
		"already-in-progress",
		"stale",
		"refused",
	]),
	reason: Schema.optional(Schema.String),
});

/** The agent configuration read: opaque profile tables plus provenance and the
 * conflict list the settings UI renders. */
export type { AgentsListResponse } from "./gateway.ts";

export const agentsListResponseSchema = Schema.Struct({
	agents: Schema.optionalKey(Schema.Unknown),
	provenance: Schema.optionalKey(Schema.Unknown),
	conflicts: Schema.Array(Schema.String),
	revision: Schema.optional(Schema.String),
	/** The user-scope compaction policy read (`add-agent-compaction`): the
	 * written section, its resolved effective values and the source. Opaque to
	 * the transport; the Settings layer reads the fields it renders. */
	compaction: Schema.optional(Schema.Unknown),
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

/** Decoded request/result types for the operator-only parked-task recovery. */
export type AgentTaskRetryRequest = typeof agentTaskRetryRequestSchema.Type;
export type AgentTaskRetryResult = typeof agentTaskRetryResultSchema.Type;
