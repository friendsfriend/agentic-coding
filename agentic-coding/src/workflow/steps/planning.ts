import type { WorkflowRouting } from "../contracts.ts";
import type { StepBehavior } from "./types.ts";

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
	},
	"fusion.plan": {
		roles: ({ snapshot }) => fusionPlannerRoles(snapshot.routing),
		candidateRoles: ({ fusionPlannerCount }) =>
			plannerRoles(fusionPlannerCount),
	},
	"fusion.consolidate": {
		roles: () => ["consolidator"],
		candidateRoles: () => ["consolidator"],
	},
};
