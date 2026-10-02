import { describe, expect, test } from "bun:test";
import { seedAgentHostSettings } from "../src/agent-host/settings.ts";

describe("agentHost settings seeding", () => {
	test("seeds matching keys from the global pi settings when absent", () => {
		const seeded = seedAgentHostSettings(undefined, {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
		});
		expect(seeded).toEqual({
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "high",
		});
	});

	test("never overwrites an existing section, however the global default changes", () => {
		const existing = {
			defaultProvider: "opencode-go",
			defaultModel: "deepseek-v4.1-flash",
		};
		const seeded = seedAgentHostSettings(existing, {
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
		});
		expect(seeded).toBe(existing);
	});

	test("seeds nothing from an absent or empty global settings file", () => {
		expect(seedAgentHostSettings(undefined, undefined)).toEqual({});
		expect(seedAgentHostSettings(undefined, {})).toEqual({});
	});

	test("ignores blank or non-string global values", () => {
		expect(
			seedAgentHostSettings(undefined, {
				defaultProvider: "  ",
				defaultModel: 42 as unknown as string,
			}),
		).toEqual({});
	});
});
