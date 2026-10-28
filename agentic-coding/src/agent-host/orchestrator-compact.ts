// The compact result contract of the orchestrator's workflow-management tools
// (efficiency backlog items 4 and 5: "workflow_status returns a compact
// projection by default" and "compact JSON and compact rows for every
// orchestrator list tool").
//
// One orchestrator conversation pays for every byte of every tool result on
// every later turn, and the measured waste was field *selection*, not size: the
// task text was ~47 % of a `workflow_status` result, `orchestratorQuestions` was
// a byte-identical copy of `pendingQuestions`, and the run history and gate
// decisions were re-sent on every poll. The compact shapes below are what the
// model reads by default; the full shapes stay reachable behind an explicit
// `detail: "full"`, so nothing is lost, only opted into.
//
// Everything here is a pure projection of the server's own views. The
// dashboard and the TUI read the same views through their own projection code
// (`src/tui/data/workflow.ts`, `src/workflow/runtime/view.ts`) and are
// unchanged: only the orchestrator's tool results narrow.
import { emitToolTelemetry } from "./telemetry.ts";

type Record_ = Record<string, unknown>;

/** The `status` filter `list_workflows` accepts. The default (`undefined`) is
 * every workflow that is not closed, so closed work cannot dominate the list;
 * `active` covers `paused` too, because a paused workflow is not finished. */
export type WorkflowListStatus =
	| "active"
	| "attention"
	| "completed"
	| "closed"
	| "all";

export interface WorkflowStatusArgs {
	/** Revision of the previous answer: an unchanged workflow answers with a
	 * few bytes instead of the row. */
	sinceRevision?: number;
	/** Include the task text in the compact row. */
	includeTask?: boolean;
	/** Name the `workflowId` on the `unchanged` short-circuit: a poll of several
	 * ids answers one entry per id, so every entry identifies itself. */
	named?: boolean;
}

export interface WorkflowListArgs {
	/** Default: every non-closed workflow. */
	status?: WorkflowListStatus;
	/** `full` returns the row the tool returned before the compact default. */
	detail?: "full";
}

export interface AgentConfigArgs {
	repository?: string;
	detail?: "full";
}

function asRecord(value: unknown): Record_ {
	return value && typeof value === "object" ? (value as Record_) : {};
}

function asArray(value: unknown): Record_[] {
	return Array.isArray(value) ? (value as Record_[]) : [];
}

/** The step every projection reports: id plus the human label. */
function workflowStep(
	view: Record_,
): { id: unknown; label: unknown } | undefined {
	const step = asRecord(view.currentStep);
	if (step.id === undefined && step.label === undefined) return undefined;
	return { id: step.id, label: step.label };
}

/** `pendingQuestions` with the orchestrator-routed ones folded in and
 * de-duplicated by id. The two server arrays overlap (a question routed to the
 * orchestrator is also a pending developer question), so emitting both copied
 * the same bytes twice; one deduplicated list keeps every routed question
 * visible and answerable while dropping the copy. */
export function pendingQuestionUnion(view: Record_): Record_[] {
	const seen = new Set<string>();
	const union: Record_[] = [];
	for (const question of [
		...asArray(view.pendingQuestions),
		...asArray(view.orchestratorQuestions),
	]) {
		const key =
			typeof question.id === "string" ? question.id : JSON.stringify(question);
		if (seen.has(key)) continue;
		seen.add(key);
		union.push(question);
	}
	return union;
}

function failedEffects(view: Record_): Record_[] {
	return asArray(view.effects)
		.filter((effect) => effect.status === "failed")
		.map((effect) => ({
			id: effect.id,
			kind: effect.kind,
			attempts: effect.attempts,
			...(effect.lastError ? { lastError: effect.lastError } : {}),
		}));
}

function availableActionIds(view: Record_): Record_[] {
	return asArray(view.availableActions).map((action) => ({
		id: action.id,
		label: action.label,
	}));
}

export function orchestratorRecoveryStatus(view: Record_): Record_ | undefined {
	if (!view.recovery) return undefined;
	const recovery = asRecord(view.recovery);
	const owned = view.startedBy === "orchestrator";
	return {
		eligible: owned && recovery.eligible === true,
		operation: recovery.operation,
		targetStep: recovery.targetStep,
		refusals: [
			...(Array.isArray(recovery.refusals) ? recovery.refusals : []),
			...(owned
				? []
				: [
						"Only visible workflows started by the orchestrator are within recovery authority.",
					]),
		],
		requiredInputs: recovery.requiredInputs,
		limitations:
			"Current agent step only; no live runs, leased effects, pending questions or human review decisions. Use workflow_recovery_preview before workflow_recover.",
	};
}

/** The default `workflow_status` row: identity, where it is, what it waits
 * for, what the caller may do next, and the one run that is current — a few
 * hundred bytes instead of the whole view. */
export function compactWorkflowStatusView(
	view: Record_,
	options: { includeTask?: boolean } = {},
): Record_ {
	const runs = asArray(view.runs);
	const attention = Array.isArray(asRecord(view.health).attention)
		? (asRecord(view.health).attention as unknown[])
		: [];
	const step = workflowStep(view);
	const currentRun = runs.at(-1);
	return {
		workflowId: view.workflowId,
		target: view.repository,
		status: view.status,
		...(step ? { step } : {}),
		...(attention.length ? { attention } : {}),
		revision: view.revision,
		startedBy: view.startedBy,
		...(options.includeTask && view.task !== undefined
			? { task: view.task }
			: {}),
		pendingQuestions: pendingQuestionUnion(view),
		availableActions: availableActionIds(view),
		...(view.recovery ? { recovery: orchestratorRecoveryStatus(view) } : {}),
		failedEffects: failedEffects(view),
		...(currentRun
			? {
					run: {
						role: currentRun.role,
						status: currentRun.status,
						model: currentRun.model,
					},
				}
			: {}),
	};
}

