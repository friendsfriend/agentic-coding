// Workflow wire contract: the shapes the server, dashboard, gateway and engine
// exchange — views, actions, questions, hand-offs, commands, reviews. Pure:
// Effect Schemas and structural types only, no runtime, TUI or server import.
import { Schema } from "effect";
import {
	boundedText,
	ContractFailure,
	decodeContract,
	integer,
	text,
} from "./decode.ts";
import type { WorktreeGitStatus } from "./integration.ts";

export type ExternalDiagnosticCode =
	| "invalid-command"
	| "invalid-input"
	| "reducer-contract"
	| "artifact"
	| "unauthorized"
	| "stale-run"
	| "stale-effect"
	| "pin-mismatch"
	| "change-id"
	| "entry-guard"
	| "start-guard"
	| "triage"
	| "unavailable";

/** Concrete tagged operational failures (adopt-workflow-effect-foundation,
 * task 2.1). Each expected failure carries a stable external diagnostic code
 * and a bounded, redacted message. Unexpected defects and interruption stay
 * distinct from ordinary retryable failures so a generic error conversion
 * cannot silently retry a defect. Secrets/raw input are never placed in the
 * default `message`; `detail` is bounded and redacted. */
export type WorkflowFailure =
	| {
			_tag: "invalid-input";
			code: "invalid-command" | "reducer-contract" | "artifact";
			message: string;
	  }
	| {
			_tag: "validation";
			code: "invalid-input";
			message: string;
			issues?: readonly { path: string; message: string }[];
	  }
	| { _tag: "unauthorized"; code: "unauthorized"; message: string }
	| {
			_tag: "stale-revision";
			code: "stale-run";
			message: string;
			currentRevision: number;
	  }
	| { _tag: "stale-ownership"; code: "stale-effect"; message: string }
	| {
			_tag: "compatibility";
			code:
				| "pin-mismatch"
				| "change-id"
				| "entry-guard"
				| "start-guard"
				| "triage";
			message: string;
	  }
	| { _tag: "infrastructure"; code: "unavailable"; message: string }
	| { _tag: "defect"; message: string };

/** Mask credential-shaped content so a secret that reaches a message before
 * the slice bound is still not emitted verbatim (SEC-001 defense in depth;
 * the primary fix removes raw received values at `decodeContract`). Keeps
 * digest/hex identifiers intact — only values adjacent to secret key words
 * (and `Bearer` tokens) are masked. Bare `key=`/`nonce=`/`hash=` labels are
 * included so credential-shaped values are masked even without a secret
 * keyword prefix. */
function redactSecrets(message: string): string {
	return message
		.replace(
			/(token|secret|password|credential|authorization|api[_-]?key|key|nonce|hash)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1: <redacted>",
		)
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
}

/** Map a typed failure to the bounded, redacted external diagnostic the CLI
 * and dashboard surface. Never emits raw secrets or full input contents. */
export function externalDiagnostic(failure: WorkflowFailure): {
	code: string;
	message: string;
} {
	return {
		code: failure._tag === "defect" ? "unavailable" : failure.code,
		message: redactSecrets(failure.message).slice(0, 2048),
	};
}

/** True when a failure is a retryable, expected infrastructure/ownership
 * condition rather than a programming defect or terminal validation error. */
export function isRetryableFailure(
	failure: WorkflowFailure,
): failure is Extract<WorkflowFailure, { _tag: "infrastructure" }> {
	return failure._tag === "infrastructure";
}

export type ActorKind = "agent" | "developer" | "system";
export type WorkflowStatus =
	| "active"
	| "paused"
	| "attention-required"
	| "completed"
	| "closed";
export type RunStatus =
	| "pending"
	| "working"
	| "completed"
	| "blocked"
	| "failed"
	| "expired";
export type EffectStatus =
	| "pending"
	| "running"
	| "retry"
	| "completed"
	| "failed"
	| "expired";
export type RuntimeId = "pi" | "opencode" | "opencode-v2" | (string & {});
export type AdapterCapability =
	| "interactive"
	| "prompt"
	| "persistent-session"
	| "run-environment"
	| "observe"
	| "read-only"
	| "shell"
	| "edit"
	| "runtime-bridge";
