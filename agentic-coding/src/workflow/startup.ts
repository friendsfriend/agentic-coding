import fs from "node:fs";
import path from "node:path";
import { runGit } from "./cli/git.ts";
import { registry as defaultRegistry } from "./cli/registry.ts";
import type { WorkflowRouting } from "./contracts.ts";
import {
	definitionVersionForManifestPolicy,
	PUBLIC_WORKFLOW_CATALOG,
	registerBuiltins,
} from "./definitions.ts";
import {
	type ConfigProvenance,
	executionSettings,
	loadConfigWithProvenance,
	type WorkflowConfig,
} from "./effects.ts";
import {
	type AgentsConfig,
	enforceResearchReadOnlyRouting,
	parseAgentsConfig,
	preflightProfile,
	type RoutingPreset,
	resolvePreset,
	resolveProfile,
	resolveRouting,
	validatePresetCoverage,
} from "./profiles.ts";
import type { WorkflowRegistry } from "./registry.ts";
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
	fusionProfiles?: readonly string[];
	context?: Record<string, unknown>;
}

export interface PreparedWorkflowStart {
	input: Parameters<WorkflowEngine["start"]>[0];
	target: string;
	config: WorkflowConfig;
	provenance: ConfigProvenance;
}

export function parseFusionProfiles(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length < 2 || names.length > 5)
		throw new Error(
			"--fusion-profiles requires 2-5 comma-separated profile names",
		);
	if (new Set(names).size !== names.length)
		throw new Error("--fusion-profiles profiles must be distinct");
	return names;
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
	registry: Pick<WorkflowRegistry, "step"> = defaultRegistry,
	fusionPlannerCount = 0,
): Record<string, string[]> {
	const roles: Record<string, string[]> = {};
	for (const stepId of steps) {
		const step = registry.step(stepId);
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

function plannerCount(preset: RoutingPreset | undefined): number {
	const table = preset?.roles?.["fusion.plan"] ?? {};
	const has = (name: string) =>
		typeof table[name] === "string" && table[name] !== "";
	let count = 0;
	while (count < 5 && has(`planner-${count + 1}`)) count++;
	for (let index = count + 1; index <= 5; index++)
		if (has(`planner-${index}`))
			throw new Error(
				`contiguous planner roles required: planner-${index} is set but planner-${count + 1} is missing`,
			);
	return count;
}

export const fusionPlannerCount = plannerCount;

function startPreset(
	agents: AgentsConfig,
	name?: string,
): RoutingPreset | undefined {
	return name ? resolvePreset(agents, name) : undefined;
}

function resolveRoutingForStart(
	definitionId: string,
	definition: ReturnType<WorkflowRegistry["definition"]>,
	registry: WorkflowRegistry,
	agents: AgentsConfig,
	presetName?: string,
	fusionProfiles?: readonly string[],
): WorkflowRouting {
	const preset = startPreset(agents, presetName);
	const fusion = definitionId.startsWith("openspec-fusion");
	const count = fusion ? (fusionProfiles?.length ?? plannerCount(preset)) : 0;
	const roles = rolesForDefinition(
		definitionId,
		definition.steps,
		registry,
		count,
	);
	if (preset)
		validatePresetCoverage(preset, definition, Object.keys(roles), agents);
	const routing = resolveRouting(definition, roles, agents, preset);
	if (fusionProfiles) {
		for (const [index, name] of fusionProfiles.entries()) {
			const route = routing.routes.find(
				(item) =>
					item.stepId === "fusion.plan" && item.role === `planner-${index + 1}`,
			);
			if (!route)
				throw new Error(`missing fusion planner route planner-${index + 1}`);
			route.profile = resolveProfile(name, agents);
		}
	}
	const planners = routing.routes.filter(
		(route) => route.stepId === "fusion.plan",
	);
	if (fusion && (planners.length < 2 || planners.length > 5))
		throw new Error(
			`${definitionId} requires between 2 and 5 planner routings`,
		);
	if (
		fusion &&
		new Set(planners.map((route) => route.profile.name)).size !==
			planners.length
	)
		throw new Error("fusion workflow requires distinct planner profiles");
	return routing;
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

export function prepareWorkflowStart(
	request: WorkflowStartRequest,
): PreparedWorkflowStart {
	if (
		request.definitionId !== "wiki-comments" &&
		!PUBLIC_WORKFLOW_CATALOG.some((item) => item.id === request.definitionId)
	)
		throw new Error(`unknown workflow definition: ${request.definitionId}`);
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
	if (request.fusionProfiles) {
		if (request.fusionProfiles.length < 2 || request.fusionProfiles.length > 5)
			throw new Error("fusion profiles require 2-5 profiles");
		if (new Set(request.fusionProfiles).size !== request.fusionProfiles.length)
			throw new Error("fusion profiles must be distinct");
	}
	const target = research
		? researchWorkflowTarget()
		: wikiOnly
			? wikiWorkflowTarget()
			: repo;
	const independent = wikiOnly || (research && !request.repositoryContext);
	const resolved = loadConfigWithProvenance({
		repository: independent ? undefined : repo,
		repositoryIndependent: independent,
	});
	const config = resolved.config;
	const definitionVersion = definitionVersionForManifestPolicy(
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
	const agents = parseAgentsConfig(config.agents, config);
	const routing = resolveRoutingForStart(
		request.definitionId,
		definition,
		registry,
		agents,
		request.preset,
		request.fusionProfiles,
	);
	const finalRouting = research
		? enforceResearchReadOnlyRouting(routing, definition.initial)
		: routing;
	for (const route of finalRouting.routes)
		preflightProfile(route.profile, registry.step(route.stepId).requirements);
	if (!wikiOnly)
		validateStart(repo, workflowId, request.definitionId, request.task);
	const sameCheckout = [
		"openspec-propose",
		"openspec-fusion-propose",
		"wiki",
	].includes(request.definitionId);
	if (!research && !wikiOnly && sameCheckout && request.mode !== "checkout")
		throw new Error("repository-backed workflows require checkout mode");
	const baseCommit =
		research || wikiOnly
			? ""
			: sameCheckout
				? runGit(repo, "rev-parse", "HEAD")
				: runGit(repo, "rev-parse", `${config.workflow.base_branch}^{commit}`);
	if (!research && !wikiOnly && !sameCheckout)
		runGit(repo, "remote", "get-url", config.workflow.remote);
	const branch =
		research || wikiOnly
			? ""
			: sameCheckout
				? runGit(repo, "branch", "--show-current")
				: `${config.workflow.branch_prefix}${workflowId}`;
	if (!research && !wikiOnly && sameCheckout && !branch)
		throw new Error(
			"repository-backed workflows require a named current branch",
		);
	return {
		config,
		provenance: resolved.provenance,
		target,
		input: {
			repo: target,
			...(research && repo ? { repositoryContext: repo } : {}),
			...(request.mode ? { mode: request.mode } : {}),
			sameCheckout,
			workflowId,
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
				executionSettings: executionSettings(config, resolved.provenance),
			},
			routing: finalRouting,
		},
	};
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
