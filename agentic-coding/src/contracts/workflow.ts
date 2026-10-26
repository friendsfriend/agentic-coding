// Workflow wire contract: the shapes the server, dashboard, gateway and engine
// exchange — views, actions, questions, hand-offs, commands, reviews. Pure:
// Effect Schemas and structural types only, no runtime, TUI or server import.
import { Effect, Schema } from "effect";
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
 * keyword prefix. Exported so every bounded event payload uses the one masking
 * helper (add-orchestrator-event-subscriptions). */
export function redactSecrets(message: string): string {
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

/** The authenticated principal a workflow action arrived from: the operator
 * (the developer's own shell, CLI or dashboard) or the Home Orchestrator
 * session. It is decided by the server from the request's bearer capability and
 * never travels on the wire; an event actor records it beside `kind` so
 * `ActorKind` (and every step definition) stays untouched. */
export type WorkflowPrincipal = "operator" | "orchestrator";

/** Who started a workflow, pinned once at start for its lifetime. Snapshots
 * written before the attribution existed omit it and read as `developer`. */
export type StartedBy = "developer" | "orchestrator";

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
/** The one managed agent runtime (multiplexer removal): the bundled durable
 * host. Pane-hosted runtimes (`pi`, `opencode`) are gone with the multiplexer. */
export type RuntimeId = "pi-durable";

/** Runtime ids a persisted snapshot, run or handle may still carry from before
 * the multiplexer removal. They are normalized to the one runtime on read, so
 * history and in-flight workflows stay loadable instead of failing decode. */
export const RETIRED_RUNTIME_IDS = ["pi", "opencode", "opencode-v2"] as const;

/** Normalize a persisted runtime id onto the one managed runtime. Any value
 * that is not the current runtime is a retired id by construction. */
export function normalizeRuntimeId(_value: unknown): RuntimeId {
	return "pi-durable";
}
export type AdapterCapability =
	| "interactive"
	| "prompt"
	| "persistent-session"
	| "run-environment"
	| "observe"
	| "read-only"
	| "shell"
	| "edit"
	| "runtime-bridge"
	| "vision";
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
	| "workspace.cleanup"
	/** Owner-bound release of every app one workflow holds (close and delete). */
	| "environment.teardown"
	/** The env-setup family's write guard: baseline before the first author
	 * turn, comparison at every author handoff. */
	| "environment.setup-guard"
	/** Structural validation of the env-setup drafts plus a real start. */
	| "environment.validate"
	/** Atomic promotion of approved env-setup drafts, with rollback. */
	| "environment.promote"
	/** Materializes the env-setup staged configuration root
	 * (staged-env-setup-config-root). */
	| "environment.setup-stage"
	/** Post-promotion smoke check of the real default target. */
	| "environment.setup-smoke"
	/** Rolls a promotion back from its own authenticated journal. */
	| "environment.setup-rollback"
	/** Removes a setup workflow's staged state at close (staged-env-setup-config-root). */
	| "environment.setup-cleanup"
	/** Validates and renders a stage-test report from its structured output. */
	| "stage.report.render"
	/** Promotes the run's authored block drafts into the shared store on review
	 * approval (author-stage-blocks-as-data). */
	| "stage.blocks.promote"
	/** Starts one delegated debug request's run: captures the baseline and
	 * enqueues the run's own launch (add-debug-subagent-requests). */
	| "debug.request.run"
	/** Injects one finished debug request's report into its caller run's
	 * conversation as a follow-up (add-debug-subagent-requests). */
	| "debug.request.deliver";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

/** The message a developer abort records as the parked run's `blocked`
 * handoff. The engine clears exactly this attention entry when the run is
 * reopened by the developer's next message (`agent.resume`), and the host
 * records it, so both sides name the same bounded text. */
export const DEVELOPER_ABORT_MESSAGE = "aborted by the developer";

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

/** Bounds the persisted snapshot places on the stage fields pinned at start.
 * The stage catalog decodes against them too, so a stage document can never be
 * accepted and then be impossible to pin. */
export const STAGE_SYSTEM_MAX_BYTES = 256;
export const STAGE_WIKI_PROCESS_MAX_BYTES = 512;

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
	task?: string;
	ticket?: string;
	/** The hosted stage pinned by a stage-test workflow at start. */
	stage?: string;
	stageSystem?: string;
	stageWikiProcesses?: string[];
	stageAccess?: "read-only" | "writable";
	stagePlanApproval?: "always" | "when-writing" | "never";
	/** Engine-pinned plan/report payloads; the agents cannot replace these. */
	stageTestPlan?: JsonValue;
	stageTestReport?: JsonValue;
	/** Engine-rendered, secret-scrubbed stage report shown in dashboard review. */
	stageTestReportMarkdown?: string;
	/** What each block the pinned plan names is, projected from the composed
	 * registry at plan acceptance: the review shows the title, effect set and
	 * role scope of the block being approved, not only its id. */
	stagePlanBlocks?: Array<{
		routeStepId: string;
		id: string;
		/** The version the plan resolved for this block, so the report's executed
		 * version is checked against the document the developer approved. */
		version?: string;
		title?: string;
		app?: string;
		effects?: string[];
		roles?: string[];
	}>;
	/** Summary of the optional compiled-flow replay; the result, report and heal
	 * JSON stay in the evidence store and this only links to them. */
	stageReplay?: {
		status: "passed" | "failed" | "ineligible";
		flowId?: string;
		planId?: string;
		revision?: number;
		inputsHash?: string;
		routeHash?: string;
		specHash?: string;
		blockVersions?: Record<string, string>;
		blockDigests?: Record<string, string>;
		resultEvidenceId?: string;
		reportEvidenceId?: string;
		healEvidenceId?: string;
		reason?: string;
		stepCount?: number;
		durationMs?: number;
	};
	/** The redacted replay heal packet, retained for the fallback tester. */
	stageReplayHeal?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	stepEnteredAt: string;
	/** Engine-pinned centralized wiki destination for workflows with core.wiki. */
	wikiRoot?: string;
	/** The preset selected for this workflow, when one was explicitly chosen. */
	selectedPreset?: string;
	/** The configured app an `env-setup` workflow drafts definitions for. */
	app?: string;
	/** The drafts root an `env-setup` workflow writes to and validates from,
	 * pinned at start like `wikiRoot`. */
	setupDraftsDir?: string;
	/** The `env-setup` write guard's armed baselines, keyed by the run identity
	 * (`createdAt`, pinned at start). Engine-owned state on purpose: a baseline
	 * the authored files could reach would be a verdict the monitored process
	 * can forge. One entry per workflow. */
	/** The per-run secret the promotion's journal is authenticated with. Pinned
	 * at start and engine-owned, so a plan an agent hand-writes under `.backups`
	 * can never be adopted as this workflow's own. */
	setupPromotionSecret?: string;
	setupGuardBaselines?: Record<
		string,
		{
			configDir: string;
			checkoutDir: string;
			configFingerprint: string;
			checkoutFingerprint: string;
			/** The fingerprint algorithm that armed this baseline
			 * (`SETUP_GUARD_SCOPE`). Absent on a baseline an older build armed, which
			 * the guard reports instead of comparing. */
			scope?: string;
			/** The definition-tree scan hit its bound: a truncated fingerprint proves
			 * nothing and the guard treats it as a violation. */
			truncated?: boolean;
			/** The scanned definition entries the fingerprint was taken from, so a
			 * violation names what changed. Digests and symlink targets only, never
			 * secret content. */
			entries?: Array<{
				path: string;
				kind: "d" | "f" | "l";
				size?: number;
				digest?: string;
				target?: string;
			}>;
		}
	>;
	/** The reviewed digest of every drafted file, recorded when the validation
	 * gate passed, so the promotion can refuse to publish anything the developer
	 * did not approve. Engine-owned (the store), never a file under the staged
	 * root the authoring agent can write. */
	setupReviewedDrafts?: Record<string, string>;
	/** The default target the validation gate resolved per action, recorded when
	 * the gate passed (`fix-default-target-after-promotion`): the post-promotion
	 * smoke check resolves the live configuration through the same resolver and
	 * fails with a rollback offer when the live default is not this one. */
	setupValidatedDefaults?: Record<string, string>;
	/** Stage-gate policies resolved once at start and pinned for the run's
	 * lifetime, so a mid-run config edit cannot change what may be skipped.
	 * Absent on snapshots started before the gates existed; the mandatory
	 * `always` default is the fallback for those. */
	gatePolicies?: Record<string, string>;
	/** Who started this workflow, pinned once at start: an orchestrator-started
	 * workflow stays attributed to the orchestrator for its lifetime and a later
	 * operator action never re-attributes it. Absent on snapshots started before
	 * the attribution existed; those read as `developer`. */
	startedBy?: StartedBy;
	/** The blueprint a custom-shaped workflow was started from, pinned at start
	 * (add-orchestrator-blueprint-workflows): the label and rationale the model
	 * authored and the compiled digest the workflow pins, so the custom shape is
	 * auditable after the fact. Absent for built-in and operator-defined starts. */
	blueprint?: { label: string; rationale: string; digest: string };
	/** The classifier provider id resolved once at start and pinned for the
	 * run's lifetime, so a mid-run config edit cannot switch the endpoint. The
	 * *model id* is not pinned: it continues to follow
	 * `agents.profiles["jev-classifier"].model` for the hosted provider, while the
	 * local provider always asks its sidecar for its own local model id. Absent
	 * on snapshots started before local providers existed; the configuration is
	 * consulted for those, and an unreadable value falls back to the default
	 * hosted provider. */
	classifier?: string;
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
export const CLASSIFIER_DECISION_MAX_RECORDS = 100;
export const CLASSIFIER_DECISION_INPUT_MAX_BYTES = 16 * 1024;
export const CLASSIFIER_DECISION_CONTENT_MAX_BYTES = 160 * 1024;

/** One triage pass records one record per role question it asked, and every
 * one of them carries the same rendered state, so the per-record input budget
 * is a fraction of `CLASSIFIER_DECISION_INPUT_MAX_BYTES`: at the full budget a
 * single eight-role round would evict every routing record from the bounded
 * history. The state is still the material the classifier was asked about; it
 * is simply stored as a bounded head. */
export const TRIAGE_DECISION_INPUT_MAX_BYTES = 4 * 1024;

/** The gate-decision history has its own bounds: a record is small (stage,
 * policy, decision, one number) but a long workflow with several rounds takes
 * one decision per gate per round, so the list is capped independently of the
 * model-pool decision history. */
export const GATE_DECISION_MAX_RECORDS = 200;
export const GATE_DECISION_CONTENT_MAX_BYTES = 96 * 1024;

/** One recorded stage-gate decision. `forced` distinguishes a run decided
 * locally (`always`) or because the decision failed from an answered run, and
 * `noul` is the necessity answer when one was obtained. */
export interface GateDecisionRecord {
	id: string;
	at: string;
	stepId: string;
	stage: string;
	policy: string;
	decision: "run" | "skip";
	forced: boolean;
	noul?: number;
	reason?: string;
}

/** The re-verification scope record (role-scoped re-verification) is bounded by
 * the round's plan and the fix's own delta: at most one entry per verifier role
 * (nine), at most this many files per list, and a 16-character content digest
 * per file. It is content-free by construction — paths the changed-file
 * manifest already carries and hashes, never a file body. */
export const VERIFICATION_SCOPE_MAX_FILES = 512;
export const VERIFICATION_SCOPE_MAX_ROLES = 9;
export const VERIFICATION_SCOPE_DIGEST_LENGTH = 16;
/** The longest repository-relative path the record can hold, in UTF-8 bytes. A
 * manifest or plan entry above it is unmeasurable, which widens the round
 * instead of refusing the handoff that would record it. */
export const VERIFICATION_SCOPE_MAX_PATH_BYTES = 1024;

/** Which path decided a round's role set: the first round of a workflow, an
 * engine-scoped round, a round whose fix was below the minimum diff (the
 * engine-owned full suite only), or a round the engine widened to today's
 * classifier-decided behaviour. */
export type VerificationScopeMode =
	| "first-round"
	| "scoped"
	| "suite-only"
	| "full-set";

/** Why a round took its mode. A closed vocabulary, so the record and its
 * telemetry stay bounded: no previous round to scope from, ownership of a
 * touched file, a fix below the minimum changed-file count, the roles that
 * reported the findings the fix resolved, and the ways the engine refuses to
 * scope and leaves the round as it was. */
export type VerificationScopeReason =
	| "no-previous-round"
	| "owner-touched"
	| "below-minimum-diff"
	| "findings-reported"
	| "baseline-unusable"
	| "delta-unusable"
	| "no-plan-ownership"
	| "unowned-touched-file"
	| "shared-touched-file"
	| "reported-role-outside-catalog";

/** Why one role is in a round's run set or its skip set. `owner-touched` and
 * `not-owner` are the engine's own scope decision; `below-minimum-diff` marks
 * the roles a suite-only round skips; `findings-reported` marks a role that
 * reported a finding in the round the fix follows, which runs whatever it owns;
 * `classifier-selected`/`classifier-skipped` describe a round the engine left to
 * the classifier, so every role's participation is explainable in every mode. */
export type VerificationRoleReason =
	| "owner-touched"
	| "not-owner"
	| "below-minimum-diff"
	| "findings-reported"
	| "classifier-selected"
	| "classifier-skipped";

/** One role's participation reason. The role comes from the registered
 * verifier catalog and the reason from the closed vocabulary above, so both
 * lists are bounded by construction. */
export interface VerificationScopeRole {
	role: string;
	reason: VerificationRoleReason;
}

/** The content digests of one file in the tree a round verified. `raw` covers
 * the bytes and `normalized` the same bytes with ASCII whitespace removed, so a
 * whitespace-only edit is touched but not substantive. Binary files (a NUL byte
 * in the first 8 KiB) use the raw digest for both. Never content: a
 * 16-character hash and a path the manifest already carries. */
export interface VerificationScopeDigest {
	path: string;
	raw: string;
	normalized: string;
}

/** The tree the round verified, stamped with the round it belongs to. An
 * incomplete baseline is a measurement failure (a cap overflow or a read
 * error), never an empty change set. */
export interface VerificationScopeBaseline {
	round: number;
	complete: boolean;
	files: VerificationScopeDigest[];
}

/** One file the fix touched. `substantive` is false when only whitespace
 * changed; an added or removed file is always substantive. */
export interface VerificationScopeDeltaFile {
	path: string;
	substantive: boolean;
}

/** The fix's own delta, stamped with the round the fix followed and carrying
 * the effective minimum changed-file threshold, so the pure decision never has
 * to load configuration. An incomplete delta widens the round rather than
 * narrowing it. */
export interface VerificationScopeDelta {
	round: number;
	complete: boolean;
	threshold: number;
	files: VerificationScopeDeltaFile[];
}

/** The decision a round took, and why each role ran or did not. */
export interface VerificationScopeDecision {
	/** The round this decision is for (the round it opens). */
	round: number;
	mode: VerificationScopeMode;
	reason: VerificationScopeReason;
	threshold: number;
	/** Files the fix changed in content. */
	touched: number;
	/** Files the fix touched at all, whitespace-only ones included. */
	changed: number;
	/** Files in the baseline the delta was measured against. */
	baselineCount: number;
	rerun: VerificationScopeRole[];
	skipped: VerificationScopeRole[];
}

/** The roles that reported at least one critical finding in a round. The fix
 * that follows exists to resolve them, so each of those roles runs in the next
 * round whatever file the fix touched — the floor that keeps a fixed finding
 * from going unverified when its file was not the one that changed. */
export interface VerificationScopeReported {
	round: number;
	roles: string[];
}

/** The engine's re-verification record for the last round that reached the
 * routing step. Absent on a snapshot written before this record existed, which
 * reads as "no previous round" and takes the first-round path. */
export interface VerificationScopeRecord {
	/** The round this plan is for. */
	round?: number;
	/** That round's plan ownership: every file the triage plan scoped, per role. */
	plan?: Array<{ role: string; files: string[] }>;
	/** The roles that reported findings in this round. */
	reported?: VerificationScopeReported;
	baseline?: VerificationScopeBaseline;
	delta?: VerificationScopeDelta;
	decision?: VerificationScopeDecision;
}

export interface ClassifierDecisionOption {
	label: string;
	profile: string;
	criteria?: JsonValue;
}
export interface ClassifierDecisionAnswer {
	type: "choice" | "noul";
	choice?: string;
	/** The necessity value of a `noul` answer. Every question the classifier
	 * asks outside model-pool routing is a necessity question — the verifier
	 * roles, the stage gates, the per-file judgment sweep — so without this
	 * field those decisions could be recorded but never shown. Absent means the
	 * question went unanswered, never a usable zero. */
	noul?: number;
	confidence?: number;
	probabilities?: Readonly<Record<string, number>>;
}
export interface ClassifierDecisionRecord {
	id: string;
	at: string;
	integration: string;
	phase?: string;
	questionId: string;
	model: string;
	input: string;
	inputTruncated: boolean;
	options: ClassifierDecisionOption[];
	answer: ClassifierDecisionAnswer;
	result: {
		applied: boolean;
		profiles: string[];
		attention?: string;
	};
}
/** What a developer-dialogue record is for. Absent for an ordinary developer
 * question; `login-handoff` is the `stage_login` hand-off, which is answered by
 * the developer in the dashboard but never routed to, or resumed by, a run. */
export type DeveloperDialogueKind = "login-handoff";

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
	/** `login-handoff` marks a `stage_login` hand-off (add-stage-interactive-login):
	 * no custom text, no orchestrator routing, never a reason to resume a run. */
	kind?: DeveloperDialogueKind;
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
	/** Bounded, ordered classifier-decision history. Missing in legacy snapshots. */
	classifierDecisions?: ClassifierDecisionRecord[];
	/** Bounded, ordered stage-gate decision history. Missing in legacy snapshots. */
	gateDecisions?: GateDecisionRecord[];
	/** The last round's re-verification scope record (role-scoped
	 * re-verification): the previous plan's ownership, the fix delta measured
	 * since the tree that round verified, and the decision taken. Missing in
	 * snapshots written before the record existed. */
	verificationScope?: VerificationScopeRecord;
	/** Deterministic source-content baseline for repository-backed wiki runs. */
	sourceBaseline?: { fingerprint: string };
	/** Complete pre-agent baseline for repository-independent wiki reviews. */
	wikiBaseline?: {
		fingerprint: string;
		concepts: Array<{ id: string; digest: string }>;
	};
	repaired?: WorkflowRepairRecord;
	repinned?: { fromDigest: string; at: string };
}

