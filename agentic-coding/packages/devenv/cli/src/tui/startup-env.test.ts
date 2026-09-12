import { describe, expect, test } from "bun:test";
import { configureOpenTuiConsoleEnv } from "./startup-env";

describe("configureOpenTuiConsoleEnv", () => {
	test("disables OpenTUI console capture by default", () => {
		const env: NodeJS.ProcessEnv = {};
		configureOpenTuiConsoleEnv(env);
		expect(env.OTUI_USE_CONSOLE).toBe("false");
	});

	test("enables OpenTUI console capture for DevEnv console mode", () => {
		const env: NodeJS.ProcessEnv = { DEVENV_TUI_CONSOLE: "1" };
		configureOpenTuiConsoleEnv(env);
		expect(env.OTUI_USE_CONSOLE).toBe("true");
	});

	test("respects explicit OpenTUI console setting", () => {
		const env: NodeJS.ProcessEnv = {
			DEVENV_TUI_CONSOLE: "1",
			OTUI_USE_CONSOLE: "false",
		};
		configureOpenTuiConsoleEnv(env);
		expect(env.OTUI_USE_CONSOLE).toBe("false");
	});
});
