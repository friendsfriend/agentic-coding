import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { rankSimilarIds } from "../agent-host/orchestrator-resolve.ts";
import { resolveConfigRoot } from "../config-root.ts";
import { TASK_CHAR_BOUND } from "../contracts/actions.ts";
import {
	changesRoot,
	discoverChangeIds,
	readChangeArtifact,
} from "./openspec-changes.ts";

// The listing is the resolver's input and `list_changes`' answer; one
// implementation keeps the ids the model is told to pick from and the ids that
// resolve from drifting apart.
export { discoverChangeIds };

import type {
	StartedBy,
	WorkflowExecutionSettings,
	WorkflowRouting,
} from "../contracts/workflow.ts";
import { setupDraftsDir } from "../server/environment/setup-drafts.ts";
import {
	setupStagedStateIds,
	sweepStaleSetupState,
} from "../server/environment/setup-staged.ts";
import { runGit } from "./cli/git.ts";
import { registry as defaultRegistry } from "./cli/registry.ts";
import type { WorkflowRuntimeError } from "./contracts.ts";
import {
	CUSTOM_DEFINITION_VERSION,
	isCustomDefinitionId,
} from "./definitions/custom.ts";
// Imported from `manifest-policy.ts` rather than the `definitions.ts` barrel so
// the barrel's frozen export-surface fixture stays untouched by a new tier.
import {
	definitionVersionForStagedRoot,
	effectiveFamilyTraits,
	effectiveManifestPolicy,
} from "./definitions/manifest-policy.ts";
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
import type { WorkflowManifestPolicy, WorkflowRegistry } from "./registry.ts";
import { resolveDefinitionAt } from "./runtime/definitions.ts";
import {
	toRuntimeError,
	WorkflowConfig as WorkflowConfigService,
} from "./runtime/services.ts";
import { knownWorkflowIds } from "./runtime/store.ts";
import { workflowTargets } from "./runtime/target-registry.ts";
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
	/** A task *reference* instead of inline text: an active OpenSpec change of
	 * the target repository, resolved here into the task the start guard, the
	 * preset and every review already see (efficiency backlog item 21). */
	taskRef?: { change: string };
	ticket?: string;
	mode?: "worktree" | "checkout";
	preset?: string;
	context?: Record<string, unknown>;
	/** The rebase family's selected branch: the branch that gets rebased. */
	sourceBranch?: string;
	/** The rebase family's selected target: the ref the branch is rebased onto. */
	targetBranch?: string;
	/** The configured app an `env-setup` workflow drafts definitions for. */
	app?: string;
	/** Pin the plan, developer, and wiki review gates to `always`. Set by the
	 * server for orchestrator-started work, never from a wire request. */
	enforceHumanReviewGates?: boolean;
	/** The blueprint provenance the server compiles and stores before starting
	 * a custom-shaped workflow (add-orchestrator-blueprint-workflows): pinned
	 * onto the workflow's metadata so the shape stays auditable. Set by the
	 * server, never from a wire request. */
	blueprint?: { label: string; rationale: string; digest: string };
	/** Who started this workflow. Set by the server from the authenticated
	 * principal, never from a wire request; the engine-facing request defaults
	 * to the operator (`developer`). */
	startedBy?: StartedBy;
}

export interface PreparedWorkflowStart {
	input: Parameters<WorkflowEngine["start"]>[0];
	target: string;
	config: WorkflowConfig;
	provenance: ConfigProvenance;
	/** The change a `taskRef` resolved to and the length of the task assembled
	 * from it: the start answer echoes both, so a reference that resolved to
	 * the wrong change is visible instead of silent. */
	taskReference?: { change: string; taskChars: number };
}

/** The echo a start answer carries when its task came from a change reference
 * (`taskReferenceSuffix` of an inline-text start is empty, so its answer is
 * unchanged). */
export function taskReferenceSuffix(prepared: PreparedWorkflowStart): string {
	const reference = prepared.taskReference;
	if (!reference) return "";
	return ` — task from change ${JSON.stringify(reference.change)}, ${reference.taskChars} task chars`;
}

/** The acceptance line of a start. Both start paths (built-in and blueprint)
 * answer with this one function, so the echo that makes a mis-resolved task
 * reference visible cannot be dropped from one of them: an inline-text start
 * answers the bare `Workflow started: <id>` it always did. */
