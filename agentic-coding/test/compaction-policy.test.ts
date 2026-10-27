// Compaction policy resolution, validation and configuration layering
// (add-agent-compaction, tasks 1.1–1.4).
//
// Pure/writer-level checks against temporary config directories: no test ever
// reads or writes the developer's own configuration root.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	compactionConfigPath,
	liveCompactionSection,
	loadCompactionSection,
} from "../src/agent-host/host-main.ts";
import {
	applyAgentsMutation,
	loadCompactionSettings,
} from "../src/server/config.ts";
import { saveAgents } from "../src/server/handlers.ts";
import {
	COMPACTION_DEFAULT_TRIGGER_PERCENT,
	COMPACTION_DEFAULTS,
	COMPACTION_PERCENT_MAX,
	COMPACTION_TOKEN_CEILING,
	COMPACTION_TOKEN_FLOOR,
	parseCompactionConfig,
	resolveCompactionPolicy,
	resolveCompactionSection,
	validateCompactionConfig,
} from "../src/workflow/compaction.ts";

/** One temporary configuration root, restored afterwards. */
function withConfigRoot<T>(run: (root: string) => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-config-"));
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousWorkflow = process.env.HERDR_WORKFLOW_CONFIG;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	try {
		return run(root);
	} finally {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		if (previousWorkflow === undefined)
			delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousWorkflow;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("compaction policy resolution", () => {
	test("no configuration resolves to the documented defaults", () => {
		expect(resolveCompactionPolicy({})).toEqual(COMPACTION_DEFAULTS);
		expect(COMPACTION_DEFAULTS).toEqual({
			enabled: true,
			reserveTokens: 32000,
			keepRecentTokens: 20000,
			backgroundTokens: 32000,
		});
	});

	test("the default reserve scales with the window, so the trigger fires at 70%", () => {
		// Every model the presets run declares a ~1M-token window. An absolute
		// 32000-token reserve put the blocking threshold at 968000 tokens, which a
		// real run never reaches, so the documented default is the larger of the
		// absolute default and 30% of the window.
		const wide = resolveCompactionPolicy({}, 1_000_000);
		expect(wide.reserveTokens).toBe(300_000);
		expect(1_000_000 - wide.reserveTokens).toBe(700_000);
		expect(100 - COMPACTION_DEFAULT_TRIGGER_PERCENT).toBe(30);
		// The absolute default stays the no-window fallback and the floor of the
		// window-relative form: a smaller window keeps the 32000 reserve.
		expect(resolveCompactionPolicy({}).reserveTokens).toBe(
			COMPACTION_DEFAULTS.reserveTokens,
		);
		expect(resolveCompactionPolicy({}, 100_000).reserveTokens).toBe(32000);
		// The fields whose default does not move the trigger stay absolute.
		expect(wide.backgroundTokens).toBe(COMPACTION_DEFAULTS.backgroundTokens);
		expect(wide.keepRecentTokens).toBe(COMPACTION_DEFAULTS.keepRecentTokens);
		// A configured value still wins over both default forms.
		expect(
			resolveCompactionPolicy({ reserveTokens: 50000 }, 1_000_000)
				.reserveTokens,
		).toBe(50000);
		expect(
			resolveCompactionPolicy({ reserveTokens: "5%" }, 1_000_000).reserveTokens,
		).toBe(50000);
	});

	test("a percentage resolves against a known reference window", () => {
		expect(
			resolveCompactionPolicy({ keepRecentTokens: "15%" }, 200_000)
				.keepRecentTokens,
		).toBe(30000);
		// The reserve is scaled too, then clamped to half the window.
		expect(
			resolveCompactionPolicy({ reserveTokens: "20%" }, 100_000).reserveTokens,
		).toBe(20000);
	});

	test("a percentage with no known window falls back to the field's default", () => {
		const policy = resolveCompactionPolicy({
			keepRecentTokens: "15%",
			reserveTokens: "50%",
			backgroundTokens: "10%",
		});
		expect(policy.keepRecentTokens).toBe(COMPACTION_DEFAULTS.keepRecentTokens);
		expect(policy.reserveTokens).toBe(COMPACTION_DEFAULTS.reserveTokens);
		expect(policy.backgroundTokens).toBe(COMPACTION_DEFAULTS.backgroundTokens);
	});

	test("absolute values are used as written", () => {
		expect(
			resolveCompactionPolicy({
				enabled: false,
				reserveTokens: 50000,
				backgroundTokens: 0,
				keepRecentTokens: 9000,
			}),
		).toEqual({
			enabled: false,
			reserveTokens: 50000,
			backgroundTokens: 0,
			keepRecentTokens: 9000,
		});
	});

	test("floors hold a bad configuration above the usable minimum", () => {
		const policy = resolveCompactionPolicy({
			reserveTokens: 10,
			keepRecentTokens: 1,
			backgroundTokens: -5,
		});
		expect(policy.reserveTokens).toBe(COMPACTION_TOKEN_FLOOR);
		expect(policy.keepRecentTokens).toBe(COMPACTION_TOKEN_FLOOR);
		// A negative background is floored to 0, which disables the background path.
		expect(policy.backgroundTokens).toBe(0);
	});

	test("a known window clamps the reserve and the kept tail so a range remains", () => {
		const policy = resolveCompactionPolicy(
			{ reserveTokens: 100000, keepRecentTokens: 100000 },
			128_000,
		);
		expect(policy.reserveTokens).toBe(64_000);
		expect(policy.keepRecentTokens).toBe(
			Math.max(COMPACTION_TOKEN_FLOOR, 128_000 - 64_000 - 1024),
		);
		// The kept tail still leaves room under the window for a summarized range.
		expect(policy.reserveTokens + policy.keepRecentTokens).toBeLessThan(
			128_000,
		);
	});
});

describe("compaction section validation and parsing", () => {
	test("accepts whole counts and the percentage form", () => {
		expect(
			validateCompactionConfig({
				enabled: true,
				reserveTokens: 40000,
				backgroundTokens: 0,
				keepRecentTokens: "15%",
			}),
		).toEqual([]);
	});

	test("rejects a non-integer, a negative count and an out-of-range percentage, naming the field", () => {
		const errors = validateCompactionConfig({
			enabled: true,
			reserveTokens: 12.5,
			backgroundTokens: -1,
			keepRecentTokens: `${COMPACTION_PERCENT_MAX + 1}%`,
		});
		expect(errors.map((error) => error.field).sort()).toEqual([
			"backgroundTokens",
			"keepRecentTokens",
			"reserveTokens",
		]);
		expect(errors.find((e) => e.field === "reserveTokens")?.message).toContain(
			"reserveTokens",
		);
	});

	test("rejects a non-boolean enabled, an absurd count and a malformed percentage", () => {
		expect(validateCompactionConfig({ enabled: "yes" })[0]?.field).toBe(
			"enabled",
		);
		expect(
			validateCompactionConfig({ reserveTokens: COMPACTION_TOKEN_CEILING + 1 }),
		).toHaveLength(1);
		expect(
			validateCompactionConfig({ keepRecentTokens: "15 %" })[0]?.message,
		).toContain("percentage");
		expect(validateCompactionConfig("nonsense")).toHaveLength(1);
	});

	test("parsing ignores unknown keys and unusable values instead of failing a launch", () => {
		expect(
			parseCompactionConfig({
				reserveTokens: 9000,
				note: "hand-written",
				keepRecentTokens: "wat",
				enabled: false,
			}),
		).toEqual({ reserveTokens: 9000, enabled: false });
	});

	test("the agentHost override wins over the agents section", () => {
		expect(
			resolveCompactionSection({ reserveTokens: 9000 }, { reserveTokens: 111 }),
		).toEqual({ config: { reserveTokens: 111 }, source: "agentHost" });
		expect(resolveCompactionSection({ reserveTokens: 9000 }, {})).toEqual({
			config: { reserveTokens: 9000 },
			source: "agents",
		});
		expect(resolveCompactionSection(undefined, undefined)).toEqual({
			config: {},
			source: "default",
		});
	});
});

describe("compaction configuration layering", () => {
	test("ordinary edits preserve exact overrides", () =>
		withConfigRoot((root) => {
			const file = path.join(root, "config.json");
			const overrides = { "p/family/model": { reserveTokens: "40%" } };
			writeJson(file, {
				agents: { compaction: { modelOverrides: overrides } },
			});
			applyAgentsMutation({
				kind: "set-compaction",
				field: "backgroundTokens",
				value: 0,
			});
			expect(loadCompactionSection(file).config.modelOverrides).toEqual(
				overrides,
			);
		}));
	test("the host reads the configured section and prefers the agentHost override", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-host-"));
		try {
			const file = path.join(dir, "config.json");
			writeJson(file, { agents: { compaction: { reserveTokens: 48000 } } });
			expect(loadCompactionSection(file)).toEqual({
				config: { reserveTokens: 48000 },
				source: "agents",
			});
			expect(
				loadCompactionSection(file, { reserveTokens: 12345 }).config,
			).toEqual({ reserveTokens: 12345 });
			// A missing file is "nothing configured", never an error.
			expect(loadCompactionSection(path.join(dir, "absent.json")).source).toBe(
				"default",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("HERDR_WORKFLOW_CONFIG replaces the file the host reads", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-env-"));
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		try {
			const replacement = path.join(dir, "replacement.json");
			writeJson(replacement, {
				agents: { compaction: { keepRecentTokens: 4444 } },
			});
			const other = path.join(dir, "other.json");
			writeJson(other, { agents: { compaction: { keepRecentTokens: 1 } } });
			process.env.HERDR_WORKFLOW_CONFIG = replacement;
			expect(compactionConfigPath(other)).toBe(replacement);
			expect(liveCompactionSection(other)()).toEqual({
				keepRecentTokens: 4444,
			});
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the live accessor re-reads the file when it changes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-live-"));
		try {
			const file = path.join(dir, "config.json");
			writeJson(file, { agents: { compaction: { reserveTokens: 20000 } } });
			const live = liveCompactionSection(file);
			expect(live()).toEqual({ reserveTokens: 20000 });
			writeJson(file, { agents: { compaction: { reserveTokens: 40000 } } });
			expect(live()).toEqual({ reserveTokens: 40000 });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a compaction save writes the user-level file and a project overlay cannot capture it", () => {
		withConfigRoot((root) => {
			const userFile = path.join(root, "config.json");
			// The winning base file has to exist, or a user-scope write would fall
			// through to the legacy home file.
			writeJson(userFile, { agents: { default_profile: "a" } });
			const project = fs.mkdtempSync(
				path.join(os.tmpdir(), "compaction-proj-"),
			);
			try {
				writeJson(path.join(project, ".pi", "config.json"), {
					agents: { compaction: { reserveTokens: 1 } },
				});
				applyAgentsMutation({
					kind: "set-compaction",
					field: "reserveTokens",
					value: 45000,
				});
				const written = JSON.parse(fs.readFileSync(userFile, "utf8")) as {
					agents: Record<string, unknown>;
				};
				expect(written.agents.compaction).toEqual({ reserveTokens: 45000 });
				// The unrelated key of the same section survived the write.
				expect(written.agents.default_profile).toBe("a");
				// And the overlay's own value is untouched and not read.
				const overlay = JSON.parse(
					fs.readFileSync(path.join(project, ".pi", "config.json"), "utf8"),
				) as { agents: { compaction: unknown } };
				expect(overlay.agents.compaction).toEqual({ reserveTokens: 1 });
				expect(loadCompactionSettings().configured).toEqual({
					reserveTokens: 45000,
				});
				expect(loadCompactionSettings().source).toBe("agents");
			} finally {
				fs.rmSync(project, { recursive: true, force: true });
			}
		});
	});

	test("an invalid value is refused naming the field and the stored value stays", () => {
		withConfigRoot((root) => {
			const userFile = path.join(root, "config.json");
			writeJson(userFile, { agents: { compaction: { reserveTokens: 30000 } } });
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "reserveTokens",
					value: 12.5,
				}),
			).toThrow(/reserveTokens/);
			expect(() =>
				applyAgentsMutation({
					kind: "set-compaction",
					field: "enabled",
					value: "yes" as unknown as boolean,
				}),
			).toThrow(/enabled/);
			const written = JSON.parse(fs.readFileSync(userFile, "utf8")) as {
				agents: { compaction: unknown };
			};
			expect(written.agents.compaction).toEqual({ reserveTokens: 30000 });
		});
	});

	test("a stale revision is refused before any write", () => {
		withConfigRoot((root) => {
			writeJson(path.join(root, "config.json"), {
				agents: { compaction: { reserveTokens: 30000 } },
			});
			expect(() =>
				applyAgentsMutation(
					{ kind: "set-compaction", field: "reserveTokens", value: 31000 },
					undefined,
					"stale-revision",
				),
			).toThrow(/changed since it was loaded/);
		});
	});

	test("the server write path accepts a compaction mutation and still refuses an unknown kind", () => {
		withConfigRoot((root) => {
			writeJson(path.join(root, "config.json"), {});
			saveAgents({
				mutation: { kind: "set-compaction", field: "enabled", value: false },
			});
			expect(loadCompactionSettings().configured).toEqual({ enabled: false });
			expect(loadCompactionSettings().effective.enabled).toBe(false);
			expect(() =>
				saveAgents({ mutation: { kind: "not-a-mutation" } }),
			).toThrow(/unknown agents mutation/);
		});
	});

	test("the read reports the effective values, the source and the validation of a hand-edited file", () => {
		withConfigRoot((root) => {
			writeJson(path.join(root, "config.json"), {
				agents: { compaction: { keepRecentTokens: "15%" } },
				agentHost: { compaction: { reserveTokens: 40000 } },
			});
			const read = loadCompactionSettings();
			expect(read.source).toBe("agentHost");
			expect(read.effective.reserveTokens).toBe(40000);
			// No reference window is known here, so the percentage uses its default.
			expect(read.effective.keepRecentTokens).toBe(
				COMPACTION_DEFAULTS.keepRecentTokens,
			);
			expect(read.defaults).toEqual(COMPACTION_DEFAULTS);

			writeJson(path.join(root, "config.json"), {
				agents: { compaction: { keepRecentTokens: "wat" } },
			});
			const invalid = loadCompactionSettings();
			expect(invalid.validation.map((error) => error.field)).toEqual([
				"keepRecentTokens",
			]);
			// The unusable value falls back rather than failing the read.
			expect(invalid.effective.keepRecentTokens).toBe(
				COMPACTION_DEFAULTS.keepRecentTokens,
			);
		});
	});
});