/** `workflow_status`'s answer: the few-byte `unchanged` short-circuit when the
 * caller's revision is still current, otherwise the compact row. */
export function compactWorkflowStatus(
	view: Record_,
	args: WorkflowStatusArgs = {},
): unknown {
	if (args.sinceRevision !== undefined && args.sinceRevision === view.revision)
		return {
			// A multi-id poll's entries are otherwise indistinguishable, so a named
			// short-circuit identifies itself; the single-id answer is unchanged.
			...(args.named ? { workflowId: view.workflowId } : {}),
			unchanged: true,
			revision: view.revision,
			status: view.status,
			step: workflowStep(view),
		};
	return compactWorkflowStatusView(view, { includeTask: args.includeTask });
}

function compactWorkflowRow(overview: Record_): Record_ {
	const state = asRecord(overview.state);
	const attention = asRecord(state.health).attention;
	return {
		workflowId: state.workflowId,
		// The identifier `workflow_status`, `workflow_action` and
		// `drain_workflow` take as `repo`.
		target: overview.target,
		workflowType: asRecord(state.definition).id,
		status: state.status,
		step: state.stepLabel ?? state.stepId,
		branch: state.branch,
		startedBy: overview.startedBy,
		// The count, not the text: the text is what the compact row exists to
		// leave out.
		attention: Array.isArray(attention) ? attention.length : 0,
	};
}

function fullWorkflowRow(overview: Record_): Record_ {
	const state = asRecord(overview.state);
	return {
		target: overview.target,
		workflowId: state.workflowId,
		workflowType: asRecord(state.definition).id,
		status: state.status,
		step: state.stepLabel ?? state.stepId,
		task: state.task,
		branch: state.branch,
		// Who started the workflow: the session tells its own work from the
		// developer's.
		startedBy: overview.startedBy,
		attention: asRecord(state.health).attention,
		availableActions: state.availableActions,
		agents: overview.agents,
	};
}

function statusMatches(
	status: unknown,
	filter: WorkflowListStatus | undefined,
): boolean {
	if (filter === "all") return true;
	if (filter === "active") return status === "active" || status === "paused";
	if (filter === "attention") return status === "attention-required";
	if (filter === "completed") return status === "completed";
	if (filter === "closed") return status === "closed";
	// The default: everything that is not closed.
	return status !== "closed";
}

/** `list_workflows`' answer: one compact row per workflow, filtered to the
 * requested statuses (every non-closed workflow by default). */
export function projectWorkflowList(
	overviews: readonly unknown[],
	args: WorkflowListArgs = {},
): Record_[] {
	const rows: Record_[] = [];
	for (const overview of overviews) {
		const row = asRecord(overview);
		if (!statusMatches(asRecord(row.state).status, args.status)) continue;
		rows.push(
			args.detail === "full" ? fullWorkflowRow(row) : compactWorkflowRow(row),
		);
	}
	return rows;
}

/** `list_agent_config`'s answer. With a `repository` the default is the compact
 * form — the default profile, the profile and preset *names*, and the gate
 * table — because the full profile/preset tables are what every later turn
 * re-pays for; `detail: "full"` returns them. Without a repository the read is
 * the user-level configuration the tool always returned. */
export function projectAgentConfig(
	agents: Record_,
	args: AgentConfigArgs = {},
): Record_ {
	const project = {
		defaultProfile: agents.default_profile,
		profiles: agents.profiles,
		presets: agents.presets,
		gates: agents.gates,
	};
	if (!args.repository || args.detail === "full") return project;
	return {
		defaultProfile: agents.default_profile,
		profiles: Object.keys(asRecord(agents.profiles)).sort(),
		presets: Object.keys(asRecord(agents.presets)).sort(),
		gates: agents.gates,
	};
}

/** `list_branches`' answer: the refs the picker needs, in one stable shape. */
export function compactBranchRefs(value: unknown): Record_ {
	const refs = asRecord(value);
	return {
		current: refs.current ?? "",
		local: refs.local ?? [],
		remote: refs.remote ?? [],
		default: refs.default ?? "",
	};
}

const BRANCH_CACHE_TTL_MS = 30_000;
const BRANCH_CACHE_MAX_ENTRIES = 32;
const branchCache = new Map<string, { at: number; value: unknown }>();

/** One `list_branches` answer per repository, kept for 30 s: three identical
 * polls in a row cost one read. The cache is bounded, and any workflow start
 * clears it (`invalidateBranchCache`) because a start is what can add a ref. */
export async function cachedBranchRefs(
	repo: string,
	load: () => Promise<unknown>,
): Promise<Record_> {
	const hit = branchCache.get(repo);
	if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS)
		return hit.value as Record_;
	const value = compactBranchRefs(await load());
	if (branchCache.size >= BRANCH_CACHE_MAX_ENTRIES) {
		const oldest = branchCache.keys().next();
		if (!oldest.done) branchCache.delete(oldest.value);
	}
	branchCache.set(repo, { at: Date.now(), value });
	return value;
}

/** Drop every cached branch list. A workflow start calls this, so the next
 * `list_branches` sees the refs the start created. */
export function invalidateBranchCache(): void {
	branchCache.clear();
}

/** Record that a caller asked for the full projection. Telemetry only: it
 * never changes the tool's answer, and it carries no content. */
export function noteFullDetail(
	env: Readonly<Record<string, string>>,
	tool: string,
): void {
	try {
		emitToolTelemetry(env, "orchestrator.detail_full", { tool });
	} catch {
		/* observational only: a failed record never fails the tool */
	}
}
