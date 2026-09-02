// The `agent.handoff` reducer: validates the completing run's capability and
// artifact, records evidence, and advances the workflow — including the
// core.verification round-completion logic (critical findings loop back to
// implementation, a clean round runs the test-verifier once before passing),
// the fusion.plan fan-out completion count, and the openspec.validate
// side-effects for core.plan/fusion.consolidate. Moved verbatim out of
// runtime.ts's `reduce()` dispatch (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type { WorkflowCommand, WorkflowSnapshot } from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { planResult } from "../../definitions/contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { artifact, tokenMatches } from "../capability.ts";
import { changedFilesIn, validateSourceBaseline } from "../evidence.ts";
import {
	createRun,
	enqueue,
	expireSiblingRuns,
	fusionDraftInputs,
	fusionPlannerRoles,
	stopRoundAgents,
	transition,
} from "../kernel.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "../store.ts";
import { validateChangeId } from "../targets.ts";

function validateTriageScope(
	snapshot: WorkflowSnapshot,
	output: { assignments: Array<{ role: string; files: string[] }> },
): void {
	const allowed = new Set([
		"quality-verifier",
		"security-verifier",
		"performance-verifier",
		"openspec-verifier",
		"usability-verifier",
	]);
	const changed = new Set(changedFilesIn(snapshot));
	for (const assignment of output.assignments) {
		if (
			!allowed.has(assignment.role) ||
			(snapshot.definition.id === "no-openspec" &&
				assignment.role === "openspec-verifier")
		)
			throw new WorkflowRuntimeError(
				"triage",
				`unsupported verifier role: ${assignment.role}`,
			);
		for (const file of assignment.files)
			if (!changed.has(file))
				throw new WorkflowRuntimeError(
					"triage",
					`triage file is outside changed scope: ${file}`,
				);
	}
}

