import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type {
	WorkflowExecutionSettings,
	WorkflowRouting,
} from "../contracts/workflow.ts";
import { runGit } from "./cli/git.ts";
import { registry as defaultRegistry } from "./cli/registry.ts";
import type { WorkflowRuntimeError } from "./contracts.ts";
import { definitionVersionForResearchTools } from "./definitions/manifest-policy.ts";
import {
	definitionVersionForBehaviorPins,
	PUBLIC_WORKFLOW_CATALOG,
	registerBuiltins,
	removedWorkflowHint,
} from "./definitions.ts";
import {
	type ConfigOptions,
	type ConfigProvenance,
	executionSettings,
	loadConfigWithProvenance,
	type WorkflowConfig,
} from "./effects.ts";
import {
	type AgentsConfig,
	applyFusionRoster,
	defaultPoolEntries,
	enforceReadOnlySteps,
	isClassifierRouted,
	parseAgentsConfig,
	preflightProfile,
	type RoutingPreset,
	resolvePreset,
	resolveRouting,
	SETTINGS_PRESETS_HINT,
	validatePresetCoverage,
} from "./profiles.ts";
import type { WorkflowRegistry } from "./registry.ts";
import {
	toRuntimeError,
	WorkflowConfig as WorkflowConfigService,
} from "./runtime/services.ts";
import {
	researchWorkflowTarget,
	validateWorkflowId,
	type WorkflowEngine,
	wikiWorkflowTarget,
} from "./runtime.ts";
import type { StepBehavior } from "./steps/types.ts";

export interface WorkflowStartRequest {
	repo?: string;
	repositoryContext?: string;
	workflowId: string;
	definitionId: string;
	task?: string;
	ticket?: string;
	mode?: "worktree" | "checkout";
	preset?: string;
	context?: Record<string, unknown>;
}

export interface PreparedWorkflowStart {
	input: Parameters<WorkflowEngine["start"]>[0];
	target: string;
	config: WorkflowConfig;
	provenance: ConfigProvenance;
}

