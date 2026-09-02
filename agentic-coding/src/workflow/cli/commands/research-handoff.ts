// The `research-handoff` command: records the structured research handoff
// and transitions to wiki drafting in one authenticated step, restricted to
// the active core.research researcher run. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import type { WorkflowEngine } from "../../runtime.ts";
import { flag, parseInput, requireFlag } from "../args.ts";
import { managedWorkflowTarget } from "../caller-environment.ts";
import { resolveHandoffIdentity } from "../identity.ts";

export async function runResearchHandoff(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	const target = managedWorkflowTarget();
	const identity = resolveHandoffIdentity(workflowEngine, target);
	if (identity.stepId !== "core.research" || identity.role !== "researcher")
		throw new Error(
			"research-handoff is only available to the active core.research researcher run",
		);
	const run = workflowEngine.authorizeExactRunCapability(
		target,
		identity.workflowId,
		identity.runId,
		identity.stepId,
		identity.role,
		identity.token,
	);
	const subject = requireFlag(rest, "subject");
	const directivesFlag = requireFlag(rest, "directives");
	const directives = parseInput(directivesFlag);
	const findingsText = flag(rest, "findings");
	const canonicalTarget = flag(rest, "target");
	const citationsFlag = flag(rest, "citations");
	const noSourcesUsed = rest.includes("--no-sources");
	const citations = citationsFlag
		? citationsFlag
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
	const result = workflowEngine.dispatch(target, {
		type: "agent.research-handoff",
		workflowId: run.workflowId,
		runId: run.id,
		stepId: run.stepId,
		role: run.role,
		token: identity.token,
		handoff: {
			subject,
			...(canonicalTarget ? { canonicalTarget } : {}),
			...(findingsText === undefined ? {} : { findings: findingsText }),
			directives,
			citations,
			noSourcesUsed,
		},
	});
	console.log(
		JSON.stringify(
			workflowEngine.status(target, result.view.changeId),
			null,
			2,
		),
	);
}
