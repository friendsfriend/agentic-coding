// Positive fixture: application-operations boundary (in-process engine
// factory and effect draining shared by CLI and TUI).
export function engine(): unknown {
	return "engine";
}

export function drainEffects(): void {
	// durable effect execution
}