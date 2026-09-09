// The single process-lifetime builtin registry and the `WorkflowEngine`
// factory built from it. The registry itself stays here; the `engine()`
// factory moved to the application-operations boundary
// (src/workflow/operations.ts, enforce-source-layer-boundaries) so both CLI
// commands and the TUI dashboard construct engines through one layer.
// Moved verbatim out of cli.ts (split-workflow-god-modules).
import { registerBuiltins } from "../definitions.ts";
import { loadConfig } from "../effects.ts";

export const registry = registerBuiltins(
	undefined,
	loadConfig().workflow.max_verification_rounds,
);
