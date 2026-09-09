// Positive fixture: a feature importing a legitimate type contract from the
// pure domain layer.
import type { Snapshot } from "../../workflow/contracts.ts";

export interface WorkflowOverview {
	snapshot: Snapshot;
	health: string;
}