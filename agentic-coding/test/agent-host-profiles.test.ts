import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertModelAvailable,
	BUILTIN_PRESET_NAME,
	clearModelCache,
	parseAgentsConfig,
	preflightProfile,
	resolveProfile,
} from "../src/workflow/profiles.ts";

function withPiAgentDir<T>(models: unknown, fn: () => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-durable-models-"));
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(models));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

describe("pi-durable profile parsing", () => {
	test("accepts a pi-durable profile with the pi-shaped option set", () => {
		const config = parseAgentsConfig({
			default_profile: "durable-default",
			profiles: {
				"durable-default": {
					runtime: "pi-durable",
					model: "anthropic/claude-sonnet-4-5",
					thinking: "high",
				},
			},
		});
		const profile = resolveProfile("durable-default", config);
		expect(profile.runtime).toBe("pi-durable");
		expect(profile.model).toBe("anthropic/claude-sonnet-4-5");
		expect(profile.executable).toBe("pi-durable");
	});

	test("rejects an opencode-only option (agent) on a pi-durable profile", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: { durable: { runtime: "pi-durable", agent: "build" } },
			}),
		).toThrow(/unsupported pi-durable option/);
	});

	test("a custom preset may select the pi-durable runtime", () => {
		const config = parseAgentsConfig({
			profiles: { durable: { runtime: "pi-durable" } },
			presets: {
				custom: {
					runtime: "pi-durable",
					default_profile: "durable",
					pools: {
						"core.plan": [
							{ label: "durable", profile: "durable", default: true },
						],
					},
				},
			},
		});
		expect(config.presets?.custom?.runtime).toBe("pi-durable");
	});
});

describe("pi-durable preflight (no external executable)", () => {
	test("preflight does not require an executable on PATH", () => {
		const config = parseAgentsConfig({
			profiles: {
				durable: {
					runtime: "pi-durable",
					executable: "definitely-not-on-path-xyz",
				},
			},
		});
		const profile = resolveProfile("durable", config);
		expect(() => preflightProfile(profile, [])).not.toThrow();
	});

	test(
		BUILTIN_PRESET_NAME +
			" defaults to pi-durable on a fresh installation (default-model-preset)",
		() => {
			const config = parseAgentsConfig(undefined);
			const profile = resolveProfile(BUILTIN_PRESET_NAME, config);
			expect(profile.runtime).toBe("pi-durable");
		},
	);

	test("a legacy TOML migration's implicit preset also defaults to pi-durable, independent of its explicit pi-default profile", () => {
		const config = parseAgentsConfig(undefined, {
			models: { worker_default: "anthropic/claude-sonnet-4-5" },
			thinking: { worker_default: "high" },
		});
		expect(config.profiles["pi-default"]?.runtime).toBe("pi");
		const profile = resolveProfile(BUILTIN_PRESET_NAME, config);
		expect(profile.runtime).toBe("pi-durable");
	});

	test("pi remains selectable by explicitly configuring the preset's runtime", () => {
		const config = parseAgentsConfig({
			presets: { [BUILTIN_PRESET_NAME]: { runtime: "pi" } },
		});
		const profile = resolveProfile(BUILTIN_PRESET_NAME, config);
		expect(profile.runtime).toBe("pi");
	});
});

describe("pi-durable model enumeration (durable-agent-configuration)", () => {
	test("rejects a model that is not shaped <provider>/<model>", () => {
		const config = parseAgentsConfig({
			profiles: {
				durable: { runtime: "pi-durable", model: "not-a-provider-model" },
			},
		});
		const profile = resolveProfile("durable", config);
		expect(() => assertModelAvailable(profile)).toThrow(
			/pi-durable model must be/,
		);
	});

	test("accepts a built-in-shaped provider/model pair without invoking any executable", () => {
		const config = parseAgentsConfig({
			profiles: {
				durable: {
					runtime: "pi-durable",
					model: "anthropic/claude-sonnet-4-5:high",
				},
			},
		});
		const profile = resolveProfile("durable", config);
		expect(() => assertModelAvailable(profile)).not.toThrow();
	});

	test("fails closed for an unknown model of a locally configured custom provider", () => {
		withPiAgentDir(
			{ providers: { eon: { models: [{ id: "claude-5-sonnet" }] } } },
			() => {
				clearModelCache();
				const config = parseAgentsConfig({
					profiles: {
						durable: { runtime: "pi-durable", model: "eon/does-not-exist" },
					},
				});
				const profile = resolveProfile("durable", config);
				expect(() => assertModelAvailable(profile)).toThrow(/unknown model/);
			},
		);
	});

	test("passes for a known model of a locally configured custom provider", () => {
		withPiAgentDir(
			{ providers: { eon: { models: [{ id: "claude-5-sonnet" }] } } },
			() => {
				clearModelCache();
				const config = parseAgentsConfig({
					profiles: {
						durable: { runtime: "pi-durable", model: "eon/claude-5-sonnet" },
					},
				});
				const profile = resolveProfile("durable", config);
				expect(() => assertModelAvailable(profile)).not.toThrow();
			},
		);
	});
});
