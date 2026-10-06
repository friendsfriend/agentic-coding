// Workflow data selectors (establish-opencode-boundaries, task 4.1).
//
// List/get/start/action/handoff/repair/preview/question through the gateway
// port. Nothing here imports the workflow engine, server internals, the
// filesystem or Git: the transport decision belongs to the adapter
// behind the port, and projections stay pure.
import { Schema } from "effect";
import type {
	AgentHandoffRequest,
	AgentResearchHandoffRequest,
	ReviewSaveRequest,
	WorkflowActionRequest,
	WorkflowDeletion,
	WorkflowRepairRequest,
	WorkflowStartRequest,
} from "../../contracts/actions.ts";
import type {
	DashboardData,
	DeveloperReviewComment,
	PlanReviewComment,
	WikiReviewComment,
	WorkflowOverview,
	WorkflowView,
} from "../../contracts/workflow.ts";
import {
	fetchProjectCatalog,
	type ProjectCatalogOptions,
	type ProjectOption,
} from "../../workflow/project-catalog.ts";

/** The configured-project option shape the creation form renders. */
export type { ProjectOption };

import {
	cache,
	dashboardKey,
	gateway,
	viewsKey,
	workflowKey,
} from "./index.ts";

/** The dashboard read is a composite of contract records; the observation
 * decodes the envelope and the composite is typed by the contract interface. */
const compositeSchema = Schema.Unknown;

export interface DataReadOptions {
	readonly signal?: AbortSignal;
	readonly refresh?: boolean;
}

/** Reads take the caller's cancellation signal as their last argument, matching
 * the shape the dashboard already uses for observation reads. */
type Signal = AbortSignal | undefined;

/** Every workflow view of one repository, cached per repository. */
export async function listViews(
	repo: string,
	signal?: Signal,
): Promise<WorkflowView[] | undefined> {
	return cache.load(
		viewsKey(repo),
		(signal) => gateway().listViews(repo, signal),
		{ signal },
	);
}

