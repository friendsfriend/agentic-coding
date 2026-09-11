import path from "node:path";
import {
	ContractFailure,
	DeveloperQuestionAnswerSchema,
	decodeContract,
	WorkflowCommandSchema,
	WorkflowSnapshotSchema,
} from "./schema.ts";

export {
	type Contract,
	type ContractError,
	ContractFailure,
} from "./schema.ts";
/** Shared with `src/workflow/steps/*.ts` so step behavior hooks can throw the
 * same engine error the runtime recognizes, without importing runtime.ts and
 * creating a cycle back through definitions.ts -> steps/index.ts. */
export class WorkflowRuntimeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly currentRevision?: number,
	) {
		super(message);
	}
}

/** External diagnostic codes that `WorkflowFailure` maps onto. These are the
 * stable codes the workflow CLI and dashboard already expose; the typed
 * failure union below keeps recovery distinctions (expected vs defect vs
 * interruption) without a stringly-typed umbrella. */
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
	label: string;
	value: string;
}
export interface DeveloperQuestionItem {
	description: string;
	context?: string;
	options: readonly DeveloperQuestionOption[];
}
export interface DeveloperDialogueRecord {
	id: string;
	workflowId: string;
	runId: string;
	stepId: string;
	role: string;
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
			}>
	>;
}
export interface WorkflowActionView {
	id: string;
	label: string;
	input?: { schemaId: string; schemaVersion: number };
	confirmation: "none" | "confirm" | "reason";
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
export function decodeSnapshot(value: unknown): WorkflowSnapshot {
	const snapshot = decodeContract<WorkflowSnapshot>(
		"core.workflow-snapshot",
		WorkflowSnapshotSchema,
		value,
		// Preserve unknown keys through the read/rewrite cycle (QUALITY-004):
		// legacy or forward-compat snapshot_json keys not declared in the schema
		// must not be silently discarded when the engine decodes and rewrites
		// the parsed object back to the store.
		{ onExcessProperty: "preserve" },
	);
	// Repository-relative path normalization + cross-field invariants stay as
	// pure validation (design-permitted): Effect Schema decodes the structure,
	// these functions normalize/validate across fields without services.
	const repoIndependent =
		snapshot.definition.id === "wiki-comments" ||
		snapshot.definition.id === "research";
	const metadata: WorkflowSnapshot["metadata"] = { ...snapshot.metadata };
	metadata.repository =
		repoIndependent && metadata.repository === ""
			? ""
			: path.resolve(requireText(metadata.repository, "$.metadata.repository"));
	metadata.worktree = path.resolve(
		requireText(metadata.worktree, "$.metadata.worktree"),
	);
	metadata.branch =
		repoIndependent && metadata.branch === ""
			? ""
			: requireText(metadata.branch, "$.metadata.branch");
	metadata.baseBranch =
		repoIndependent && metadata.baseBranch === ""
			? ""
			: requireText(metadata.baseBranch, "$.metadata.baseBranch");
	metadata.baseCommit =
		repoIndependent && metadata.baseCommit === ""
			? ""
			: requireText(metadata.baseCommit, "$.metadata.baseCommit");
	if (metadata.wikiRoot !== undefined)
		metadata.wikiRoot = path.resolve(metadata.wikiRoot);
	const normalized: WorkflowSnapshot = { ...snapshot, metadata };
	if (normalized.step.context !== undefined)
		normalized.step.context = JSON.parse(
			JSON.stringify(normalized.step.context),
		) as JsonValue;
	const dialogue = normalized.developerDialogue;
	for (const item of dialogue) {
		if (item.status === "pending" && item.answer)
			throw new ContractFailure("core.workflow-snapshot", [
				{
					path: "$.developerDialogue",
					message: "pending question cannot have answer",
				},
			]);
		if (item.status !== "pending" && !item.answer)
			throw new ContractFailure("core.workflow-snapshot", [
				{
					path: "$.developerDialogue",
					message: "resolved question requires answer",
				},
			]);
	}
	if (new Set(dialogue.map((item) => item.id)).size !== dialogue.length)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.developerDialogue", message: "duplicate question ID" },
		]);
	if (Buffer.byteLength(JSON.stringify(dialogue)) > 128 * 1024)
		throw new ContractFailure("core.workflow-snapshot", [
			{
				path: "$.developerDialogue",
				message: "dialogue content exceeds bound",
			},
		]);
	if (
		new Set(normalized.step.activeRunIds).size !==
		normalized.step.activeRunIds.length
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.step.activeRunIds", message: "duplicate run ID" },
		]);
	if (
		normalized.status === "active" &&
		["core.completed", "core.closed"].includes(normalized.currentStep)
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.status", message: "terminal step cannot be active" },
		]);
	return normalized;
}

/** Non-empty bounded string used by the snapshot path-normalization pass. */
function requireText(value: string, at: string): string {
	if (!value.trim())
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: at, message: "expected non-empty string" },
		]);
	return value;
}