export function validateStart(
	repo: string,
	workflowId: string,
	workflow: string,
	task?: string,
): void {
	if (workflow === "research") {
		if (!task?.trim())
			throw new Error("research workflow requires non-empty task");
		if (repo)
			runGit(
				fs.realpathSync(path.resolve(repo)),
				"rev-parse",
				"--show-toplevel",
			);
		return;
	}
	if (workflow === "wiki") {
		if (!task?.trim()) throw new Error("wiki workflow requires non-empty task");
		return;
	}
	const dirty = runGit(repo, "status", "--porcelain");
	const proposal = ["openspec-propose", "openspec-fusion-propose"].includes(
		workflow,
	);
	if (dirty && !proposal)
		throw new Error("working tree must be clean before workflow start");
	if (workflow === "no-openspec") {
		if (!task?.trim())
			throw new Error("no-openspec workflow requires non-empty task");
		return;
	}
	if (!fs.existsSync(path.join(repo, "openspec", "config.yaml")))
		throw new Error("OpenSpec project required for this workflow");
	if (workflow === "openspec-apply") {
		const root = path.join(repo, "openspec", "changes", workflowId);
		for (const file of ["proposal.md", "design.md", "tasks.md"])
			if (
				!fs.existsSync(path.join(root, file)) ||
				!fs.readFileSync(path.join(root, file), "utf8").trim()
			)
				throw new Error(`invalid openspec-apply artifact: ${file}`);
		const tasks = fs.readFileSync(path.join(root, "tasks.md"), "utf8");
		if (!/\[ \]/.test(tasks))
			throw new Error("openspec-apply requires actionable unchecked task");
		const result = Bun.spawnSync(
			["openspec", "validate", workflowId, "--strict"],
			{
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (result.exitCode !== 0)
			throw new Error(
				`OpenSpec validation failed: ${(result.stderr.toString() || result.stdout.toString()).trim()}`,
			);
	}
}

export function rolesForDefinition(
	definitionId: string,
	steps: readonly string[],
	registry: Pick<
		WorkflowRegistry,
		"step" | "stepForDefinition"
	> = defaultRegistry,
	fusionPlannerCount = 0,
	definition?: ReturnType<WorkflowRegistry["definition"]>,
): Record<string, string[]> {
	const roles: Record<string, string[]> = {};
	const pinned = definition ?? { id: definitionId, steps };
	for (const stepId of steps) {
		const step = registry.stepForDefinition(pinned, stepId);
		if (step.actor !== "agent") continue;
		const candidateRoles = step.behavior?.candidateRoles;
		if (!candidateRoles)
			throw new Error(`missing candidate roles for agent step ${stepId}`);
		const resolved = candidateRoles({ definitionId, fusionPlannerCount });
		if (!Array.isArray(resolved))
			throw new Error(`invalid candidate roles for ${stepId}`);
		if (stepId !== "fusion.plan" && !resolved.length)
			throw new Error(`empty candidate roles for agent step ${stepId}`);
		roles[stepId] = resolved;
	}
	return roles;
}

function fusionPlannerDefaults(preset: RoutingPreset | undefined): string[] {
	return defaultPoolEntries(preset, "fusion.plan").map(
		(entry) => entry.profile,
	);
}

export const fusionPlannerCount = (preset: RoutingPreset | undefined): number =>
	fusionPlannerDefaults(preset).length;

function startPreset(
	agents: AgentsConfig,
	name?: string,
): RoutingPreset | undefined {
	return name ? resolvePreset(agents, name) : undefined;
}

/** Build a definition's pinned routing at start. Classifiable steps seed from
 * their pool's tagged defaults; a fusion roster seeds `planner-1..N` from the
 * `fusion.plan` tagged defaults; a classifier-routed definition without a
 * preset fails before any agent launches. */
function resolveRoutingForStart(
	definitionId: string,
	definition: ReturnType<WorkflowRegistry["definition"]>,
	registry: WorkflowRegistry,
	agents: AgentsConfig,
	presetName?: string,
): WorkflowRouting {
	const preset = startPreset(agents, presetName);
	if (isClassifierRouted(definition) && !preset)
		throw new Error(
			`classifier-routed workflow ${definitionId} requires a preset; create model pools in ${SETTINGS_PRESETS_HINT}`,
		);
	const fusion = definitionId.startsWith("openspec-fusion");
	const defaults = fusion ? fusionPlannerDefaults(preset) : [];
	const roles = rolesForDefinition(
		definitionId,
		definition.steps,
		registry,
		defaults.length,
		definition,
	);
	if (preset)
		validatePresetCoverage(preset, definition, Object.keys(roles), agents);
	let routing = resolveRouting(definition, roles, agents, preset);
	if (defaults.length) routing = applyFusionRoster(routing, agents, defaults);
	const enforced = enforceReadOnlySteps(
		routing,
		(stepId) => registry.stepForDefinition(definition, stepId).requirements,
	);
	const planners = enforced.routes.filter(
		(route) => route.stepId === "fusion.plan",
	);
	if (fusion && (planners.length < 2 || planners.length > 5))
		throw new Error(
			`${definitionId} requires between 2 and 5 planner routings; edit the fusion.plan pool in ${SETTINGS_PRESETS_HINT}`,
		);
	if (
		fusion &&
		new Set(planners.map((route) => route.profile.name)).size !==
			planners.length
	)
		throw new Error(
			"fusion workflow requires distinct planner profiles; edit the fusion.plan pool in " +
				SETTINGS_PRESETS_HINT,
		);
	return enforced;
}

/** Shared routing boundary used by dashboard controls and startup execution. */
export function startRouting(
	definitionId: string,
	presetName: string | undefined,
	definition: ReturnType<WorkflowRegistry["definition"]>,
	registry: WorkflowRegistry,
	agents: AgentsConfig,
): WorkflowRouting {
	return resolveRoutingForStart(
		definitionId,
		definition,
		registry,
		agents,
		presetName === "Config defaults" ? undefined : presetName,
	);
}

interface PreparedStartContext {
	repo: string;
	target: string;
	independent: boolean;
	options: ConfigOptions;
	workflowId: string;
}

function registeredDefinition(id: string): boolean {
	return (
		id === "wiki-comments" ||
		PUBLIC_WORKFLOW_CATALOG.some((item) => item.id === id)
	);
}

/** Actionable `unknown/removed definition` text naming the id and a registered
 * alternative, instead of a bare registry lookup failure. */
export function removedDefinitionDiagnostic(id: string): string {
	const hint = removedWorkflowHint(id) ?? `unknown/removed definition: ${id}`;
	const registered = PUBLIC_WORKFLOW_CATALOG.map((item) => item.id).join(", ");
	return `${hint}; registered definitions: ${registered}`;
}

/** Stage 1 of shared startup: resolve the target repository/worktree and the
 * config options used for the provenance-resolved load. Pure/sync; the Effect
 * boundary loads the config through `WorkflowConfig`. */
function startupContext(request: WorkflowStartRequest): PreparedStartContext {
	if (
		request.definitionId !== "wiki-comments" &&
		!registeredDefinition(request.definitionId)
	)
		throw new Error(removedDefinitionDiagnostic(request.definitionId));
	const workflowId = validateWorkflowId(request.workflowId);
	const research = request.definitionId === "research";
	const wikiOnly = request.definitionId === "wiki-comments";
	const repo = research
		? request.repositoryContext
			? fs.realpathSync(path.resolve(request.repositoryContext))
			: ""
		: wikiOnly
			? ""
			: fs.realpathSync(path.resolve(request.repo ?? ""));
	const target = research
		? researchWorkflowTarget()
		: wikiOnly
			? wikiWorkflowTarget()
			: repo;
	const independent = wikiOnly || (research && !request.repositoryContext);
	return {
		repo,
		target,
		independent,
		options: {
			repository: independent ? undefined : repo,
			repositoryIndependent: independent,
		},
		workflowId,
	};
}

/** Stage 2 of shared startup: derive routing, profiles, preflight, and git
 * evidence from the loaded config. Pure routing/profile helpers stay here. */
function prepareFromContext(
	request: WorkflowStartRequest,
	ctx: PreparedStartContext,
	config: WorkflowConfig,
	provenance: ConfigProvenance,
	settings: WorkflowExecutionSettings,
): PreparedWorkflowStart {
	const definitionVersion =
		request.definitionId === "research"
			? definitionVersionForResearchTools(
					config.workflow.max_verification_rounds,
				)
			: definitionVersionForBehaviorPins(
					config.workflow.max_verification_rounds,
				);
	const registry = registerBuiltins(
		undefined,
		config.workflow.max_verification_rounds,
	);
	const definition = registry.definition(
		request.definitionId,
		definitionVersion,
	);
	const agents = parseAgentsConfig(
		config.agents,
		config,
		provenance.files.join(", ") || undefined,
	);
	const routing = resolveRoutingForStart(
		request.definitionId,
		definition,
		registry,
		agents,
		request.preset,
	);
	for (const route of routing.routes)
		preflightProfile(
			route.profile,
			registry.stepForDefinition(definition, route.stepId).requirements,
		);
	const wikiOnly =
		request.definitionId === "wiki-comments" ||
		ctx.target === wikiWorkflowTarget();
	if (!wikiOnly)
		validateStart(ctx.repo, ctx.workflowId, request.definitionId, request.task);
	const sameCheckout = [
		"openspec-propose",
		"openspec-fusion-propose",
		"wiki",
	].includes(request.definitionId);
	const research = request.definitionId === "research";
	if (!research && !wikiOnly && sameCheckout && request.mode !== "checkout")
		throw new Error("repository-backed workflows require checkout mode");
	const baseCommit =
		research || wikiOnly
			? ""
			: sameCheckout
				? runGit(ctx.repo, "rev-parse", "HEAD")
				: runGit(
						ctx.repo,
						"rev-parse",
						`${config.workflow.base_branch}^{commit}`,
					);
	if (!research && !wikiOnly && !sameCheckout)
		runGit(ctx.repo, "remote", "get-url", config.workflow.remote);
	const branch =
		research || wikiOnly
			? ""
			: sameCheckout
				? runGit(ctx.repo, "branch", "--show-current")
				: `${config.workflow.branch_prefix}${ctx.workflowId}`;
	if (!research && !wikiOnly && sameCheckout && !branch)
		throw new Error(
			"repository-backed workflows require a named current branch",
		);
	return {
		config,
		provenance,
		target: ctx.target,
		input: {
			repo: ctx.target,
			...(research && ctx.repo ? { repositoryContext: ctx.repo } : {}),
			...(request.mode ? { mode: request.mode } : {}),
			sameCheckout,
			workflowId: ctx.workflowId,
			definitionId: request.definitionId,
			definitionVersion,
			...(request.context
				? { context: JSON.parse(JSON.stringify(request.context)) }
				: {}),
			metadata: {
				branch,
				baseBranch: research || wikiOnly ? "" : config.workflow.base_branch,
				baseCommit,
				...(request.task?.trim() ? { task: request.task.trim() } : {}),
				...(request.ticket ? { ticket: request.ticket } : {}),
				...(request.preset ? { selectedPreset: request.preset } : {}),
				executionSettings: settings,
			},
			routing,
		},
	};
}

export function prepareWorkflowStart(
	request: WorkflowStartRequest,
): PreparedWorkflowStart {
	const ctx = startupContext(request);
	const resolved = loadConfigWithProvenance(ctx.options);
	return prepareFromContext(
		request,
		ctx,
		resolved.config,
		resolved.provenance,
		executionSettings(resolved.config, resolved.provenance),
	);
}

/** Shared Effect application preparation used by CLI and dashboard entry
 * points: config provenance and execution settings resolve through the
 * `WorkflowConfig` service; routing/profile decisions stay pure. */
export function prepareWorkflowStartEffect(
	request: WorkflowStartRequest,
): Effect.Effect<
	PreparedWorkflowStart,
	WorkflowRuntimeError,
	WorkflowConfigService
> {
	return Effect.gen(function* () {
		const service = yield* WorkflowConfigService;
		const ctx = yield* Effect.try({
			try: () => startupContext(request),
			catch: toRuntimeError,
		});
		const resolved = yield* service.load(ctx.options);
		const settings = yield* service.executionSettingsOf(
			resolved.config,
			resolved.provenance,
		);
		return yield* Effect.try({
			try: () =>
				prepareFromContext(
					request,
					ctx,
					resolved.config,
					resolved.provenance,
					settings,
				),
			catch: toRuntimeError,
		});
	});
}

export function startWorkflow(
	request: WorkflowStartRequest,
	engine: WorkflowEngine,
): PreparedWorkflowStart {
	const prepared = prepareWorkflowStart(request);
	engine.start(prepared.input);
	return prepared;
}

export type { StepBehavior };
