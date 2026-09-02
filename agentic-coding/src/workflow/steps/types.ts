import type {
	EffectKind,
	JsonValue,
	WorkflowActionView,
	WorkflowRun,
	WorkflowSnapshot,
} from "../contracts.ts";
import type { WorkflowEdge } from "../registry.ts";

export interface StepRolesContext {
	snapshot: WorkflowSnapshot;
}

export interface CandidateRolesContext {
	definitionId: string;
	fusionPlannerCount: number;
}

export interface ValidateEvidenceContext {
	snapshot: WorkflowSnapshot;
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
}

export interface AssignmentInputsContext {
	snapshot: WorkflowSnapshot;
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
}

export interface StepBehavior {
	roles?(ctx: StepRolesContext): string[];
	candidateRoles?(ctx: CandidateRolesContext): string[];
	/** Entry-guard predicate run before a step's `complete` outcome is
	 * accepted; throws `WorkflowRuntimeError("entry-guard", ...)` to reject. */
	validateEvidence?(ctx: ValidateEvidenceContext): void;
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
}
