// Application-operations boundary shared by the CLI surface and the TUI
// dashboard (enforce-source-layer-boundaries): the in-process engine factory,
// durable effect draining, project discovery, and the continuation constant.
// The CLI composes these operations into commands; the dashboard consumes
// them directly as an application client. Neither the CLI command modules nor
// the TUI presentation layers may import each other — both consume this
// boundary instead. Exact-edge function provenance:
//   - `engine` moved from cli/registry.ts (the process-lifetime registry
//     itself stays in the CLI layer)
//   - `drainEffects` + `CONTINUATION_WAIT_MS` moved from cli/drain.ts
//   - `listProjects` moved from cli/commands/misc.ts
import { Effect } from "effect";
import type { WorkflowDeletion } from "../contracts/actions.ts";
import { runWorktree } from "../worktree/boundary.ts";
import { WorktreeAdapter } from "../worktree/index.ts";
import { WorktreeError } from "../worktree/port.ts";
import { type AgentAdapter, PiDurableAdapter } from "./adapters.ts";
import type { WorkflowApplication } from "./application.ts";
import { registry } from "./cli/registry.ts";
import type { CredentialPrompt } from "./credentials.ts";
import { agentEffectHandlers, EffectRunner } from "./effect-runner.ts";
import { TelemetrySink } from "./observability.ts";
import {
	loadProjectCatalog,
	type ProjectCatalogOptions,
	type ProjectOption,
	projectOptions,
} from "./project-catalog.ts";
import {
	dueQuestionTimers,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	WorkflowEngine,
	wikiWorkflowDataRoot,
} from "./runtime.ts";
export const CONTINUATION_WAIT_MS = 65_000;

/** The `WorkflowEngine` factory built from the process-lifetime builtin
 * registry. CLI commands and the dashboard coordinator both start engines
 * through this boundary; when a named application root is supplied the
 * engine consumes its root-owned layer instead of building a nested runtime
 * (complete-workflow-effect-cutover, task 1). */
export function engine(application?: WorkflowApplication): WorkflowEngine {
	return new WorkflowEngine(
		registry,
		application?.clock,
		undefined,
		application?.layerOf(),
	);
}

/** Runs the effect-runner against every pending effect for a workflow
 * within the given bounded wait budget. */
export async function drainEffects(
	workflowEngine: WorkflowEngine,
	repo: string,
	credentialPrompt?: CredentialPrompt,
	limit = 20,
	waitMs = 0,
	signal?: AbortSignal,
	onFailure?: (workflowId: string, message: string) => void,
	onProgress?: () => void,
): Promise<number> {
	// The durable host is the one managed runtime (multiplexer removal).
	const adapters = new Map<string, AgentAdapter>([
		["pi-durable", new PiDurableAdapter()],
	]);
	const handlers = agentEffectHandlers(repo, workflowEngine, {
		registry,
		adapters,
		credentialPrompt,
		telemetry: (directory, envelope) =>
			new TelemetrySink(directory).emit(envelope),
	});
	const deadline = Date.now() + Math.max(0, waitMs);
	let completed = 0;
	do {
		if (signal?.aborted) break;
		// Drain through the Effect program directly (the Promise facade stays
		// only for test callers); the CLI/dashboard callers run this within
		// their owned application scope (complete-workflow-effect-cutover,
		// task 3.1).
		completed += await Effect.runPromise(
			new EffectRunner(repo, workflowEngine, handlers).drainProgram(
				limit,
				30_000,
				signal,
				onFailure,
				onProgress,
			),
		);
		if (signal?.aborted) break;
		expireDueQuestionTimers(workflowEngine, repo, limit);
		if (Date.now() >= deadline) break;
		await Bun.sleep(Math.min(DRAIN_POLL_MS, deadline - Date.now()));
	} while (!signal?.aborted && Date.now() < deadline);
	return completed;
}

/** Every configured project option from the canonical catalog, including
 * unavailable projects (which stay visible with their availability). This is
 * the shared discovery boundary for the CLI `projects` output and the wizard —
 * no caller scans directories or re-reads legacy discovery configuration. */
export async function listProjects(
	options: ProjectCatalogOptions = {},
): Promise<ProjectOption[]> {
	const catalog = await loadProjectCatalog(options);
	return projectOptions(catalog);
}

/** Delete one durable workflow: its store rows first, then its worktree
 * directory. The branch is kept (the same policy the workflow's own
 * `workspace.cleanup` effect applies), so the committed work stays reviewable.
 * Repository-independent workflows (wiki, research) own no worktree and are
 * store-only. */
export async function deleteWorkflow(
	repo: string,
	workflowId: string,
	application?: WorkflowApplication,
): Promise<WorkflowDeletion> {
	const workflowEngine = engine(application);
	// The worktree path lives in the snapshot the delete removes, so it is read
	// before the transaction.
	const view = workflowEngine.status(repo, workflowId);
	workflowEngine.deleteWorkflow(repo, workflowId);
	return removeWorkflowWorktree(repo, view.worktree, view.repository);
}

/** The shared wiki/research data root, when this machine has one. Its store
 * file holds every wiki and research workflow's rows, so no delete may remove
 * the directory: a legacy row that kept the shared root in its worktree column
 * would otherwise take every other workflow's state with it. */
function sharedTargetDataRoot(): string | undefined {
	try {
		return wikiWorkflowDataRoot();
	} catch {
		return undefined;
	}
}

async function removeWorkflowWorktree(
	repo: string,
	worktree: string,
	repository: string,
): Promise<WorkflowDeletion> {
	// A repository-independent workflow (wiki, research) owns no worktree: its
	// rows live in the shared target store. Neither does a workflow checked out
	// in its own repository, and the shared store's directory is never a
	// deletable worktree, whichever store a legacy row was read from.
	if (
		isWikiWorkflowTarget(repo) ||
		isResearchWorkflowTarget(repo) ||
		!worktree ||
		worktree === repository ||
		worktree === sharedTargetDataRoot()
	)
		return { worktreeRemoved: false };
	try {
		await runWorktree(
			new WorktreeAdapter().remove({
				repo: repository,
				path: worktree,
				force: true,
			}),
		);
		return { worktreeRemoved: true };
	} catch (error) {
		// A worktree that is already gone counts as removed, exactly as the
		// cleanup effect treats an absent workspace.
		if (error instanceof WorktreeError && error.kind === "absent")
			return { worktreeRemoved: true };
		return {
			worktreeRemoved: false,
			worktreeError: error instanceof Error ? error.message : String(error),
		};
	}
}

const DRAIN_POLL_MS = 1_000;

function expireDueQuestionTimers(
	workflowEngine: WorkflowEngine,
	repo: string,
	limit: number,
): void {
	for (const timer of dueQuestionTimers(repo, new Date(), limit)) {
		try {
			workflowEngine.dispatch(repo, {
				type: "timer.question-expire",
				workflowId: timer.workflowId,
				questionId: timer.questionId,
				timerNonce: timer.timerNonce,
			});
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/stale-question|no longer pending|invalid/.test(error.message)
			)
				throw error;
		}
	}
}
