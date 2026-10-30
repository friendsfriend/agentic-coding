// Run-environment keys of the Home Orchestrator session. Kept free of
// pi-durable imports so the TUI can write them without loading the runtime.

/** Base URL of the unified server the orchestrator tools call. */
export const ORCHESTRATOR_URL_ENV = "AGENTIC_ORCHESTRATOR_URL";
/** Operator launch-pinned verifier origin, never taken from recoverRun JSON. */
export const ORCHESTRATOR_INPUT_VERIFIER_ENV =
	"AGENTIC_ORCHESTRATOR_INPUT_VERIFIER_URL";
/** The orchestrator capability (`orchestratorTokenFor`), never the instance token. */
export const ORCHESTRATOR_TOKEN_ENV = "AGENTIC_ORCHESTRATOR_TOKEN";
/** The shell's primary repository: the project the embedded OpenCode TUI uses
 * and the project `opencode_session` creates sessions in. */
export const OPENCODE_CWD_ENV = "AGENTIC_OPENCODE_CWD";
