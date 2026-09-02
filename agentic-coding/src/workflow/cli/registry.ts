// The single process-lifetime builtin registry and the `WorkflowEngine`
// factory built from it. Moved verbatim out of cli.ts
// (split-workflow-god-modules) into its own module since `start`, `drain`,
// and `engine()` all need the same registry instance.
import { registerBuiltins } from "../definitions.ts";
import { loadConfig } from "../effects.ts";
import { WorkflowEngine } from "../runtime.ts";

export const registry = registerBuiltins(
	undefined,
	loadConfig().workflow.max_verification_rounds,
);
export function engine(): WorkflowEngine {
	return new WorkflowEngine(registry);
}