/** The last operator repair, as the snapshot records it and the view publishes
 * it: the bounded reason a repair was taken, the step it left, when it ran, and
 * what it retired. `expiredEffects`, `retiredRuns` and `count` are absent in a
 * snapshot written before they were recorded, so they are read as “not
 * recorded” rather than as an empty repair. Both id lists hold at most 32 ids. */
export interface WorkflowRepairRecord {
	reason: string;
	fromStep: string;
	at: string;
	expiredEffects?: readonly string[];
	retiredRuns?: readonly string[];
	/** How many repairs this workflow has recorded, this one included. */
	count?: number;
}

/** What a workflow is waiting for a human to do. Three states block a workflow
 * in front of the developer, and each one already exists in the store: a pending
 * developer question, a run handed over `blocked`, and a step whose actor is the
 * developer (an approval or a review gate). The wait kind names which one, the
 * subject is the id a reader resolves it by (the question, the run, the step),
 * and `since` is when the wait began, absent when the state does not record it
 * (a legacy snapshot with no `stepEnteredAt`). */
export type WorkflowWaitKind = "question" | "handoff" | "approval";
export interface WorkflowWait {
	kind: WorkflowWaitKind;
	subject: string;
	since?: string;
}

/** Whether two waits are the same obligation. A wait whose `since` moved is the
 * same wait: the workflow never stopped waiting for the developer, so a repair
 * that re-enters the same gate does not restart the wait. Both the engine (the
 * pair it records per commit) and the event bus (two successive observations of
 * a view) compare waits with it, so one definition decides what a transition is. */
