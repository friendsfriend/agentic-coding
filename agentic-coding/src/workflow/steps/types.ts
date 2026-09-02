import type { WorkflowSnapshot } from "../contracts.ts";

export interface StepRolesContext {
	snapshot: WorkflowSnapshot;
}

export interface CandidateRolesContext {
	definitionId: string;
	fusionPlannerCount: number;
}

export interface StepBehavior {
	roles?(ctx: StepRolesContext): string[];
	candidateRoles?(ctx: CandidateRolesContext): string[];
}
