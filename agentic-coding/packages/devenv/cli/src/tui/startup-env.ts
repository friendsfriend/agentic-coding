export function configureOpenTuiConsoleEnv(
	env: NodeJS.ProcessEnv = process.env,
) {
	if (env.OTUI_USE_CONSOLE !== undefined) return;
	env.OTUI_USE_CONSOLE = env.DEVENV_TUI_CONSOLE === "1" ? "true" : "false";
}
