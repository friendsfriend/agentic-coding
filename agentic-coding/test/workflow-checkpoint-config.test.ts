// The `[agents.checkpoint]` section (run-progress checkpoint, efficiency backlog
// item 19): the defaults it ships with, the bounds its load enforces, and the
// lenient resolution the durable host reads per run start.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	liveCheckpointSection,
	loadCheckpointSection,
} from "../src/agent-host/host-main.ts";
import {
	CHECKPOINT_CLASSES,
	DEFAULT_CHECKPOINT_CONTEXT_TOKENS,
	DEFAULT_CHECKPOINT_THRESHOLDS,
} from "../src/agent-host/progress-checkpoint.ts";
import {
	CHECKPOINT_MIN_SOFT_TURNS,
	checkpointConfigIsEmpty,
	checkpointThresholdsForClass,
	DEFAULT_CHECKPOINT_CONFIG,
	resolveCheckpointConfig,
	validateCheckpointConfig,
} from "../src/workflow/checkpoint.ts";
import { parseAgentsConfig } from "../src/workflow/profiles.ts";

describe("checkpoint configuration defaults", () => {
	test("a configuration that says nothing is the shipped behaviour", () => {
		const config = resolveCheckpointConfig(undefined);
		expect(config.enabled).toBe(true);
		expect(config.steer).toBe(true);
		expect(config.contextTokens).toBe(DEFAULT_CHECKPOINT_CONTEXT_TOKENS);
		expect(config.contextTokens).toBe(200_000);
		expect(config.thresholds).toEqual({});
		expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
	});

	test("every class resolves to its measured threshold without an override", () => {
		const config = resolveCheckpointConfig(undefined);
		for (const checkpointClass of CHECKPOINT_CLASSES)
			expect(checkpointThresholdsForClass(config, checkpointClass)).toEqual(
				DEFAULT_CHECKPOINT_THRESHOLDS[checkpointClass],
			);
		// The measured table itself: worker 280/1400, planner 60/300,
		// verifier 70/350, mechanical 30/150, and `other` is the worker row.
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.worker).toEqual({
			softTurns: 280,
			hardTurns: 1400,
		});
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.planner).toEqual({
			softTurns: 60,
			hardTurns: 300,
		});
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.verifier).toEqual({
			softTurns: 70,
			hardTurns: 350,
		});
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.mechanical).toEqual({
			softTurns: 30,
			hardTurns: 150,
		});
		expect(DEFAULT_CHECKPOINT_THRESHOLDS.other).toEqual(
			DEFAULT_CHECKPOINT_THRESHOLDS.worker,
		);
	});

	test("an undeclared class uses the worker row, overridden or not", () => {
		const overridden = resolveCheckpointConfig({
			worker: { softTurns: 40, hardTurns: 90 },
		});
		expect(checkpointThresholdsForClass(overridden, "other")).toEqual({
			softTurns: 40,
			hardTurns: 90,
		});
		// An explicit `other` row wins over the worker's.
		const explicit = resolveCheckpointConfig({
			worker: { softTurns: 40, hardTurns: 90 },
			other: { softTurns: 20, hardTurns: 60 },
		});
		expect(checkpointThresholdsForClass(explicit, "other")).toEqual({
			softTurns: 20,
			hardTurns: 60,
		});
		// A class that was not overridden keeps its measured defaults.
		expect(checkpointThresholdsForClass(explicit, "planner")).toEqual(
			DEFAULT_CHECKPOINT_THRESHOLDS.planner,
		);
	});

	test("only the classes the section overrides carry a row", () => {
		const config = resolveCheckpointConfig({
			enabled: false,
			steer: false,
			contextTokens: 120_000,
			mechanical: { softTurns: 15, hardTurns: 40 },
		});
		expect(config.enabled).toBe(false);
		expect(config.steer).toBe(false);
		expect(config.contextTokens).toBe(120_000);
		expect(Object.keys(config.thresholds)).toEqual(["mechanical"]);
	});

	test("an empty section is recognised as empty", () => {
		expect(checkpointConfigIsEmpty({})).toBe(true);
		expect(checkpointConfigIsEmpty({ enabled: true })).toBe(false);
		expect(checkpointConfigIsEmpty({ worker: { softTurns: 30 } })).toBe(false);
	});
});

