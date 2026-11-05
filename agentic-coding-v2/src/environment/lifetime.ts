import type { TaskInfo } from "../state.ts";
import type { Plan } from "./model.ts";

export const independentLifetime = "independent-roots-v1";
export const referencedLifetime = "referenced-roots-v1";
export type Lifetime = typeof independentLifetime | typeof referencedLifetime;

export function independentRoot(plan: Plan) {
	return plan.lifetime === independentLifetime;
}
/** Reference mode keeps one atomic acquisition. Only app roots are stop/expiry
 * units; declared prerequisites are retained by live root references. */
export function referencedRoot(plan: Plan) {
	return plan.lifetime === referencedLifetime;
}
export function scopedRoot(plan: Plan) {
	return plan.lifetime !== undefined;
}
/** An opt-in request is a new lifetime, never a permission to split an existing
 * coupled graph or a second acquisition. */
export function validateLifetime(plans: Plan[], owner: TaskInfo) {
	if (!plans.some(scopedRoot)) return;
	const unsupported = plans.some(
		(plan) =>
			!scopedRoot(plan) ||
			plan.action !== "run" ||
			plan.runtime !== "shell" ||
			plan.container ||
			plan.compose ||
			plan.kubernetes,
	);
	if (
		unsupported ||
		(plans.some(independentRoot) && plans.some(referencedRoot)) ||
		owner.kind !== undefined ||
		!owner.skill ||
		owner.policy !== "workspace-write"
	)
		throw new Error(
			"Lifetimes require one approved request of agent-owned shell app roots without container, Compose or Kubernetes resources; modes cannot be mixed",
		);
	if (
		plans.some(independentRoot) &&
		plans.some(
			(plan) =>
				plan.projectKind !== "app" ||
				!!plan.requires?.length ||
				plan.dependencyBatch,
		)
	)
		throw new Error(
			"Independent lifetimes require one approved request of agent-owned standalone shell app roots; dependencies and other runtimes are unsupported",
		);
	if (
		plans.some(referencedRoot) &&
		!plans.some((plan) => plan.projectKind === "app")
	)
		throw new Error(
			"Referenced lifetimes require one approved request containing at least one shell app root and its declared same-repository prerequisites",
		);
}
