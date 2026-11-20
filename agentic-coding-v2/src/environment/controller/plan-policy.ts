import type { TaskInfo } from "../../state.ts";
import { belongsToOwner } from "../dependency-workspaces.ts";
import { validateLifetime } from "../lifetime.ts";
import type { Plan } from "../model.ts";
import { ControllerRefusal, type ControllerScope } from "./state.ts";

/** Compatibility domain description only; never creates a native agent/task. */
export function controllerOwner(scope: ControllerScope): TaskInfo {
	return {
		id: scope.owner,
		topicId: scope.id,
		skill: "environment-controller",
		profile: "none",
		repository: scope.workspace.repository,
		workspace: scope.workspace.directory,
		...(scope.mode === "operator"
			? { kind: "operator-environment" as const }
			: {}),
		relatedTo: null,
		createdAt: scope.createdAt,
		reported: false,
	};
}

/** Domain rules are reused before approval and dispatch, never relaxed by transport. */
export function validateControllerPlans(
	plans: readonly Plan[],
	scope: ControllerScope,
) {
	const owner = controllerOwner(scope);
	if (
		!plans.length ||
		plans.length > 16 ||
		plans.some(
			(plan) =>
				![
					"shell",
					"systemshell",
					"docker",
					"podman",
					"compose",
					"kubernetes",
				].includes(plan.runtime) ||
				!belongsToOwner(plan, owner) ||
				(["docker", "podman"].includes(plan.runtime) && !plan.container) ||
				(plan.runtime === "compose" && (!plan.compose || !plan.composePlan)) ||
				(plan.runtime === "kubernetes" &&
					(!plan.kubernetes ||
						!plan.clusterConnection ||
						(plan.kubernetes.workload === "helm-release-v1" &&
							!plan.helmChart))),
		)
	)
		throw new ControllerRefusal("operation-plan-unavailable");
	try {
		validateLifetime([...plans], owner);
	} catch {
		throw new ControllerRefusal("operation-plan-unavailable");
	}
}
