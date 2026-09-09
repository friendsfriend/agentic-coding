// The `research-handoff` command: records the structured research handoff
// and transitions to wiki drafting in one authenticated step, restricted to
// the active core.research researcher run. Moved verbatim out of cli.ts
// (split-workflow-god-modules); migrated to run Effect programs at the
// CLI-invocation application root (complete-workflow-effect-cutover, task 2.1).
import type { WorkflowApplication } from "../../application.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { flag, parseInput, requireFlag } from "../args.ts";
import { managedWorkflowTarget } from "../caller-environment.ts";
import { scheduleDrain } from "../drain.ts";
import { resolveHandoffIdentity } from "../identity.ts";

type App = WorkflowApplication;

export async function runResearchHandoff(
	rest: string[],
	workflowEngine: WorkflowEngine,
	_repo: string,
	application?: App,
): Promise<void> {
	const target = managedWorkflowTarget();
	const identity = resolveHandoffIdentity(workflowEngine, target, application);
	if (identity.stepId !== "core.research" || identity.role !== "researcher")
		throw new Error(
			"research-handoff is only available to the active core.research researcher run",
		);
	const run = application
		? application.runSync(
				workflowEngine.authorizeExactRunCapabilityEffect(
					target,
					identity.workflowId,
					identity.runId,
					identity.stepId,
					identity.role,
					identity.token,
				),
			)
		: workflowEngine.authorizeExactRunCapability(
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
	const command = {
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
	} as never;
	if (application)
		application.runSync(workflowEngine.dispatchEffect(target, command));
	else workflowEngine.dispatch(target, command);
	scheduleDrain(target, 20);
	console.log(
		JSON.stringify(
			application
				? application.runSync(
						workflowEngine.statusEffect(target, run.workflowId),
					)
				: workflowEngine.status(target, run.workflowId),
			null,
			2,
		),
	);
}
