import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateImplementationEvidence,
} from "./validation.ts";

/** Definitions whose implementation step runs without an OpenSpec change: the
 * task list the entry guard reads does not exist for them, so there is nothing
 * to require. `no-openspec` is the reduced OpenSpec-free loop; `solo` runs one
 * implementation agent with no planning step at all. */
const CHANGE_FREE_IMPLEMENTATION = new Set(["no-openspec", "solo"]);

export const implementationBehavior: StepBehavior = {
	classification: "single",
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	validateEvidence: ({ snapshot, evidence }) => {
		if (CHANGE_FREE_IMPLEMENTATION.has(snapshot.definition.id)) return;
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
