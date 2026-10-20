// `workflow checkpoint --record` (efficiency backlog item 19): one run's
// run-progress checkpoint decision appended to the workflow's bounded
// classifier-decision history. The reducer authenticates the caller, appends and
// changes nothing else — no transition, no status, no run set — because the
// checkpoint is diagnostic and the run keeps working whatever the record does.
import { expect, test } from "bun:test";
import {
	CHECKPOINT_ACTION_SUMMARY,
	CHECKPOINT_DECIDER,
	checkpointAnswer,
	checkpointDigestInput,
	ProgressCheckpoint,
} from "../src/agent-host/progress-checkpoint.ts";
import type {
	ResolvedProfile,
	WorkflowCommand,
	WorkflowRouting,
} from "../src/contracts/workflow.ts";
import {
	CHECKPOINT_ACTIONS,
	CHECKPOINT_RECORD_LIMIT,
} from "../src/contracts/workflow.ts";
import { runCheckpoint } from "../src/workflow/cli/commands/checkpoint.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	CHECKPOINT_RECORD_INTEGRATION,
	checkpointRecordProblems,
	checkpointRecords,
	runCheckpointRecords,
} from "../src/workflow/runtime/reducers/agent-checkpoint.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "fake",
};
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: ["core.implementation"].map((stepId) => ({ stepId, profile })),
};

interface Started {
	readonly engine: WorkflowEngine;
	readonly repo: string;
	readonly runId: string;
	readonly stepId: string;
	readonly role: string;
	readonly generation: number;
	readonly token: string;
}

/** One started `no-openspec` workflow whose single run holds a launch-bound
 * capability. */
function startedRun(): Started {
	const repo = createTempRepoFixture("agent-checkpoint-", repoPreset.readme);
	const engine = new WorkflowEngine(
		registerBuiltins(),
		() => new Date("2026-01-01T00:00:00Z"),
	);
	const started = engine.start({
		repo,
		workflowId: "change",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "task",
		},
		routing,
	});
	const run = requireDefined(started.view.runs[0], "first run");
	const token = requireDefined(
		engine
			.claimEffects(repo, 100)
			.find((effect) => effect.kind === "agent.launch")?.runToken,
		"run token",
	);
	const launched = engine.getRun(repo, run.id);
	return {
		engine,
		repo,
		runId: run.id,
		stepId: launched.stepId,
		role: launched.role,
		generation: launched.generation,
		token,
	};
}

/** The digest one live evaluation records: the accumulator's own, so the test's
 * `input` is exactly what the host sends — content-free and closed-vocabulary. */
function digestInput(index: number): string {
	const checkpoint = new ProgressCheckpoint({
		checkpointClass: "worker",
		thresholds: { softTurns: 10, hardTurns: 50 },
	});
	for (let turn = 1; turn <= index * 10; turn += 1)
		checkpoint.observeTurn({ turn, costUnits: 0.01, contextTokens: 1000 });
	checkpoint.observeTool({ tool: "read", ok: true, argsHash: "a" });
	return checkpointDigestInput(checkpoint.takeDigest("soft"));
}

/** The record one evaluation hands the CLI: the design's field mapping —
 * content-free digest input, the five action labels as options, one-hot
 * probabilities and no confidence (a rule has none). */
function recordInput(
	runId: string,
	index: number,
): Extract<WorkflowCommand, { type: "agent.checkpoint" }>["record"] {
	const digest = digestInput(index);
	return {
		integration: CHECKPOINT_RECORD_INTEGRATION,
		phase: "core.implementation",
		questionId: `checkpoint:${runId}:${index}`,
		model: CHECKPOINT_DECIDER,
		input: digest,
		options: CHECKPOINT_ACTIONS.map((action) => ({
			label: action,
			profile: action,
			criteria: CHECKPOINT_ACTION_SUMMARY[action],
		})),
		// One of the five actions, chosen from the closed vocabulary.
		answer: checkpointAnswer({
			action: "steer",
			rule: "no-progress",
			signal: "no-progress",
		}),
		result: {
			applied: true,
			profiles: ["steer"],
			attention: "rule no-progress",
		},
	};
}

function checkpointCommand(
	started: Started,
	record = recordInput(started.runId, 1),
	overrides: Partial<
		Extract<WorkflowCommand, { type: "agent.checkpoint" }>
	> = {},
): Extract<WorkflowCommand, { type: "agent.checkpoint" }> {
	return {
		type: "agent.checkpoint",
		workflowId: "change",
		runId: started.runId,
		stepId: started.stepId,
		role: started.role,
		token: started.token,
		generation: started.generation,
		record,
		...overrides,
	};
}

