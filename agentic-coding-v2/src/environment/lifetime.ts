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
/** Lifetimes scope agent-owned app roots and declared prerequisite generations
 * on shell processes, owned Docker/Podman containers and Compose stacks.
 * Kubernetes and foreign/shared external resources stay out of scope. */
function scopedRuntime(plan: Plan) {
	return (
		plan.runtime === "shell" ||
		plan.runtime === "docker" ||
		plan.runtime === "podman" ||
		plan.runtime === "compose"
	);
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
/** Canonical identity of one approved plan. A later acquisition may reuse a
 * prerequisite generation only when this exact description was approved: a
 * changed command, image, publication, environment or endpoint is a different
 * generation, never adopted by app name. */
export function approvedPlanIdentity(plan: Plan) {
	return JSON.stringify(canonical(plan));
}
export function sameApprovedPlan(left: Plan, right: Plan) {
	return approvedPlanIdentity(left) === approvedPlanIdentity(right);
}
/** An opt-in request is a new lifetime, never a permission to split an existing
 * coupled graph or a second acquisition. */
export function validateLifetime(plans: Plan[], owner: TaskInfo) {
	if (!plans.some(scopedRoot)) return;
	if (
		plans.some((plan) =>
			Object.keys(plan.prerequisiteTargets ?? {}).some((app) =>
				plans.some(
					(member) => member.app === app && member.projectKind === "app",
				),
			),
		)
	)
		throw new Error(
			"Application prerequisites require the default coupled lifetime; independent/shared app-generation attachment is not inferred",
		);
	const unsupported = plans.some(
		(plan) =>
			!scopedRoot(plan) ||
			plan.action !== "run" ||
			plan.kubernetes ||
			!scopedRuntime(plan),
	);
	if (
		unsupported ||
		new Set(plans.map((plan) => plan.lifetime)).size > 1 ||
		owner.kind !== undefined ||
		!owner.skill ||
		owner.policy !== "workspace-write"
	)
		throw new Error(
			"Lifetimes require one approved request of agent-owned app roots and declared prerequisites on shell, Docker/Podman or Compose run targets without Kubernetes resources; modes cannot be mixed",
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
			"Independent lifetimes require one approved request of agent-owned standalone app roots without declared dependencies; Kubernetes and shared/external resources are unsupported",
		);
	if (
		plans.some(sharedRoot) &&
		!plans.some((plan) => plan.projectKind === "app")
	)
		throw new Error(
			"Shared lifetimes require one approved request containing at least one app root and its explicitly declared owned infrastructure prerequisites",
		);
	if (
		plans.some(referencedRoot) &&
		!plans.some((plan) => plan.projectKind === "app")
	)
		throw new Error(
			"Referenced lifetimes require one approved request containing at least one app root and its explicitly declared owned infrastructure prerequisites",
		);
}
