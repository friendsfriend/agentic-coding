// The `agent.handoff` reducer: validates the completing run's capability and
// artifact, records evidence, and applies the registered step's completion
// result. Step-specific aggregation, validation, and follow-up requests stay
// in `src/workflow/steps`; this reducer owns authentication and bookkeeping.
import type { Database } from "bun:sqlite";
import path from "node:path";
import type { WorkflowCommand, WorkflowSnapshot } from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import type { PreparedStepEvidence } from "../../steps/validation.ts";
import { artifact, tokenMatches } from "../capability.ts";
import { sourceContentFingerprint } from "../evidence.ts";
import {
	applyCompletionResult,
	expireSiblingRuns,
	transition,
} from "../kernel.ts";
import { prepareStepEvidence } from "../step-evidence.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "../store.ts";
import { wikiWorkflowDataRoot } from "../targets.ts";

export interface PreparedHandoffEvidence {
	artifactDigest?: string;
	artifactOutput?: unknown;
	changedFiles?: readonly string[];
	sourceFingerprint?: string;
	stepEvidence?: PreparedStepEvidence;
}

export function agentHandoff(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "agent.handoff" }>,
	registry: WorkflowRegistry,
	now: () => Date,
	prepared?: PreparedHandoffEvidence,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		run.generation !== command.generation ||
		!ACTIVE_RUN.has(run.status) ||
		run.stepId !== snapshot.currentStep ||
		!snapshot.step.activeRunIds.includes(run.id)
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
	if (prepared?.sourceFingerprint) {
		const currentFingerprint = sourceContentFingerprint(
			snapshot.metadata.repository,
			snapshot.metadata.wikiRoot,
		);
		if (currentFingerprint !== prepared.sourceFingerprint)
			throw new WorkflowRuntimeError(
				"source-isolation",
				"source changed during handoff transaction",
			);
	}
	let output: unknown;
	let outputDigest: string | undefined;
	if (command.outcome === "complete" && run.outputPath) {
		if (!prepared?.artifactDigest || prepared.artifactOutput === undefined)
			throw new WorkflowRuntimeError("artifact", "prepared artifact missing");
		if (path.resolve(command.artifact ?? "") !== path.resolve(run.outputPath))
			throw new WorkflowRuntimeError("artifact", "artifact path changed");
		const finalArtifact = artifact(
			run,
			command.artifact,
			snapshot.definition.id === "wiki-comments"
				? wikiWorkflowDataRoot()
				: snapshot.metadata.worktree,
		);
		if (finalArtifact.digest !== prepared.artifactDigest)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact changed during handoff transaction",
			);
		output = finalArtifact.output;
		outputDigest = finalArtifact.digest;
	}
	const step = registry.stepForDefinition(definition, run.stepId);
	if (output !== undefined) output = step.output.parse(output);

	const handoffEvidence =
		outputDigest && run.outputPath
			? {
					kind: `${run.stepId}:${run.role}`,
					path: run.outputPath,
					digest: outputDigest,
				}
			: undefined;
	const completion = step.behavior?.onAgentComplete?.({
		snapshot: structuredClone(snapshot),
		definitionId: definition.id,
		run,
		outcome: command.outcome,
		output,
		outputDigest,
		changedFiles: prepared?.changedFiles,
		remainingActiveRunIds: snapshot.step.activeRunIds.filter(
			(id) => id !== run.id,
		),
		loopMaxAttempts: definition.edges.find(
			(edge) => edge.from === run.stepId && edge.outcome === "fix",
		)?.loop?.maxAttempts,
		evidence: handoffEvidence
			? [...snapshot.evidence, handoffEvidence]
			: snapshot.evidence,
	});
	if (completion?.metadata?.changeId !== undefined)
		snapshot.metadata.changeId = completion.metadata.changeId;
	if (command.outcome === "complete" && prepared?.stepEvidence) {
		const currentEvidence = prepareStepEvidence(snapshot);
		if (
			JSON.stringify(currentEvidence) !== JSON.stringify(prepared.stepEvidence)
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				"step evidence changed during handoff transaction",
			);
	}
	const completedAt = nowIso(now);
	db.query(
		"UPDATE workflow_runs SET status=?, capability_hash='', output_digest=?, completed_at=? WHERE id=? AND status IN ('pending','working')",
	).run(
		command.outcome === "complete" ? "completed" : command.outcome,
		outputDigest ?? null,
		completedAt,
		run.id,
	);
	db.query(
		"UPDATE workflow_outbox SET status='expired',lease=NULL,lease_expires_at=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
	).run(snapshot.workflowId, run.id);
	if (handoffEvidence) snapshot.evidence.push(handoffEvidence);
	snapshot.step.activeRunIds = snapshot.step.activeRunIds.filter(
		(id) => id !== run.id,
	);
	snapshot.step.completedRunIds.push(run.id);
	if (completion) {
		applyCompletionResult(
			db,
			snapshot,
			definition,
			step,
			completion,
			registry,
			now,
		);
		if (
			command.outcome === "complete" &&
			!completion.transition &&
			!completion.deferTransition
		)
			transition(db, snapshot, definition, "complete", output, registry, now);
	} else if (command.outcome === "complete")
		transition(db, snapshot, definition, "complete", output, registry, now);
	else if (command.outcome === "blocked" && !completion) {
		snapshot.status = "attention-required";
		snapshot.attention = [command.message ?? `${run.role} blocked`];
	} else if (command.outcome === "failed") {
		expireSiblingRuns(db, snapshot, now);
		transition(
			db,
			snapshot,
			definition,
			"failed",
			command.message,
			registry,
			now,
		);
	}
	return {
		type: "agent.handoff",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: { outcome: command.outcome, outputDigest },
	};
}
