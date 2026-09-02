// The `agent.research-handoff` reducer: records the active researcher run's
// structured handoff and, in the same authenticated step, transitions into
// wiki drafting. Moved verbatim out of runtime.ts's `reduce()` dispatch
// (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type {
	JsonValue,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { researchHandoffContract } from "../../definitions.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { questionRun } from "../dialogue.ts";
import { validateSourceBaseline } from "../evidence.ts";
import { enqueue, expireRuns, transition } from "../kernel.ts";
import { runs } from "../store.ts";

/** Record the active researcher run's structured handoff and, in the same
 * authenticated step, request the transition into wiki drafting. Reuses
 * the same source-isolation and workspace-readiness checks a developer
 * dashboard action previously performed before that transition: an
 * invalid handoff or a failed check throws, leaves the researcher run
 * active, and performs no expiry or transition. Only a valid handoff that
 * passes every check expires the researcher run, stops its session, and
 * enters `core.wiki`. */
export function recordResearchHandoff(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "agent.research-handoff" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	if (
		snapshot.definition.id !== "research" ||
		command.stepId !== "core.research" ||
		command.role !== "researcher"
	)
		throw new WorkflowRuntimeError(
			"unavailable",
			"research handoff recording is only available to the active core.research researcher run",
		);
	const run = questionRun(db, snapshot, command, now);
	let handoff: ReturnType<typeof researchHandoffContract.parse>;
	try {
		handoff = researchHandoffContract.parse(command.handoff);
	} catch (error) {
		throw new WorkflowRuntimeError(
			"invalid-command",
			error instanceof Error ? error.message : String(error),
		);
	}
	validateSourceBaseline(snapshot);
	if (!snapshot.metadata.workspace)
		throw new WorkflowRuntimeError(
			"unavailable",
			"research handoff requires a ready workspace",
		);
	const active = runs(db, snapshot.workflowId).filter((item) =>
		snapshot.step.activeRunIds.includes(item.id),
	);
	const researchContext = {
		task: snapshot.metadata.task ?? "",
		handoff: handoff as unknown as JsonValue,
	};
	expireRuns(db, snapshot, now);
	for (const item of active)
		if (item.handle)
			enqueue(
				db,
				snapshot,
				"agent.stop",
				`run:${item.id}:stop:${item.generation}`,
				{
					runId: item.id,
				},
			);
	transition(
		db,
		snapshot,
		definition,
		"request-wiki",
		researchContext,
		registry,
		now,
	);
	return {
		type: "research.handoff.recorded",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: { runId: run.id },
	};
}
