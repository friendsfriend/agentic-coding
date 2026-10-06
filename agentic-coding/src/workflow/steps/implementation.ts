import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateImplementationEvidence,
} from "./validation.ts";

/** Definitions whose implementation step runs without an OpenSpec change: the
 * task list the entry guard reads does not exist for them, so there is nothing
 * to require. `no-openspec` is the reduced OpenSpec-free loop; `solo` runs one
 * implementation agent with no planning step at all; `verify` has no planning
 * step either — its worker only fixes the findings the developer selected.
 * Exported so the manifest's `changeArtifacts` trait is checked against this
 * set rather than restated (add-definition-family-traits). */
export const CHANGE_FREE_IMPLEMENTATION = new Set([
	"no-openspec",
	"solo",
	"verify",
]);

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
	validateEvidence: ({ snapshot, evidence }) => {
		if (CHANGE_FREE_IMPLEMENTATION.has(snapshot.definition.id)) return;
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