export function sameWorkflowWait(
	left: WorkflowWait | undefined,
	right: WorkflowWait | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.kind === right.kind && left.subject === right.subject;
}

/** Whole seconds from `since` to `at`, or absent when `since` is unknown or
 * unreadable. Never negative: a clock that moved backwards reports zero. */
export function waitSeconds(
	since: string | undefined,
	at: string,
): number | undefined {
	if (since === undefined) return undefined;
	const start = Date.parse(since);
	const end = Date.parse(at);
	if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
	return Math.max(0, Math.round((end - start) / 1000));
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
	sessionId?: string;
	/** The workflow host's control-socket path and the conversation this run
	 * maps to (durable-agent-host). */
	hostSocket?: string;
	conversationId?: string;
	/** Opaque registration lease used only to avoid a late stop removing a
	 * newer retry target for a relaunched run. It is not a host capability. */
	retryTargetLease?: string;
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
				/** The delegated debug request this run is investigating, on the run a
				 * caller workflow started for it (add-debug-subagent-requests). */
				HERDR_DEBUG_REQUEST_ID?: string;
				/** The owner-scoped agent environment capability the `env_*`, `browser_*`
				 * and debug tools call the server with
				 * (`agent-host/environment-capability.ts`). Absent when the launching
				 * process could not reach any server, which the rendered assignment states
				 * outright. */
				AGENTIC_ENV_URL?: string;
				AGENTIC_ENV_TOKEN?: string;
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
	/** Where the pinned definition came from (custom-workflow-presentation);
	 * absent when the definition could not be resolved. */
	definitionOrigin?: WorkflowDefinitionOrigin;
	/** The rationale pinned with a blueprint start, when the workflow was
	 * started from one. */
	blueprintRationale?: string;
	/** The pinned definition's compiled graph, in walk order. */
	definitionGraph?: WorkflowDefinitionGraph;
	status: WorkflowStatus;
	repository: string;
	worktree: string;
	branch: string;
	baseCommit: string;
	task?: string;
	ticket?: string;
	stage?: string;
	stageSystem?: string;
	stageAccess?: "read-only" | "writable";
	stageTestPlan?: JsonValue;
	stageTestReport?: JsonValue;
	stageTestReportMarkdown?: string;
	stagePlanBlocks?: Array<{
		routeStepId: string;
		id: string;
		/** The version the plan resolved for this block, so the report's executed
		 * version is checked against the document the developer approved. */
		version?: string;
		title?: string;
		app?: string;
		effects?: string[];
		roles?: string[];
	}>;
	createdAt: string;
	updatedAt: string;
	/** The selected agent preset, or absent when using configuration defaults. */
	selectedPreset?: string;
	/** Who started this workflow; always set by the projection, defaulting to
	 * `developer` for a snapshot that predates the attribution. */
	startedBy?: StartedBy;
	/** The gate policies pinned at start; absent when none were pinned. */
	gatePolicies?: Record<string, string>;
	currentStep: {
		id: string;
		label: string;
		attempt: number;
		enteredAt: string;
		/** The step's carried context: the validation report at an env-setup
		 * approval, the smoke report at a smoke review. Read-side only. */
		context?: JsonValue;
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
		outputPath?: string;
		outputDigest?: string;
		/** Durable handle fields, surfaced so the dashboard Agents panel can open
		 * the agent session view. */
		hostSocket?: string;
		conversationId?: string;
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
	/** Classifier decisions in creation order. */
	classifierDecisions?: ClassifierDecisionRecord[];
	/** Stage-gate decisions in creation order. */
	gateDecisions?: GateDecisionRecord[];
	/** The last operator repair: why, from where, and what it retired. Read next
	 * to the run list, where a blocked handoff is read. */
	repaired?: WorkflowRepairRecord;
	/** The developer wait the workflow is in right now, when it is in one. A
	 * projection of the state that already blocks the workflow — a pending
	 * developer question, a blocked run, a developer step — never stored state, so
	 * it can never dangle (record-repairs-and-developer-waits, item 12). */
	waiting?: WorkflowWait;
	/** Pending subset routed to the developer, ordered oldest first. */
	pendingQuestions?: DeveloperDialogueRecord[];
	/** Pending subset routed to the orchestrator first (orchestrator-started
	 * workflows). The orchestrator either answers these or forwards them to the
	 * developer, at which point they move into `pendingQuestions`. */
	orchestratorQuestions?: DeveloperDialogueRecord[];
	availableActions: WorkflowActionView[];
}

export type WorkflowCommand =
	| {
			type: "developer.action";
			workflowId: string;
			revision: number;
			actionId: string;
			input?: unknown;
			/** The principal the action arrived from; a server-decided option, never
			 * a wire field. Absent reads as the operator. */
			principal?: WorkflowPrincipal;
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
			type: "login-handoff.open";
			workflowId: string;
			recordId: string;
			description: string;
			context?: string;
			expiresAt: string;
			/** Whether the record offers *Done*. A hand-off the page can finish offers it;
			 * a completion-driven login (a code grant, whose ending is the server's own
			 * receiver) offers *Abort* alone, because no *Done* could verify it. */
			canConfirm?: boolean;
			/** The run whose session is held, for the record's provenance only: the
			 * hand-off is never routed to it and never resumes it. */
			runId?: string;
			stepId?: string;
			role?: string;
	  }
	| {
			type: "login-handoff.resolve";
			workflowId: string;
			recordId: string;
			/** `done` lets the hand-off verify the login; `abort` ends it. Result way
			 * the resolution is recorded by the server, not by a run. */
			answer: "done" | "abort";
	  }
	| {
			type: "agent.handoff";
			runId: string;
			generation: number;
			token: string;
			outcome: "complete" | "blocked" | "failed";
			artifact?: string;
			message?: string;
			/** Records the handoff as a developer abort of a run that is still
			 * alive: the parked run keeps its capability so the developer's next
			 * message can reopen it through `agent.resume`, instead of the
			 * `agent.handoff` a run makes itself (which clears it). */
			aborted?: boolean;
	  }
	| {
			type: "agent.resume";
			workflowId: string;
			runId: string;
			stepId: string;
			role: string;
			token: string;
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
	| { type: "operator.resume"; workflowId: string; revision: number };

// ---------------------------------------------------------------------------
// Developer-question and workflow-command schemas
// ---------------------------------------------------------------------------
export const DeveloperQuestionOptionSchema: Schema.Codec<DeveloperQuestionOption> =
	Schema.Struct({
		title: Schema.optionalKey(text(256)),
		label: Schema.optionalKey(text(256)),
		value: Schema.optionalKey(text(1024)),
		recommended: Schema.optionalKey(Schema.Boolean),
		description: Schema.optionalKey(boundedText(4096)),
	});

/** Structural option-list validation shared by command input and persisted
 * records. Kept permissive so a snapshot written by an earlier schema of this
 * feature (for example with two recommendations) still decodes; the
 * recommendation invariant is a command-input rule only. */
export const questionOptions = Schema.Array(DeveloperQuestionOptionSchema).pipe(
	Schema.check(
		Schema.makeFilter(
			(options) => {
				const resolved = options.map(resolveDeveloperQuestionOption);
				return (
					options.length <= 16 &&
					resolved.every(
						(option) =>
							option.label.trim().length > 0 && option.value.trim().length > 0,
					) &&
					new Set(resolved.map((option) => option.value)).size ===
						resolved.length
				);
			},
			{
				message:
					"expected at most 16 options with a non-empty title and unique values",
			},
		),
	),
);

/** Command-input option list: the shared structural rules plus the authoring
 * invariant that at most one option is marked recommended. Never used to decode
 * persisted dialogue, so tightening it cannot strand older state. */
export const commandQuestionOptions = questionOptions.pipe(
	Schema.check(
		Schema.makeFilter(
			(options) =>
				options.filter(
					(option) =>
						resolveDeveloperQuestionOption(option).recommended === true,
				).length <= 1,
			{ message: "expected at most one recommended option" },
		),
	),
);

export const DeveloperQuestionItemSchema = Schema.Struct({
	ident: Schema.optionalKey(text(256)),
	question: Schema.optionalKey(text(4096)),
	description: Schema.optionalKey(text(4096)),
	context: Schema.optionalKey(boundedText(4096)),
	options: commandQuestionOptions.pipe(
		Schema.withDecodingDefaultKey(Effect.sync(() => [])),
	),
}).pipe(
	Schema.check(
		Schema.makeFilter(
			(item) => item.question !== undefined || item.description !== undefined,
			{ message: "each question requires question or description" },
		),
	),
);

const MAX_QUESTIONNAIRE_ITEMS = 8;

export const DeveloperQuestionAnswerSchema = Schema.Union([
	Schema.Struct({
		questionId: text(4096),
		kind: Schema.Literals(["option", "custom", "cancel"]),
		value: Schema.optionalKey(text(8192)),
	}).pipe(
		Schema.check(
			Schema.makeFilter(
				(answer) => answer.kind === "cancel" || answer.value !== undefined,
				{
					message: "option and custom answers require a value; cancel does not",
				},
			),
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
				kind: Schema.Literals(["option", "custom"]),
				value: text(8192),
			}),
		).pipe(
			Schema.check(
				Schema.makeFilter(
					(responses) =>
						responses.length >= 1 &&
						responses.length <= MAX_QUESTIONNAIRE_ITEMS &&
						new Set(responses.map((item) => item.questionId)).size ===
							responses.length,
					{
						message: `expected 1-${MAX_QUESTIONNAIRE_ITEMS} unique responses`,
					},
				),
			),
		),
	}),
]);

