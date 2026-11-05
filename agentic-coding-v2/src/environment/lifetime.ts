import type { TaskInfo } from "../state.ts";
import type { Plan } from "./model.ts";

export const independentLifetime = "independent-roots-v1";
export const referencedLifetime = "referenced-roots-v1";
export const sharedLifetime = "shared-prerequisites-v1";
export type Lifetime =
	| typeof independentLifetime
	| typeof referencedLifetime
	| typeof sharedLifetime;

export function independentRoot(plan: Plan) {
	return plan.lifetime === independentLifetime;
}
/** Reference modes scope roots: only app roots are stop/expiry units and
 * declared prerequisites are retained by live root references. */
export function referencedRoot(plan: Plan) {
	return (
		plan.lifetime === referencedLifetime || sharedLifetime === plan.lifetime
	);
}
/** Shared reference mode adds a second, disjoint acquisition that attaches to an
 * already-live prerequisite generation instead of starting another one. */
export function sharedRoot(plan: Plan) {
	return plan.lifetime === sharedLifetime;
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
		new Set(plans.map((plan) => plan.lifetime)).size > 1 ||
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
		plans.some(sharedRoot) &&
		!plans.some((plan) => plan.projectKind === "app")
	)
		throw new Error(
			"Shared lifetimes require one approved request containing at least one shell app root and its declared same-repository prerequisites",
		);
	if (
		plans.some(referencedRoot) &&
		!plans.some((plan) => plan.projectKind === "app")
	)
		throw new Error(
			"Referenced lifetimes require one approved request containing at least one shell app root and its declared same-repository prerequisites",
		);
}
