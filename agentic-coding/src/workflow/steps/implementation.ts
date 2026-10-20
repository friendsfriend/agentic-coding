import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { WorkflowFamilyTraits } from "../registry.ts";
import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateImplementationEvidence,
} from "./validation.ts";

/** Whether a definition's implementation step runs without an OpenSpec change:
 * the task list the entry guard reads does not exist for it, so there is
 * nothing to require. Read from the family traits (`changeArtifacts: none`)
 * instead of a definition-id list (read-family-traits-instead-of-ids): the
 * change-free loop, the single-agent `solo` family, and the verify-only family
 * all declare it. A caller that passes no traits — a direct hook invocation, or
 * a tier below the family-traits tier — falls back to the catalog table
 * `effectiveFamilyTraits` reads, so every built-in family keeps its behavior. */
function changeFree(
	definition: { id: string },
	traits?: WorkflowFamilyTraits,
): boolean {
	return (
		(traits ?? effectiveFamilyTraits(definition))?.changeArtifacts === "none"
	);
}

/** Whether an arriving transition output is a review's comment payload. The
 * only producer of `{comments}` into the implementation step is a review's
 * `review-comments` action, whose comments the run is meant to fix. */
function carriesComments(output: unknown): boolean {
	return (
		typeof output === "object" &&
		output !== null &&
		!Array.isArray(output) &&
		"comments" in output
	);
}

export const implementationBehavior: StepBehavior = {
	classification: "single",
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	validateEvidence: ({ snapshot, evidence, traits }) => {
		if (changeFree(snapshot.definition, traits)) return;
		validateImplementationEvidence(evidence as PreparedStepEvidence);
	},
	onArrive: ({ outcome, output }) => ({
		// A review's comments arrive here two ways: the direct edge of an older
		// tier delivers the `comments` outcome itself, while the per-step routing
		// pass (`classifier-driven-step-model-selection`) hands the arriving
		// context on as its own transition output with outcome `complete`. Both are
		// a review fix, so the carried payload — not only the outcome — decides.
		mode:
			outcome === "comments" || carriesComments(output)
				? "review-fix"
				: outcome === "fix" || outcome === "failed"
					? "fix"
					: "apply",
	}),
	carriesOutputContext: true,
};
