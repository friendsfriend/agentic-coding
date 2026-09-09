// Resolves and authorizes the run identity a managed agent command
// (handoff/question/research-handoff) is calling on behalf of, including the
// persistent-agent pane-reuse token refresh path. Moved verbatim out of
// cli.ts (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import type { WorkflowApplication } from "../application.ts";
import {
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	type WorkflowEngine,
	wikiWorkflowDataRoot,
} from "../runtime.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../secure-fs.ts";
import {
	type CallerEnvironment,
	callerEnvironment,
} from "./caller-environment.ts";

export function resolveHandoffIdentity(
	workflowEngine: WorkflowEngine,
	repo: string,
	application?: WorkflowApplication,
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
	// Managed handoff/question commands are mutating entry points. Initialize
	// before resolving the run so legacy stores can be imported explicitly,
	// while ordinary status/list observation remains side-effect free. When an
	// application root is supplied the run executes there (cutover seam).
	if (application) {
		application.runSync(workflowEngine.initializeEffect(repo, workflowId));
	} else {
		workflowEngine.initialize(repo, workflowId);
	}
	const callerRun = application
		? application.runSync(workflowEngine.getRunEffect(repo, runId))
		: workflowEngine.getRun(repo, runId);
	let run = callerRun;
	const authorize = (runIdArg: string, tokenArg: string) =>
		application
			? application.runSync(
					workflowEngine.authorizeExactRunCapabilityEffect(
						repo,
						workflowId,
						runIdArg,
						stepId,
						role,
						tokenArg,
					),
				)
			: workflowEngine.authorizeExactRunCapability(
					repo,
					workflowId,
					runIdArg,
					stepId,
					role,
					tokenArg,
				);
	try {
		authorize(runId, token ?? "");
	} catch (authorizationError) {
		// Persistent agents keep the original environment when their pane is
		// reused. Only adopt the current generation when the immutable caller
		// run and current run resolve to the same live pane; never select by
		// mutable role identity alone.
		const current = application
			? application.runSync(
					workflowEngine.activeRunForRoleEffect(repo, workflowId, stepId, role),
				)
			: workflowEngine.activeRunForRole(repo, workflowId, stepId, role);
		if (
			!callerRun.handle?.paneId ||
			!current.handle?.paneId ||
			callerRun.handle.paneId !== current.handle.paneId
		)
			// SEC: keep the original capability rejection as cause detail on
			// this trust boundary so token-expiry vs pane-mismatch stays
			// auditable instead of collapsing to one generic message.
			throw new Error(
				`invalid or inactive run capability (${(authorizationError as Error).message ?? String(authorizationError)})`,
			);
		const currentSnapshot = application
			? application.runSync(workflowEngine.getSnapshotEffect(repo, workflowId))
			: workflowEngine.getSnapshot(repo, workflowId);
		const runDirectory =
			isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
				? path.join(wikiWorkflowDataRoot(), currentSnapshot.workflowId, "runs")
				: path.join(repo, ".herdr-workflow");
		const envFile = path.join(
			runDirectory,
			"runtime-bin",
			current.id,
			"run.env",
		);
		const directory = openSecureDirectory(path.dirname(envFile), runDirectory);
		let content: string;
		try {
			const fd = openSecureFile(directory, path.basename(envFile));
			try {
				content = fs.readFileSync(fd, "utf8");
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			closeSecureDirectory(directory);
		}
		const values = new Map(
			content
				.split("\n")
				.map((item) => item.split("=", 2) as [string, string])
				.filter(([key, value]) => Boolean(key) && value !== undefined)
				.map(
					([key, value]) =>
						[key, value.replace(/^'|'$/g, "")] as [string, string],
				),
		);
		if (values.get("HERDR_RUN_ID") !== current.id)
			throw new Error("persistent agent run environment does not match run");
		const refreshedToken = values.get("HERDR_RUN_TOKEN")?.replace(/^'|'$/g, "");
		if (!refreshedToken)
			throw new Error("persistent agent run capability is unavailable");
		token = refreshedToken;
		run = authorize(current.id, refreshedToken);
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
