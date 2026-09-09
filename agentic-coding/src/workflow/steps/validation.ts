// Pure entry-guard validation over already-prepared evidence
// (enforce-source-layer-boundaries): these functions receive
// `PreparedStepEvidence` prepared by the runtime (`prepareStepEvidence` in
// src/workflow/runtime/evidence.ts) and never touch filesystem, persistence,
// or other effects themselves.
import { WorkflowRuntimeError } from "../contracts.ts";

export interface PreparedStepEvidence {
	planning?: { complete: boolean; hasScenario: boolean; missing?: string };
	implementation?: { tasksComplete: boolean };
	archive?: { activeExists: boolean; archived: boolean };
}

/** Planning and consolidation both must leave a complete OpenSpec change
 * directory behind before their completion counts. */
export function validatePlanningArtifacts(
	_evidence: PreparedStepEvidence,
): void {
	const evidence = _evidence;
	if (!evidence.planning?.complete)
		throw new WorkflowRuntimeError(
			"entry-guard",
			`planning artifact invalid: ${evidence.planning?.missing ?? "proposal.md"}`,
		);
	if (!evidence.planning.hasScenario)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"planning requires at least one OpenSpec scenario",
		);
}

export function validateImplementationEvidence(
	evidence: PreparedStepEvidence,
): void {
	if (!evidence.implementation?.tasksComplete)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"implementation requires completed OpenSpec tasks",
		);
}

export function validateArchiveEvidence(evidence: PreparedStepEvidence): void {
	if (evidence.archive?.activeExists || !evidence.archive?.archived)
		throw new WorkflowRuntimeError("entry-guard", "archive move not found");
}
