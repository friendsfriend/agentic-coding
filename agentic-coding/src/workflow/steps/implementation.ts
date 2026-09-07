import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	prepareStepEvidence,
	validateImplementationEvidence,
} from "./validation.ts";

export const implementationBehavior: StepBehavior = {
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	validateEvidence: ({ snapshot, evidence }) => {
		if (snapshot.definition.id === "no-openspec") return;
		validateImplementationEvidence(
			(evidence as PreparedStepEvidence | undefined) ??
				prepareStepEvidence(snapshot),
		);
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