export type EffectKind =
	| "workspace.setup"
	| "artifact.write"
	| "agent.launch"
	| "agent.prompt"
	| "agent.stop"
	| "model.classify"
	| "notification.show"
	| "openspec.validate"
	| "wiki.verify"
	| "delivery.commit"
	| "delivery.push"
	| "pull-request.create"
	| "workspace.close"
	| "workspace.cleanup";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface DefinitionPin {
	id: string;
	version: number;
	digest: string;
	/** Present on semantic-pin definitions; absent on legacy snapshots. */
	stepRefs?: readonly {
		id: string;
		version: number;
		behaviorVersion: number;
	}[];
}
export interface ResolvedProfile {
	name: string;
	runtime: RuntimeId;
	executable: string;
	model?: string;
	agent?: string;
	thinking?: string;
	tools: readonly string[];
	extensions: readonly string[];
	readOnly: boolean;
	capabilities: readonly AdapterCapability[];
	digest: string;
}
export interface WorkflowRouting {
	defaultProfile: string;
	routes: readonly {
		stepId: string;
		role?: string;
		profile: ResolvedProfile;
	}[] /** @deprecated ignored legacy snapshot data */;
	diversity?: readonly { routes: string[]; satisfied: boolean }[];
}
export interface StepAttemptState {
	attempt: number;
	mode?: "apply" | "fix" | "review-fix";
	activeRunIds: string[];
	completedRunIds: string[];
	selectedRoles: string[];
	testRunStarted: boolean;
	context?: JsonValue;
	results: Array<{
		runId: string;
		role: string;
		critical: number;
		outputDigest?: string;
	}>;
}
export interface WorkflowExecutionSettings {
	/** Effective non-secret settings accepted at workflow start. */
	remote: string;
	/** Absolute executable path, or null when PR tooling is unavailable. */
	prTool: string | null;
	provenance: {
		source: "default" | "environment" | "user" | "legacy" | "project";
		files: readonly string[];
	};
}

export interface WorkflowMetadata {
	/** Empty for repository-independent workflows such as wiki-comments. */
	repository: string;
	worktree: string;
	/** Empty until the plan step records the planner-declared primary change.
	 * `openspec-apply` (which has no planner) records it at start. */
	changeId: string;
	/** Empty for repository-independent workflows. */
	branch: string;
	/** Empty for repository-independent workflows. */
	baseBranch: string;
	/** Empty for repository-independent workflows. */
	baseCommit: string;
	workspace?: string;
	task?: string;
	ticket?: string;
	createdAt: string;
	updatedAt: string;
	stepEnteredAt: string;
	/** Engine-pinned centralized wiki destination for workflows with core.wiki. */
	wikiRoot?: string;
	/** The preset selected for this workflow, when one was explicitly chosen. */
	selectedPreset?: string;
	/** Missing only on legacy snapshots; sensitive delivery effects must not guess. */
	executionSettings?: WorkflowExecutionSettings;
	executionSettingsPreview?: {
		settings: WorkflowExecutionSettings;
		fingerprint: string;
		revision: number;
	};
}
export type DeveloperQuestionStatus =
	| "pending"
	| "answered"
	| "cancelled"
	| "expired";
export interface DeveloperQuestionOption {
	/** Display title for the option; legacy payloads use `label`. */
	title?: string;
	/** Legacy display label; retained so existing payloads keep decoding. */
	label?: string;
	/** Stable value returned when the option is selected; defaults to the title. */
	value?: string;
	/** Marks the option the asking agent recommends. */
	recommended?: boolean;
	/** Markdown detail rendered by the option-detail modal. */
	description?: string;
}
/** Normalized option used for storage, rendering, and answer matching. */
export interface ResolvedDeveloperQuestionOption {
	label: string;
	value: string;
	recommended?: boolean;
	description?: string;
}
/** Resolve the display label, stable value, and new detail fields of an option
 * while accepting both the new `title` and the legacy `label` shapes. */
