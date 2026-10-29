// Pure canonical conversation names shared by assignment and admission policy.
import { createHash } from "node:crypto";
import type { WorkflowSnapshot } from "../contracts/workflow.ts";
import type { StepDefinition } from "./registry.ts";
import { stepBehavior } from "./steps/index.ts";

export function canonicalAgentName(
	workflowId: string,
	definitionId: string,
	run: { stepId: string; role: string; id: string },
	step?: Pick<StepDefinition, "behavior">,
): string {
	const hash = createHash("sha256")
		.update(`${workflowId}\n${definitionId}\n${run.stepId}\n${run.role}`)
		.digest("hex")
		.slice(0, 8);
	if ((step?.behavior ?? stepBehavior(run.stepId)).roundScoped !== true)
		return `${run.role}-${hash}`;
	const shortRole = run.role.endsWith("-verifier")
		? `${run.role.slice(0, -9)}-verif`
		: run.role;
	return `${shortRole.slice(0, 14)}-${hash}`;
}
export function debugRunAgentName(
	snapshot: WorkflowSnapshot,
	run: { id: string },
): string {
	return `debug-${createHash("sha256").update(`${snapshot.workflowId}\n${run.id}`).digest("hex").slice(0, 12)}`;
}