describe("checkpoint configuration validation", () => {
	test("a usable section has no problems", () => {
		expect(
			validateCheckpointConfig({
				enabled: true,
				steer: false,
				contextTokens: 150_000,
				worker: { softTurns: 200, hardTurns: 700 },
				other: { softTurns: 40, hardTurns: 90 },
			}),
		).toEqual([]);
	});

	test("a section that is not a table is refused", () => {
		expect(validateCheckpointConfig(42)[0]?.message).toContain(
			"must be a table",
		);
	});

	test("the scalars must have their own types", () => {
		expect(validateCheckpointConfig({ enabled: "yes" })[0]?.field).toBe(
			"enabled",
		);
		expect(validateCheckpointConfig({ steer: 1 })[0]?.field).toBe("steer");
		expect(validateCheckpointConfig({ contextTokens: 0 })[0]?.field).toBe(
			"contextTokens",
		);
		expect(validateCheckpointConfig({ contextTokens: 1.5 })[0]?.field).toBe(
			"contextTokens",
		);
	});

	test("a class table names the key that carries the problem", () => {
		const errors = validateCheckpointConfig({
			worker: { softTurns: 200, hardTurns: 300 },
		});
		expect(errors[0]?.field).toBe("agents.checkpoint.worker.hardTurns");
		expect(errors[0]?.message).toContain("agents.checkpoint.worker");
		expect(errors[0]?.message).toContain("at least 2");
	});

	test("the soft threshold has a floor and both values are whole turns", () => {
		expect(
			validateCheckpointConfig({
				planner: { softTurns: CHECKPOINT_MIN_SOFT_TURNS - 1 },
			})[0]?.field,
		).toBe("agents.checkpoint.planner.softTurns");
		expect(
			validateCheckpointConfig({ planner: { softTurns: 20.5 } })[0]?.field,
		).toBe("agents.checkpoint.planner.softTurns");
		expect(
			validateCheckpointConfig({ planner: { hardTurns: 0 } })[0]?.field,
		).toBe("agents.checkpoint.planner.hardTurns");
	});

	test("a hard value alone is measured against the class's own soft default", () => {
		// The planner's default soft is 60, so a hard limit below 120 is refused
		// even though the table never states a soft value.
		expect(
			validateCheckpointConfig({ planner: { hardTurns: 100 } })[0]?.field,
		).toBe("agents.checkpoint.planner.hardTurns");
		expect(validateCheckpointConfig({ planner: { hardTurns: 130 } })).toEqual(
			[],
		);
		// `other` is measured against the worker's row, which it falls back to.
		expect(
			validateCheckpointConfig({ other: { hardTurns: 400 } })[0]?.field,
		).toBe("agents.checkpoint.other.hardTurns");
	});

	test("a class table that is not a table is refused", () => {
		expect(validateCheckpointConfig({ worker: 5 })[0]?.field).toBe(
			"agents.checkpoint.worker",
		);
	});
});

describe("checkpoint configuration resolution is lenient", () => {
	test("a mistyped scalar falls back to the default instead of failing a run", () => {
		const config = resolveCheckpointConfig({
			enabled: "no",
			steer: 0,
			contextTokens: "200000",
		});
		expect(config.enabled).toBe(true);
		expect(config.steer).toBe(true);
		expect(config.contextTokens).toBe(DEFAULT_CHECKPOINT_CONTEXT_TOKENS);
	});

	test("a class table that breaks the invariant keeps the hard limit above the soft one", () => {
		const config = resolveCheckpointConfig({
			worker: { softTurns: 100, hardTurns: 110 },
		});
		const worker = checkpointThresholdsForClass(config, "worker");
		expect(worker.softTurns).toBe(100);
		expect(worker.hardTurns).toBeGreaterThanOrEqual(200);
	});

	test("an unknown class key changes nothing", () => {
		// An unknown class key is ignored, not an error here: the strict load
		// refuses it, and the live reader falls back rather than failing a run.
		const config = resolveCheckpointConfig({
			wroker: { softTurns: 10, hardTurns: 20 },
		});
		expect(config.thresholds).toEqual({});
	});
});