export function resolveDeveloperQuestionOption(
	option: DeveloperQuestionOption,
): ResolvedDeveloperQuestionOption {
	const label = option.title ?? option.label ?? option.value ?? "";
	const value = option.value ?? option.title ?? option.label ?? "";
	return {
		label,
		value,
		...(option.recommended === undefined
			? {}
			: { recommended: option.recommended }),
		...(option.description === undefined
			? {}
			: { description: option.description }),
	};
}
export interface DeveloperQuestionItem {
	/** Short tab title shown when several questions are grouped. */
	ident?: string;
	/** Question text; legacy payloads use `description`. */
	question?: string;
	/** Legacy question text; retained so existing payloads keep decoding. */
	description?: string;
	context?: string;
	options: readonly DeveloperQuestionOption[];
}
export interface DeveloperDialogueRecord {
	id: string;
	workflowId: string;
	runId: string;
	stepId: string;
	role: string;
	/** Short tab title; absent for legacy single-question records. */
	ident?: string;
	description: string;
	context?: string;
	options: readonly DeveloperQuestionOption[];
	/** Present for items created by one questionnaire; absent in legacy records. */
	groupId?: string;
	/** Secret binding for the internal timer that may expire this question. */
	timerNonce?: string;
	/** Present when the question is routed to a peer agent rather than the developer. */
	targetRole?: string;
	/** Completed peer run the question was delivered to; absent for developer questions. */
	targetRunId?: string;
	/** Secret binding for the peer agent's one-shot answer capability. */
	answerNonceHash?: string;
	itemIndex?: number;
	status: DeveloperQuestionStatus;
	createdAt: string;
	expiresAt: string;
	answeredAt?: string;
	answer?: {
		kind: "option" | "custom" | "cancel";
		value?: string;
	};
}
export interface WorkflowSnapshot {
	schemaVersion: 1;
	workflowId: string;
	revision: number;
	definition: DefinitionPin;
	status: WorkflowStatus;
	currentStep: string;
	step: StepAttemptState;
	metadata: WorkflowMetadata;
	routing: WorkflowRouting;
	evidence: Array<{ kind: string; path: string; digest: string }>;
	loopCounts: Record<string, number>;
	attention: string[];
	/** Bounded, ordered question/answer history. Missing in legacy snapshots. */
	developerDialogue: DeveloperDialogueRecord[];
	/** Deterministic source-content baseline for repository-backed wiki runs. */
	sourceBaseline?: { fingerprint: string };
	/** Complete pre-agent baseline for repository-independent wiki reviews. */
	wikiBaseline?: {
		fingerprint: string;
		concepts: Array<{ id: string; digest: string }>;
	};
	repaired?: { reason: string; fromStep: string; at: string };
	migrated?: {
		from: DefinitionPin;
		to: DefinitionPin;
		reason: string;
		at: string;
	};
	repinned?: { fromDigest: string; at: string };
}
export interface WorkflowRun {
	id: string;
	workflowId: string;
	stepId: string;
	role: string;
	generation: number;
	attempt: number;
	status: RunStatus;
	profile: ResolvedProfile;
	issuedRevision: number;
	allowedOutcomes: readonly ("complete" | "blocked" | "failed")[];
	capabilityHash: string;
	capabilityExpiresAt: string;
	assignmentPath: string;
	outputPath?: string;
	outputSchema?: { id: string; version: number };
	outputDigest?: string;
	handle?: AgentHandle;
	createdAt: string;
	completedAt?: string;
}
export interface AgentHandle {
	runtime: RuntimeId;
	name: string;
	paneId: string;
	tabId?: string;
	sessionId?: string;
}
export interface WorkflowEffect {
	id: string;
	workflowId: string;
	revision: number;
	kind: EffectKind;
	idempotencyKey: string;
	payload: JsonValue;
	status: EffectStatus;
	attempts: number;
	maxAttempts: number;
	lease?: string;
	leaseExpiresAt?: string;
	nextAttemptAt?: string;
	lastError?: string;
}
export interface Assignment {
	protocolVersion: 1;
	workflowId: string;
	runId: string;
	generation: number;
	stepId: string;
	role: string;
	objective: string;
	interaction: "developer-dialogue" | "silent";
	inputs: readonly string[];
	permissions: readonly string[];
	checks: readonly string[];
	output?: {
		path: string;
		schemaId: string;
		schemaVersion: number;
		maxBytes: number;
	};
	allowedOutcomes: readonly ("complete" | "blocked" | "failed")[];
	environment: Readonly<
		Record<
			| "HERDR_WORKFLOW_ID"
			| "HERDR_RUN_ID"
			| "HERDR_RUN_GENERATION"
			| "HERDR_RUN_TOKEN"
			| "HERDR_OUTPUT"
			| "HERDR_OUTPUT_SCHEMA_ID"
			| "HERDR_OUTPUT_SCHEMA_VERSION"
			| "HERDR_STEP_ID"
			| "HERDR_ROLE"
			| "HERDR_PROFILE"
			| "HERDR_RUNTIME"
			| "HERDR_TELEMETRY_PATH"
			| "TRACEPARENT",
			string
		> &
			Readonly<{
				/** Present only for steps that run after the primary change is
				 * recorded (implementation onward; archive); absent during
				 * planning, where the planner chooses the change id(s). */
				HERDR_CHANGE_ID?: string;
				HERDR_WORKFLOW_TARGET?: string;
				/** Session content capture opt-in, forwarded from
				 * `telemetry.capture_content`; absent when capture is off. */
				HERDR_CAPTURE_CONTENT?: string;
			}>
	>;
}
export interface WorkflowActionView {
	id: string;
	label: string;
	input?: { schemaId: string; schemaVersion: number };
	confirmation: "none" | "confirm" | "reason";
	/** Presentation-only hint supplied by the registered action owner: this
	 * action is a blocking human decision gate, so the workflow owes developer
	 * input until it is answered. It never affects authorization, availability,
	 * graph transitions, or execution policy — optional terminal/research
	 * actions (close, create-pr, follow-ups) leave it unset. */
	requiresInput?: boolean;
}
export interface WorkflowView {
	workflowId: string;
	changeId: string;
	revision: number;
	definition: DefinitionPin & { label: string };
	status: WorkflowStatus;
	repository: string;
	worktree: string;
	branch: string;
	baseCommit: string;
	workspace?: string;
	task?: string;
	createdAt: string;
	updatedAt: string;
	/** The selected agent preset, or absent when using configuration defaults. */
	selectedPreset?: string;
	currentStep: {
		id: string;
		label: string;
		attempt: number;
		enteredAt: string;
	};
	runs: Array<{
		id: string;
		stepId: string;
		role: string;
		attempt: number;
		status: RunStatus;
		runtime: RuntimeId;
		profile: string;
		model?: string;
		paneId?: string;
		tabId?: string;
		outputPath?: string;
		outputDigest?: string;
	}>;
	routing: WorkflowRouting;
	executionSettingsPreview?: WorkflowMetadata["executionSettingsPreview"];
	effects: Array<{
		id: string;
		kind: EffectKind;
		status: EffectStatus;
		attempts: number;
		lastError?: string;
	}>;
	observations: Array<{
		runId: string;
		runtime: RuntimeId;
		status: string;
		at: string;
	}>;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	/** Answered and terminal questions in creation order. */
	developerDialogue?: DeveloperDialogueRecord[];
	/** Pending subset, ordered oldest first. */
	pendingQuestions?: DeveloperDialogueRecord[];
	availableActions: WorkflowActionView[];
}

