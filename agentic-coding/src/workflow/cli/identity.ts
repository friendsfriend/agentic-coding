// Resolves and authorizes the run identity a managed agent command
// (handoff/question/research-handoff) is calling on behalf of, including the
// persistent-agent pane-reuse token refresh path. Moved verbatim out of
// cli.ts (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import {
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	type WorkflowEngine,
	wikiWorkflowDataRoot,
} from "../runtime.ts";
import {
	type CallerEnvironment,
	callerEnvironment,
} from "./caller-environment.ts";

export function resolveHandoffIdentity(
	workflowEngine: WorkflowEngine,
	repo: string,
	overrideEnvironment?: CallerEnvironment,
): {
	runId: string;
	generation: number;
	token: string;
	workflowId: string;
	stepId: string;
	role: string;
	outputPath?: string;
} {
	const environment = overrideEnvironment ?? callerEnvironment();
	const workflowId = environment.HERDR_WORKFLOW_ID;
	const stepId = environment.HERDR_STEP_ID;
	const role = environment.HERDR_ROLE;
	const runId = environment.HERDR_RUN_ID;
	let token = environment.HERDR_RUN_TOKEN;
	if (!workflowId || !stepId || !role || !runId)
		throw new Error(
			"handoff requires an exact launch-bound run environment and capability",
		);
	const callerRun = workflowEngine.getRun(repo, runId);
	let run = callerRun;
	try {
		workflowEngine.authorizeExactRunCapability(
			repo,
			workflowId,
			runId,
			stepId,
			role,
			token ?? "",
		);
	} catch {
		// Persistent agents keep the original environment when their pane is
		// reused. Only adopt the current generation when the immutable caller
		// run and current run resolve to the same live pane; never select by
		// mutable role identity alone.
		const current = workflowEngine.activeRunForRole(
			repo,
			workflowId,
			stepId,
			role,
		);
		if (
			!callerRun.handle?.paneId ||
			!current.handle?.paneId ||
			callerRun.handle.paneId !== current.handle.paneId
		)
			throw new Error("invalid or inactive run capability");
		const currentSnapshot = workflowEngine.getSnapshot(repo, workflowId);
		const envFile = path.join(
			isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
				? path.join(wikiWorkflowDataRoot(), currentSnapshot.workflowId)
				: path.join(repo, ".herdr-workflow"),
			"runtime-bin",
			current.id,
			"run.env",
		);
		const line = fs
			.readFileSync(envFile, "utf8")
			.split("\n")
			.find((item) => item.startsWith("HERDR_RUN_TOKEN="));
		const refreshedToken = line?.slice("HERDR_RUN_TOKEN=".length);
		if (!refreshedToken)
			throw new Error("persistent agent run capability is unavailable");
		token = refreshedToken;
		run = workflowEngine.authorizeExactRunCapability(
			repo,
			workflowId,
			current.id,
			stepId,
			role,
			refreshedToken,
		);
	}
	return {
		runId: run.id,
		generation: run.generation,
		token: token ?? "",
		workflowId,
		stepId,
		role,
		...(run.outputPath ? { outputPath: run.outputPath } : {}),
	};
}
