// The `start` command: validates workflow-specific preconditions, resolves
// role routing (including the openspec-fusion-full planner fan-out), and
// starts the pinned workflow definition. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import type { WorkflowEngine } from "../../runtime.ts";
import {
	parseFusionProfiles as parseStartupFusionProfiles,
	prepareWorkflowStart,
} from "../../startup.ts";
import { flag, requireFlag } from "../args.ts";
import { drainEffects } from "../drain.ts";

export {
	parseFusionProfiles,
	rolesForDefinition,
	validateStart,
} from "../../startup.ts";

export function parseMode(value: string | undefined): "worktree" | "checkout" {
	if (value !== "worktree" && value !== "checkout")
		throw new Error("start: --mode must be worktree or checkout");
	return value;
}

export async function runStart(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	const definitionId = flag(rest, "workflow") ?? "openspec-full";
	const research = definitionId === "research";
	const repo = research ? flag(rest, "repo") : requireFlag(rest, "repo");
	const mode = research ? undefined : parseMode(flag(rest, "mode"));
	const fusionFlag = flag(rest, "fusion-profiles");
	const fusionProfiles =
		definitionId.startsWith("openspec-fusion") && fusionFlag !== undefined
			? parseStartupFusionProfiles(fusionFlag)
			: undefined;
	const prepared = prepareWorkflowStart({
		definitionId,
		repo: repo ? fs.realpathSync(path.resolve(repo)) : undefined,
		repositoryContext: repo ? fs.realpathSync(path.resolve(repo)) : undefined,
		workflowId: requireFlag(rest, "workflow-id"),
		mode,
		task: flag(rest, "task"),
		ticket: flag(rest, "ticket"),
		preset: flag(rest, "preset"),
		fusionProfiles,
	});
	workflowEngine.start(prepared.input);
	await drainEffects(workflowEngine, prepared.target);
	console.log(
		JSON.stringify(
			workflowEngine.status(prepared.target, prepared.input.workflowId),
			null,
			2,
		),
	);
}
