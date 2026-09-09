// The remaining small operator/administrative commands: `repair`, `repin`,
// and `agent-extension`. (`listProjects` moved to the application-operations
// boundary src/workflow/operations.ts, enforce-source-layer-boundaries.)
// Moved verbatim out of cli.ts (split-workflow-god-modules); migrated to run
// Effect programs at the CLI-invocation application root
// (complete-workflow-effect-cutover, task 2.1).
import { manageAgentExtension } from "../../agent-extensions.ts";
import type { WorkflowApplication } from "../../application.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { flag, positional, requireFlag } from "../args.ts";
import { scheduleDrain } from "../drain.ts";
import { AGENT_EXTENSION_SUBCOMMANDS } from "../schema.ts";

type App = WorkflowApplication;

export async function runRepair(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
	application?: App,
): Promise<void> {
	if (!rest.includes("--confirm")) {
		console.log(
			JSON.stringify(
				application
					? application.runSync(
							workflowEngine.previewRepairEffect(
								repo,
								requireFlag(rest, "workflow-id"),
							),
						)
					: workflowEngine.previewRepair(
							repo,
							requireFlag(rest, "workflow-id"),
						),
				null,
				2,
			),
		);
		return;
	}
	const view = application
		? application.runSync(
				workflowEngine.statusEffect(repo, requireFlag(rest, "workflow-id")),
			)
		: workflowEngine.status(repo, requireFlag(rest, "workflow-id"));
	if (application)
		application.runSync(
			workflowEngine.dispatchEffect(repo, {
				type: "operator.repair",
				workflowId: view.workflowId,
				revision: Number(flag(rest, "revision")),
				targetStep: flag(rest, "step"),
				reason: flag(rest, "reason") ?? "",
			}),
		);
	else
		workflowEngine.dispatch(repo, {
			type: "operator.repair",
			workflowId: view.workflowId,
			revision: Number(flag(rest, "revision")),
			targetStep: flag(rest, "step"),
			reason: flag(rest, "reason") ?? "",
		});
	scheduleDrain(repo);
	console.log(
		JSON.stringify(
			application
				? application.runSync(
						workflowEngine.statusEffect(repo, requireFlag(rest, "workflow-id")),
					)
				: workflowEngine.status(repo, requireFlag(rest, "workflow-id")),
			null,
			2,
		),
	);
}

export async function runMigrate(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
	application?: App,
): Promise<void> {
	const workflowId = requireFlag(rest, "workflow-id");
	const targetVersion = Number(requireFlag(rest, "target-version"));
	if (!Number.isInteger(targetVersion) || targetVersion < 1)
		throw new Error("migrate: --target-version must be a positive integer");
	const preview = application
		? application.runSync(
				workflowEngine.previewMigrationEffect(repo, workflowId, targetVersion),
			)
		: workflowEngine.previewMigration(repo, workflowId, targetVersion);
	if (!rest.includes("--confirm")) {
		console.log(JSON.stringify(preview, null, 2));
		return;
	}
	if (!preview.compatible)
		throw new Error(preview.diagnostic ?? "migration target is incompatible");
	if (application)
		application.runSync(
			workflowEngine.dispatchEffect(repo, {
				type: "operator.migrate",
				workflowId,
				revision: Number(flag(rest, "revision")),
				targetVersion,
				reason: requireFlag(rest, "reason"),
			}),
		);
	else
		workflowEngine.dispatch(repo, {
			type: "operator.migrate",
			workflowId,
			revision: Number(flag(rest, "revision")),
			targetVersion,
			reason: requireFlag(rest, "reason"),
		});
	scheduleDrain(repo);
	console.log(
		JSON.stringify(
			application
				? application.runSync(workflowEngine.statusEffect(repo, workflowId))
				: workflowEngine.status(repo, workflowId),
			null,
			2,
		),
	);
}

export async function runRepin(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
	application?: App,
): Promise<void> {
	const view = application
		? application.runSync(
				workflowEngine.statusEffect(repo, requireFlag(rest, "workflow-id")),
			)
		: workflowEngine.status(repo, requireFlag(rest, "workflow-id"));
	const revision =
		flag(rest, "revision") === undefined
			? view.revision
			: Number(flag(rest, "revision"));
	if (application)
		application.runSync(
			workflowEngine.dispatchEffect(repo, {
				type: "operator.repin",
				workflowId: view.workflowId,
				revision,
			}),
		);
	else
		workflowEngine.dispatch(repo, {
			type: "operator.repin",
			workflowId: view.workflowId,
			revision,
		});
	scheduleDrain(repo);
	console.log(
		JSON.stringify(
			application
				? application.runSync(
						workflowEngine.statusEffect(repo, requireFlag(rest, "workflow-id")),
					)
				: workflowEngine.status(repo, requireFlag(rest, "workflow-id")),
			null,
			2,
		),
	);
}

export function runAgentExtension(rest: string[]): void {
	const [subcommand, ...args] = rest;
	if (!(AGENT_EXTENSION_SUBCOMMANDS as readonly string[]).includes(subcommand))
		throw new Error(
			`unknown agent-extension command: ${subcommand ?? "(none)"}`,
		);
	const profiles: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--profile") continue;
		const next = args[index + 1];
		if (next !== undefined) profiles.push(next);
	}
	if (subcommand === "list") manageAgentExtension({ command: "list" });
	else if (subcommand === "install")
		manageAgentExtension({
			command: "install",
			source: positional(args),
			profiles,
		});
	else
		manageAgentExtension({
			command: "install-local",
			source: positional(args),
			profiles,
		});
}
