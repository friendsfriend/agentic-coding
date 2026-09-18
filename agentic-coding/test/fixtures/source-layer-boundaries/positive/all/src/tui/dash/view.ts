// Positive fixture: a feature consuming application operations, a typed
// engine view, and a shared primitive.

import { GenericModal } from "@ui";
import { drainEffects } from "../../workflow/operations.ts";
import type { WorkflowView } from "../../workflow/runtime/view.ts";

export function Overview(view: WorkflowView): unknown {
	drainEffects();
	return { view, modal: GenericModal };
}