// ---------------------------------------------------------------------------
// Workflow command (discriminated union on `type`)
// ---------------------------------------------------------------------------

const developerActionSchema = Schema.Struct({
	type: Schema.Literal("developer.action"),
	workflowId: text(4096),
	revision: integer(),
	actionId: text(4096),
	input: Schema.optionalKey(Schema.Unknown),
	/** The acting principal, handed over by the server from the authenticated
	 * capability; the wire request cannot carry it. */
	principal: Schema.optionalKey(Schema.Literals(["operator", "orchestrator"])),
});
const agentQuestionSchema = Schema.Struct({
	type: Schema.Literal("agent.question"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	description: Schema.optionalKey(text(4096)),
	context: Schema.optionalKey(boundedText(4096)),
	options: Schema.optionalKey(commandQuestionOptions),
	questions: Schema.optionalKey(
		Schema.Array(DeveloperQuestionItemSchema).pipe(
			Schema.check(
				Schema.makeFilter(
					(items) =>
						items.length >= 1 && items.length <= MAX_QUESTIONNAIRE_ITEMS,
					{
						message: `expected 1-${MAX_QUESTIONNAIRE_ITEMS} question items`,
					},
				),
			),
		),
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
	context: Schema.optionalKey(boundedText(4096)),
	options: Schema.optionalKey(commandQuestionOptions),
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
const loginHandoffOpenSchema = Schema.Struct({
	type: Schema.Literal("login-handoff.open"),
	workflowId: text(4096),
	recordId: text(4096),
	description: text(8192),
	context: Schema.optional(text(16384)),
	expiresAt: text(64),
	canConfirm: Schema.optional(Schema.Boolean),
	runId: Schema.optional(text(4096)),
	stepId: Schema.optional(text(4096)),
	role: Schema.optional(text(4096)),
});
const loginHandoffResolveSchema = Schema.Struct({
	type: Schema.Literal("login-handoff.resolve"),
	workflowId: text(4096),
	recordId: text(4096),
	answer: Schema.Literals(["done", "abort"]),
});

const agentHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.handoff"),
	runId: text(4096),
	generation: integer(1),
	token: text(1024),
	outcome: Schema.Literals(["complete", "blocked", "failed"]),
	artifact: Schema.optionalKey(text(4096)),
	message: Schema.optionalKey(text(4096)),
	aborted: Schema.optionalKey(Schema.Boolean),
});
const agentResumeSchema = Schema.Struct({
	type: Schema.Literal("agent.resume"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
});
const agentResearchHandoffSchema = Schema.Struct({
	type: Schema.Literal("agent.research-handoff"),
	workflowId: text(4096),
	runId: text(4096),
	stepId: text(4096),
	role: text(4096),
	token: text(1024),
	handoff: Schema.optionalKey(Schema.Unknown),
});
const effectResultSchema = Schema.Struct({
	type: Schema.Literal("effect.result"),
	effectId: text(4096),
	lease: text(4096),
	outcome: Schema.Literals(["complete", "retry", "failed"]),
	data: Schema.optionalKey(Schema.Unknown),
	/** Measured handler wall clock, reported on the exported telemetry event.
	 * Optional so existing callers keep decoding unchanged. */
	durationMs: Schema.optional(integer()),
});
const operatorRepairSchema = Schema.Struct({
	type: Schema.Literal("operator.repair"),
	workflowId: text(4096),
	revision: integer(),
	targetStep: text(4096),
	reason: boundedText(2048).pipe(
		Schema.withDecodingDefaultKey(Effect.sync(() => "")),
	),
});
const operatorRepinSchema = Schema.Struct({
	type: Schema.Literal("operator.repin"),
	workflowId: text(4096),
	revision: integer(),
});
const operatorResumeSchema = Schema.Struct({
	type: Schema.Literal("operator.resume"),
	workflowId: text(4096),
	revision: integer(),
});

export const WorkflowCommandSchema = Schema.Union([
	developerActionSchema,
	agentQuestionSchema,
	agentQuestionExpireSchema,
	agentAskSchema,
	agentAnswerSchema,
	timerQuestionExpireSchema,
	loginHandoffOpenSchema,
	loginHandoffResolveSchema,
	agentHandoffSchema,
	agentResumeSchema,
	agentResearchHandoffSchema,
	effectResultSchema,
	operatorRepairSchema,
	operatorRepinSchema,
	operatorResumeSchema,
]);

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
	// The forward-question action (orchestrator-only) names exactly one of a
	// single question or a questionnaire group to hand back to the developer.
	if (
		command.type === "developer.action" &&
		command.actionId === "forward-question"
	)
		return { ...command, input: decodeForwardQuestionInput(command.input) };
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

/** The forward-question action input: exactly one of a single question id or a
 * questionnaire group id. Pure validation, matching the answer decode style. */
export type ForwardQuestionInput = { questionId: string } | { groupId: string };
export function decodeForwardQuestionInput(
	value: unknown,
): ForwardQuestionInput {
	const input = value as
		| { questionId?: unknown; groupId?: unknown }
		| null
		| undefined;
	const questionId =
		typeof input?.questionId === "string" ? input.questionId : "";
	const groupId = typeof input?.groupId === "string" ? input.groupId : "";
	if (!questionId === !groupId)
		throw new ContractFailure("core.developer-question", [
			{
				path: "$.input",
				message:
					"forward-question requires exactly one of questionId or groupId",
			},
		]);
	return questionId ? { questionId } : { groupId };
}

// ---------------------------------------------------------------------------
// Dashboard wire records: the workflow state the dashboard reads, its review
// and cost projections, and the finding records a review carries.
// ---------------------------------------------------------------------------

/** Where the pinned definition came from (custom-workflow-presentation):
 * `built-in` is a definition from the code registry, `custom` is a `custom.`
 * definition stored in the target store under the origin kind its row recorded
 * (`blueprint` for a graph the Home Orchestrator shaped, `operator` for
 * `workflow define`). */
export type WorkflowDefinitionOrigin =
	| { readonly kind: "built-in" }
	| { readonly kind: "custom"; readonly origin: string };

/** One step of a pinned definition's compiled graph, in walk order. */
export interface WorkflowDefinitionStep {
	readonly id: string;
	readonly label: string;
	readonly actor: ActorKind;
	/** True for machinery the engine inserts around the logical graph — a
	 * per-step routing step, the triage-routing step, or a stage gate — so the
	 * dashboard can dim it and let the developer read the logical graph first. */
	readonly inserted: boolean;
}

/** One outcome edge of a pinned definition's compiled graph, in declared
 * order. `loop` carries the bound of a re-entering transition. */
export interface WorkflowDefinitionEdge {
	readonly from: string;
	readonly outcome: string;
	readonly to: string;
	readonly loop?: { readonly maxAttempts: number };
}

/** The pinned definition's compiled graph (custom-workflow-presentation): the
 * steps in walk order from the initial step, and every outcome edge the
 * definition declares. Projected by the read model, never by the dashboard. */
export interface WorkflowDefinitionGraph {
	readonly steps: readonly WorkflowDefinitionStep[];
	readonly edges: readonly WorkflowDefinitionEdge[];
}

export interface WorkflowState {
	/** User-supplied workflow identifier; dashboards address workflows by it. */
	workflowId: string;
	/** Planner-recorded primary change id; empty until the plan step. */
	changeId: string;
	phase: string;
	stepId?: string;
	stepLabel?: string;
	/** The current step's carried context (`WorkflowView.currentStep.context`):
	 * the env-setup validation report at an approval, the smoke report at a smoke
	 * review, so the decision prompt can state what was run. */
	stepContext?: unknown;
	revision: number;
	definition?: { id: string; version: number; digest: string; label: string };
	status: string;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	availableActions?: Array<{ id: string; label: string; confirmation: string }>;
	repository: string;
	worktree: string;
	branch: string;
	/** The pinned definition's origin; absent only on a workflow whose definition
	 * could not be resolved (a pin mismatch or an unavailable-store view). */
	definitionOrigin?: WorkflowDefinitionOrigin;
	/** The blueprint rationale pinned at start, when the workflow was started
	 * from a blueprint; absent for built-in and operator-defined starts. */
	blueprintRationale?: string;
	/** The pinned definition's compiled graph; absent when the definition could
	 * not be resolved. */
	definitionGraph?: WorkflowDefinitionGraph;
	task?: string;
	ticket?: string;
	stage?: string;
	stageSystem?: string;
	stageAccess?: "read-only" | "writable";
	stageTestPlan?: JsonValue;
	stageTestReport?: JsonValue;
	stageTestReportMarkdown?: string;
	stagePlanBlocks?: Array<{
		routeStepId: string;
		id: string;
		/** The version the plan resolved for this block, so the report's executed
		 * version is checked against the document the developer approved. */
		version?: string;
		title?: string;
		app?: string;
		effects?: string[];
		roles?: string[];
	}>;
	verificationRound: number;
	baseCommit?: string;
	createdAt?: string;
	phaseStartedAt?: string;
	selectedPreset?: string;
	prCreated?: boolean;
	prUrl?: string | null;
	ticketNumber?: string;
	workerModel?: string;
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
		/** Durable session identity: present so the dashboard Agents panel can
		 * open the run's session view. */
		hostSocket?: string;
		conversationId?: string;
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
	classifierDecisions?: ClassifierDecisionRecord[];
	gateDecisions?: GateDecisionRecord[];
	pendingQuestions?: DeveloperDialogueRecord[];
	planQuality?: {
		passed: boolean;
		issues: string[];
		specFiles: number;
		taskCount: number;
	};
}

/** The active verification round as the sidebar reads it: the findings the
 * verifiers have committed so far, and how many of the round's runs completed.
 * Absent unless the workflow is currently at the verification step. */
export interface VerificationOverview {
	findings: FindingCounts;
	/** Verifier runs in the round that finished, whether clean or with findings. */
	completedVerifiers: number;
	/** Every verifier run selected for the round. */
	totalVerifiers: number;
	/** Verifier runs still pending or working; the collapsed strip's one-char
	 * verification signal. */
	runningVerifiers: number;
	/** True when a verifier run failed, blocked, or expired rather than still
	 * running, so the row can flag the round without calling a pending run a
	 * failure. */
	failed: boolean;
}

export interface WorkflowOverview {
	state: WorkflowState;
	/** The workflow target that owns this workflow's store: a canonical
	 * repository path, the wiki target, or the research target. It is the key
	 * every store-scoped operation addresses the workflow with, and it is not
	 * `state.repository`: a repository-independent workflow (wiki, research)
	 * keeps the repository it was started from — or none at all — in
	 * `state.repository`, while its rows live in the shared target store. */
	target: string;
	/** Who started this workflow; always set by the projection, defaulting to
	 * `developer` for a snapshot that predates the attribution. */
	startedBy?: StartedBy;
	tasks: [number, number];
	/** Stable configured project ident resolved from the catalog, when the
	 * workflow's repository is a configured project (environment cross-link). */
	projectIdent?: string;
	/** Current verification round, present only while the workflow verifies. */
	verification?: VerificationOverview;
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
	/** `critical` reaches the review only from the verify-only family's findings
	 * review, which selects fixes from a round the verifiers already failed; the
	 * developer review of a passing change shows advisory findings only. */
	severity: "critical" | "warning" | "info";
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
		/** `pi-durable` session identity (add-pi-durable-runtime): present only
		 * for a durable agent, so the Agents panel can open its session view. */
		runId?: string;
		hostSocket?: string;
		conversationId?: string;
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
	Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));
const nonNegativeInt = Schema.Number.pipe(
	Schema.check(
		Schema.makeFilter((n) => Number.isInteger(n) && n >= 0, {
			message: "expected integer >= 0",
		}),
	),
);

const definitionPinResponseSchema = Schema.Struct({
	id: boundedString(4096),
	version: nonNegativeInt,
	digest: boundedString(4096),
	label: boundedString(4096),
});

const workflowDefinitionOriginResponseSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("built-in") }),
	Schema.Struct({
		kind: Schema.Literal("custom"),
		origin: boundedString(64),
	}),
]);

