import type { StepBehavior } from "./types.ts";

export const implementationBehavior: StepBehavior = {
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
};
