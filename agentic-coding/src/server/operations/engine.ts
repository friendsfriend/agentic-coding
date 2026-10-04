import { randomUUID } from "node:crypto";
import type { WorkflowView } from "../../contracts/workflow.ts";
import { loadConfigWithProvenance } from "../../workflow/effects.ts";
import {
	dashboardApplication,
	disposeDashboardApplication,
	disposeExecutionCoordinator,
	executionCoordinator,
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
	requestWorkflowExecution,
	setCredentialPromptProvider,
	workflowExecutionError,
} from "../../workflow/execution-coordinator.ts";
import { engine as workflowEngineFactory } from "../../workflow/operations.ts";
import { parseAgentsConfig } from "../../workflow/profiles.ts";
import {
	loadProjectCatalog,
	type ProjectOption,
	projectOptions,
} from "../../workflow/project-catalog.ts";
import {
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

// Repository execution coordination and the shared application runtime moved
// to the root-owned `workflow/execution-coordinator.ts` (compose-unified-
// feature-shell, task 1.2). Re-exported here so existing dashboard callers and
// tests keep one import site while the backend-facing owner has no TUI imports.
export {
	dashboardApplication,
	disposeDashboardApplication,
	disposeExecutionCoordinator,
	executionCoordinator,
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
	requestWorkflowExecution,
	setCredentialPromptProvider,
	workflowExecutionError,
};

export function getWorkflowView(
	repo: string,
	workflowId: string,
): WorkflowView {
	const view = workflowEngineFactory(dashboardApplication).status(
		repo,
		workflowId,
	);
	const error = workflowExecutionError(repo, workflowId);
	return error
		? {
				...view,
				health: {
					...view.health,
					attention: [...view.health.attention, error],
					diagnostic: error,
				},
			}
		: view;
}
export function listWorkflowViews(repo: string): WorkflowView[] {
	return workflowEngineFactory(dashboardApplication).list(repo);
}

export function previewWorkflowRepair(repo: string, workflowId: string) {
	return workflowEngineFactory(dashboardApplication).previewRepair(
		repo,
		workflowId,
	);
}
export function repairWorkflow(
	repo: string,
	workflowId: string,
	revision: number,
	targetStep: string,
	reason = "",
) {
	const engine = workflowEngineFactory(dashboardApplication);
	const view = engine.status(repo, workflowId);
	if (view.revision !== revision)
		throw new Error(`stale revision ${revision}; current ${view.revision}`);
	const result = engine.dispatch(repo, {
		type: "operator.repair",
		workflowId: view.workflowId,
		revision,
		targetStep,
		reason,
	});
	requestWorkflowExecution(repo, workflowId);
	return result.view;
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
	const workflow = workflowEngineFactory(dashboardApplication);
	const view = workflow.status(repo, workflowId);
	const result = workflow.dispatch(repo, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision,
		actionId: "answer-question",
		input: "groupId" in answer ? answer : { questionId, ...answer },
	});
	requestWorkflowExecution(repo, workflowId);
	return result.view;
}

export async function switchWorkflowPreset(
	repo: string,
	workflowId: string,
	revision: number,
	preset: string,
): Promise<void> {
	const engine = workflowEngineFactory(dashboardApplication);
	engine.dispatch(repo, {
		type: "developer.action",
		workflowId,
		revision,
		actionId: "switch-preset",
		input: preset,
	});
	requestWorkflowExecution(repo, workflowId);
}

export async function runWorkflowAction(
	actionId: string,
	repo: string,
	workflowId: string,
	revision: number,
	input?: string,
): Promise<string> {
	const engine = workflowEngineFactory(dashboardApplication);
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
	requestWorkflowExecution(repo, workflowId);
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
			: (input.workflowType ?? "openspec");
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
	const resolved = loadConfigWithProvenance({ repository });
	try {
		const agents = parseAgentsConfig(
			resolved.config.agents,
			resolved.config,
			resolved.provenance.files.join(", ") || undefined,
		);
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
	const engine = workflowEngineFactory(dashboardApplication);
	engine.start(prepared.input);
	requestWorkflowExecution(prepared.target, args.workflowId);
	return `Workflow started: ${args.workflowId}`;
}

/** Start the home-only wiki review without requiring a repository. */
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
	const engine = workflowEngineFactory(dashboardApplication);
	engine.start(prepared.input);
	requestWorkflowExecution(prepared.target, sessionId);
	return `Wiki review workflow started: ${sessionId}`;
}
export async function discoverProjectsInProcess(): Promise<ProjectOption[]> {
	// All configured projects, including unavailable ones, so the picker can
	// show availability/detail diagnostics; the wizard refuses to start work on
	// an unavailable project instead of silently omitting it.
	return projectOptions(await loadProjectCatalog());
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
	return {
		workflowId: view.workflowId,
		changeId: view.changeId,
		phase: view.currentStep.id,
		stepId: view.currentStep.id,
		stepLabel: view.currentStep.label,
		revision: view.revision,
		definition: view.definition,
		status: view.status,
		health: view.health,
		developerDialogue: view.developerDialogue ?? [],
		classifierDecisions: view.classifierDecisions ?? [],
		gateDecisions: view.gateDecisions ?? [],
		pendingQuestions: view.pendingQuestions ?? [],
		availableActions: view.availableActions,
		repository: view.repository,
		worktree: view.worktree,
		branch: view.branch,
		task: view.task,
		verificationRound,
		baseCommit: view.baseCommit,
		createdAt: view.createdAt,
		phaseStartedAt: view.currentStep.enteredAt,
		...(view.selectedPreset ? { selectedPreset: view.selectedPreset } : {}),
		runs: view.runs,
		verificationRoles: currentVerifierRuns.map((run) => run.role),
		verificationModels: Object.fromEntries(
			currentVerifierRuns.flatMap((run) =>
				run.model ? [[run.role, run.model]] : [],
			),
		),
	};
}
