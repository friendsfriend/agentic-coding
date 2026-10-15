// The `agent.resume` reducer: reopens the run a developer abort parked, when
// the developer speaks to that run again (dashboard/agent-session prompt,
// steering, follow-up or overwrite). A developer abort records the run's
// `blocked` handoff with `aborted: true`, which keeps the run's capability
// (the durable marker `agent-handoff.ts` documents); this reducer is the only
// writer that turns that parked run back into a working one.
//
// Only an aborted run is reopenable. A run that handed off `blocked` itself
// (a real blocker, or a question asker) has no capability left, so an
// unrelated message can never clear the park it created.
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
	DEVELOPER_ABORT_MESSAGE,
	type WorkflowCommand,
	type WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type { CompiledWorkflowDefinition } from "../../registry.ts";
import { agentRunEnvironmentFile } from "../../run-env.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../../secure-fs.ts";
import { hashToken, tokenMatches } from "../capability.ts";
import { ACTIVE_RUN, type RunRow, runFromRow } from "../store.ts";

/** Whether the caller still holds the run's own launch token: the only
 * credential a park recorded before the abort marker existed left behind. The
 * file is the run's 0600 launch environment, read the same way the managed CLI
 * resolves a persistent agent's refreshed token. Returns false for every
 * unreadable or non-matching file, so a missing file fails closed. */
function holdsLaunchToken(
	snapshot: WorkflowSnapshot,
	runId: string,
	token: string,
): boolean {
	if (!token) return false;
	const file = agentRunEnvironmentFile({
		worktree: snapshot.metadata.worktree,
		definitionId: snapshot.definition.id,
		workflowId: snapshot.workflowId,
		runId,
	});
	let directory: number | undefined;
	try {
		directory = openSecureDirectory(
			path.dirname(file),
			path.dirname(path.dirname(file)),
			false,
		);
		const fd = openSecureFile(directory, path.basename(file));
		try {
			const contents = fs.readFileSync(fd, "utf8");
			const stored = contents
				.split("\n")
				.find((line) => line.startsWith("HERDR_RUN_TOKEN="))
				?.slice("HERDR_RUN_TOKEN=".length)
				?.replace(/^'|'$/g, "");
			return stored !== undefined && tokenMatches(token, hashToken(stored));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	} finally {
		if (directory !== undefined) closeSecureDirectory(directory);
	}
}

export function agentResume(
	db: Database,
	snapshot: WorkflowSnapshot,
	_definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "agent.resume" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("not-found", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== command.workflowId ||
		run.stepId !== command.stepId ||
		run.role !== command.role
	)
		throw new WorkflowRuntimeError("unauthorized", "run does not match caller");
	// A park is reopenable when it carries the abort marker (its capability), or -
	// for a park recorded before that marker existed - when the workflow owes
	// developer input for exactly the abort message and the caller still holds
	// the run's own launch token. Every other `blocked` outcome (the agent's own
	// blocker, a question asker, a delegated run) is refused here, so an
	// unrelated message can never clear a park the agent created.
	const marker = run.status === "blocked" && run.capabilityHash !== "";
	const preMarkerPark =
		run.status === "blocked" &&
		run.capabilityHash === "" &&
		snapshot.status === "attention-required" &&
		snapshot.attention.includes(DEVELOPER_ABORT_MESSAGE) &&
		holdsLaunchToken(snapshot, run.id, command.token);
	if (!marker && !preMarkerPark)
		throw new WorkflowRuntimeError(
			// Its own code, so the caller can tell "this park is not yours to
			// clear" (nothing changed) from a stale state, and no rejection audit
			// row is written for a prompt that simply hit a parked run.
			"not-parked",
			"run is not parked by a developer abort",
		);
	if (
		marker &&
		(Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
			!tokenMatches(command.token, run.capabilityHash))
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or expired run capability",
		);
	if (
		snapshot.status === "paused" ||
		snapshot.status === "completed" ||
		snapshot.status === "closed"
	)
		throw new WorkflowRuntimeError(
			"unavailable",
			`workflow is ${snapshot.status}`,
		);
	// The parked run must still be the current step's own run: a step that
	// moved on, a bumped attempt (the answer path re-issues a run) or a live
	// sibling of the same role all mean this run is history, not a live
	// session the developer is talking to.
	if (
		snapshot.currentStep !== run.stepId ||
		run.attempt !== snapshot.step.attempt ||
		!snapshot.step.completedRunIds.includes(run.id) ||
		snapshot.step.activeRunIds.includes(run.id)
	)
		throw new WorkflowRuntimeError(
			"stale-run",
			"run is no longer the current attempt of this step",
		);
	const runList = db
		.query("SELECT * FROM workflow_runs WHERE workflow_id=?")
		.all(snapshot.workflowId) as RunRow[];
	if (
		runList.some(
			(item) =>
				item.id !== run.id &&
				item.step_id === run.stepId &&
				item.role === run.role &&
				ACTIVE_RUN.has(item.status),
		)
	)
		throw new WorkflowRuntimeError(
			"unavailable",
			"another run of this role is active",
		);
	// A pre-marker park has no capability left to keep, so the caller's own
	// launch token - just verified against the run's launch environment - is
	// bound as this run's capability: the reopened run must be able to hand off
	// at the end of its continued turn.
	const capabilityHash = marker ? run.capabilityHash : hashToken(command.token);
	const reopened = db
		.query(
			"UPDATE workflow_runs SET status='working', capability_hash=?, completed_at=NULL WHERE id=? AND status='blocked'",
		)
		.run(capabilityHash, run.id);
	if (reopened.changes !== 1)
		throw new WorkflowRuntimeError(
			"not-parked",
			"run is no longer parked by a developer abort",
		);
	snapshot.step.activeRunIds.push(run.id);
	snapshot.step.completedRunIds = snapshot.step.completedRunIds.filter(
		(id) => id !== run.id,
	);
	// Clear exactly the abort's own attention entry: a diagnostic another
	// writer parked beside it survives, and the workflow only becomes active
	// again once nothing is left owing developer input.
	snapshot.attention = snapshot.attention.filter(
		(entry) => entry !== DEVELOPER_ABORT_MESSAGE,
	);
	if (
		snapshot.status === "attention-required" &&
		snapshot.attention.length === 0 &&
		!runList.some((item) => item.id !== run.id && item.status === "blocked")
	)
		snapshot.status = "active";
	return {
		type: "agent.resumed",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			generation: run.generation,
			// Which park was reopened, so the durable log distinguishes the
			// authenticated marker from a park recorded before it existed.
			park: marker ? "abort-marker" : "abort-attention",
		},
	};
}
