import type { TaskInfo } from "../state.ts";
import type { Plan } from "./model.ts";

export const independentLifetime = "independent-roots-v1";
export function independentRoot(plan: Plan) {
	return plan.lifetime === independentLifetime;
}
/** An opt-in request is not a permission to split an existing coupled graph. */
export function validateLifetime(plans: Plan[], owner: TaskInfo) {
	if (!plans.some((plan) => plan.lifetime !== undefined)) return;
	if (
		owner.kind !== undefined ||
		!owner.skill ||
		owner.policy !== "workspace-write" ||
		plans.some(
			(plan) =>
				!independentRoot(plan) ||
				plan.action !== "run" ||
				plan.runtime !== "shell" ||
				plan.projectKind !== "app" ||
				!!plan.requires?.length ||
				plan.dependencyBatch ||
				plan.container ||
				plan.compose ||
				plan.kubernetes,
		)
	)
		throw new Error(
			"Independent lifetimes require one approved request of agent-owned standalone shell app roots; dependencies and other runtimes are unsupported",
		);
}
