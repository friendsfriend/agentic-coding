import { describe, expect, test } from "bun:test";
import {
	normalizeLocalPiToolsSettings,
	seedAgentHostSettings,
} from "../src/agent-host/settings.ts";

describe("local Pi tool settings", () => {
	test("normalizes machine-local policy lists without retaining duplicates", () => {
		expect(
			normalizeLocalPiToolsSettings({
				enabled: true,
				restrictedAllow: {
					readOnly: ["pi__lookup__query", "pi__lookup__query"],
					orchestrator: [],
				},
				replaySafe: ["mcp__docs__search"],
			}),
		).toEqual({
			settings: {
				enabled: true,
				restrictedAllow: {
					readOnly: ["pi__lookup__query"],
					orchestrator: [],
				},
				replaySafe: ["mcp__docs__search"],
			},
		});
	});

	test("fails closed without echoing invalid policy values", () => {
		const invalid = normalizeLocalPiToolsSettings({
			secret: "never retain this",
			restrictedAllow: { readOnly: ["bad\nname"] },
		});
		expect(invalid).toEqual({
			diagnostic: "local Pi tool bridge configuration is invalid",
		});
	});
});

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