export function workflowStartedAnswer(
	workflowId: string,
	prepared: PreparedWorkflowStart,
): string {
	return `Workflow started: ${workflowId}${taskReferenceSuffix(prepared)}`;
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
	definition?: { id: string; policy?: WorkflowManifestPolicy },
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
	// Every repository family property this guard enforces is read from the
	// definition's effective traits (`startRequirements`) instead of a
	// definition-id branch (read-family-traits-instead-of-ids). `startup.ts`
	// resolves the pinned definition before calling; an id-only caller (the
	// exported guard, the CLI's start prompt) falls back to the catalog table
	// `effectiveFamilyTraits` reads, so every built-in family keeps its rules.
	const requirements = new Set(
		effectiveFamilyTraits(definition ?? { id: workflow })?.startRequirements ??
			[],
	);
	// A verify-only run inspects the current state of the checkout, so it needs
	// no task, no OpenSpec project, and no clean worktree — but the branch it
	// verifies must have a base to compare against.
	if (requirements.has("base-commit")) {
		validateVerifyBase(repo, branches.baseBranch);
		return;
	}
	if (requirements.has("clean-tree")) {
		const dirty = runGit(repo, "status", "--porcelain");
		if (dirty) throw new Error(cleanTreeRefusal(dirty));
	}
	// The detached-worktree debug family selects the branch it investigates; the
	// branch must already exist and is never created or switched.
	if (requirements.has("branch"))
		validateDebugBranch(repo, branches.sourceBranch);
	if (requirements.has("task")) {
		if (!task?.trim())
			throw new Error(`${workflow} workflow requires non-empty task`);
		return;
	}
	// A rebase replaces its branch in place, so both selected refs must already
	// exist and must differ: a missing target would rebase onto nothing, and a
	// branch rebased onto itself is a no-op the launch cannot have meant.
	if (requirements.has("rebase-refs")) {
		validateRebaseBranches(repo, branches);
		return;
	}
	if (
		requirements.has("openspec-project") &&
		!fs.existsSync(path.join(repo, "openspec", "config.yaml"))
	)
		throw new Error("OpenSpec project required for this workflow");
	if (requirements.has("openspec-change")) {
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

/** The refusal a dirty checkout gets: the rule plus the paths that broke it,
 * bounded so a repository-wide mess cannot become a page of output. The
 * orchestrator relays this to the developer, so the paths are the answer to
 * "what is dirty?". */
const CLEAN_TREE_PATH_LIMIT = 20;
function cleanTreeRefusal(porcelain: string): string {
	const paths = porcelain
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => (line.length > 3 ? line.slice(3).trim() : line));
	const shown = paths.slice(0, CLEAN_TREE_PATH_LIMIT);
	const more =
		paths.length > shown.length
			? ` (+${paths.length - shown.length} more)`
			: "";
	return `working tree must be clean before workflow start: ${paths.length} dirty path(s): ${shown.join(", ")}${more}`;
}

/** The bound the orchestrator's `task` parameter already enforces on a task, in
 * characters. A change reference assembles its task inside the same bound, so a
 * reference never starts a workflow an inline task could not. */
export { TASK_CHAR_BOUND };

/** Room the trailing truncation marker may use inside `TASK_CHAR_BOUND`. */
const TRUNCATION_MARKER_BUDGET = 240;
/** How many dropped section names the truncation marker still lists. */
const TRUNCATION_MARKER_SECTIONS = 5;
/** How much of a change's `proposal.md` (its whole task source) and of its
 * `tasks.md` (read to list the checkboxes) is read at all. */
const PROPOSAL_BYTES = 64 * 1024;
const OPENSPEC_TASKS_BYTES = 64 * 1024;

/** A change reference resolved into the task every later start rule reads. */
export interface ResolvedTaskReference {
	/** The active OpenSpec change the reference resolved to. */
	change: string;
	/** The task text assembled from that change's `proposal.md` and `tasks.md`. */
	task: string;
	/** The `##` sections (or `tasks`) the character bound dropped whole. */
	truncated: string[];
}

/** The whole `##` sections of a proposal, in file order. The preamble before
 * the first `##` heading (the title) is left out: a task carries the sections
 * that state the goal, the constraints and the acceptance criteria. */
function proposalSections(markdown: string): string[] {
	return markdown
		.split(/\n(?=##\s)/)
		.map((chunk) => chunk.trim())
		.filter((chunk) => /^##\s/.test(chunk));
}

function sectionName(section: string): string {
	const first = section.split("\n")[0] ?? "";
	return first.replace(/^#+\s*/, "").trim() || "section";
}

/** The checkbox list of a `tasks.md`: whole lines, in file order, so the task
 * carries the same actionable items the OpenSpec tooling reads. */
function checkboxLines(markdown: string): string[] {
	return markdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*]\s*\[[ xX]\]/.test(line));
}

/** Assemble the task of a change: its proposal's `##` sections, then its
 * `tasks.md` checkbox list, capped at `TASK_CHAR_BOUND`. A section (or the
 * whole checkbox list) that does not fit is dropped *whole* and named in a
 * trailing marker, so the model sees that a constraint may be missing instead
 * of a sentence cut in half. */
function buildTaskText(
	repo: string,
	change: string,
): {
	task: string;
	truncated: string[];
	unchecked: number;
} {
	const root = path.join(changesRoot(repo), change);
	const proposal = changeArtifact(root, change, "proposal.md", PROPOSAL_BYTES);
	const tasks = changeArtifact(root, change, "tasks.md", OPENSPEC_TASKS_BYTES);
	const limit = TASK_CHAR_BOUND - TRUNCATION_MARKER_BUDGET;
	const parts: string[] = [];
	const truncated: string[] = [];
	let length = 0;
	for (const section of proposalSections(proposal)) {
		const next = length === 0 ? section : `\n\n${section}`;
		if (length + next.length > limit) {
			truncated.push(sectionName(section));
			continue;
		}
		parts.push(section);
		length += next.length;
	}
	const checklist = checkboxLines(tasks);
	if (checklist.length > 0) {
		const text = checklist.join("\n");
		if (length + text.length + 2 > limit) truncated.push("tasks");
		else {
			parts.push(text);
			length += text.length + 2;
		}
	}
	const unchecked = tasks
		.split("\n")
		.filter((line) => /^[-*]\s*\[ \]/.test(line.trim())).length;
	let body = parts.join("\n\n");
	if (truncated.length > 0) {
		const named = truncated.slice(0, TRUNCATION_MARKER_SECTIONS);
		const more =
			truncated.length > named.length
				? ` (+${truncated.length - named.length} more)`
				: "";
		body = `${body}\n\n[task truncated: ${named.join(", ")}${more}]`;
	}
	return { task: body.slice(0, TASK_CHAR_BOUND), truncated, unchecked };
}

/** One bounded artifact read of a change, refusing anything that is not a
 * regular file inside the change: a reference may not be turned into a read of
 * another file through the repository's own content. */
function changeArtifact(
	root: string,
	change: string,
	name: string,
	bytes: number,
): string {
	const artifact = readChangeArtifact(root, name, bytes);
	if (artifact.kind === "refused")
		throw new Error(
			`OpenSpec change ${change} has a ${name} that is not a regular file inside the change; refusing to read through it`,
		);
	return artifact.kind === "text" ? artifact.text : "";
}

function boundedList(values: readonly string[], limit = 5): string {
	const shown = values.slice(0, limit);
	const more =
		values.length > shown.length
			? ` (+${values.length - shown.length} more)`
			: "";
	return `${shown.join(", ")}${more}`;
}

/** Resolve a task reference into the task text of an active OpenSpec change.
 *
 * The reference is either a change id or a path that must land inside this
 * repository's `openspec/changes/<id>` (one segment, never `..`, never a
 * symlink escape, never `archive`), an exact id, then a prefix, then a
 * substring. One match resolves; more than one is refused as ambiguous with the
 * matches named; none is refused with the closest ids — the same bounded
 * `rankSimilarIds` answer `workflow_status` gives an unknown workflow id. Every
 * refusal is one line without file contents. */
export function resolveTaskReference(
	repo: string,
	reference: string,
): ResolvedTaskReference {
	const wanted = reference.trim();
	if (!wanted)
		throw new Error(
			"task reference is empty: pass an OpenSpec change id or path, or taskRef.previousMessage",
		);
	if (!repo)
		throw new Error(
			"a task reference needs a repository: pass repo with taskRef.change",
		);
	const ids = discoverChangeIds(repo);
	if (ids.length === 0)
		throw new Error(
			`no active OpenSpec changes in ${repo}: a task reference needs openspec/changes/<id>`,
		);
	const unresolved = (wantedId: string) => {
		const ranked = rankSimilarIds(ids, wantedId);
		const closest = ranked.candidates.length
			? `closest: ${ranked.candidates.join(", ")}${ranked.more > 0 ? ` (+${ranked.more} more)` : ""}`
			: "no similar change id";
		return `task reference ${JSON.stringify(reference)} matches no active OpenSpec change in ${repo}; ${closest}`;
	};
	let change: string | undefined;
	if (
		wanted.includes("/") ||
		wanted.includes("\\") ||
		path.isAbsolute(wanted)
	) {
		const root = changesRoot(repo);
		const absolute = path.resolve(
			path.isAbsolute(wanted) ? wanted : path.join(repo, wanted),
		);
		const inside = path.relative(root, absolute);
		if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
			throw new Error(
				`task reference ${JSON.stringify(reference)} is not a change of ${repo}: it must point inside ${path.join("openspec", "changes")}`,
			);
		const segments = inside.split(path.sep).filter((segment) => segment !== "");
		if (segments[0] === "archive") {
			const ranked = rankSimilarIds(ids, segments[1] ?? "");
			const closest = ranked.candidates.length
				? `; active changes: ${boundedList(ranked.candidates)}${ranked.more > 0 ? ` (+${ranked.more} more)` : ""}`
				: "";
			throw new Error(
				`task reference ${JSON.stringify(reference)} names an archived change: an archived change is history, not work to start${closest}`,
			);
		}
		if (segments.length > 1)
			throw new Error(
				`task reference ${JSON.stringify(reference)} is not a change directory: it must be ${path.join("openspec", "changes", "<changeId>")}`,
			);
		const candidate = segments[0] ?? "";
		if (!ids.includes(candidate)) throw new Error(unresolved(candidate));
		// Every listed id is a real directory (a symlinked entry is not one), and
		// the resolved directory must still live inside the changes root: a path
		// form can never be used to read a change outside the repository.
		const realRoot = fs.realpathSync(root);
		const real = fs.realpathSync(path.join(root, candidate));
		if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`))
			throw new Error(
				`task reference ${JSON.stringify(reference)} escapes ${path.join("openspec", "changes")}`,
			);
		change = candidate;
	}
	if (!change && ids.includes(wanted)) change = wanted;
	if (!change) {
		const prefixes = ids.filter((id) => id.startsWith(wanted));
		const matches =
			prefixes.length > 0 ? prefixes : ids.filter((id) => id.includes(wanted));
		if (matches.length > 1)
			throw new Error(
				`task reference ${JSON.stringify(reference)} is ambiguous in ${repo}: ${boundedList(matches)}`,
			);
		if (matches.length === 1) change = matches[0];
	}
	if (!change) throw new Error(unresolved(wanted));
	const built = buildTaskText(repo, change);
	if (!built.task.trim())
		throw new Error(
			`OpenSpec change ${change} has no proposal.md or tasks.md content in ${repo}`,
		);
	// A change whose boxes are all checked is finished work: the archive move is
	// a workflow step, not something a change's author performs, so an
	// implemented change stays listed at the top level and would otherwise start
	// a workflow with nothing left to do. The same rule the `openspec-apply`
	// start requirement applies, so both agree on what is actionable.
	if (built.unchecked === 0)
		throw new Error(
			`task reference ${JSON.stringify(reference)} resolves to ${change}, which has no unchecked task; pick a change that still has work (list_changes shows its progress)`,
		);
	return { change, task: built.task, truncated: built.truncated };
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

/** The debug family's start rule: the selected branch must be an existing
 * local branch. The detached worktree is created at that branch's head, so a
 * missing branch would have nothing to check out. */
function validateDebugBranch(repo: string, branch?: string): void {
	const selected = branch?.trim();
	if (!selected)
		throw new Error(
			"debug workflow requires --branch: the branch to investigate",
		);
	// A ref whose name begins with `-` would be read as a git option by the
	// detached `git worktree add`; refuse it here with a named diagnostic instead
	// of depending on git's option parsing.
	if (selected.startsWith("-"))
		throw new Error(`debug branch must not begin with '-': ${selected}`);
	try {
		runGit(repo, "rev-parse", "--verify", `refs/heads/${selected}`);
	} catch {
		throw new Error(`debug branch does not exist: ${selected}`);
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
	const traits = effectiveFamilyTraits(pinned);
	for (const stepId of steps) {
		const step = registry.stepForDefinition(pinned, stepId);
		if (step.actor !== "agent") continue;
		const candidateRoles = step.behavior?.candidateRoles;
		if (!candidateRoles)
			throw new Error(`missing candidate roles for agent step ${stepId}`);
		const resolved = candidateRoles({
			definitionId,
			fusionPlannerCount,
			traits,
		});
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
	const fusion = effectiveFamilyTraits(definition)?.planning === "fusion";
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
	// A `custom.` identity is stored in the target repository's definition
	// table, not in the built-in catalog, so it is validated there (with a
	// pinned diagnostic) instead of being reported as a removed built-in.
	if (
		!isCustomDefinitionId(request.definitionId) &&
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
	// Every family now declares its repository traits and selects its step
	// models with the classifier, so a new start resolves the family-traits
	// tier.
	const definitionVersion = definitionVersionForStagedRoot(
		config.workflow.max_verification_rounds,
	);
	const registry = registerBuiltins(
		undefined,
		config.workflow.max_verification_rounds,
	);
	// A stored custom definition resolves from its target store at version 1
	// (persist-custom-workflow-definitions); every built-in family resolves the
	// current family-traits tier. One call either way: the resolver answers a
	// built-in identity from the registry without touching the store.
	const definition = resolveDefinitionAt(
		registry,
		ctx.repo,
		request.definitionId,
		isCustomDefinitionId(request.definitionId)
			? CUSTOM_DEFINITION_VERSION
			: definitionVersion,
	);
	const agents = parseAgentsConfig(
		config.agents,
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
	// A task reference resolves here, before the start guard below, so the
	// resolved text is exactly the task every rule validates, the preset pools
	// and every human review sees: a reference can never take a different path
	// than inline text (efficiency backlog item 21).
	const reference =
		request.taskRef === undefined
			? undefined
			: resolveTaskReference(ctx.repo, request.taskRef.change);
	const task = reference ? reference.task : request.task;
	const wikiOnly =
		request.definitionId === "wiki-comments" ||
		ctx.target === wikiWorkflowTarget();
	const traits = effectiveFamilyTraits(definition);
	const requirements = new Set(traits?.startRequirements ?? []);
	const rebase = requirements.has("rebase-refs");
	const rebaseSource = rebase ? request.sourceBranch?.trim() : undefined;
	const rebaseTarget = rebase ? request.targetBranch?.trim() : undefined;
	// The detached-worktree debug family selects the branch it investigates; the
	// branch arrives on the same `sourceBranch` field the rebase family uses.
	const debug = requirements.has("branch");
	const debugBranch = debug ? request.sourceBranch?.trim() : undefined;
	// The verify-only family measures the current branch against the configured
	// base branch. It runs in the checkout the branch is already on and never
	// switches it, so it shares the checkout contract with `wiki`.
	const verify = requirements.has("base-commit");
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
			task,
			{
				sourceBranch: rebaseSource ?? debugBranch,
				targetBranch: rebaseTarget,
				baseBranch: verifyBase,
			},
			definition,
		);
	// The env-setup family drafts definitions for exactly one configured app, so
	// the app is required and pinned before anything runs. It is a plain
	// configuration ident: a caller cannot name a path or another target.
	const setupApp = definition.steps.includes("setup.author")
		? request.app?.trim()
		: undefined;
	if (definition.steps.includes("setup.author") && !setupApp)
		throw new Error(
			"env-setup workflow requires --app: the configured app whose environment is drafted",
		);
	if (setupApp && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(setupApp))
		throw new Error(
			`env-setup app ident must be a plain configured app name, received ${JSON.stringify(setupApp)}`,
		);
	if (definition.steps.includes("setup.author")) {
		// The drafts root is keyed by the workflow id alone, so a workflow started
		// with an id whose predecessor was deleted would begin with that run's
		// drafts still in place and treat them as its own work. Refuse instead,
		// naming the directory so the developer can look at it first.
		const drafts = setupDraftsDir(resolveConfigRoot(), ctx.workflowId);
		if (fs.existsSync(drafts) && fs.readdirSync(drafts).length > 0)
			throw new Error(
				`env-setup drafts from an earlier workflow are still at ${drafts}; remove them or start with a new workflow id`,
			);
		// Staged state whose workflow the store no longer knows — a crash, a
		// `kill -9`, a deleted workflow — is a complete copy of the live
		// configuration sitting on disk. It is reaped here, where every start
		// passes, and only for ids the store does not list: a live workflow's state
		// is never touched. A store that cannot be read sweeps nothing.
		try {
			// The state root is *configuration-global* (keyed by workflow id alone)
			// while a store is per repository, so an id is known only when no store
			// anywhere lists it as unknown: a repository-scoped answer would delete
			// another repository's live staged root. Any store that cannot be read
			// makes the question unanswerable, and nothing is swept.
			// The store reads below are a full scan each, so they run only when there
			// is something this start could sweep: state that is not its own.
			const configRoot = resolveConfigRoot();
			const candidates = setupStagedStateIds(configRoot).filter(
				(id) => id !== ctx.workflowId,
			);
			if (candidates.length > 0) {
				const stores = [...new Set([ctx.repo, ...workflowTargets()])];
				let knownAll = true;
				const knownIn: Set<string>[] = [];
				for (const target of stores) {
					const known = knownWorkflowIds(target);
					if (!known) {
						knownAll = false;
						continue;
					}
					knownIn.push(known);
				}
				if (knownAll && knownIn.length > 0) {
					// Housekeeping, not part of the start: the removals are asynchronous
					// (`fs.promises.rm` over a complete configuration copy), so the
					// start does not wait for them and the server's event loop is never
					// blocked. A failure is nothing this start must act on.
					void sweepStaleSetupState({
						configDir: configRoot,
						isKnownWorkflow: (id) => knownIn.some((known) => known.has(id)),
					})
						.then((swept) => {
							for (const removed of swept.removed)
								process.emitWarning?.(
									`env-setup: removed stale staged state of an unknown workflow at ${removed}`,
								);
						})
						.catch(() => {
							// A sweep that cannot run leaves the state for the next start.
						});
				}
			}
		} catch {
			// A sweep is housekeeping: it must never refuse a start.
		}
	}
	// The families that run against the repository checkout itself
	// (`policy.checkoutRequired`) rather than a worktree — the proposal-only
	// flows and the repository-backed `wiki`. The verify-only family requires the
	// checkout too, but selects its own base instead of inheriting the checked-out
	// branch, so it is handled by its own `base-commit` requirement below.
	const sameCheckout =
		effectiveManifestPolicy(definition).checkoutRequired && !verify;
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
						: debug
							? runGit(ctx.repo, "rev-parse", `${debugBranch}^{commit}`)
							: runGit(
									ctx.repo,
									"rev-parse",
									`${config.workflow.base_branch}^{commit}`,
								);
	// A verify-only run may legitimately have no remote at all when its base
	// branch is local, so the remote is not required for it.
	if (!research && !wikiOnly && !sameCheckout && !rebase && !verify && !debug)
		runGit(ctx.repo, "remote", "get-url", config.workflow.remote);
	const branch =
		research || wikiOnly
			? ""
			: verify
				? runGit(ctx.repo, "branch", "--show-current")
				: rebase
					? (rebaseSource ?? "")
					: debug
						? (debugBranch ?? "")
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
		...(reference
			? {
					taskReference: {
						change: reference.change,
						taskChars: reference.task.length,
					},
				}
			: {}),
		input: {
			repo: ctx.target,
			...(research && ctx.repo ? { repositoryContext: ctx.repo } : {}),
			...(request.mode ? { mode: request.mode } : {}),
			sameCheckout,
			workflowId: ctx.workflowId,
			definitionId: request.definitionId,
			definitionVersion: definition.version,
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
				...(task?.trim() ? { task: task.trim() } : {}),
				...(request.ticket ? { ticket: request.ticket } : {}),
				...(setupApp ? { app: setupApp } : {}),
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
				// Who started the run, pinned once like the gates: an orchestrator
				// start stays attributed to the orchestrator for the workflow's
				// lifetime, and an operator start says so explicitly instead of
				// leaving the reader to infer the default.
				...{ startedBy: request.startedBy ?? "developer" },
				// The blueprint a custom-shaped start was compiled from, pinned with
				// the definition it produced: the label and rationale the model
				// authored and the digest the workflow pins.
				...(request.blueprint ? { blueprint: request.blueprint } : {}),
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
