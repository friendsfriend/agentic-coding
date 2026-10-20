// `workflow checkpoint --record` (efficiency backlog item 19): one run's
// run-progress checkpoint decision appended to the workflow's bounded
// classifier-decision history. The reducer authenticates the caller, appends and
// changes nothing else — no transition, no status, no run set — because the
// checkpoint is diagnostic and the run keeps working whatever the record does.
import { Database } from "bun:sqlite";
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
	agentCheckpoint,
	CHECKPOINT_RECORD_INTEGRATION,
	checkpointRecordProblems,
	checkpointRecords,
	runCheckpointRecords,
} from "../src/workflow/runtime/reducers/agent-checkpoint.ts";
import { canonicalStorePath } from "../src/workflow/runtime/targets.ts";
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
		// Every value set is the contract's: a token-shaped word that is not a
		// member is refused, so the recorded digest's vocabulary cannot drift from
		// the decider's.
		[
			"a class outside the set",
			withDigest({ checkpointClass: "architect" }),
			"closed",
		],
		[
			"a rule outside the set",
			withDigest({
				previous: { decision: "continue", rule: "made-up-rule", progress: 0 },
			}),
			"closed",
		],
		[
			"a previous decision outside the set",
			withDigest({
				previous: { decision: "pause", rule: "default", progress: 0 },
			}),
			"closed",
		],
		[
			"a signal outside the set",
			withDigest({ steeredSignals: ["wait"] }),
			"closed",
		],
		// `a tool` is the tool-name sentinel, not a vocabulary value: it fills
		// `failingTool` and nothing else.
		["a sentinel trigger", withDigest({ trigger: "a tool" }), "closed"],
		["a sentinel class", withDigest({ checkpointClass: "a tool" }), "closed"],
		["a sentinel signal", withDigest({ steeredSignals: ["a tool"] }), "closed"],
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
		// Attention is a rule id and a closed reason, so nothing can be smuggled in.
		[
			"a newline",
			{
				...base,
				result: { ...base.result, attention: "rule no-progress\nrm -rf" },
			},
			"attention",
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

/** One digest built by the decider itself, with `tool` as the failing streak:
 * `"a tool"` is what the accumulator writes for a name the host did not
 * publish. */
function digestWithFailingTool(tool: string): string {
	const checkpoint = new ProgressCheckpoint({
		checkpointClass: "worker",
		thresholds: { softTurns: 10, hardTurns: 50 },
	});
	for (let turn = 1; turn <= 40; turn += 1)
		checkpoint.observeTurn({ turn, costUnits: 0.01, contextTokens: 1000 });
	checkpoint.observeTool({ tool: "read", ok: true, argsHash: "a" });
	for (let index = 0; index < 5; index += 1)
		checkpoint.observeTool({ tool, ok: false, argsHash: `h${index}` });
	return checkpointDigestInput(checkpoint.takeDigest("stall"));
}

test("the boundary accepts the digest the decider itself builds", () => {
	// The host publishes dotted tool names (`agentic.codemode`), and the decider
	// writes the literal `a tool` for a name it cannot vouch for. Both are the
	// digest's own vocabulary, so both are recorded — the record boundary is what
	// the host's own `workflow checkpoint --record` call goes through, and a
	// boundary that refuses the digest it documents loses every decision.
	for (const [tool, expected] of [
		["agentic.codemode", "agentic.codemode"],
		["agentic.ask-jev", "agentic.ask-jev"],
		["../../etc/passwd", "a tool"],
		["a tool", "a tool"],
	] as const) {
		const input = digestWithFailingTool(tool);
		expect(
			(JSON.parse(input) as Record<string, unknown>).failingTool,
			`${tool} reached the digest as recorded`,
		).toBe(expected);
		expect(
			checkpointRecordProblems(
				{ ...recordInput("run-x", 1), input },
				"run-x",
				CHECKPOINT_RECORD_LIMIT,
			),
			`${tool} was refused`,
		).toEqual([]);
	}
	// And the reducer really appends it, not just the pure check.
	const started = startedRun();
	started.engine.dispatch(
		started.repo,
		checkpointCommand(started, {
			...recordInput(started.runId, 1),
			input: digestWithFailingTool("agentic.codemode"),
		}),
	);
	const [record] = checkpointRecords(
		started.engine.getSnapshot(started.repo, "change"),
	);
	expect(record?.integration).toBe(CHECKPOINT_RECORD_INTEGRATION);
	expect(
		(JSON.parse(record?.input ?? "{}") as Record<string, unknown>).failingTool,
	).toBe("agentic.codemode");
});

test("the boundary checks the digest's shape, not only its key names", () => {
	const base = recordInput("run-x", 1);
	const digest = JSON.parse(base.input) as Record<string, unknown>;
	const withDigest = (patch: Record<string, unknown>) => ({
		...base,
		input: JSON.stringify({ ...digest, ...patch }),
	});
	const cases: [string, ReturnType<typeof recordInput>, string][] = [
		// A sentence where a count belongs is content trying to reach the history.
		[
			"a string for a number",
			withDigest({ turns: "273 turns of rereading" }),
			"number",
		],
		["a string for a boolean", withDigest({ readOnly: "yes" }), "boolean"],
		["a null for a number", withDigest({ contextTokens: null }), "number"],
		[
			"an unknown nested key",
			withDigest({ window: { turns: 4, progress: 1, note: "/Users/me/x" } }),
			"unknown key",
		],
		["a missing nested key", withDigest({ window: { turns: 4 } }), "missing"],
		[
			"a sentence in a list",
			withDigest({ steeredSignals: ["repeats", "a whole sentence"] }),
			"closed",
		],
		[
			"a record instead of a list",
			withDigest({ steeredSignals: { note: "x" } }),
			"list",
		],
		["a missing key", withDigest({ diff: { files: 1 } }), "missing"],
		[
			"a list instead of the digest",
			{ ...base, input: JSON.stringify([base.input]) },
			"object",
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
	// The nullable keys are the ones the digest declares nullable, and no other.
	expect(
		checkpointRecordProblems(
			withDigest({ diff: null, tickedTasks: null, previous: null }),
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		),
	).toEqual([]);
	expect(
		checkpointRecordProblems(
			withDigest({ window: null }),
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		)[0],
	).toContain("object");
});

test("the boundary pins the option criteria and the attention line", () => {
	const base = recordInput("run-x", 1);
	const options = base.options as unknown as Array<Record<string, unknown>>;
	const withOptions = (patch: Record<string, unknown>) => ({
		...base,
		options: options.map((option, index) =>
			index === 1 ? { ...option, ...patch } : option,
		),
	});
	// The options are rendered in the dashboard: free text here would be a second
	// way around the digest's content-free rule.
	expect(
		checkpointRecordProblems(
			withOptions({ criteria: "/Users/someone/secret.txt" }),
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		)[0],
	).toContain("criteria");
	expect(
		checkpointRecordProblems(
			withOptions({ criteria: CHECKPOINT_ACTION_SUMMARY.steer }),
			"run-x",
			CHECKPOINT_RECORD_LIMIT,
		),
	).toEqual([]);
	for (const attention of [
		"rule hard-limit; question q-checkpoint-7 unanswered",
		"rule hard-limit; question checkpoint:run-x:3 cancelled",
		"rule no-progress; steer disabled; context above limit, compaction not admissible",
		"rule failing-tool; steer not delivered",
		"rule context; compaction not admitted",
		"rule default",
	])
		expect(
			checkpointRecordProblems(
				{ ...base, result: { ...base.result, attention } },
				"run-x",
				CHECKPOINT_RECORD_LIMIT,
			),
			`"${attention}" was refused`,
		).toEqual([]);
	for (const attention of [
		"rule default; /Users/someone/secret.txt",
		"rule no-progress; and then some prose the caller chose",
		"the run looked stuck",
	]) {
		expect(
			checkpointRecordProblems(
				{ ...base, result: { ...base.result, attention } },
				"run-x",
				CHECKPOINT_RECORD_LIMIT,
			)[0],
			`"${attention}" was accepted`,
		).toContain("attention");
	}
});

test("a repeated question id is one record, however often it is sent", () => {
	const started = startedRun();
	const { engine, repo } = started;
	// The same checkpoint reported twice — a retried command, or two evaluations
	// the same run started — is one record, and the answer says it was recorded
	// because the history really holds it.
	const record = recordInput(started.runId, 1);
	for (let attempt = 0; attempt < 3; attempt += 1)
		engine.dispatch(repo, checkpointCommand(started, record));
	const snapshot = engine.getSnapshot(repo, "change");
	expect(runCheckpointRecords(snapshot, started.runId)).toHaveLength(1);
	// A later checkpoint of the same run is a different record.
	engine.dispatch(
		repo,
		checkpointCommand(started, recordInput(started.runId, 2)),
	);
	expect(
		runCheckpointRecords(engine.getSnapshot(repo, "change"), started.runId),
	).toHaveLength(2);
});

test("a second record under the same id that says something else is refused", () => {
	const started = startedRun();
	const { engine, repo } = started;
	engine.dispatch(
		repo,
		checkpointCommand(started, recordInput(started.runId, 1)),
	);
	// A relaunched run id that re-issues an ordinal its predecessor used would
	// otherwise be told its own decision was recorded while the history still
	// holds the other one.
	const contradicting = checkpointCommand(started, {
		...recordInput(started.runId, 1),
		answer: checkpointAnswer({ action: "continue", rule: "default" }),
	});
	engine.dispatch(repo, contradicting);
	// The reducer's own verdict, read the way the engine reads it: the caller is
	// told what it was not told, without a second record and without an edit.
	const db = new Database(canonicalStorePath(repo));
	try {
		const reduced = agentCheckpoint(
			db,
			engine.getSnapshot(repo, "change"),
			contradicting,
			() => new Date("2026-01-01T00:00:00Z"),
		);
		expect(reduced.data).toEqual({
			recorded: false,
			reason: "duplicate",
			records: 1,
		});
	} finally {
		db.close();
	}
	const [stored] = runCheckpointRecords(
		engine.getSnapshot(repo, "change"),
		started.runId,
	);
	expect(stored?.answer.choice).toBe("steer");
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

test("the CLI reports a record that contradicts the stored one as not recorded", () => {
	const started = startedRun();
	const restoreEnvironment = asManagedRun(started);
	try {
		printedView(() =>
			runCheckpoint(
				["--record", JSON.stringify(recordInput(started.runId, 1))],
				started.engine,
				undefined,
				started.repo,
			),
		);
		const view = printedView(() =>
			runCheckpoint(
				[
					"--record",
					JSON.stringify({
						...recordInput(started.runId, 1),
						answer: checkpointAnswer({ action: "continue", rule: "default" }),
					}),
				],
				started.engine,
				undefined,
				started.repo,
			),
		);
		expect(view.recorded).toBe(false);
		expect(view.reason).toBe("duplicate");
		expect(view.records).toBe(1);
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
