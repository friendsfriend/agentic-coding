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
// Imported from `manifest-policy.ts` rather than the `definitions.ts` barrel so
// the barrel's frozen export-surface fixture stays untouched by a new tier.
import { definitionVersionForStepRouting } from "./definitions/manifest-policy.ts";
import {
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
	resolveClassifierProvider,
	resolveGatePolicies,
	resolvePreset,
	resolveRouting,
	SETTINGS_PRESETS_HINT,
	validatePresetCoverage,
	withHumanReviewGates,
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
	/** The rebase family's selected branch: the branch that gets rebased. */
	sourceBranch?: string;
	/** The rebase family's selected target: the ref the branch is rebased onto. */
	targetBranch?: string;
	/** Pin the plan, developer, and wiki review gates to `always`. Set by the
	 * server for orchestrator-started work, never from a wire request. */
	enforceHumanReviewGates?: boolean;
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
	branches: {
		sourceBranch?: string;
		targetBranch?: string;
		baseBranch?: string;
	} = {},
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
	// A verify-only run inspects the current state of the checkout, so it needs
	// no task, no OpenSpec project, and no clean worktree — but the branch it
	// verifies must have a base to compare against.
	if (workflow === "verify") {
		validateVerifyBase(repo, branches.baseBranch);
		return;
	}
	const dirty = runGit(repo, "status", "--porcelain");
	const proposal = ["openspec-propose", "openspec-fusion-propose"].includes(
		workflow,
	);
	if (dirty && !proposal)
		throw new Error("working tree must be clean before workflow start");
	if (workflow === "no-openspec" || workflow === "solo") {
		if (!task?.trim())
			throw new Error(`${workflow} workflow requires non-empty task`);
		return;
	}
	// A rebase replaces its branch in place, so both selected refs must already
	// exist and must differ: a missing target would rebase onto nothing, and a
	// branch rebased onto itself is a no-op the launch cannot have meant.
	if (workflow === "rebase") {
		validateRebaseBranches(repo, branches);
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

/** The verify-only family's start rules: the checkout must be on a named
 * branch, and the configured base branch must resolve and share history with
 * it — the merge base is what the branch's own change set is measured from, so
 * a base with no common ancestor has nothing to verify against. */
function validateVerifyBase(repo: string, baseBranch?: string): void {
	const base = baseBranch?.trim();
	if (!base)
		throw new Error(
			"verify workflow requires a base branch; set workflow.base_branch",
		);
	if (!runGit(repo, "branch", "--show-current"))
		throw new Error("verify workflow requires a named current branch");
	try {
		runGit(repo, "rev-parse", "--verify", `${base}^{commit}`);
	} catch {
		throw new Error(
			`verify base branch does not resolve: ${base} (fetch the remote or set workflow.base_branch)`,
		);
	}
	try {
		runGit(repo, "merge-base", base, "HEAD");
	} catch {
		throw new Error(
			`verify base branch has no common ancestor with HEAD: ${base}`,
		);
	}
}

/** The start guard's rebase branch rules: the source branch must be a local
 * branch, the target ref must resolve (a `git fetch` has already been
 * attempted, so a remote-tracking ref is current when the network allowed it),
 * and the two must not be the same ref. The engine's own `start-guard` evidence
 * check enforces the same three rules directly, the way the two boundaries
 * already duplicate the clean-tree rule. */
function validateRebaseBranches(
	repo: string,
	branches: { sourceBranch?: string; targetBranch?: string },
): void {
	const source = branches.sourceBranch?.trim();
	const target = branches.targetBranch?.trim();
	if (!source || !target)
		throw new Error(
			"rebase workflow requires a source branch and a target branch",
		);
	if (source === target)
		throw new Error(`rebase source and target are the same ref: ${source}`);
	try {
		runGit(repo, "rev-parse", "--verify", `refs/heads/${source}`);
	} catch {
		throw new Error(`rebase source branch does not exist: ${source}`);
	}
	try {
		runGit(repo, "rev-parse", "--verify", `${target}^{commit}`);
	} catch {
		throw new Error(`rebase target branch does not resolve: ${target}`);
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
	// Every family now selects its step models with the classifier, so a new
	// start resolves the per-step routing tier — including research, whose
	// tool policy that tier applies as the research tier did.
	const definitionVersion = definitionVersionForStepRouting(
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
	const rebase = request.definitionId === "rebase";
	const rebaseSource = rebase ? request.sourceBranch?.trim() : undefined;
	const rebaseTarget = rebase ? request.targetBranch?.trim() : undefined;
	// The verify-only family measures the current branch against the configured
	// base branch. It runs in the checkout the branch is already on and never
	// switches it, so it shares the checkout contract with `wiki`.
	const verify = request.definitionId === "verify";
	const verifyBase = verify ? config.workflow.base_branch : undefined;
	if (rebase || verify) {
		// Refresh the target remote once, before the branch rules are enforced, so
		// a remote-tracking target resolves from the current remote state. A
		// repository without the configured remote, or an offline machine whose
		// refs are already local, still starts: the agent reports what the ref
		// actually is if it is missing.
		try {
			runGit(ctx.repo, "fetch", "--prune", "--", config.workflow.remote);
		} catch {
			/* no remote, or unreachable: the local refs decide */
		}
	}
	if (!wikiOnly)
		validateStart(
			ctx.repo,
			ctx.workflowId,
			request.definitionId,
			request.task,
			{
				sourceBranch: rebaseSource,
				targetBranch: rebaseTarget,
				baseBranch: verifyBase,
			},
		);
	const sameCheckout = [
		"openspec-propose",
		"openspec-fusion-propose",
		"wiki",
	].includes(request.definitionId);
	const research = request.definitionId === "research";
	// A rebase owns the repository checkout exactly like the sameCheckout
	// families, but it selects its own branch instead of inheriting the one that
	// happens to be checked out — so it requires checkout mode and nothing else.
	if (
		!research &&
		!wikiOnly &&
		(sameCheckout || rebase || verify) &&
		request.mode !== "checkout"
	)
		throw new Error("repository-backed workflows require checkout mode");
	const baseCommit =
		research || wikiOnly
			? ""
			: sameCheckout
				? runGit(ctx.repo, "rev-parse", "HEAD")
				: verify
					? // The branch's own change set: everything reachable from HEAD but
						// not from the base branch. `baseCommit..HEAD` in the changed-file
						// manifest and in every per-file diff is then exactly the branch,
						// committed work included.
						runGit(ctx.repo, "merge-base", verifyBase ?? "", "HEAD")
					: rebase
						? runGit(ctx.repo, "rev-parse", `${rebaseTarget}^{commit}`)
						: runGit(
								ctx.repo,
								"rev-parse",
								`${config.workflow.base_branch}^{commit}`,
							);
	// A verify-only run may legitimately have no remote at all when its base
	// branch is local, so the remote is not required for it.
	if (!research && !wikiOnly && !sameCheckout && !rebase && !verify)
		runGit(ctx.repo, "remote", "get-url", config.workflow.remote);
	const branch =
		research || wikiOnly
			? ""
			: verify
				? runGit(ctx.repo, "branch", "--show-current")
				: rebase
					? (rebaseSource ?? "")
					: sameCheckout
						? runGit(ctx.repo, "branch", "--show-current")
						: `${config.workflow.branch_prefix}${ctx.workflowId}`;
	if (!research && !wikiOnly && (sameCheckout || verify) && !branch)
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
				baseBranch:
					research || wikiOnly
						? ""
						: (rebaseTarget ?? config.workflow.base_branch),
				baseCommit,
				...(request.task?.trim() ? { task: request.task.trim() } : {}),
				...(request.ticket ? { ticket: request.ticket } : {}),
				...(request.preset ? { selectedPreset: request.preset } : {}),
				// The gate table is resolved once, here, and pinned with the
				// preset: a later edit to the config document must not change
				// what an in-flight workflow is allowed to skip.
				...{
					gatePolicies: request.enforceHumanReviewGates
						? withHumanReviewGates(resolveGatePolicies(agents, request.preset))
						: resolveGatePolicies(agents, request.preset),
				},
				// Same pinning for the classifier transport: which endpoint serves
				// this run is decided once, so a mid-run provider switch cannot
				// redirect the requests.
				...{ classifier: resolveClassifierProvider(agents) },
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