export type WorkflowCommand =
	| {
			type: "developer.action";
			workflowId: string;
			revision: number;
			actionId: string;
			input?: unknown;
	  }
	| {
			type: "agent.question";
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
			description?: string;
			context?: string;
			options?: readonly DeveloperQuestionOption[];
			questions?: readonly DeveloperQuestionItem[];
	  }
	| {
			type: "agent.question-expire";
			workflowId: string;
			questionId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
	  }
	| {
			type: "agent.ask";
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
			targetRole: string;
			description: string;
			context?: string;
			options?: readonly DeveloperQuestionOption[];
	  }
	| {
			type: "agent.answer";
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			questionId: string;
			answerNonce: string;
			answer: string;
	  }
	| {
			type: "timer.question-expire";
			workflowId: string;
			questionId: string;
			timerNonce: string;
	  }
	| {
			type: "agent.handoff";
			runId: string;
			generation: number;
			token: string;
			outcome: "complete" | "blocked" | "failed";
			artifact?: string;
			message?: string;
	  }
	| {
			type: "agent.research-handoff";
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
			handoff: unknown;
	  }
	| {
			type: "effect.result";
			effectId: string;
			lease: string;
			outcome: "complete" | "retry" | "failed";
			data?: unknown;
			/** Measured handler wall clock in milliseconds, for telemetry only. */
			durationMs?: number;
	  }
	| {
			type: "operator.repair";
			workflowId: string;
			revision: number;
			targetStep: string;
			reason: string;
	  }
	| { type: "operator.repin"; workflowId: string; revision: number }
	| {
			type: "operator.migrate";
			workflowId: string;
			revision: number;
			targetVersion: number;
			reason: string;
	  }
	| { type: "operator.resume"; workflowId: string; revision: number };

// ---------------------------------------------------------------------------
// Developer-question and workflow-command schemas
// ---------------------------------------------------------------------------
export const DeveloperQuestionOptionSchema: Schema.Schema<DeveloperQuestionOption> =
	Schema.Struct({
		title: Schema.optionalWith(text(256), { exact: true }),
		label: Schema.optionalWith(text(256), { exact: true }),
		value: Schema.optionalWith(text(1024), { exact: true }),
		recommended: Schema.optionalWith(Schema.Boolean, { exact: true }),
		description: Schema.optionalWith(boundedText(4096), { exact: true }),
	});

/** Structural option-list validation shared by command input and persisted
 * records. Kept permissive so a snapshot written by an earlier schema of this
 * feature (for example with two recommendations) still decodes; the
 * recommendation invariant is a command-input rule only. */
