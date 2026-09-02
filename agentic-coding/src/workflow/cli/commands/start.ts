// The `start` command: validates workflow-specific preconditions, resolves
// role routing (including the openspec-fusion-full planner fan-out), and
// starts the pinned workflow definition. Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import {
	definitionVersionForManifestPolicy,
	PUBLIC_WORKFLOW_CATALOG,
} from "../../definitions.ts";
import { loadConfig } from "../../effects.ts";
import {
	enforceResearchReadOnlyRouting,
	parseAgentsConfig,
	preflightProfile,
	resolvePreset,
	resolveProfile,
	resolveRouting,
	validatePresetCoverage,
} from "../../profiles.ts";
import {
	researchWorkflowTarget,
	validateWorkflowId,
	type WorkflowEngine,
} from "../../runtime.ts";
import type { StepBehavior } from "../../steps/types.ts";
import { flag, requireFlag } from "../args.ts";
import { drainEffects } from "../drain.ts";
import { runGit } from "../git.ts";
import { registry } from "../registry.ts";

export function validateStart(
	repo: string,
	workflowId: string,
	workflow: string,
	task?: string,
): void {
	if (workflow === "research") {
		if (!task?.trim())
			throw new Error("research workflow requires non-empty --task");
		if (repo) {
			const resolved = fs.realpathSync(path.resolve(repo));
			runGit(resolved, "rev-parse", "--show-toplevel");
		}
		return;
	}
	const dirty = runGit(repo, "status", "--porcelain");
	const proposal = ["openspec-propose", "openspec-fusion-propose"].includes(
		workflow,
	);
	if (workflow === "wiki") {
		if (!task?.trim())
			throw new Error("wiki workflow requires non-empty --task");
		return;
	}
	if (dirty && !proposal)
		throw new Error("working tree must be clean before workflow start");
	if (workflow === "no-openspec") {
		if (!task?.trim())
			throw new Error("no-openspec workflow requires non-empty --task");
		return;
	}
	if (!fs.existsSync(path.join(repo, "openspec", "config.yaml")))
		throw new Error("OpenSpec project required for this workflow");
	if (workflow === "openspec-apply") {
		// `openspec-apply` has no planner step, so the workflow id also names
		// the pre-existing change it applies.
		const root = path.join(repo, "openspec", "changes", workflowId);
		const requiredFiles = ["proposal.md", "design.md", "tasks.md"];
		for (const file of requiredFiles)
			if (
				!fs.existsSync(path.join(root, file)) ||
				!fs.readFileSync(path.join(root, file), "utf8").trim()
			)
				throw new Error(`invalid openspec-apply artifact: ${file}`);
		if (!/\[ \]/.test(fs.readFileSync(path.join(root, "tasks.md"), "utf8")))
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

/** Ordered 2–5 profile list for openspec-fusion-full's planner fan-out, following the
 * existing single-flag convention: comma-separated names, order = role order. */
export function parseFusionProfiles(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length < 2 || names.length > 5)
		throw new Error(
			"openspec-fusion-full: --fusion-profiles requires 2-5 comma-separated profile names",
		);
	if (new Set(names).size !== names.length)
		throw new Error(
			"openspec-fusion-full: duplicate profile in --fusion-profiles",
		);
	return names;
}

/** Agent roles per step for a built-in definition. The openspec-fusion-full fan-out
 * derives one planner role per entry of the ordered profile list. */
export function rolesForDefinition(
	definitionId: string,
	steps: readonly string[],
	registry: {
		step(id: string): { actor: string; behavior?: StepBehavior };
	},
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
			throw new Error(`invalid candidate roles for ${stepId}: expected array`);
		if (stepId !== "fusion.plan" && !resolved.length)
			throw new Error(`empty candidate roles for agent step ${stepId}`);
		roles[stepId] = resolved;
	}
	return roles;
}

export function parseMode(value: string | undefined): "worktree" | "checkout" {
	if (value !== "worktree" && value !== "checkout")
		throw new Error("start: --mode must be worktree or checkout");
	return value;
}

export async function runStart(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	const workflow = flag(rest, "workflow") ?? "openspec-full";
	const research = workflow === "research";
	const repo = research
		? flag(rest, "repo")
			? fs.realpathSync(path.resolve(requireFlag(rest, "repo")))
			: ""
		: fs.realpathSync(path.resolve(requireFlag(rest, "repo")));
	const workflowId = validateWorkflowId(requireFlag(rest, "workflow-id"));
	const mode = research ? undefined : parseMode(flag(rest, "mode"));
	const proposal = ["openspec-propose", "openspec-fusion-propose"].includes(
		workflow,
	);
	const sameCheckout = proposal || workflow === "wiki";
	if (!PUBLIC_WORKFLOW_CATALOG.some((item) => item.id === workflow))
		throw new Error(`unknown workflow definition: ${workflow}`);
	if (!research && sameCheckout && mode !== "checkout")
		throw new Error("repository-backed workflows require --mode checkout");
	const fusionProfiles =
		workflow === "openspec-fusion-full" ||
		workflow === "openspec-fusion-propose"
			? parseFusionProfiles(flag(rest, "fusion-profiles"))
			: undefined;
	const task = flag(rest, "task");
	validateStart(repo, workflowId, workflow, task);
	const config = loadConfig();
	const definitionVersion = definitionVersionForManifestPolicy(
		config.workflow.max_verification_rounds,
	);
	const definition = registry.definition(workflow, definitionVersion);
	const agents = parseAgentsConfig(config.agents, config);
	const roles = rolesForDefinition(
		definition.id,
		definition.steps,
		registry,
		fusionProfiles?.length ?? 0,
	);
	const presetName = flag(rest, "preset");
	const preset = presetName ? resolvePreset(agents, presetName) : undefined;
	if (preset)
		validatePresetCoverage(preset, definition, Object.keys(roles), agents);
	let routing = resolveRouting(definition, roles, agents, preset);
	if (fusionProfiles) {
		// Explicit per-task model list overrides preset/config resolution for
		// the planner fan-out; position i binds to role planner-i.
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
	if (research)
		routing = enforceResearchReadOnlyRouting(routing, definition.initial);
	for (const route of routing.routes)
		preflightProfile(route.profile, registry.step(route.stepId).requirements);
	const baseBranch = config.workflow.base_branch;
	const baseCommit = research
		? ""
		: sameCheckout
			? runGit(repo, "rev-parse", "HEAD")
			: runGit(repo, "rev-parse", `${baseBranch}^{commit}`);
	if (!research && !sameCheckout)
		runGit(repo, "remote", "get-url", config.workflow.remote);
	const branch = research
		? ""
		: sameCheckout
			? runGit(repo, "branch", "--show-current")
			: `${config.workflow.branch_prefix}${workflowId}`;
	if (!research && sameCheckout && !branch)
		throw new Error(
			"repository-backed workflows require a named current branch",
		);
	workflowEngine.start({
		repo: research ? researchWorkflowTarget() : repo,
		...(research && repo ? { repositoryContext: repo } : {}),
		...(mode ? { mode } : {}),
		sameCheckout,
		workflowId,
		definitionId: workflow,
		definitionVersion,
		metadata: {
			branch,
			baseBranch: research ? "" : baseBranch,
			baseCommit,
			...(task?.trim() ? { task: task.trim() } : {}),
			...(flag(rest, "ticket") ? { ticket: requireFlag(rest, "ticket") } : {}),
		},
		routing,
	});
	const target = research ? researchWorkflowTarget() : repo;
	await drainEffects(workflowEngine, target);
	console.log(
		JSON.stringify(workflowEngine.status(target, workflowId), null, 2),
	);
}
