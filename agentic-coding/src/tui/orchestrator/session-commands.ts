// Both commands create a fresh host conversation, rather than just clearing
// the rendered transcript. The view owns reconnection and local UI state.
export function orchestratorSessionCommands(
	startNewSession: () => void,
	attachWorkflow?: (argument?: string) => void,
) {
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
		...(attachWorkflow
			? [
					{
						name: "/attach",
						description:
							"Attach clarification custody to this Home: workflow-id [repository path]",
						acceptsArguments: true,
						run: attachWorkflow,
					},
				]
			: []),
	];
}