const workflowDefinitionGraphResponseSchema = Schema.Struct({
	steps: Schema.Array(
		Schema.Struct({
			id: boundedString(256),
			label: boundedString(256),
			actor: Schema.Literals(["agent", "developer", "system"]),
			inserted: Schema.Boolean,
		}),
	).pipe(
		Schema.check(
			Schema.makeFilter((steps) => steps.length <= 64, {
				message: "expected at most 64 definition graph steps",
			}),
		),
	),
	edges: Schema.Array(
		Schema.Struct({
			from: boundedString(256),
			outcome: boundedString(256),
			to: boundedString(256),
			loop: Schema.optional(Schema.Struct({ maxAttempts: nonNegativeInt })),
		}),
	).pipe(
		Schema.check(
			Schema.makeFilter((edges) => edges.length <= 256, {
				message: "expected at most 256 definition graph edges",
			}),
		),
	),
});

/** Decode the optional graph carried by the dashboard observation, whose
 * aggregate response is intentionally Schema.Unknown. Invalid or oversized
 * presentation data is omitted instead of reaching the TUI row renderer. */
export function decodeWorkflowDefinitionGraph(
	value: unknown,
): WorkflowDefinitionGraph | undefined {
	try {
		return decodeContract<WorkflowDefinitionGraph>(
			"workflow.definition-graph",
			workflowDefinitionGraphResponseSchema,
			value,
		);
	} catch {
		return undefined;
	}
}