export function agentHandoff(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "agent.handoff" }>,
	registry: WorkflowRegistry,
	now: () => Date,
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
	let output: unknown;
	let outputDigest: string | undefined;
	if (command.outcome === "complete" && run.outputPath) {
		const validated = artifact(run, command.artifact);
		output = validated.output;
		outputDigest = validated.digest;
	}
	const step = registry.step(run.stepId);
	if (output !== undefined) output = step.output.parse(output);
	if (snapshot.definition.id === "research") validateSourceBaseline(snapshot);
	if (command.outcome === "complete") {
		if (run.stepId === "core.plan" || run.stepId === "fusion.consolidate") {
			// The planner owns change scope: it declares exactly one primary
			// change id in its handoff output, and that id (recorded now, before
			// the entry guard) is what the change-directory validation and every
			// downstream step operate on. Shape validation is the same change-id
			// rule the engine enforces elsewhere. A missing, mis-shaped, or
			// incomplete declaration rejects the completion; the reducer throws
			// inside the transaction, which rolls back, so nothing is recorded
			// and the workflow does not advance.
			let primary: string | undefined;
			try {
				primary = planResult.parse(output).primaryChangeId;
			} catch (error) {
				throw new WorkflowRuntimeError(
					"entry-guard",
					`plan output must declare a primary change id: ${String(
						(error as Error).message,
					)}`,
				);
			}
			validateChangeId(primary);
			snapshot.metadata.changeId = primary;
		}
		registry.step(run.stepId).behavior?.validateEvidence?.({ snapshot });
		if (run.stepId === "core.wiki") validateSourceBaseline(snapshot);
		if (run.stepId === "core.triage")
			validateTriageScope(
				snapshot,
				output as { assignments: Array<{ role: string; files: string[] }> },
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
		"UPDATE workflow_outbox SET status='expired',lease=NULL WHERE workflow_id=? AND status IN ('pending','retry','running') AND kind IN ('artifact.write','agent.launch','agent.prompt') AND json_extract(payload_json,'$.runId')=?",
	).run(snapshot.workflowId, run.id);
	if (outputDigest && run.outputPath)
		snapshot.evidence.push({
			kind: `${run.stepId}:${run.role}`,
			path: run.outputPath,
			digest: outputDigest,
		});
	snapshot.step.activeRunIds = snapshot.step.activeRunIds.filter(
		(id) => id !== run.id,
	);
	snapshot.step.completedRunIds.push(run.id);
	if (snapshot.currentStep === "core.triage" && command.outcome === "complete")
		snapshot.step.selectedRoles = (output as { roles: string[] }).roles;
	if (
		snapshot.currentStep === "core.verification" &&
		command.outcome === "complete"
	) {
		const critical = Number((output as { critical?: number })?.critical ?? 0);
		snapshot.step.results.push({
			runId: run.id,
			role: run.role,
			critical,
			...(outputDigest ? { outputDigest } : {}),
		});
		if (!snapshot.step.activeRunIds.length) {
			if (snapshot.step.results.some((result) => result.critical > 0)) {
				stopRoundAgents(db, snapshot, snapshot.step.attempt);
				transition(
					db,
					snapshot,
					definition,
					(snapshot.loopCounts["core.verification:fix"] ?? 0) + 1 >=
						(definition.edges.find(
							(edge) =>
								edge.from === "core.verification" && edge.outcome === "fix",
						)?.loop?.maxAttempts ?? 1)
						? "limit"
						: "fix",
					{
						findings: snapshot.evidence.filter((item) =>
							item.kind.startsWith("core.verification:"),
						),
					},
					registry,
					now,
				);
			} else if (
				!snapshot.step.testRunStarted &&
				run.role !== "test-verifier"
			) {
				snapshot.step.testRunStarted = true;
				createRun(db, snapshot, step, "test-verifier", now);
			} else {
				stopRoundAgents(db, snapshot, snapshot.step.attempt);
				transition(db, snapshot, definition, "pass", undefined, registry, now);
			}
		}
	} else if (
		command.outcome === "complete" &&
		snapshot.currentStep === "fusion.plan"
	) {
		// Fan-out completion counting: each validated draft is recorded as it
		// arrives; the step only transitions when every planner role holds one.
		snapshot.step.results.push({
			runId: run.id,
			role: run.role,
			critical: 0,
			...(outputDigest ? { outputDigest } : {}),
		});
		const expected = fusionPlannerRoles(snapshot.routing);
		if (
			!snapshot.step.activeRunIds.length &&
			expected.every((role) =>
				snapshot.step.results.some(
					(result) => result.role === role && result.outputDigest,
				),
			)
		)
			transition(
				db,
				snapshot,
				definition,
				"complete",
				{ drafts: fusionDraftInputs(snapshot) },
				registry,
				now,
			);
	} else if (
		command.outcome === "complete" &&
		snapshot.currentStep === "core.plan"
	)
		enqueue(
			db,
			snapshot,
			"openspec.validate",
			`openspec:${snapshot.workflowId}:plan:${snapshot.step.attempt}`,
			{ changeId: snapshot.metadata.changeId },
		);
	else if (
		command.outcome === "complete" &&
		snapshot.currentStep === "fusion.consolidate"
	)
		enqueue(
			db,
			snapshot,
			"openspec.validate",
			`openspec:${snapshot.workflowId}:consolidate:${snapshot.step.attempt}`,
			{ changeId: snapshot.metadata.changeId },
		);
	else if (command.outcome === "complete")
		transition(db, snapshot, definition, "complete", output, registry, now);
	else if (command.outcome === "blocked") {
		if (
			snapshot.definition.id === "wiki" ||
			snapshot.definition.id === "wiki-comments" ||
			snapshot.definition.id === "research"
		)
			transition(
				db,
				snapshot,
				definition,
				"blocked",
				command.message,
				registry,
				now,
			);
		else {
			snapshot.status = "attention-required";
			snapshot.attention = [command.message ?? `${run.role} blocked`];
		}
	} else {
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
	if (
		(run.stepId === "core.wiki" || run.stepId === "core.research") &&
		run.handle
	)
		enqueue(
			db,
			snapshot,
			"agent.stop",
			`run:${run.id}:stop:${run.generation}`,
			{
				runId: run.id,
			},
		);
	return {
		type: "agent.handoff",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: { outcome: command.outcome, outputDigest },
	};
}