test("a checkpoint record is appended and changes no workflow state", () => {
	const started = startedRun();
	const { engine, repo } = started;
	const before = engine.getSnapshot(repo, "change");
	const runStatus = engine.getRun(repo, started.runId).status;
	engine.dispatch(repo, checkpointCommand(started));
	const after = engine.getSnapshot(repo, "change");
	expect(checkpointRecords(after)).toHaveLength(1);
	const record = checkpointRecords(after)[0];
	expect(record?.integration).toBe(CHECKPOINT_RECORD_INTEGRATION);
	expect(record?.questionId).toBe(`checkpoint:${started.runId}:1`);
	expect(record?.answer.choice).toBe("steer");
	expect(record?.result.applied).toBe(true);
	expect(record?.answer.confidence).toBeUndefined();
	// Diagnostic history only: the same step, the same status, the same run set.
	expect(after.currentStep).toBe(before.currentStep);
	expect(after.status).toBe(before.status);
	expect(after.step.activeRunIds).toEqual(before.step.activeRunIds);
	expect(after.revision).toBe(before.revision + 1);
	expect(engine.getRun(repo, started.runId).status).toBe(runStatus);
});

test("a switch-model decision is recorded verbatim and never applied", () => {
	const started = startedRun();
	const { engine, repo } = started;
	engine.dispatch(
		repo,
		checkpointCommand(started, {
			...recordInput(started.runId, 1),
			answer: { type: "choice", choice: "switch-model", confidence: 1 },
			result: {
				applied: false,
				profiles: [],
				attention: "rule cost-rising",
			},
		}),
	);
	const [record] = checkpointRecords(engine.getSnapshot(repo, "change"));
	expect(record?.answer.choice).toBe("switch-model");
	// `switch-model` is vocabulary only: the record says outright that nothing
	// was applied, so a reader never mistakes it for an action.
	expect(record?.result.applied).toBe(false);
	expect(engine.getSnapshot(repo, "change").currentStep).toBe(started.stepId);
});

test("the record history is bounded per feature and later records report the cap", () => {
	const started = startedRun();
	const { engine, repo } = started;
	for (let index = 1; index <= CHECKPOINT_RECORD_LIMIT; index++)
		engine.dispatch(
			repo,
			checkpointCommand(started, recordInput(started.runId, index)),
		);
	const full = engine.getSnapshot(repo, "change");
	expect(checkpointRecords(full)).toHaveLength(CHECKPOINT_RECORD_LIMIT);
	const revision = full.revision;
	engine.dispatch(
		repo,
		checkpointCommand(
			started,
			recordInput(started.runId, CHECKPOINT_RECORD_LIMIT + 1),
		),
	);
	const after = engine.getSnapshot(repo, "change");
	expect(checkpointRecords(after)).toHaveLength(CHECKPOINT_RECORD_LIMIT);
	// Nothing was evicted to make room, and nothing else in the history moved.
	expect(checkpointRecords(after)[0]?.questionId).toBe(
		`checkpoint:${started.runId}:1`,
	);
	expect(after.revision).toBe(revision + 1);
});

test("a caller without the run's capability records nothing", () => {
	const started = startedRun();
	const { engine, repo } = started;
	const revision = engine.getSnapshot(repo, "change").revision;
	for (const broken of [
		checkpointCommand(started, recordInput(started.runId, 1), {
			token: "not-the-token",
		}),
		checkpointCommand(started, recordInput(started.runId, 1), {
			runId: "missing-run",
		}),
		checkpointCommand(started, recordInput(started.runId, 1), {
			role: "someone-else",
		}),
		checkpointCommand(started, recordInput(started.runId, 1), {
			stepId: "core.triage",
		}),
		checkpointCommand(started, recordInput(started.runId, 1), {
			generation: 99,
		}),
	]) {
		expect(() => engine.dispatch(repo, broken)).toThrow();
	}
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(checkpointRecords(engine.getSnapshot(repo, "change"))).toHaveLength(0);
});

test("a record from another integration is refused", () => {
	const started = startedRun();
	const { engine, repo } = started;
	expect(() =>
		engine.dispatch(
			repo,
			checkpointCommand(started, {
				...recordInput(started.runId, 1),
				integration: "model-routing",
			}),
		),
	).toThrow(/progress-checkpoint/);
	expect(checkpointRecords(engine.getSnapshot(repo, "change"))).toHaveLength(0);
});