const workflowRunResponseSchema = Schema.Struct({
	id: boundedString(4096),
	stepId: boundedString(4096),
	role: boundedString(4096),
	attempt: nonNegativeInt,
	status: Schema.String,
	runtime: Schema.String,
	profile: Schema.String,
	model: Schema.optional(Schema.String),
	outputPath: Schema.optional(Schema.String),
	outputDigest: Schema.optional(Schema.String),
});

const classifierDecisionRecordResponseSchema = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	integration: Schema.String,
	phase: Schema.optional(Schema.String),
	questionId: Schema.String,
	model: Schema.String,
	input: Schema.String,
	inputTruncated: Schema.Boolean,
	options: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			profile: Schema.String,
			criteria: Schema.optional(Schema.Unknown),
		}),
	),
	answer: Schema.Struct({
		type: Schema.Literals(["choice", "noul"]),
		choice: Schema.optional(Schema.String),
		noul: Schema.optional(Schema.Number),
		confidence: Schema.optional(Schema.Number),
		probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
	}),
	result: Schema.Struct({
		applied: Schema.Boolean,
		profiles: Schema.Array(Schema.String),
		attention: Schema.optional(Schema.String),
	}),
});

const gateDecisionRecordResponseSchema = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	stepId: Schema.String,
	stage: Schema.String,
	policy: Schema.String,
	decision: Schema.Literals(["run", "skip"]),
	forced: Schema.Boolean,
	noul: Schema.optional(Schema.Number),
	reason: Schema.optional(Schema.String),
});