export const questionOptions = Schema.Array(DeveloperQuestionOptionSchema).pipe(
	Schema.filter(
		(options) => {
			const resolved = options.map(resolveDeveloperQuestionOption);
			return (
				options.length <= 16 &&
				resolved.every(
					(option) =>
						option.label.trim().length > 0 && option.value.trim().length > 0,
				) &&
				new Set(resolved.map((option) => option.value)).size === resolved.length
			);
		},
		{
			message: () =>
				"expected at most 16 options with a non-empty title and unique values",
		},
	),
);

/** Command-input option list: the shared structural rules plus the authoring
 * invariant that at most one option is marked recommended. Never used to decode
 * persisted dialogue, so tightening it cannot strand older state. */
export const commandQuestionOptions = questionOptions.pipe(
	Schema.filter(
		(options) =>
			options.filter(
				(option) => resolveDeveloperQuestionOption(option).recommended === true,
			).length <= 1,
		{ message: () => "expected at most one recommended option" },
	),
);

export const DeveloperQuestionItemSchema = Schema.Struct({
	ident: Schema.optionalWith(text(256), { exact: true }),
	question: Schema.optionalWith(text(4096), { exact: true }),
	description: Schema.optionalWith(text(4096), { exact: true }),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(commandQuestionOptions, {
		exact: true,
		default: () => [],
	}),
}).pipe(
	Schema.filter(
		(item) => item.question !== undefined || item.description !== undefined,
		{ message: () => "each question requires question or description" },
	),
);

const MAX_QUESTIONNAIRE_ITEMS = 8;

export const DeveloperQuestionAnswerSchema = Schema.Union(
	Schema.Struct({
		questionId: text(4096),
		kind: Schema.Literal("option", "custom", "cancel"),
		value: Schema.optionalWith(text(8192), { exact: true }),
	}).pipe(
		Schema.filter(
			(answer) => answer.kind === "cancel" || answer.value !== undefined,
			{
				message: () =>
					"option and custom answers require a value; cancel does not",
			},
		),
	),
	Schema.Struct({
		groupId: text(4096),
		kind: Schema.Literal("cancel"),
	}),
	Schema.Struct({
		groupId: text(4096),
		responses: Schema.Array(
			Schema.Struct({
				questionId: text(4096),
				kind: Schema.Literal("option", "custom"),
				value: text(8192),
			}),
		).pipe(
			Schema.filter(
				(responses) =>
					responses.length >= 1 &&
					responses.length <= MAX_QUESTIONNAIRE_ITEMS &&
					new Set(responses.map((item) => item.questionId)).size ===
						responses.length,
				{
					message: () =>
						`expected 1-${MAX_QUESTIONNAIRE_ITEMS} unique responses`,
				},
			),
		),
	}),
);

// ---------------------------------------------------------------------------
// Workflow command (discriminated union on `type`)
// ---------------------------------------------------------------------------

const developerActionSchema = Schema.Struct({
	type: Schema.Literal("developer.action"),
	workflowId: text(4096),
	revision: integer(),
	actionId: text(4096),
	input: Schema.Unknown,
});
const agentQuestionSchema = Schema.Struct({
	type: Schema.Literal("agent.question"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	description: Schema.optionalWith(text(4096), { exact: true }),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(commandQuestionOptions, { exact: true }),
	questions: Schema.optionalWith(
		Schema.Array(DeveloperQuestionItemSchema).pipe(
			Schema.filter(
				(items) => items.length >= 1 && items.length <= MAX_QUESTIONNAIRE_ITEMS,
				{
					message: () => `expected 1-${MAX_QUESTIONNAIRE_ITEMS} question items`,
				},
			),
		),
		{ exact: true },
	),
});
const agentQuestionExpireSchema = Schema.Struct({
	type: Schema.Literal("agent.question-expire"),
	workflowId: text(4096),
	questionId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
});
const timerQuestionExpireSchema = Schema.Struct({
	type: Schema.Literal("timer.question-expire"),
	workflowId: text(4096),
	questionId: text(4096),
	timerNonce: text(128),
});
const agentAskSchema = Schema.Struct({
	type: Schema.Literal("agent.ask"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	targetRole: text(4096),
	description: text(4096),
	context: Schema.optionalWith(boundedText(4096), { exact: true }),
	options: Schema.optionalWith(commandQuestionOptions, { exact: true }),
});
const agentAnswerSchema = Schema.Struct({
	type: Schema.Literal("agent.answer"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	questionId: text(4096),
	answerNonce: text(1024),
	answer: text(8192),
});
const agentHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.handoff"),
	runId: text(4096),
	generation: integer(1),
	token: text(1024),
	outcome: Schema.Literal("complete", "blocked", "failed"),
	artifact: Schema.optionalWith(text(4096), { exact: true }),
	message: Schema.optionalWith(text(4096), { exact: true }),
});
const agentResearchHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.research-handoff"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	handoff: Schema.Unknown,
});
const effectResultSchema = Schema.Struct({
	type: Schema.Literal("effect.result"),
	effectId: text(4096),
	lease: text(4096),
	outcome: Schema.Literal("complete", "retry", "failed"),
	data: Schema.Unknown,
	/** Measured handler wall clock, reported on the exported telemetry event.
	 * Optional so existing callers keep decoding unchanged. */
	durationMs: Schema.optional(integer()),
});
const operatorRepairSchema = Schema.Struct({
	type: Schema.Literal("operator.repair"),
	workflowId: text(4096),
	revision: integer(),
	targetStep: text(4096),
	reason: Schema.optionalWith(boundedText(2048), {
		exact: true,
		default: () => "",
	}),
});
const operatorRepinSchema = Schema.Struct({
	type: Schema.Literal("operator.repin"),
	workflowId: text(4096),
	revision: integer(),
});
const operatorMigrateSchema = Schema.Struct({
	type: Schema.Literal("operator.migrate"),
	workflowId: text(4096),
	revision: integer(),
	targetVersion: integer(1),
	reason: Schema.optionalWith(boundedText(2048), {
		exact: true,
		default: () => "",
	}),
});
const operatorResumeSchema = Schema.Struct({
	type: Schema.Literal("operator.resume"),
	workflowId: text(4096),
	revision: integer(),
});

