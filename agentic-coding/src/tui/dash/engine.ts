import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Herdr } from "../../herdr-client.ts";
import {
	drainEffects,
	listProjects,
	rolesForDefinition,
	runGit,
	validateStart,
	engine as workflowEngineFactory,
} from "../../workflow/cli.ts";
import type {
	WorkflowRouting,
	WorkflowView,
} from "../../workflow/contracts.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../../workflow/definitions.ts";
import { loadConfig } from "../../workflow/effects.ts";
import {
	type AgentsConfig,
	parseAgentsConfig,
	preflightProfile,
	type RoutingPreset,
	resolvePreset,
	resolveRouting,
	validatePresetCoverage,
} from "../../workflow/profiles.ts";
import type { WorkflowRegistry } from "../../workflow/registry.ts";
import {
	canonicalStorePath,
	validateChangeId,
	wikiWorkflowTarget,
} from "../../workflow/runtime.ts";
import {
	validateWikiReviewComments,
	type WikiReviewComment,
} from "../../workflow/wiki.ts";
import { credentialPromptBridge } from "./ui/CredentialsModal.tsx";

export function getWorkflowView(repo: string, change: string): WorkflowView {
	const engine = workflowEngineFactory();
	void drainEffects(engine, repo, credentialPromptBridge()).catch(
		() => undefined,
	);
	return engine.status(repo, change);
}
export function listWorkflowViews(repo: string): WorkflowView[] {
	return workflowEngineFactory().list(repo);
}
export function previewWorkflowRepair(repo: string, change: string) {
	return workflowEngineFactory().previewRepair(repo, change);
}
export function repairWorkflow(
	repo: string,
	change: string,
	revision: number,
	targetStep: string,
	reason = "",
) {
	const engine = workflowEngineFactory();
	const view = engine.status(repo, change);
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
	change: string,
	revision: number,
	questionId: string,
	answer: { kind: "option" | "custom" | "cancel"; value?: string },
): WorkflowView {
	const workflow = workflowEngineFactory();
	const view = workflow.status(repo, change);
	return workflow.dispatch(repo, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision,
		actionId: "answer-question",
		input: { questionId, ...answer },
	}).view;
}

export async function runWorkflowAction(
	actionId: string,
	repo: string,
	change: string,
	revision: number,
	input?: string,
): Promise<string> {
	const engine = workflowEngineFactory();
	const view = engine.status(repo, change);
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
	return JSON.stringify(engine.status(repo, change));
}
/** Sentinel choice meaning "use existing global config defaults"; stripped
 * before routing so it never reaches resolvePreset. */
export const PRESET_CONFIG_DEFAULTS = "(config defaults)";

export function startArgs(input: {
	repo: string;
	ticket: string;
	change: string;
	task?: string;
	mode: string;
	workflowType?: string;
	preset?: string;
}) {
	const definitionId =
		input.workflowType === "quick"
			? "no-openspec"
			: (input.workflowType ?? "standard");
	const sameCheckout = [
		"standard-propose",
		"fusion-propose",
		"wiki-only",
	].includes(definitionId);
	return {
		repo: input.repo,
		changeId: validateChangeId(input.change),
		definitionId,
		task: input.task || undefined,
		ticket: input.ticket || undefined,
		mode: sameCheckout ? "checkout" : input.mode,
		...(sameCheckout ? { sameCheckout: true } : {}),
		...(input.preset && input.preset !== PRESET_CONFIG_DEFAULTS
			? { preset: input.preset }
			: {}),
	};
}
/** Preset names available for the new workflow modal's agent-preset step. */
export function listPresetNames(): string[] {
	const config = loadConfig();
	try {
		const agents = parseAgentsConfig(config.agents, config);
		return Object.keys(agents.presets ?? {}).sort();
	} catch {
		return [];
	}
}
function resolveStartPreset(
	agents: AgentsConfig,
	presetName?: string,
): RoutingPreset | undefined {
	if (!presetName || presetName === PRESET_CONFIG_DEFAULTS) return undefined;
	return resolvePreset(agents, presetName);
}
/** Ordered plan-fusion planner count configured under the selected preset's
 * roles.fusion.plan table: the contiguous run planner-1..planner-N. An entry
 * beyond the run is rejected so an edited preset can never silently drop a
 * planner or launch an unintended count. */
export function fusionPlannerCount(preset: RoutingPreset | undefined): number {
	const table = (preset?.roles?.["fusion.plan"] ?? {}) as Record<
		string,
		unknown
	>;
	const has = (role: string): boolean =>
		typeof table[role] === "string" && table[role] !== "";
	for (const role of Object.keys(table)) {
		const match = /^planner-(\d+)$/.exec(role);
		if (match && Number(match[1]) > 5)
			throw new Error(
				`plan-fusion preset ${preset?.name} supports at most planner-5`,
			);
	}
	let count = 0;
	while (count < 5 && has(`planner-${count + 1}`)) count += 1;
	for (let index = count + 1; index <= 5; index += 1)
		if (has(`planner-${index}`))
			throw new Error(
				`plan-fusion preset ${preset?.name} requires contiguous planner roles: planner-${index} is set but planner-${count + 1} is missing`,
			);
	return count;
}
/** Shared dashboard-start routing: derives agent roles through the CLI's
 * rolesForDefinition (including the plan-fusion planner fan-out), validates
 * preset coverage, resolves routes via the existing preset precedence chain,
 * and rejects unusable plan-fusion configuration before any workspace or
 * agent effects occur. */
