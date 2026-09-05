import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Herdr } from "../../herdr-client.ts";
import {
	drainEffects,
	listProjects,
	engine as workflowEngineFactory,
} from "../../workflow/cli.ts";
import type { WorkflowView } from "../../workflow/contracts.ts";
import { loadConfig } from "../../workflow/effects.ts";
import { parseAgentsConfig } from "../../workflow/profiles.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	validateWorkflowId,
} from "../../workflow/runtime.ts";
import { prepareWorkflowStart } from "../../workflow/startup.ts";

export {
	fusionPlannerCount,
	startRouting,
} from "../../workflow/startup.ts";

import {
	validateWikiReviewComments,
	type WikiReviewComment,
} from "../../workflow/wiki.ts";
import { credentialPromptBridge } from "./ui/CredentialsModal.tsx";

export function getWorkflowView(
	repo: string,
	workflowId: string,
): WorkflowView {
	const engine = workflowEngineFactory();
	void drainEffects(engine, repo, credentialPromptBridge()).catch(
		() => undefined,
	);
	return engine.status(repo, workflowId);
}
export function listWorkflowViews(repo: string): WorkflowView[] {
	return workflowEngineFactory().list(repo);
}
export function previewWorkflowRepair(repo: string, workflowId: string) {
	return workflowEngineFactory().previewRepair(repo, workflowId);
}
export function repairWorkflow(
	repo: string,
	workflowId: string,
	revision: number,
	targetStep: string,
	reason = "",
) {
	const engine = workflowEngineFactory();
	const view = engine.status(repo, workflowId);
	if (view.revision !== revision)
		throw new Error(`stale revision ${revision}; current ${view.revision}`);
	return engine.dispatch(repo, {
		type: "operator.repair",
		workflowId: view.workflowId,
		revision,
		targetStep,
		reason,
	}).view;
}
export function answerWorkflowQuestion(
	repo: string,
	workflowId: string,
	revision: number,
	questionId: string,
	answer:
		| { kind: "option" | "custom" | "cancel"; value?: string }
		| {
				groupId: string;
				responses: Array<{
					questionId: string;
					kind: "option" | "custom";
					value: string;
				}>;
		  }
		| { groupId: string; kind: "cancel" },
): WorkflowView {
	const workflow = workflowEngineFactory();
	const view = workflow.status(repo, workflowId);
	return workflow.dispatch(repo, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision,
		actionId: "answer-question",
		input: "groupId" in answer ? answer : { questionId, ...answer },
	}).view;
}

export async function runWorkflowAction(
	actionId: string,
	repo: string,
	workflowId: string,
	revision: number,
	input?: string,
): Promise<string> {
	const engine = workflowEngineFactory();
	const view = engine.status(repo, workflowId);
	let parsed: unknown;
	if (input) {
		try {
			parsed = JSON.parse(input);
		} catch {
			parsed = input;
		}
	}
	engine.dispatch(repo, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision,
		actionId,
		input: parsed,
	});
	await drainEffects(engine, repo, credentialPromptBridge());
	return JSON.stringify(engine.status(repo, workflowId));
}
/** Sentinel choice meaning "use existing global config defaults"; stripped
 * before routing so it never reaches resolvePreset. */
export const PRESET_CONFIG_DEFAULTS = "Config defaults";

export function startArgs(input: {
	repo: string;
	ticket: string;
	workflowId: string;
	task?: string;
	mode: string;
	workflowType?: string;
	preset?: string;
}) {
	const definitionId =
		input.workflowType === "quick"
			? "no-openspec"
			: (input.workflowType ?? "openspec-full");
	const sameCheckout = [
		"openspec-propose",
		"openspec-fusion-propose",
		"wiki",
	].includes(definitionId);
	const research = definitionId === "research";
	return {
		repo: research ? researchWorkflowTarget() : input.repo,
		...(research && input.repo ? { repositoryContext: input.repo } : {}),
		workflowId: validateWorkflowId(input.workflowId),
		definitionId,
		task: input.task || undefined,
		ticket: input.ticket || undefined,
		...(research ? {} : { mode: sameCheckout ? "checkout" : input.mode }),
		...(sameCheckout ? { sameCheckout: true } : {}),
		...(input.preset && input.preset !== PRESET_CONFIG_DEFAULTS
			? { preset: input.preset }
			: {}),
	};
}
/** Preset names available for the new workflow modal's agent-preset step. */
export function listPresetNames(repository?: string): string[] {
	const config = loadConfig(repository);
	try {
		const agents = parseAgentsConfig(config.agents, config);
		return Object.keys(agents.presets ?? {}).sort();
	} catch {
		return [];
	}
}
export async function startWorkflowInProcess(
	input: Parameters<typeof startArgs>[0],
): Promise<string> {
	const args = startArgs(input);
	const prepared = prepareWorkflowStart({
		repo: input.repo,
		repositoryContext: args.repositoryContext,
		workflowId: args.workflowId,
		definitionId: args.definitionId,
		mode: args.mode as "worktree" | "checkout" | undefined,
		task: args.task,
		ticket: args.ticket,
		preset: args.preset,
	});
	const engine = workflowEngineFactory();
	engine.start(prepared.input);
	await drainEffects(engine, prepared.target, credentialPromptBridge());
	return `Workflow started: ${args.workflowId}`;
}

