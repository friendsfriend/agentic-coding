import type { ArriveResult, StepBehavior } from "./types.ts";

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
		// Attempt is seeded from the verification round counter so a triage
		// redo after a verification loop keeps the same round number.
		onArrive: ({ snapshot }) => ({
			attempt: (snapshot.loopCounts["core.verification:round"] ?? 0) + 1,
		}),
		roundScoped: true,
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
		onArrive: ({ snapshot, output }) => {
			const round = (snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
			snapshot.loopCounts["core.verification:round"] = round;
			const result: ArriveResult = { attempt: round };
			if (
				output &&
				typeof output === "object" &&
				"roles" in output &&
				Array.isArray((output as { roles: unknown }).roles)
			)
				result.selectedRoles = [...(output as { roles: string[] }).roles];
			return result;
		},
		carriesOutputContext: true,
		roundScoped: true,
	},
};
