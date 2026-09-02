// Workflow target identity: change-id validation, the repository-independent
// wiki/research target locators, and canonical repository/store path
// resolution. Zero-dependency foundation used by nearly every other runtime
// module. Moved verbatim out of runtime.ts (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import { WorkflowRuntimeError } from "../contracts.ts";
import { wikiRoot } from "../wiki.ts";

const WORKFLOW_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** User-supplied workflow identifier: the string a workflow is started and
 * addressed with. Shares the change-id shape so both can serve as branch
 * seeds and directory-name components interchangeably. */
export function validateWorkflowId(value: string): string {
	if (!WORKFLOW_ID.test(value))
		throw new WorkflowRuntimeError(
			"workflow-id",
			"workflow id must be 1-80 lowercase letters, digits, or hyphens",
		);
	return value;
}

/** Planner-derived change identifier (declared as the primary change at plan
 * handoff; also used to bound legacy/open-spec directory names). */
export function validateChangeId(value: string): string {
	if (!WORKFLOW_ID.test(value))
		throw new WorkflowRuntimeError(
			"change-id",
			"change ID must be 1-80 lowercase letters, digits, or hyphens",
		);
	return value;
}

export function canonicalRepository(repo: string): string {
	const resolved = fs.realpathSync(path.resolve(repo));
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			resolved,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error(`not a Git repository: ${repo}`);
	const common = fs.realpathSync(result.stdout.toString().trim());
	return path.basename(common) === ".git" ? path.dirname(common) : resolved;
}
/** Explicit locator for workflows that review the centralized wiki without a repository. */
export const WIKI_WORKFLOW_TARGET = "wiki://centralized";
export const RESEARCH_WORKFLOW_TARGET = "research://standalone";
export function wikiWorkflowTarget(): string {
	return WIKI_WORKFLOW_TARGET;
}
export function researchWorkflowTarget(): string {
	return RESEARCH_WORKFLOW_TARGET;
}
export function isWikiWorkflowTarget(repo: string): boolean {
	return repo === WIKI_WORKFLOW_TARGET;
}
export function isResearchWorkflowTarget(repo: string): boolean {
	return repo === RESEARCH_WORKFLOW_TARGET;
}
export function wikiWorkflowDataRoot(): string {
	return path.join(path.dirname(wikiRoot()), ".agentic-coding-workflow");
}
export function canonicalStorePath(repo: string): string {
	return isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)
		? path.join(wikiWorkflowDataRoot(), "herdr.db")
		: path.join(canonicalRepository(repo), ".herdr-workflow", "herdr.db");
}
