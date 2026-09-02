import type { StepBehavior } from "./types.ts";

export const researchBehavior: StepBehavior = {
	roles: () => ["researcher"],
	candidateRoles: () => ["researcher"],
};