/** One workflow view, cached by repository + workflow id. */
export async function loadView(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<WorkflowView | undefined> {
	return cache.load(
		workflowKey(repo, workflowId),
		(signal) => gateway().view(repo, workflowId, signal),
		{
			signal,
		},
	);
}

/** Fast first paint from the cheap workflow view; full observations follow. */
export async function loadDashboardSeed(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<DashboardData | undefined> {
	const view = await loadView(repo, workflowId, signal);
	if (!view) return undefined;
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
	// Latest run per role, selected by attempt (the same per-role projection the
	// server observation applies; inlined because the data layer may not reach
	// the workflow run projections).
	const latest = new Map<string, (typeof view.runs)[number]>();
	for (const run of view.runs) {
		const existing = latest.get(run.role);
		if (!existing || existing.attempt <= run.attempt) latest.set(run.role, run);
	}
	// One timeline entry per verifier role, from the same latest run the Agents
	// row represents: a verifier a later round did not re-select keeps its
	// verdict here exactly as the full observation reports it.
	const latestVerifierRuns = new Map<string, (typeof view.runs)[number]>();
	for (const run of verifierRuns) {
		const existing = latestVerifierRuns.get(run.role);
		if (!existing || existing.attempt <= run.attempt)
			latestVerifierRuns.set(run.role, run);
	}
	const state = {
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
	const verifierTimeline = [...latestVerifierRuns.values()].map((run) => ({
		role: run.role,
		status:
			run.status === "completed"
				? "PASS"
				: run.status === "working" || run.status === "pending"
					? "RUN"
					: "FAIL",
		rawStatus: run.status,
		model: run.model,
		providerErrors: 0,
		fallback: false,
	}));
	const now = Date.now();
	const createdAt = Date.parse(view.createdAt);
	const updatedAt = Date.parse(view.updatedAt);
	return {
		state,
		request: view.task?.trim() || "No request recorded",
		proposal: "Loading proposal…",
		review: "Not run",
		reviewHistory: [],
		agents: [...latest].flatMap(([role, run]) =>
			["git", "dashboard"].includes(role)
				? []
				: [
						{
							role,
							status: run.status,
							runtime: run.runtime,
							model: run.model,
							runId: run.id,
							...(run.hostSocket ? { hostSocket: run.hostSocket } : {}),
							...(run.conversationId
								? { conversationId: run.conversationId }
								: {}),
						},
					],
		),
		updated: Number.isNaN(updatedAt)
			? ""
			: new Date(updatedAt).toLocaleTimeString(),
		health: {
			dirty: false,
			ahead: 0,
			behind: 0,
			branch: view.branch,
		},
		gitStatus: {
			available: false,
			branch: view.branch,
			changedFiles: 0,
			addedFiles: 0,
			deletedFiles: 0,
			noUpstream: true,
		},
		age: Number.isNaN(createdAt)
			? "unknown"
			: `${Math.max(0, Math.floor((now - createdAt) / 3600000))}h`,
		events: [],
		verifierTimeline,
		costBreakdown: [],
	};
}

/** The dashboard projection for one workflow (server-composed read).
 * `refresh: true` bypasses the cache for an authoritative re-read — the
 * periodic safety resync uses it so a dropped backend event cannot leave the
 * view stale. */
export async function loadDashboard(
	repo: string,
	workflowId: string,
	signal?: Signal,
	options: { readonly refresh?: boolean } = {},
): Promise<DashboardData | undefined> {
	return cache.load(
		dashboardKey(repo, workflowId),
		(signal) =>
			gateway().observe<DashboardData>(
				{ kind: "dashboard", repo, workflowId },
				compositeSchema,
				signal,
			),
		{
			signal,
			...(options.refresh ? { refresh: true } : {}),
		},
	);
}

/** Mutations return the committed view; the caller renders what the server
 * committed instead of a locally guessed revision. */
export async function runAction(
	request: WorkflowActionRequest,
): Promise<WorkflowView> {
	const view = await gateway().action(request);
	cache.invalidate(workflowKey(request.repo, request.workflowId));
	cache.invalidate(dashboardKey(request.repo, request.workflowId));
	cache.invalidate(viewsKey(request.repo));
	return view;
}

export async function startWorkflow(
	request: WorkflowStartRequest,
): Promise<string> {
	const workflowId = await gateway().start(request);
	cache.invalidate(viewsKey(request.repo));
	return workflowId;
}

/** Delete one durable workflow and its worktree (the branch is kept). The
 * overview list is cached under one unkeyed entry, so it is invalidated
 * explicitly instead of waiting for the next poll. */
export async function deleteWorkflow(
	repo: string,
	workflowId: string,
): Promise<WorkflowDeletion> {
	const deletion = await gateway().deleteWorkflow({ repo, workflowId });
	cache.invalidate("workflows");
	cache.invalidate(workflowKey(repo, workflowId));
	cache.invalidate(dashboardKey(repo, workflowId));
	cache.invalidate(viewsKey(repo));
	return deletion;
}

export async function repairWorkflow(
	request: WorkflowRepairRequest,
): Promise<WorkflowView> {
	const view = await gateway().repair(request);
	cache.invalidate(workflowKey(request.repo, request.workflowId));
	cache.invalidate(dashboardKey(request.repo, request.workflowId));
	return view;
}

export async function answerQuestion(
	repo: string,
	workflowId: string,
	revision: number,
	questionId: string,
	answer: unknown,
): Promise<WorkflowView> {
	const view = await gateway().question({
		repo,
		workflowId,
		revision,
		questionId,
		answer,
	});
	cache.invalidate(workflowKey(repo, workflowId));
	cache.invalidate(dashboardKey(repo, workflowId));
	return view;
}

export async function requestExecution(
	repo: string,
	workflowId?: string,
): Promise<void> {
	await gateway().execute({
		repo,
		...(workflowId ? { workflowId } : {}),
	});
	if (workflowId) {
		cache.invalidate(workflowKey(repo, workflowId));
		cache.invalidate(dashboardKey(repo, workflowId));
	}
}

export async function agentHandoff(
	request: AgentHandoffRequest,
): Promise<WorkflowView> {
	const view = await gateway().agentHandoff(request);
	cache.invalidate(workflowKey(request.repo, view.workflowId));
	cache.invalidate(dashboardKey(request.repo, view.workflowId));
	return view;
}

export async function researchHandoff(
	request: AgentResearchHandoffRequest,
): Promise<WorkflowView> {
	const view = await gateway().researchHandoff(request);
	cache.invalidate(workflowKey(request.repo, view.workflowId));
	cache.invalidate(dashboardKey(request.repo, view.workflowId));
	return view;
}

/** Repair preview (which steps can be re-run and what they cost). */
export async function previewRepair(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<unknown> {
	return gateway().observe(
		{ kind: "repair-preview", repo, workflowId },
		compositeSchema,
		signal,
	);
}

/** Persist review comments; the review kinds share one contract request. */
export async function saveReview(request: ReviewSaveRequest): Promise<void> {
	await gateway().saveReview(request);
	if (request.workflowId) {
		cache.invalidate(workflowKey(request.repo, request.workflowId));
		cache.invalidate(dashboardKey(request.repo, request.workflowId));
	}
}

/** Workflow overviews for the history list (the `workflows` observation).
 * `options.refresh` bypasses the cache for the sidebar's bounded poll. */
export async function loadOverviews(
	signal?: Signal,
	options?: DataReadOptions,
): Promise<WorkflowOverview[] | undefined> {
	return cache.load(
		"workflows",
		(signal) =>
			gateway().observe<WorkflowOverview[]>(
				{ kind: "workflows" },
				compositeSchema,
				signal,
			),
		{ signal, ...(options?.refresh ? { refresh: true } : {}) },
	);
}

/** Verifier findings for one role, and the committed report body. */
export async function loadVerifierFindings<T = unknown>(
	repo: string,
	workflowId: string,
	role: string,
	signal?: Signal,
): Promise<T | undefined> {
	return cache.load(
		`workflow:${repo}:${workflowId}:findings:${role}`,
		(signal) =>
			gateway().observe<T>(
				{ kind: "verifier-findings", repo, workflowId, role },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

export async function loadVerifierReport<T = unknown>(
	repo: string,
	workflowId: string,
	role: string,
	signal?: Signal,
): Promise<T | undefined> {
	return cache.load(
		`workflow:${repo}:${workflowId}:report:${role}`,
		(signal) =>
			gateway().observe<T>(
				{ kind: "verifier-report", repo, workflowId, role },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

/** Findings a developer review recorded. */
export async function loadDeveloperReviewFindings<T = unknown>(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<T | undefined> {
	return cache.load(
		`workflow:${repo}:${workflowId}:review-findings`,
		(signal) =>
			gateway().observe<T>(
				{ kind: "developer-review-findings", repo, workflowId },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

/** Discover configured projects for the creation form. */
export async function discoverProjects(
	signal?: Signal,
): Promise<ProjectOption[] | undefined> {
	return cache.load(
		"projects",
		(signal) =>
			gateway().observe<ProjectOption[]>(
				{ kind: "projects" },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

/** Changed files a repository reports (the `changes` observation). */
export async function discoverChanges(
	repo: string,
	signal?: Signal,
): Promise<string[] | undefined> {
	return cache.load(
		`changes:${repo}`,
		(signal) =>
			gateway().observe<string[]>(
				{ kind: "changes", repo },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

/** The branches a rebase launch may select: the current branch, the local
 * branches (source), and the remote refs (target), plus the target the picker
 * preselects. Read from the running checkout each time the selected repository
 * changes, so a branch created outside the form is offered on the next open. */
export interface BranchOptions {
	current: string;
	local: string[];
	remote: string[];
	default: string;
}

export async function discoverBranches(
	repo: string,
	signal?: Signal,
): Promise<BranchOptions | undefined> {
	return cache.load(
		`branches:${repo}`,
		(signal) =>
			gateway().observe<BranchOptions>(
				{ kind: "branches", repo },
				compositeSchema,
				signal,
			),
		{ signal },
	);
}

/** Repair preview applied through the gateway (the operation itself is
 * revision-guarded server-side). */
export async function applyRepair(
	repo: string,
	workflowId: string,
	revision: number,
	targetStep: string,
	reason?: string,
): Promise<WorkflowView> {
	const view = await gateway().repair({
		repo,
		workflowId,
		revision,
		targetStep,
		...(reason ? { reason } : {}),
	});
	cache.invalidate(workflowKey(repo, workflowId));
	cache.invalidate(dashboardKey(repo, workflowId));
	return view;
}

/** Run one workflow action and return the engine's answer (the same JSON string
 * the observation boundary returned before the data layer existed). */
export async function runWorkflow(
	action: string,
	repo: string,
	workflowId: string,
	revision: number,
	argument?: string,
): Promise<string> {
	let input: unknown;
	if (argument) {
		try {
			input = JSON.parse(argument);
		} catch {
			input = argument;
		}
	}
	const view = await gateway().action({
		repo,
		workflowId,
		revision,
		actionId: action,
		...(input === undefined ? {} : { input }),
	});
	cache.invalidate(workflowKey(repo, workflowId));
	cache.invalidate(dashboardKey(repo, workflowId));
	return JSON.stringify(view);
}

/** Review saves: one gateway call per review kind, keeping the call shape the
 * review feature already used. */
export async function saveDeveloperReview(
	repo: string,
	workflowId: string,
	comments: DeveloperReviewComment[],
): Promise<void> {
	return saveReview({ repo, workflowId, kind: "developer", comments });
}

export async function savePlanReview(
	repo: string,
	workflowId: string,
	comments: PlanReviewComment[],
): Promise<void> {
	return saveReview({ repo, workflowId, kind: "plan", comments });
}

export async function saveWikiReview(
	repo: string,
	workflowId: string,
	comments: WikiReviewComment[],
): Promise<void> {
	return saveReview({ repo, workflowId, kind: "wiki", comments });
}

/** The configured project catalog (settings and launch surfaces read it). */
export async function loadProjectCatalog(
	options: ProjectCatalogOptions = {},
): Promise<Awaited<ReturnType<typeof fetchProjectCatalog>> | undefined> {
	const key = options.baseUrl
		? `projects:catalog:${options.baseUrl}`
		: "projects:catalog";
	return cache.load(
		key,
		(readSignal) => fetchProjectCatalog({ ...options, signal: readSignal }),
		{ signal: options.signal },
	);
}
