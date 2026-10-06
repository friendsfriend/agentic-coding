// Run-environment keys of the Home Orchestrator session. Kept free of
// pi-durable imports so the TUI can write them without loading the runtime.

/** Base URL of the unified server the orchestrator tools call. */
export const ORCHESTRATOR_URL_ENV = "AGENTIC_ORCHESTRATOR_URL";
/** The orchestrator capability (`orchestratorTokenFor`), never the instance token. */
export const ORCHESTRATOR_TOKEN_ENV = "AGENTIC_ORCHESTRATOR_TOKEN";
