import type {
	EffectKind,
	JsonValue,
	WorkflowActionView,
	WorkflowRun,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import type { WorkflowEdge, WorkflowFamilyTraits } from "../registry.ts";

// Every behavior hook receives the pinned definition's effective family traits
// (read-family-traits-instead-of-ids): the runtime resolves the compiled
// definition once per command and passes `effectiveFamilyTraits(definition)
// here, so a composed workflow with a new id behaves by what it declares
// instead of falling through an id comparison. `undefined` is the documentation
// families (`wiki`, `wiki-comments`, `research`), which declare none.
export interface StepRolesContext {
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
}

export interface CandidateRolesContext {
	definitionId: string;
	fusionPlannerCount: number;
	traits?: WorkflowFamilyTraits;
}

export interface ValidateEvidenceContext {
	snapshot: WorkflowSnapshot;
	evidence?: unknown;
	traits?: WorkflowFamilyTraits;
}

export interface CompletionEffect {
	kind: EffectKind;
	idempotencyKey: string;
	payload: JsonValue;
}

/** One engine telemetry event a committed command records. The event is
 * observation only — it never feeds a transition — and the shared envelope's
 * bound keeps only scalar values, so a payload can carry counts, ids, and
 * digests but never a file body, a diff, or a prompt. */
export interface CompletionTelemetry {
	event: string;
	payload: Record<string, unknown>;
}

export interface CompletionResult {
	step?: {
		selectedRoles?: readonly string[];
		testRunStarted?: boolean;
		appendResults?: readonly WorkflowSnapshot["step"]["results"][number][];
	};
	metadata?: {
		changeId?: string;
		stageTestPlan?: JsonValue;
		stageTestReport?: JsonValue;
		stageTestReportMarkdown?: string;
	};
	transition?: { outcome: string; output?: unknown };
	deferTransition?: boolean;
	runs?: readonly { role: string }[];
	effects?: readonly CompletionEffect[];
	/** The re-verification scope record this completion writes, merged into the
	 * snapshot field by field: the runtime stamps the baseline and the delta, so
	 * a step that records plan ownership or the round's decision must never
	 * replace them. */
	verificationScope?: WorkflowSnapshot["verificationScope"];
	/** Attention entries this completion records, appended to the workflow's
	 * existing (redacted, bounded) list. */
	attention?: readonly string[];
	/** The decisions this completion recorded, emitted by the runtime as engine
	 * telemetry events after the command commits — one event per entry. */
	telemetry?: readonly CompletionTelemetry[];
}

export interface AgentCompletionContext {
	snapshot: WorkflowSnapshot;
	definitionId: string;
	traits?: WorkflowFamilyTraits;
	/** Whether the pinned definition carries `stepId`: the graph's shape, the
	 * same way `traits` is its declared behaviour. */
	hasStep: (stepId: string) => boolean;
	run: Pick<WorkflowRun, "id" | "role" | "stepId">;
	outcome: string;
	output?: unknown;
	outputDigest?: string;
	changedFiles?: readonly string[];
	remainingActiveRunIds: readonly string[];
	loopMaxAttempts?: number;
	evidence: readonly WorkflowSnapshot["evidence"][number][];
	/** Stage-test handoff facts (`stage-test-workflow`): the workflow's stage
	 * journal and the pinned stage's declared application names, so the execute
	 * step's own validator can refuse a dangling citation or a missing version
	 * before the engine renders the report. Absent for every other family. */
	stageJournal?: readonly {
		seq: number;
		knowledge?: { concept: string; kind: string };
	}[];
	stageApps?: readonly string[];
	/** Every evidence id already attached to this workflow, so the execute
	 * validator can refuse a citation of evidence that does not exist before the
	 * render effect sees it. */
	stageEvidenceIds?: readonly string[];
}

export interface EffectCompletionContext {
	snapshot: WorkflowSnapshot;
	/** The pinned definition's id: the routing step reads its eligible verifier
	 * catalog from the definition's family traits. */
	definitionId: string;
	traits?: WorkflowFamilyTraits;
	effect: {
		kind: EffectKind;
		payload: JsonValue;
		data?: unknown;
	};
}

export interface StepArrivalPrior {
	attempt: number;
	results: WorkflowSnapshot["step"]["results"];
	context: JsonValue | undefined;
}

export interface ArriveContext {
	/** The edge's destination step is already current and `step` already
	 * reset to a fresh attempt; `prior` carries what preceded that reset. */
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
	edge: WorkflowEdge;
	outcome: string;
	output: unknown;
	prior: StepArrivalPrior;
}

export interface ArriveResult {
	attempt?: number;
	mode?: WorkflowSnapshot["step"]["mode"];
	results?: WorkflowSnapshot["step"]["results"];
	selectedRoles?: string[];
	/** Only the two lifecycle steps that leave "active" ever set this. */
	status?: "completed" | "closed";
}

export interface EnterContext {
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
	enqueue: (
		kind: EffectKind,
		idempotencyKey: string,
		payload: JsonValue,
	) => void;
	/** True when `role` already holds a validated result or an active
	 * (pending/working) run for the current step attempt. */
	hasLiveRun: (role: string) => boolean;
}

export interface EnterResult {
	/** Roles the engine should not launch a run for this time through. */
	skipRoles?: readonly string[];
}

export interface DeveloperActionsContext {
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
}

export interface AssignmentInputsContext {
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
	run: Pick<WorkflowRun, "stepId" | "role"> & {
		profile: Pick<WorkflowRun["profile"], "readOnly">;
	};
}

export interface AssignmentInputsResult {
	taskLine?: string;
	introLines?: readonly string[];
	objective?: string;
	interaction?: "developer-dialogue" | "silent";
	permissions?: readonly string[];
	checks?: readonly string[];
	suppressStepInputLine?: boolean;
}

export interface InstructionAssetForRoleContext {
	role: string;
	traits?: WorkflowFamilyTraits;
}

export interface StepBehavior {
	/** Classifier mode this step participates in; absent when the step is not
	 * classifiable. Step-owned so the runner/reducer never keep a step table. */
	classification?: "single" | "roster";
	roles?(ctx: StepRolesContext): string[];
	candidateRoles?(ctx: CandidateRolesContext): string[];
	/** Entry-guard predicate run before a step's `complete` outcome is
	 * accepted; throws `WorkflowRuntimeError("entry-guard", ...)` to reject. */
	validateEvidence?(ctx: ValidateEvidenceContext): void;
	onAgentComplete?(ctx: AgentCompletionContext): CompletionResult | undefined;
	onEffectComplete?(ctx: EffectCompletionContext): CompletionResult | undefined;
	/** Derives step-local state (attempt seeding, mode, preserved results,
	 * selected roles, terminal status) for arrival at this step. Context
	 * carry-over itself is resolved centrally — see `resolveStepContext`. */
	onArrive?(ctx: ArriveContext): ArriveResult | undefined;
	/** Declares entry effects and which candidate roles to skip launching. */
	onEnter?(ctx: EnterContext): EnterResult | undefined;
	/** Dashboard actions offered to the developer while this step is current. */
	developerActions?(ctx: DeveloperActionsContext): WorkflowActionView[];
	/** Step-specific overrides for the rendered agent assignment. */
	assignmentInputs?(ctx: AssignmentInputsContext): AssignmentInputsResult;
	/** Which pinned instruction asset (if any) a role-specific variant should
	 * read, out of several pinned under this step. */
	instructionAssetForRole?(
		ctx: InstructionAssetForRoleContext,
	): string | undefined;
	/** Replaces the rendered assignment's generic "finish the run" handoff
	 * guidance with step-specific instructions (see `assignment.ts`). */
	handoffNote?: readonly string[];
	/** Context carry-over rules this step opts into — see design D3's ordered
	 * resolver in `resolveStepContext`. */
	carriesOutputContext?: boolean;
	acceptsCommentsContext?: boolean;
	producesWikiVerificationContext?: boolean;
	/** Whether runs at this step are grouped/named per verification round
	 * (see `effect-runner.ts`'s canonical/legacy agent naming). */
	roundScoped?: boolean;
	/** Resolves a round-scoped step's layout group to the launching run's role
	 * instead of a constant `paneGroup`, giving each role its own tab while
	 * `roundScoped` still governs agent naming. */
	groupByRole?: boolean;
	/** Tab/pane group a round-scoped step splits into. Runs at round-scoped
	 * steps share a tab only when their groups match, so triage keeps its own
	 * tab instead of anchoring verifier geometry. Ignored when `groupByRole`
	 * is set. Defaults to `verification`. */
	paneGroup?: string;
}