export const WorkflowCommandSchema = Schema.Union(
	developerActionSchema,
	agentQuestionSchema,
	agentQuestionExpireSchema,
	agentAskSchema,
	agentAnswerSchema,
	timerQuestionExpireSchema,
	agentHandoffSchema,
	agentResearchHandoffSchema,
	effectResultSchema,
	operatorRepairSchema,
	operatorRepinSchema,
	operatorMigrateSchema,
	operatorResumeSchema,
);

// ---------------------------------------------------------------------------
// Snapshot / profile / settings
// ---------------------------------------------------------------------------

/** Schema-backed command decode (complete-workflow-effect-cutover, task 3.1):
 * the migration-only `commandContract` facade is removed; callers decode
 * through the Schema path directly. Cross-field invariants stay pure. */
export function decodeCommand(value: unknown): WorkflowCommand {
	const command = decodeContract<WorkflowCommand>(
		"core.workflow-command",
		WorkflowCommandSchema,
		value,
	);
	// Cross-field invariants (pure validation, design-permitted): a question
	// command provides either a description or a questionnaire, never both,
	// and a questionnaire carries no top-level context/options.
	if (command.type === "agent.question") {
		const hasDescription = command.description !== undefined;
		const hasQuestions = command.questions !== undefined;
		if (hasDescription === hasQuestions)
			throw new ContractFailure("core.developer-question", [
				{
					path: "$.description",
					message: "provide either description or questions, but not both",
				},
			]);
		if (
			hasQuestions &&
			(command.options !== undefined || command.context !== undefined)
		)
			throw new ContractFailure("core.developer-question", [
				{
					path: "$.questions",
					message: "questionnaires use per-item context and options",
				},
			]);
	}
	// The answer-question action's input is a developer-question answer.
	if (
		command.type === "developer.action" &&
		command.actionId === "answer-question"
	)
		return {
			...command,
			input: decodeDeveloperQuestionAnswer(command.input),
		};
	return command;
}

export type DeveloperQuestionAnswer =
	| {
			questionId: string;
			kind: "option" | "custom" | "cancel";
			value?: string;
	  }
	| {
			groupId: string;
			kind: "cancel";
	  }
	| {
			groupId: string;
			responses: Array<{
				questionId: string;
				kind: "option" | "custom";
				value: string;
			}>;
	  };
export function decodeDeveloperQuestionAnswer(
	value: unknown,
): DeveloperQuestionAnswer {
	return decodeContract<DeveloperQuestionAnswer>(
		"core.developer-question",
		DeveloperQuestionAnswerSchema,
		value,
	);
}

// ---------------------------------------------------------------------------
// Dashboard wire records: the workflow state the dashboard reads, its review
// and cost projections, and the finding records a review carries.
// ---------------------------------------------------------------------------