const repairRecordResponseSchema = Schema.Struct({
	reason: boundedString(4096),
	fromStep: Schema.String,
	at: Schema.String,
	expiredEffects: Schema.optional(Schema.Array(Schema.String)),
	retiredRuns: Schema.optional(Schema.Array(Schema.String)),
	count: Schema.optional(nonNegativeInt),
});

const waitResponseSchema = Schema.Struct({
	kind: Schema.Literals(["question", "handoff", "approval"]),
	subject: Schema.String,
	since: Schema.optional(Schema.String),
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
	kind: Schema.optional(Schema.String),
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
	definitionOrigin: Schema.optional(workflowDefinitionOriginResponseSchema),
	blueprintRationale: Schema.optional(boundedString(4096)),
	definitionGraph: Schema.optional(workflowDefinitionGraphResponseSchema),
	status: Schema.String,
	repository: Schema.String,
	worktree: Schema.String,
	branch: Schema.String,
	baseCommit: Schema.String,
	task: Schema.optional(Schema.String),
	ticket: Schema.optional(Schema.String),
	stage: Schema.optional(Schema.String),
	stageSystem: Schema.optional(Schema.String),
	stageAccess: Schema.optional(Schema.Literals(["read-only", "writable"])),
	stageTestPlan: Schema.optional(Schema.Unknown),
	stageTestReport: Schema.optional(Schema.Unknown),
	stageTestReportMarkdown: Schema.optional(boundedString(2 * 1024 * 1024)),
	stagePlanBlocks: Schema.optional(
		Schema.Array(
			Schema.Struct({
				routeStepId: Schema.String,
				id: Schema.String,
				version: Schema.optional(Schema.String),
				title: Schema.optional(Schema.String),
				app: Schema.optional(Schema.String),
				effects: Schema.optional(Schema.Array(Schema.String)),
				roles: Schema.optional(Schema.Array(Schema.String)),
			}),
		),
	),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	selectedPreset: Schema.optional(Schema.String),
	startedBy: Schema.optional(Schema.Literals(["developer", "orchestrator"])),
	gatePolicies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	currentStep: Schema.Struct({
		id: Schema.String,
		label: Schema.String,
		attempt: nonNegativeInt,
		enteredAt: Schema.String,
		context: Schema.optional(Schema.Unknown),
	}),
	runs: Schema.Array(workflowRunResponseSchema),
	routing: Schema.optionalKey(Schema.Unknown),
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
	classifierDecisions: Schema.optional(
		Schema.Array(classifierDecisionRecordResponseSchema),
	),
	gateDecisions: Schema.optional(
		Schema.Array(gateDecisionRecordResponseSchema),
	),
	repaired: Schema.optional(repairRecordResponseSchema),
	waiting: Schema.optional(waitResponseSchema),
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
	Schema.check(Schema.isMaxLength(4096)),
);

/** Saved review comments are not echoed back; the server returns a count. */
export const savedReviewResponseSchema = Schema.Unknown;

// ---------------------------------------------------------------------------
// Blueprint contracts (add-orchestrator-blueprint-workflows): the step catalog
// the orchestrator reads, and the validate route's compiled summary or
// diagnostics. Pure wire shapes; the server maps the compiler's own types onto
// them so no workflow module crosses into this layer.
// ---------------------------------------------------------------------------

/** One logical blueprint step as the catalog serves it. */
const blueprintStepSchema = Schema.Struct({
	id: text(256),
	label: text(256),
	actor: Schema.Literals(["agent", "developer", "system"]),
	outcomes: Schema.Array(text(256)),
	description: boundedText(4096),
});
export type BlueprintStepCatalogEntry = typeof blueprintStepSchema.Type;

/** The step catalog read (`GET /api/v1/workflow/steps`). */
export const blueprintStepCatalogSchema = Schema.Array(blueprintStepSchema);
export type BlueprintStepCatalog = typeof blueprintStepCatalogSchema.Type;

/** One compiler diagnostic: the rule that rejected a blueprint and the step or
 * edge involved. */
export const blueprintDiagnosticSchema = Schema.Struct({
	rule: boundedText(256),
	message: boundedText(4096),
	path: Schema.optional(Schema.Array(boundedText(256))),
});
export type BlueprintDiagnostic = typeof blueprintDiagnosticSchema.Type;

/** The compiled summary of a blueprint that validates. */
export const blueprintSummarySchema = Schema.Struct({
	label: boundedText(256),
	rationale: boundedText(4096),
	steps: Schema.Array(boundedText(256)),
	initial: boundedText(256),
	terminal: Schema.Array(boundedText(256)),
	stepCount: integer(),
	edgeCount: integer(),
	verificationRounds: integer(1),
});
export type BlueprintSummary = typeof blueprintSummarySchema.Type;

/** The validate route's answer: the compiled digest and summary, or the
 * diagnostics. `diagnostics` is always present (empty on success) so a caller
 * never has to branch on the field's existence. */
export const blueprintValidationSchema = Schema.Struct({
	ok: Schema.Boolean,
	digest: Schema.optional(boundedText(4096)),
	definitionId: Schema.optional(boundedText(256)),
	summary: Schema.optional(blueprintSummarySchema),
	diagnostics: Schema.Array(blueprintDiagnosticSchema),
});
export type BlueprintValidation = typeof blueprintValidationSchema.Type;