describe("the section inside a whole agents configuration", () => {
	test("an absent section stays absent, so the defaults apply", () => {
		const agents = parseAgentsConfig({ profiles: {} });
		expect(agents.checkpoint).toBeUndefined();
	});

	test("a valid section is accepted as written", () => {
		const agents = parseAgentsConfig({
			profiles: {},
			checkpoint: {
				enabled: true,
				steer: false,
				contextTokens: 120_000,
				worker: { softTurns: 120, hardTurns: 300 },
			},
		});
		expect(agents.checkpoint).toEqual({
			enabled: true,
			steer: false,
			contextTokens: 120_000,
			worker: { softTurns: 120, hardTurns: 300 },
		});
	});

	test("a table that breaks the invariant fails the load naming the table", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: {},
				checkpoint: { worker: { softTurns: 200, hardTurns: 300 } },
			}),
		).toThrow(/agents\.checkpoint.*worker/);
	});

	test("a section that is not a table fails the load", () => {
		expect(() => parseAgentsConfig({ profiles: {}, checkpoint: [] })).toThrow(
			/agents\.checkpoint must be a table/,
		);
	});
});

describe("the section the durable host reads per run start", () => {
	function withConfigFile(body: unknown): {
		file: string;
		restore: () => void;
	} {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-section-"));
		const file = path.join(dir, "config.json");
		fs.writeFileSync(file, JSON.stringify(body));
		// `liveCheckpointSection` honours the explicit replacement file too, so a
		// test cannot read one file while the host reads another.
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		delete process.env.HERDR_WORKFLOW_CONFIG;
		return {
			file,
			restore: () => {
				if (previous !== undefined)
					process.env.HERDR_WORKFLOW_CONFIG = previous;
			},
		};
	}

	test("the file's own section is resolved, and an absent one is the default", () => {
		const configured = withConfigFile({
			agents: {
				checkpoint: {
					enabled: false,
					steer: false,
					contextTokens: 90_000,
					mechanical: { softTurns: 40, hardTurns: 200 },
				},
			},
		});
		try {
			const resolved = loadCheckpointSection(configured.file);
			expect(resolved.enabled).toBe(false);
			expect(resolved.steer).toBe(false);
			expect(resolved.contextTokens).toBe(90_000);
			expect(checkpointThresholdsForClass(resolved, "mechanical")).toEqual({
				softTurns: 40,
				hardTurns: 200,
			});
			// A class the file does not mention keeps its measured row.
			expect(checkpointThresholdsForClass(resolved, "worker")).toEqual(
				DEFAULT_CHECKPOINT_THRESHOLDS.worker,
			);
		} finally {
			configured.restore();
		}
		expect(
			loadCheckpointSection(configured.file.replace(".json", "-2.json")),
		).toEqual(DEFAULT_CHECKPOINT_CONFIG);
	});

	test("a mistyped hot edit falls back to the default instead of failing a run", () => {
		// The configuration load refuses these; this reader is the per-run-start
		// getter, and a bad value there must not keep a run from starting.
		for (const section of [
			[],
			{ enabled: "maybe" },
			{ contextTokens: "a lot" },
			{ mechanical: { softTurns: 3 } },
		]) {
			const file = withConfigFile({ agents: { checkpoint: section } });
			try {
				const resolved = loadCheckpointSection(file.file);
				expect(resolved.enabled).toBe(true);
				expect(resolved.steer).toBe(true);
				expect(resolved.contextTokens).toBe(DEFAULT_CHECKPOINT_CONTEXT_TOKENS);
				expect(checkpointThresholdsForClass(resolved, "mechanical")).toEqual(
					DEFAULT_CHECKPOINT_THRESHOLDS.mechanical,
				);
			} finally {
				file.restore();
			}
		}
	});

	test("the live accessor re-reads only when the file changed", () => {
		const configured = withConfigFile({
			agents: { checkpoint: { enabled: false } },
		});
		try {
			const live = liveCheckpointSection(configured.file);
			// A getter, resolved per run start: no copy, so a Settings save reaches the
			// next run without restarting the host.
			expect(live().enabled).toBe(false);
			// The same file answers the same object, which is what makes the per-run
			// getter a stat plus a pure computation.
			const first = live();
			expect(live()).toBe(first);
			// A save (a different size and mtime) is a new resolution.
			fs.writeFileSync(
				configured.file,
				JSON.stringify({ agents: { checkpoint: { enabled: true } } }),
			);
			const stat = fs.statSync(configured.file);
			fs.utimesSync(
				configured.file,
				new Date(stat.atimeMs + 5000),
				new Date(stat.mtimeMs + 5000),
			);
			expect(live().enabled).toBe(true);
			expect(live()).not.toBe(first);
		} finally {
			configured.restore();
		}
	});
});