export interface WorkflowState {
	/** User-supplied workflow identifier; dashboards address workflows by it. */
	workflowId: string;
	/** Planner-recorded primary change id; empty until the plan step. */
	changeId: string;
	phase: string;
	stepId?: string;
	stepLabel?: string;
	revision: number;
	definition?: { id: string; version: number; digest: string; label: string };
	status: string;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	availableActions?: Array<{ id: string; label: string; confirmation: string }>;
	repository: string;
	worktree: string;
	branch: string;
	task?: string;
	workspace: string;
	verificationRound: number;
	baseCommit?: string;
	createdAt?: string;
	phaseStartedAt?: string;
	selectedPreset?: string;
	prCreated?: boolean;
	prUrl?: string | null;
	ticketNumber?: string;
	workerModel?: string;
	returnWorkspace?: string;
	verificationTier?: string;
	verificationRoles?: string[];
	runs: Array<{
		id: string;
		stepId: string;
		role: string;
		attempt: number;
		status: RunStatus;
		runtime: string;
		profile: string;
		model?: string;
		paneId?: string;
		outputPath?: string;
		outputDigest?: string;
	}>;
	verificationResults?: Record<string, unknown>;
	verificationReusedResults?: Record<string, unknown>;
	verificationStartedAt?: string;
	testVerifierStarted?: boolean;
	verificationTimeoutRoles?: string[];
	verificationRoleStartedAt?: Record<string, string>;
	verificationModels?: Record<string, string>;
	developerDialogue?: DeveloperDialogueRecord[];
	pendingQuestions?: DeveloperDialogueRecord[];
	planQuality?: {
		passed: boolean;
		issues: string[];
		specFiles: number;
		taskCount: number;
	};
	panes: Record<string, string>;
}

export interface WorkflowOverview {
	state: WorkflowState;
	workspaceOpen: boolean;
	tasks: [number, number];
	/** Stable configured project ident resolved from the catalog, when the
	 * workflow's repository is a configured project (environment cross-link). */
	projectIdent?: string;
	// WorkflowOverview agents: role/status/model plus lifetime cost.
	agents: Array<{
		role: string;
		status: RunStatus;
		runtime?: string;
		model?: string;
		cost?: number;
	}>;
}

export interface DeveloperReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
	findingId?: string;
}

export interface PlanReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
}
export type WikiReviewComment = PlanReviewComment;

export interface DeveloperReviewFinding {
	id: string;
	originalId: string;
	severity: "warning" | "info";
	path?: string;
	line?: number;
	detail: string;
	recommendation?: string;
	evidence?: string;
	fix?: string;
	verifier?: string;
}

export interface FindingCounts {
	critical: number;
	warning: number;
	info: number;
}
export interface DashboardData {
	state: WorkflowState;
	/** Stable configured project ident for the repository, when configured. */
	projectIdent?: string;
	/** Set when a repository-backed workflow's project is absent from the
	 * configured catalog; the detail stays usable and shows the mismatch. */
	catalogMismatch?: string;
	request: string;
	proposal: string;
	review: string;
	reviewHistory: string[];
	agents: Array<{
		role: string;
		status: RunStatus;
		runtime?: string;
		model?: string;
		cost?: number;
		metrics?: AgentUsageMetrics;
		findingCounts?: FindingCounts;
	}>;
	updated: string;
	health: { dirty: boolean; ahead: number; behind: number; branch: string };
	gitStatus: WorktreeGitStatus;
	age: string;
	events: Array<{
		at: string;
		event: string;
		role?: string;
		model?: string;
		cost?: number;
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		status?: number;
		tier?: string;
		roles?: string[];
		reports?: string[];
		fallback?: string;
	}>;
	verifierTimeline: Array<{
		role: string;
		status: string;
		rawStatus?: string;
		diagnostic?: string;
		durationSeconds?: number;
		model?: string;
		providerErrors: number;
		fallback: boolean;
	}>;
	costBreakdown: Array<Omit<CostRow, "messages"> & { messages: CostMessage[] }>;
}

