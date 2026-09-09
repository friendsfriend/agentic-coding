// Positive fixture: a feature consuming application operations, a typed
// engine view, and a shared primitive.

import { drainEffects } from "../../workflow/operations.ts";
import type { WorkflowView } from "../../workflow/runtime/view.ts";
import { GenericModal } from "../shared/GenericModal.tsx";

export function Overview(view: WorkflowView): unknown {
	drainEffects();
	return { view, modal: GenericModal };
}