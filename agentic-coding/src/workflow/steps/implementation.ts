import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateImplementationEvidence,
} from "./validation.ts";

export const implementationBehavior: StepBehavior = {
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	validateEvidence: ({ snapshot, evidence }) => {
		if (snapshot.definition.id === "no-openspec") return;
		validateImplementationEvidence(evidence as PreparedStepEvidence);
	},
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
