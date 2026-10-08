import { randomUUID } from "node:crypto";
import type {
	StartedBy,
	WorkflowPrincipal,
	WorkflowView,
} from "../../contracts/workflow.ts";
import {
	catalogManifestPolicy,
	effectiveFamilyTraits,
} from "../../workflow/definitions/manifest-policy.ts";
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
import { prepareBlueprintWorkflowStart } from "./blueprints.ts";

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
	principal?: WorkflowPrincipal,
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
		// The server-decided principal, so the event actor can name the
		// orchestrator; the operator is the default and stays unlabelled.
		...(principal === undefined ? {} : { principal }),
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
	sourceBranch?: string;
	targetBranch?: string;
}) {
	const definitionId =
		input.workflowType === "quick"
			? "no-openspec"
			: (input.workflowType ?? "openspec");
	// The launcher picks the family id; every family property it derives from
	// that id — the checkout contract and the ref-shaped start inputs — comes
	// from the family's declared policy and traits, never from comparing the id
	// (read-family-traits-instead-of-ids). The start boundary resolves the pinned
	// definition and re-derives the same decisions from it.
	const requirements = new Set(
		effectiveFamilyTraits({ id: definitionId })?.startRequirements ?? [],
	);
	const research = definitionId === "research";
	// The verify-only family verifies the branch the checkout is already on, so
	// it forces checkout mode and carries no extra input: it declares
	// `base-commit` instead of being a `sameCheckout` launch.
	const verify = requirements.has("base-commit");
	const sameCheckout =
		catalogManifestPolicy(definitionId)?.checkoutRequired === true && !verify;
	// The rebase family runs in the repository checkout, like the sameCheckout
	// families, but on the branch the launch selected rather than on the one that
	// happens to be checked out — so it forces checkout mode and carries its two
	// selected refs to the start boundary instead of setting `sameCheckout`.
	const rebase = requirements.has("rebase-refs");
	return {
		repo: research ? researchWorkflowTarget() : input.repo,
		...(research && input.repo ? { repositoryContext: input.repo } : {}),
		workflowId: validateWorkflowId(input.workflowId),
		definitionId,
		task: input.task || undefined,
		ticket: input.ticket || undefined,
		...(research
			? {}
			: {
					mode: sameCheckout || rebase || verify ? "checkout" : input.mode,
				}),
		...(sameCheckout ? { sameCheckout: true } : {}),
		...(rebase
			? {
					sourceBranch: input.sourceBranch,
					targetBranch: input.targetBranch,
				}
			: {}),
		...(input.preset && input.preset !== PRESET_CONFIG_DEFAULTS
			? { preset: input.preset }
			: {}),
	};
}
/** The presets a launch may select, plus the reason the agents config could not
 * be read. An empty name list on its own reads as "no presets configured",
 * which hides a broken profile: a caller that can show the failure takes it
 * from here instead of offering an empty picker. */
export interface PresetCatalog {
	names: string[];
	error?: string;
}

/** Preset names available for the new workflow modal's agent-preset step. */
export function presetCatalog(repository?: string): PresetCatalog {
	const resolved = loadConfigWithProvenance({ repository });
	try {
		const agents = parseAgentsConfig(
			resolved.config.agents,
			resolved.config,
			resolved.provenance.files.join(", ") || undefined,
		);
		return { names: Object.keys(agents.presets ?? {}).sort() };
	} catch (error) {
		return {
			names: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Preset names only, for a caller with nowhere to report a config failure
 * (see `presetCatalog`). */
export function listPresetNames(repository?: string): string[] {
	return presetCatalog(repository).names;
}
export async function startWorkflowInProcess(
	input: Parameters<typeof startArgs>[0] & {
		enforceHumanReviewGates?: boolean;
		startedBy?: StartedBy;
	},
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
		sourceBranch: args.sourceBranch,
		targetBranch: args.targetBranch,
		...(input.enforceHumanReviewGates ? { enforceHumanReviewGates: true } : {}),
		...(input.startedBy ? { startedBy: input.startedBy } : {}),
	});
	const engine = workflowEngineFactory(dashboardApplication);
	engine.start(prepared.input);
	requestWorkflowExecution(prepared.target, args.workflowId);
	return `Workflow started: ${args.workflowId}`;
}

/** Everything a blueprint start carries in addition to the ordinary start
 * fields: the compiled document and the principal its stored origin records. */
export interface BlueprintStartRequest {
	repo: string;
	workflowId: string;
	blueprint: unknown;
	task?: string;
	ticket?: string;
	mode?: string;
	preset?: string;
	principal?: WorkflowPrincipal;
	enforceHumanReviewGates?: boolean;
	startedBy?: StartedBy;
}

/**
 * Start a blueprint workflow (add-orchestrator-blueprint-workflows): the server
 * compiles the blueprint, stores its definition in the target repository's
 * store with its origin and principal, pins the blueprint's label, rationale
 * and digest on the workflow's metadata, and starts it through the same path a
 * built-in type uses. A blueprint the compiler rejects is refused by
 * `prepareBlueprintWorkflowStart` before anything is written.
 */
export async function startBlueprintWorkflowInProcess(
	input: BlueprintStartRequest,
): Promise<string> {
	const prepared = prepareBlueprintWorkflowStart({
		repo: input.repo,
		workflowId: input.workflowId,
		blueprint: input.blueprint,
		task: input.task,
		ticket: input.ticket,
		mode: input.mode as "worktree" | "checkout" | undefined,
		preset: input.preset,
		principal: input.principal,
		now: dashboardApplication.clock,
		...(input.enforceHumanReviewGates ? { enforceHumanReviewGates: true } : {}),
		...(input.startedBy ? { startedBy: input.startedBy } : {}),
	});
	const engine = workflowEngineFactory(dashboardApplication);
	engine.start(prepared.input);
	requestWorkflowExecution(prepared.target, input.workflowId);
	return `Workflow started: ${input.workflowId}`;
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
