// Positive fixture: pure step behavior consuming typed validated evidence and
// an explicitly supplied timestamp, with no external access.
import type { Snapshot } from "../contracts.ts";

export interface StepEvidence {
	complete: boolean;
	tasks: string[];
}

export function decide(
	snapshot: Snapshot,
	evidence: StepEvidence,
	now: number,
): boolean {
	return snapshot.status === "active" && evidence.complete && now > 0;
}