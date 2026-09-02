import type { StepBehavior } from "./types.ts";

const VERIFIER_ROLES = [
	"quality-verifier",
	"security-verifier",
	"performance-verifier",
	"openspec-verifier",
	"usability-verifier",
	"test-verifier",
] as const;

function candidateRoles(definitionId: string): string[] {
	return VERIFIER_ROLES.filter(
		(role) => definitionId !== "no-openspec" || role !== "openspec-verifier",
	);
}

export const verificationBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.triage": {
		roles: () => ["triage"],
		candidateRoles: () => ["triage"],
	},
	"core.verification": {
		// Candidate roles configure routing before a run exists; active roles use
		// the selected subset (or the test/quality fallback) during fan-out.
		roles: ({ snapshot }) =>
			snapshot.step.selectedRoles.length
				? [...snapshot.step.selectedRoles]
				: snapshot.step.testRunStarted
					? ["test-verifier"]
					: ["quality-verifier"],
		candidateRoles: ({ definitionId }) => candidateRoles(definitionId),
	},
};
