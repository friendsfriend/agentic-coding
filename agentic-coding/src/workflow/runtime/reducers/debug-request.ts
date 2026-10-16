// The delegated debug request's own handoff lane
// (add-debug-subagent-requests).
//
// A debug side run is deliberately outside the caller workflow's step
// machinery, so `agentHandoff`'s step invariants (current step, active-run
// membership, a transition) are the wrong questions for it. What the handoff
// does instead is finish the request: record the report the delegated run
// produced, measure the files that changed since the baseline taken at start,
// move the run and the request to their terminal status, and enqueue the
// delivery that injects the report into the caller's conversation.
//
// Nothing here touches `snapshot.step`, the caller's runs or the workflow's
// status: the caller keeps working exactly as it was.
import type { Database } from "bun:sqlite";
import type {
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { artifact, tokenMatches } from "../capability.ts";
import { debugRequestForRun, updateDebugRequest } from "../debug-requests.ts";
import { debugRequestReportPathFor } from "../evidence-store.ts";
import { enqueue } from "../kernel.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "../store.ts";

/** What the engine prepared for one delegated run's handoff before it opened
 * the write transaction: the report the run produced, the digest it was read
 * with, the files that changed since the request's baseline, and the staged
 * report bytes the engine renames over their target once the command commits. */
export interface PreparedDebugRequestHandoff {
	readonly report: string;
	readonly artifactDigest?: string;
	readonly changedFiles: readonly string[];
	/** False when tracked changes could not be measured against the baseline, so
	 * `changedFiles` is only the untracked delta. */
	readonly baselineUsable: boolean;
	readonly staged: readonly { path: string; tempPath: string }[];
}

/** Where one request's report is written: the workflow's own data directory
 * **in the repository**, not the checkout's worktree, so the developer still
 * has the report after the worktree is removed. */
export function debugRequestReportPath(
	snapshot: WorkflowSnapshot,
	requestId: string,
): string {
	return debugRequestReportPathFor(
		snapshot.metadata.repository,
		snapshot.metadata.worktree,
		snapshot.workflowId,
		requestId,
	);
}

/** The bounded summary the delivery message leads with: the report's first
 * non-empty lines, cut at a heading-safe bound. The full report stays at its
 * path, which the message names. */
export function debugReportSummary(report: string, maxChars = 1200): string {
	const trimmed = report.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const cut = trimmed.slice(0, maxChars);
	const lastBreak = cut.lastIndexOf("\n");
	return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}\n…`;
}

export function debugRequestHandoff(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.handoff" }>,
	now: () => Date,
	prepared?: PreparedDebugRequestHandoff,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		run.generation !== command.generation ||
		!ACTIVE_RUN.has(run.status)
	)
		throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
	if (
		!run.allowedOutcomes.includes(command.outcome) ||
		!run.capabilityHash ||
		!tokenMatches(command.token, run.capabilityHash) ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or expired run capability",
		);
	const request = debugRequestForRun(db, run.id);
	if (!request)
		throw new WorkflowRuntimeError(
			"stale-run",
			`no debug request owns run ${run.id}`,
		);
	// A cancelled or already finished request is final: a late handoff must not
	// relabel it or deliver a second time.
	if (request.status !== "running")
		throw new WorkflowRuntimeError(
			"stale-run",
			`debug request ${request.id} is ${request.status}`,
		);
	let report: string | undefined;
	let staged: PreparedDebugRequestHandoff["staged"] | undefined;
	if (command.outcome === "complete") {
		if (!prepared?.report || !run.outputPath)
			throw new WorkflowRuntimeError(
				"artifact",
				"prepared debug request report missing",
			);
		// The artifact is re-read through the same capability path every handoff
		// uses, so the bytes recorded here are the bytes the digest names.
		const finalArtifact = artifact(
			run,
			command.artifact,
			snapshot.metadata.worktree,
		);
		if (
			prepared.artifactDigest !== undefined &&
			finalArtifact.digest !== prepared.artifactDigest
		)
			throw new WorkflowRuntimeError(
				"artifact",
				"debug request report changed during the handoff transaction",
			);
		report = prepared.report;
		staged = prepared.staged;
	}
	const status =
		command.outcome === "complete"
			? "completed"
			: command.outcome === "blocked"
				? "blocked"
				: "failed";
	const completedAt = nowIso(now);
	db.query(
		"UPDATE workflow_runs SET status=?, capability_hash='', completed_at=? WHERE id=? AND status IN ('pending','working')",
	).run(status, completedAt, run.id);
	db.query(
		"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
	).run(snapshot.workflowId, run.id);
	const finished = updateDebugRequest(db, request.id, {
		status: report === undefined ? "failed" : "done",
		finishedAt: completedAt,
		...(report === undefined
			? {}
			: {
					reportPath: debugRequestReportPath(snapshot, request.id),
					changedFiles: prepared?.changedFiles ?? [],
					baselineUsable: prepared?.baselineUsable ?? false,
				}),
	});
	// The delivery is a durable effect of the caller's own workflow: the report
	// reaches the caller's conversation even if this process dies right after the
	// commit, and the host's submission id makes a retry the same message.
	enqueue(db, snapshot, "debug.request.deliver", deliveryKey(finished.id), {
		requestId: finished.id,
		workflowId: finished.workflowId,
	});
	return {
		type: "debug.request.handoff",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			outcome: command.outcome,
			requestId: finished.id,
			...(report === undefined ? {} : { reportPath: finished.reportPath }),
			...(staged ? { staged: staged.length } : {}),
		},
	};
}

/** The delivery effect's idempotency key: one delivery per request. */
export function deliveryKey(requestId: string): string {
	return `debug-request:${requestId}:deliver`;
}