export interface CostRow {
	role: string;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

export interface CostMessage {
	at: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

export interface AgentUsageMetrics {
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	durationSeconds?: number;
	tokensPerSecond?: number;
}

/** One parsed finding from a committed verifier `core.findings` artifact. */
export interface VerifierFinding {
	id: string;
	severity: "critical" | "warning" | "info";
	detail: string;
	recommendation?: string;
	path?: string;
	line?: number;
	status?: string;
	evidence?: string;
	changedCode?: string;
	fix?: string;
}

/** Read one workflow view (or list the repository's views). */
export const workflowViewRequestSchema = Schema.Struct({
	repo: Schema.String,
	workflowId: Schema.String,
});

// ---------------------------------------------------------------------------
// Response schemas: decoded at the client boundary, never cast
// ---------------------------------------------------------------------------

const boundedString = (max: number) =>
	Schema.String.pipe(Schema.maxLength(max));
const nonNegativeInt = Schema.Number.pipe(
	Schema.filter((n) => Number.isInteger(n) && n >= 0, {
		message: () => "expected integer >= 0",
	}),
);

const definitionPinResponseSchema = Schema.Struct({
	id: boundedString(4096),
	version: nonNegativeInt,
	digest: boundedString(4096),
	label: boundedString(4096),
});

const workflowRunResponseSchema = Schema.Struct({
	id: boundedString(4096),
	stepId: boundedString(4096),
	role: boundedString(4096),
	attempt: nonNegativeInt,
	status: Schema.String,
	runtime: Schema.String,
	profile: Schema.String,
	model: Schema.optional(Schema.String),
	paneId: Schema.optional(Schema.String),
	tabId: Schema.optional(Schema.String),
	outputPath: Schema.optional(Schema.String),
	outputDigest: Schema.optional(Schema.String),
});

const dialogueRecordResponseSchema = Schema.Struct({
	id: Schema.String,
	workflowId: Schema.String,
	runId: Schema.String,
	stepId: Schema.String,
	role: Schema.String,
	description: Schema.String,
	context: Schema.optional(Schema.String),
	ident: Schema.optional(Schema.String),
	options: Schema.Array(
		Schema.Struct({
			title: Schema.optional(Schema.String),
			label: Schema.optional(Schema.String),
			value: Schema.optional(Schema.String),
			recommended: Schema.optional(Schema.Boolean),
			description: Schema.optional(Schema.String),
		}),
	),
	groupId: Schema.optional(Schema.String),
	timerNonce: Schema.optional(Schema.String),
	targetRole: Schema.optional(Schema.String),
	targetRunId: Schema.optional(Schema.String),
	answerNonceHash: Schema.optional(Schema.String),
	itemIndex: Schema.optional(Schema.Number),
	status: Schema.String,
	createdAt: Schema.String,
	expiresAt: Schema.String,
	answeredAt: Schema.optional(Schema.String),
	answer: Schema.optional(Schema.Unknown),
});

/** One workflow view as the server returns it. Bounded and structural: an
 * unexpected field type fails at the client boundary instead of surfacing as
 * `undefined` deep inside a dashboard projection. */
export const workflowViewSchema = Schema.Struct({
	workflowId: boundedString(4096),
	changeId: Schema.String,
	revision: nonNegativeInt,
	definition: definitionPinResponseSchema,
	status: Schema.String,
	repository: Schema.String,
	worktree: Schema.String,
	branch: Schema.String,
	baseCommit: Schema.String,
	workspace: Schema.optional(Schema.String),
	task: Schema.optional(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	selectedPreset: Schema.optional(Schema.String),
	currentStep: Schema.Struct({
		id: Schema.String,
		label: Schema.String,
		attempt: nonNegativeInt,
		enteredAt: Schema.String,
	}),
	runs: Schema.Array(workflowRunResponseSchema),
	routing: Schema.Unknown,
	executionSettingsPreview: Schema.optional(Schema.Unknown),
	effects: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			kind: Schema.String,
			status: Schema.String,
			attempts: nonNegativeInt,
			lastError: Schema.optional(Schema.String),
		}),
	),
	observations: Schema.Array(
		Schema.Struct({
			runId: Schema.String,
			runtime: Schema.String,
			status: Schema.String,
			at: Schema.String,
		}),
	),
	health: Schema.Struct({
		valid: Schema.Boolean,
		attention: Schema.Array(Schema.String),
		diagnostic: Schema.optional(Schema.String),
	}),
	developerDialogue: Schema.optional(
		Schema.Array(dialogueRecordResponseSchema),
	),
	pendingQuestions: Schema.optional(Schema.Array(dialogueRecordResponseSchema)),
	availableActions: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			label: Schema.String,
			input: Schema.optional(Schema.Unknown),
			confirmation: Schema.String,
			requiresInput: Schema.optional(Schema.Boolean),
		}),
	),
});

/** The view list read (`GET /workflow/view?list=1`). */
export const workflowViewListSchema = Schema.Array(workflowViewSchema);

/** Workflow start/agent-question answers return the new workflow id. */
export const workflowIdResponseSchema = Schema.String.pipe(
	Schema.maxLength(4096),
);

/** Saved review comments are not echoed back; the server returns a count. */
export const savedReviewResponseSchema = Schema.Unknown;