test("the record's identity is the runtime's, and an oversized input is refused", () => {
	const started = startedRun();
	const { engine, repo } = started;
	engine.dispatch(
		repo,
		checkpointCommand(started, recordInput(started.runId, 1)),
	);
	const [record] = checkpointRecords(engine.getSnapshot(repo, "change"));
	// The id names the workflow, the revision the command was applied at, the
	// integration and the caller's question id; the caller supplies neither the
	// id nor the timestamp.
	// The revision in the id is the one the command applied at, so the snapshot
	// has already moved on by exactly one.
	expect(record?.id).toBe(
		`change:${engine.getSnapshot(repo, "change").revision - 1}:progress-checkpoint:checkpoint:${started.runId}:1`,
	);
	expect(record?.at).toBe("2026-01-01T00:00:00.000Z");
	expect(record?.inputTruncated).toBe(false);
	// A digest is content-free by construction and small; the command's own bound
	// refuses anything that could smuggle a transcript into the history.
	expect(() =>
		engine.dispatch(
			repo,
			checkpointCommand(started, {
				...recordInput(started.runId, 2),
				input: "x".repeat(20 * 1024),
			}),
		),
	).toThrow(/16384 bytes/);
});

test("the recorded digest is exactly the closed key set the boundary allows", () => {
	const input = JSON.parse(digestInput(1)) as Record<string, unknown>;
	// Pinned so a new digest field cannot reach the durable history without the
	// boundary learning about it: the reducer would refuse the record instead.
	expect(Object.keys(input).sort()).toEqual(
		[
			"ordinal",
			"trigger",
			"checkpointClass",
			"readOnly",
			"turns",
			"costUnits",
			"contextTokens",
			"peakContextTokens",
			"softTurns",
			"hardTurns",
			"contextLimit",
			"compactionAdmissible",
			"successfulCalls",
			"failingToolEligible",
			"failingTool",
			"failingToolStreak",
			"repeatCalls",
			"windowCalls",
			"turnsSinceProgress",
			"costRisingRatio",
			"window",
			"diff",
			"tickedTasks",
			"previous",
			"steeredSignals",
		].sort(),
	);
	expect(
		checkpointRecordProblems(
			recordInput("run-x", 1),
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		),
	).toEqual([]);
});

test("the boundary refuses text and vocabulary outside the closed set", () => {
	const base = recordInput("run-x", 1);
	const withDigest = (
		patch: Record<string, unknown>,
	): ReturnType<typeof recordInput> => ({
		...base,
		input: JSON.stringify({
			...(JSON.parse(base.input) as Record<string, unknown>),
			...patch,
		}),
	});
	const cases: [string, ReturnType<typeof recordInput>, string][] = [
		// A free-text field is not a digest key at all.
		[
			"a note",
			withDigest({ note: "/Users/someone/secret.txt" }),
			"unknown key",
		],
		["a free-text tool", withDigest({ failingTool: "read a file" }), "closed"],
		["a fenced string", withDigest({ trigger: "```" }), "closed"],
		// The recorded answer is one of the five actions.
		[
			"a pause",
			{ ...base, answer: { type: "choice", choice: "pause" } },
			"action",
		],
		[
			"a probability outside the set",
			{
				...base,
				answer: { type: "choice", choice: "steer", probabilities: { wait: 1 } },
			},
			"probabilities",
		],
		// Attention is one line of printable ASCII, so nothing can be smuggled in.
		[
			"a newline",
			{
				...base,
				result: { ...base.result, attention: "rule no-progress\nrm -rf" },
			},
			"printable",
		],
		// The record names the run that recorded it, and the caller's own step.
		["another run's id", { ...base, questionId: "checkpoint:run-y:1" }, "run"],
		["a path as step", { ...base, phase: "core/../implementation" }, "step id"],
		["a free-text step", { ...base, phase: "../etc/passwd" }, "step id"],
		[
			"an unknown profile",
			{ ...base, result: { ...base.result, profiles: ["teleport"] } },
			"action",
		],
	];
	for (const [what, record, expected] of cases) {
		const problems = checkpointRecordProblems(
			record,
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		);
		expect(problems.length, `${what} was accepted`).toBeGreaterThan(0);
		expect(problems[0], `${what} was refused for another reason`).toContain(
			expected,
		);
	}
	// The reducer refuses with the first problem as its reason, so a caller sees
	// why rather than a bare failure.
	const started = startedRun();
	const forThisRun = recordInput(started.runId, 1);
	expect(() =>
		started.engine.dispatch(
			started.repo,
			checkpointCommand(started, {
				...forThisRun,
				input: JSON.stringify({
					...(JSON.parse(forThisRun.input) as Record<string, unknown>),
					note: "/Users/someone/secret.txt",
				}),
			}),
		),
	).toThrow(/checkpoint record refused: .*unknown key/);
	expect(
		checkpointRecords(started.engine.getSnapshot(started.repo, "change")),
	).toHaveLength(0);
});

