import type { StepBehavior } from "./types.ts";
import { validateImplementationEvidence } from "./validation.ts";

export const implementationBehavior: StepBehavior = {
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	validateEvidence: ({ snapshot }) => validateImplementationEvidence(snapshot),
	onArrive: ({ outcome }) => ({
		mode:
			outcome === "comments"
				? "review-fix"
				: outcome === "fix" || outcome === "failed"
					? "fix"
					: "apply",
	}),
	carriesOutputContext: true,
};
