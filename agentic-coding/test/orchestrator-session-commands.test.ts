import { expect, test } from "bun:test";
import { orchestratorSessionCommands } from "../src/tui/orchestrator/session-commands.ts";

test("/clear-session and /new both start a fresh orchestrator conversation", () => {
	let starts = 0;
	const reset = () => {
		starts += 1;
	};
	const commands = orchestratorSessionCommands(reset);
	expect(commands.map((command) => command.name)).toEqual([
		"/clear-session",
		"/new",
	]);
	for (const command of commands) {
		expect(command.run).toBe(reset);
		command.run();
	}
	expect(starts).toBe(2);
});
