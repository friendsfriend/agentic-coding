// Engine events → the run tree history serves
// (`port-action-execution-to-bun`, task 2.3).
//
// Ported from `server/pkg/actionexec/projection.go`.
//
// Accounting rule: exactly one leaf step per executed command, and no
// placeholder step for work that did not execute. A composite or an SDK
// operation that runs no process stays commandless rather than gaining an empty
// command record, and a semantic node that only mirrors a shared execution is
// marked as a reference instead of owning duplicate output.
import type { EngineEvent, EventSink } from "./engine.ts";
import { RUN_STATUS, type RunRegistry } from "./run-registry.ts";

export class ActionRunProjection implements EventSink {
	constructor(private readonly registry: RunRegistry) {}

	emit(event: EngineEvent): void {
		const at = event.at;
		switch (event.type) {
			case "step.started":
				this.registry.addStep(event.runId, {
					id: event.stepId,
					definitionId: event.stepId,
					label: event.label ?? "",
					status: RUN_STATUS.active,
					startedAt: at,
					commands: [],
				});
				return;
			case "step.reference":
				this.registry.addStep(event.runId, {
					id: event.stepId,
					definitionId: event.stepId,
					label: event.label ?? "",
					canonicalId: event.canonicalId,
					sharedReference: true,
					status: RUN_STATUS.active,
					commands: [],
				});
				return;
			case "step.completed":
				this.registry.updateStep(event.runId, event.stepId, (step) => {
					step.status = RUN_STATUS.completed;
					step.finishedAt = at;
					if (event.outcome) step.outcome = event.outcome;
				});
				return;
			case "step.failed":
				this.registry.updateStep(event.runId, event.stepId, (step) => {
					step.status = RUN_STATUS.failed;
					step.finishedAt = at;
					if (event.outcome) step.outcome = event.outcome;
					if (event.error !== undefined) step.error = event.error;
				});
				return;
			default:
				return;
		}
	}
}
