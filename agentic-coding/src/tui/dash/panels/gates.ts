// The dashboard's view of the workflow's stage-gate history. Pure projection:
// the Change panel renders it, and it never reads workflow state itself.
// A gate decision list is append-only and ordered oldest first, so the latest
// record per stage is simply the last one seen — a stage that later ran again
// after an earlier skip is not reported as skipped.
import type { GateDecisionRecord } from "../../../contracts/workflow.ts";

export interface SkippedGateStage {
	readonly stage: string;
	readonly policy: string;
	readonly noul?: number;
}

/** The stages whose most recent decision was a skip, in the order they were
 * first recorded. A workflow that has skipped nothing yields an empty list, so
 * the panel renders nothing rather than a permanent empty heading. */
export function skippedGateStages(
	decisions: readonly GateDecisionRecord[],
): SkippedGateStage[] {
	const latest = new Map<string, GateDecisionRecord>();
	for (const decision of decisions) latest.set(decision.stage, decision);
	return [...latest.values()]
		.filter((decision) => decision.decision === "skip")
		.map((decision) => ({
			stage: decision.stage,
			policy: decision.policy,
			...(decision.noul === undefined ? {} : { noul: decision.noul }),
		}));
}