/** Start the home-only wiki review without requiring a repository or blocking
 * the UI while Herdr creates the workspace and launches the agent. */
export function startWikiCommentWorkflowInProcess(
	input: readonly WikiReviewComment[],
	sessionId = `wiki-review-${randomUUID()}`,
): string {
	const comments = validateWikiReviewComments(input);
	const prepared = prepareWorkflowStart({
		workflowId: validateWorkflowId(sessionId),
		definitionId: "wiki-comments",
		task: "Address the submitted wiki review comments.",
		context: { comments },
	});
	const engine = workflowEngineFactory();
	engine.start(prepared.input);
	void drainEffects(engine, prepared.target, credentialPromptBridge()).catch(
		() => undefined,
	);
	return `Wiki review workflow started: ${sessionId}`;
}
function navigationPath(repo: string, workflowId: string): string {
	return path.join(
		path.dirname(canonicalStorePath(repo)),
		"navigation",
		`${encodeURIComponent(workflowId)}.json`,
	);
}
function returnWorkspace(repo: string, workflowId: string): string | undefined {
	let file: string | undefined;
	try {
		file = navigationPath(repo, workflowId);
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
			workspace?: unknown;
			at?: unknown;
		};
		const workspace =
			typeof value.workspace === "string" &&
			value.workspace.length <= 256 &&
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters
			!/[\x00-\x1f]/.test(value.workspace)
				? value.workspace
				: undefined;
		const fresh =
			typeof value.at === "string" &&
			Date.now() - Date.parse(value.at) <= 10 * 60_000;
		if (!workspace || !fresh) {
			fs.rmSync(file, { force: true });
			return undefined;
		}
		const live = new Herdr().call("workspace", "get", workspace) as {
			workspace?: { status?: string; closed_at?: string };
		};
		if (
			!live.workspace ||
			live.workspace.status === "closed" ||
			live.workspace.closed_at
		) {
			fs.rmSync(file, { force: true });
			return undefined;
		}
		return workspace;
	} catch (error) {
		if (
			file &&
			/not found|unknown workspace|closed/i.test(
				String((error as Error).message),
			)
		)
			fs.rmSync(file, { force: true });
		return undefined;
	}
}
export function consumeReturnWorkspace(
	repo: string,
	workflowId: string,
	workspace: string,
): void {
	try {
		const file = navigationPath(repo, workflowId);
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
			workspace?: unknown;
		};
		if (value.workspace === workspace) fs.rmSync(file, { force: true });
	} catch {}
}
export function setReturnInProcess(
	repo: string,
	workflowId: string,
	workspace: string,
): void {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters
	if (!workspace || workspace.length > 256 || /[\x00-\x1f]/.test(workspace))
		throw new Error("invalid return workspace identity");
	const file = navigationPath(repo, workflowId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporary,
		`${JSON.stringify({ workspace, at: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
	fs.renameSync(temporary, file);
}
export function discoverProjectsInProcess(): Array<{
	name: string;
	path: string;
	openspec: boolean;
}> {
	return listProjects();
}

export function dashboardState(repo: string, workflowId: string) {
	return viewToDashboardState(getWorkflowView(repo, workflowId));
}
export function viewToDashboardState(view: WorkflowView) {
	const verifierRuns = view.runs.filter(
		(run) => run.stepId === "core.verification",
	);
	const verificationRound = Math.max(
		0,
		...verifierRuns.map((run) => run.attempt),
	);
	const currentVerifierRuns = verifierRuns.filter(
		(run) => run.attempt === verificationRound,
	);
	const latestByRole = new Map<string, (typeof view.runs)[number]>();
	for (const run of view.runs) {
		const existing = latestByRole.get(run.role);
		if (!existing || existing.attempt <= run.attempt)
			latestByRole.set(run.role, run);
	}
	const panes = Object.fromEntries(
		[...latestByRole.values()].flatMap((run) =>
			run.paneId ? [[run.role, run.paneId]] : [],
		),
	);
	return {
		workflowId: view.workflowId,
		changeId: view.changeId,
		...(view.repository
			? { returnWorkspace: returnWorkspace(view.repository, view.workflowId) }
			: {}),
		phase: view.currentStep.id,
		stepId: view.currentStep.id,
		stepLabel: view.currentStep.label,
		revision: view.revision,
		definition: view.definition,
		status: view.status,
		health: view.health,
		developerDialogue: view.developerDialogue ?? [],
		pendingQuestions: view.pendingQuestions ?? [],
		availableActions: view.availableActions,
		repository: view.repository,
		worktree: view.worktree,
		branch: view.branch,
		task: view.task,
		workspace: view.workspace ?? "",
		verificationRound,
		baseCommit: view.baseCommit,
		createdAt: view.createdAt,
		phaseStartedAt: view.currentStep.enteredAt,
		panes,
		runs: view.runs,
		verificationRoles: currentVerifierRuns.map((run) => run.role),
		verificationModels: Object.fromEntries(
			currentVerifierRuns.flatMap((run) =>
				run.model ? [[run.role, run.model]] : [],
			),
		),
	};
}
