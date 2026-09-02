import type { WorkflowRouting } from "../contracts.ts";
import type { StepBehavior } from "./types.ts";
import { validatePlanningArtifacts } from "./validation.ts";

const PLANNER_ROLE = /^planner-[1-5]$/;
const plannerRoles = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => `planner-${index + 1}`);

export const fusionPlannerRoles = (routing: WorkflowRouting): string[] =>
	[
		...new Set(
			routing.routes
				.filter(
					(route) =>
						route.stepId === "fusion.plan" &&
						route.role !== undefined &&
						PLANNER_ROLE.test(route.role),
				)
				.map((route) => route.role as string),
		),
	].sort(
		(a, b) =>
			Number(a.slice("planner-".length)) - Number(b.slice("planner-".length)),
	);

export const planningBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan": {
		roles: () => ["planner"],
		candidateRoles: () => ["planner"],
		validateEvidence: ({ snapshot }) => validatePlanningArtifacts(snapshot),
		onArrive: ({ edge, outcome }) =>
			edge.to === "core.plan" && outcome === "comments"
				? { mode: "review-fix" }
				: undefined,
		carriesOutputContext: true,
	},
	"fusion.plan": {
		roles: ({ snapshot }) => fusionPlannerRoles(snapshot.routing),
		candidateRoles: ({ fusionPlannerCount }) =>
			plannerRoles(fusionPlannerCount),
		onArrive: ({ edge, prior }) =>
			// Retry of a failed role resumes collection: surviving validated
			// drafts are preserved instead of re-fanning every planner.
			edge.from === "fusion.plan" && edge.to === "fusion.plan"
				? {
						results: prior.results.filter(
							(result) =>
								result.role.startsWith("planner-") && result.outputDigest,
						),
					}
				: undefined,
		onEnter: ({ snapshot, hasLiveRun }) => ({
			// Never relaunch a role whose validated draft already survived, nor
			// one whose run is still pending/working.
			skipRoles: fusionPlannerRoles(snapshot.routing).filter(hasLiveRun),
		}),
	},
	"fusion.consolidate": {
		roles: () => ["consolidator"],
		candidateRoles: () => ["consolidator"],
		validateEvidence: ({ snapshot }) => validatePlanningArtifacts(snapshot),
		carriesOutputContext: true,
	},
};