test("the record cap counts one run's records, never the workflow's", () => {
	const started = startedRun();
	const { engine, repo } = started;
	for (let index = 1; index <= CHECKPOINT_RECORD_LIMIT; index++)
		engine.dispatch(
			repo,
			checkpointCommand(started, recordInput(started.runId, index)),
		);
	const full = engine.getSnapshot(repo, "change");
	expect(runCheckpointRecords(full, started.runId)).toHaveLength(
		CHECKPOINT_RECORD_LIMIT,
	);
	// A second run of the same workflow starts with an empty history: the cap is
	// a per-run budget, so one long run cannot silence the next one.
	const other = requireDefined(
		requireDefined(full.classifierDecisions, "recorded decisions")[0],
		"first record",
	);
	const foreign = { ...other, questionId: "checkpoint:another-run:1" };
	const mixed = {
		...full,
		classifierDecisions: [
			...requireDefined(full.classifierDecisions, "recorded decisions"),
			foreign,
		],
	};
	expect(runCheckpointRecords(mixed, "another-run")).toHaveLength(1);
	expect(checkpointRecords(mixed)).toHaveLength(CHECKPOINT_RECORD_LIMIT + 1);
});

/** The environment one managed run carries: what `checkpoint` resolves its own
 * identity and capability from. */
function asManagedRun(started: Started): () => void {
	const keys = [
		"HERDR_WORKFLOW_TARGET",
		"HERDR_WORKFLOW_ID",
		"HERDR_RUN_ID",
		"HERDR_STEP_ID",
		"HERDR_ROLE",
		"HERDR_RUN_TOKEN",
	] as const;
	const previous = new Map<string, string | undefined>(
		keys.map((key) => [key, process.env[key]]),
	);
	process.env.HERDR_WORKFLOW_TARGET = started.repo;
	process.env.HERDR_WORKFLOW_ID = "change";
	process.env.HERDR_RUN_ID = started.runId;
	process.env.HERDR_STEP_ID = started.stepId;
	process.env.HERDR_ROLE = started.role;
	process.env.HERDR_RUN_TOKEN = started.token;
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/** Capture what one CLI invocation printed (its one JSON line). */
function printedView(run: () => void): Record<string, unknown> {
	const printed: string[] = [];
	const log = console.log;
	console.log = (...args: unknown[]) => {
		printed.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		run();
	} finally {
		console.log = log;
	}
	const line = printed.at(-1);
	return line === undefined
		? {}
		: (JSON.parse(line) as Record<string, unknown>);
}

test("the CLI records the caller's own decision and reports it", () => {
	const started = startedRun();
	const restoreEnvironment = asManagedRun(started);
	try {
		const view = printedView(() =>
			runCheckpoint(
				["--record", JSON.stringify(recordInput(started.runId, 1))],
				started.engine,
				undefined,
				started.repo,
			),
		);
		expect(view.recorded).toBe(true);
		expect(view.records).toBe(1);
		expect(
			checkpointRecords(started.engine.getSnapshot(started.repo, "change")),
		).toHaveLength(1);
	} finally {
		restoreEnvironment();
	}
});

test("the CLI reports a capped record instead of failing the run", () => {
	const started = startedRun();
	const restoreEnvironment = asManagedRun(started);
	try {
		for (let index = 1; index <= CHECKPOINT_RECORD_LIMIT; index++)
			started.engine.dispatch(
				started.repo,
				checkpointCommand(started, recordInput(started.runId, index)),
			);
		const view = printedView(() =>
			runCheckpoint(
				[
					"--record",
					JSON.stringify(
						recordInput(started.runId, CHECKPOINT_RECORD_LIMIT + 1),
					),
				],
				started.engine,
				undefined,
				started.repo,
			),
		);
		expect(view.recorded).toBe(false);
		expect(view.reason).toBe("record-cap");
		expect(view.records).toBe(CHECKPOINT_RECORD_LIMIT);
	} finally {
		restoreEnvironment();
	}
});
