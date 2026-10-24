// Both commands create a fresh host conversation, rather than just clearing
// the rendered transcript. The view owns reconnection and local UI state.
export function orchestratorSessionCommands(startNewSession: () => void) {
	return [
		{
			name: "/clear-session",
			description: "Clear orchestrator context and start a fresh session",
			run: startNewSession,
		},
		{
			name: "/new",
			description: "Start a new orchestrator session (alias of /clear-session)",
			run: startNewSession,
		},
	];
}