export function startRouting(
	definitionId: string,
	presetName: string | undefined,
	definition: ReturnType<WorkflowRegistry["definition"]>,
	registry: Pick<WorkflowRegistry, "step">,
	agents: AgentsConfig,
): WorkflowRouting {
	const preset = resolveStartPreset(agents, presetName);
	const roles = rolesForDefinition(
		definitionId,
		definition.steps,
		registry,
		["plan-fusion", "fusion-propose"].includes(definitionId)
			? fusionPlannerCount(preset)
			: 0,
	);
	if (preset)
		validatePresetCoverage(preset, definition, Object.keys(roles), agents);
	const routing = resolveRouting(definition, roles, agents, preset);
	if (["plan-fusion", "fusion-propose"].includes(definitionId)) {
		// Mirror the engine's defensive start-time checks with clearer errors
		// before git inspection, workspace creation, or agent launches.
		const planners = routing.routes.filter(
			(route) => route.stepId === "fusion.plan",
		);
		if (planners.length < 2 || planners.length > 5)
			throw new Error(
				`${definitionId} requires between 2 and 5 planner routings`,
			);
		const names = planners.map((route) => route.profile.name);
		if (new Set(names).size !== names.length)
			throw new Error(`${definitionId} requires distinct planner profiles`);
	}
	return routing;
}
export async function startWorkflowInProcess(
	input: Parameters<typeof startArgs>[0],
): Promise<string> {
	const args = startArgs(input);
	validateStart(args.repo, args.changeId, args.definitionId, args.task);
	const config = loadConfig();
	const definitionVersion = definitionVersionForPolicy(
		config.workflow.max_verification_rounds,
	);
	const registry = registerBuiltins(
		undefined,
		config.workflow.max_verification_rounds,
	);
	const definition = registry.definition(args.definitionId, definitionVersion);
	const agents = parseAgentsConfig(config.agents, config);
	const routing = startRouting(
		args.definitionId,
		args.preset,
		definition,
		registry,
		agents,
	);
	for (const route of routing.routes)
		preflightProfile(route.profile, registry.step(route.stepId).requirements);
	const sameCheckout = args.sameCheckout === true;
	const baseCommit = sameCheckout
		? runGit(args.repo, "rev-parse", "HEAD")
		: runGit(args.repo, "rev-parse", `${config.workflow.base_branch}^{commit}`);
	if (!sameCheckout)
		runGit(args.repo, "remote", "get-url", config.workflow.remote);
	const branch = sameCheckout
		? runGit(args.repo, "branch", "--show-current")
		: `${config.workflow.branch_prefix}${args.changeId}`;
	if (sameCheckout && !branch)
		throw new Error(
			"repository-backed workflows require a named current branch",
		);
	const engine = workflowEngineFactory();
	engine.start({
		repo: args.repo,
		mode: args.mode as "worktree" | "checkout",
		sameCheckout: args.sameCheckout,
		changeId: args.changeId,
		definitionId: args.definitionId,
		definitionVersion,
		metadata: {
			branch,
			baseBranch: config.workflow.base_branch,
			baseCommit,
			...(args.task ? { task: args.task } : {}),
			...(args.ticket ? { ticket: args.ticket } : {}),
		},
		routing,
	});
	await drainEffects(engine, args.repo, credentialPromptBridge());
	return `Workflow started: ${args.changeId}`;
}

/** Start the home-only wiki review without requiring a repository or blocking
 * the UI while Herdr creates the workspace and launches the agent. */
export function startWikiCommentWorkflowInProcess(
	input: readonly WikiReviewComment[],
	sessionId = `wiki-review-${randomUUID()}`,
): string {
	const comments = validateWikiReviewComments(input);
	const config = loadConfig();
	const definitionVersion = definitionVersionForPolicy(
		config.workflow.max_verification_rounds,
	);
	const registry = registerBuiltins(
		undefined,
		config.workflow.max_verification_rounds,
	);
	const definition = registry.definition(
		"wiki-comment-review",
		definitionVersion,
	);
	const agents = parseAgentsConfig(config.agents, config);
	const routing = startRouting(
		"wiki-comment-review",
		undefined,
		definition,
		registry,
		agents,
	);
	for (const route of routing.routes)
		preflightProfile(route.profile, registry.step(route.stepId).requirements);
	const engine = workflowEngineFactory();
	engine.start({
		repo: wikiWorkflowTarget(),
		changeId: validateChangeId(sessionId),
		definitionId: "wiki-comment-review",
		definitionVersion,
		context: JSON.parse(JSON.stringify({ comments })),
		metadata: {
			branch: "",
			baseBranch: "",
			baseCommit: "",
			task: "Address the submitted wiki review comments.",
		},
		routing,
	});
	void drainEffects(
		engine,
		wikiWorkflowTarget(),
		credentialPromptBridge(),
	).catch(() => undefined);
	return `Wiki review workflow started: ${sessionId}`;
}
function navigationPath(repo: string, change: string): string {
	return path.join(
		path.dirname(canonicalStorePath(repo)),
		"navigation",
		`${encodeURIComponent(change)}.json`,
	);
}
function returnWorkspace(repo: string, change: string): string | undefined {
	let file: string | undefined;
	try {
		file = navigationPath(repo, change);
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
	change: string,
	workspace: string,
): void {
	try {
		const file = navigationPath(repo, change);
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
			workspace?: unknown;
		};
		if (value.workspace === workspace) fs.rmSync(file, { force: true });
	} catch {}
}
export function setReturnInProcess(
	repo: string,
	change: string,
	workspace: string,
): void {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters
	if (!workspace || workspace.length > 256 || /[\x00-\x1f]/.test(workspace))
		throw new Error("invalid return workspace identity");
	const file = navigationPath(repo, change);
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

export function dashboardState(repo: string, change: string) {
	return viewToDashboardState(getWorkflowView(repo, change));
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
		changeId: view.changeId,
		...(view.repository
			? { returnWorkspace: returnWorkspace(view.repository, view.changeId) }
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
