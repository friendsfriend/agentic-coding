#!/usr/bin/env bun
// Replays recorded runs through the checkpoint's own rule module.
//
//   bun run scripts/efficiency/replay-checkpoint.ts --dataset <dir> --limit 20
//   bun run scripts/efficiency/replay-checkpoint.ts --dataset <dir> --run <run_id>
//
// The point is to answer "what would the rules have done to the runs we already
// have" without touching the read-only evidence snapshot: the script reads only
// the dataset's preferred turns and calls, feeds them through
// `src/agent-host/progress-checkpoint.ts` in recorded order, and prints the
// decisions each run would have taken.
//
// What the replay cannot know is stated in its output rather than guessed:
//   * the worktree samples (diff numbers, `HEAD`, ticked tasks) only exist while
//     a run is alive, so the replay's diff/commit/task progress is unknown and
//     only edits, writes and (for a read-only run) new calls count as progress;
//   * the repeats signal needs an argument hash, so the share of calls that carry
//     one is printed beside every decision — a run without hashes can never
//     report repeats.
import { Database } from "bun:sqlite";
import path from "node:path";
import { FAIL_FAST_EXEMPT_ROLES } from "../../src/agent-host/fail-fast.ts";
import {
	CHECKPOINT_ACTIONS,
	type CheckpointAction,
	type CheckpointTrigger,
	checkpointClassOfRole,
	decideCheckpoint,
	type ProgressCheckpoint,
	ProgressCheckpoint as Tracker,
} from "../../src/agent-host/progress-checkpoint.ts";
import {
	formatTable,
	numberValue,
	optionalValue,
	parseArgs,
	requireValue,
	UsageError,
} from "./lib/cli.ts";
import { assertDatasetSchemaVersion, DATASET_FILE } from "./lib/dataset.ts";

const HELP = `Usage: bun run scripts/efficiency/replay-checkpoint.ts --dataset <path> [options]

Feeds every recorded run's turns and calls through the checkpoint's rule module
and prints the decisions it would have taken.

Options:
  --dataset <path>   Dataset directory (or dataset.sqlite itself). Required.
  --run <run_id>     Replay one run (repeatable) instead of the longest runs.
  --limit <n>        How many runs to replay, longest first (default 20).
  --decisions        Print every decision instead of one line per run.
  --json             Emit JSON instead of tables.
  --help             Show this help.
`;

interface ReplayDecision {
	ordinal: number;
	turn: number;
	trigger: CheckpointTrigger;
	action: CheckpointAction;
	rule: string;
	signal?: string;
	contextTokens: number;
	costUnits: number;
}

interface ReplayRun {
	run_id: string;
	role: string | null;
	step_id: string | null;
	checkpoint_class: string;
	turns: number;
	calls: number;
	calls_with_hash: number;
	hash_coverage: number;
	outcome: string;
	decisions: ReplayDecision[];
}

interface TurnRow {
	turn_index: number;
	input_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost: number | null;
}

interface CallRow {
	turn_index: number | null;
	tool: string;
	ok: number | null;
	args_hash: string | null;
}

function resolveDataset(input: string): string {
	const resolved = path.resolve(input);
	return resolved.endsWith(".sqlite")
		? resolved
		: path.join(resolved, DATASET_FILE);
}

function replayRun(
	db: Database,
	row: { run_id: string },
): ReplayRun | undefined {
	const run = db
		.query<
			{
				run_id: string;
				role: string | null;
				step_id: string | null;
				status: string | null;
				handoff_outcome: string | null;
			},
			[string]
		>(
			`SELECT run_id, role, step_id, status, handoff_outcome
			 FROM v_runs WHERE run_id = ?`,
		)
		.get(row.run_id);
	if (!run) return undefined;
	const turns = db
		.query<TurnRow, [string]>(
			`SELECT turn_index, input_tokens, cache_read_tokens, cache_write_tokens, cost
			 FROM v_turns WHERE run_id = ? ORDER BY turn_index`,
		)
		.all(run.run_id);
	if (turns.length === 0) return undefined;
	const calls = db
		.query<CallRow, [string]>(
			`SELECT turn_index, tool, ok, args_hash
			 FROM v_tool_calls WHERE run_id = ?
			 ORDER BY COALESCE(turn_index, 0), started_at, id`,
		)
		.all(run.run_id);

	// The live host reads the class from `HERDR_CHECKPOINT_CLASS`; a recorded run
	// predates it, so the replay maps its role name the way the queries do.
	const checkpointClass = checkpointClassOfRole(run.role);
	const tracker: ProgressCheckpoint = new Tracker({
		checkpointClass,
		readOnly: (run.role ?? "").endsWith("-verifier"),
		failingToolEligible: !FAIL_FAST_EXEMPT_ROLES.includes(run.role ?? ""),
	});

	const callsByTurn = new Map<number, CallRow[]>();
	const early: CallRow[] = [];
	for (const call of calls) {
		if (call.turn_index === null) early.push(call);
		else {
			const bucket = callsByTurn.get(call.turn_index) ?? [];
			bucket.push(call);
			callsByTurn.set(call.turn_index, bucket);
		}
	}
	const decisions: ReplayDecision[] = [];
	const decide = (trigger: CheckpointTrigger) => {
		// The dataset records no ceiling state, so a replay can never observe the
		// summarizer's admission: the context rule's `compact` stays unreachable
		// here, and the header says so. Everything else is the live rule set.
		const digest = tracker.takeDigest(trigger, { compactionAdmissible: false });
		const decision = decideCheckpoint(digest, { steer: true });
		tracker.noteDecision(decision, digest);
		decisions.push({
			ordinal: digest.ordinal,
			turn: digest.turns,
			trigger,
			action: decision.action,
			rule: decision.rule,
			...(decision.signal ? { signal: decision.signal } : {}),
			contextTokens: digest.contextTokens,
			costUnits: digest.costUnits,
		});
		if (decision.action === "escalate") {
			// A parked run is never resumed by the record: the replay stops here,
			// which is what the host would do after the grace window.
			return true;
		}
		return false;
	};
	const feed = (call: CallRow) =>
		tracker.observeTool({
			tool: call.tool,
			// A NULL outcome is *unknown*, not a failure: older envelope generations
			// record no `pi.tool.ok`, and counting those as failures would replay a
			// productive run as a run that never made progress.
			ok: call.ok !== 0,
			...(call.args_hash ? { argsHash: call.args_hash } : {}),
		});
	for (const call of early) feed(call);

	let stopped = false;
	for (const turn of turns) {
		tracker.observeTurn({
			// The dataset's turn index is 0-based; the live host observes the 1-based
			// turn number, and the schedule is compared against it.
			turn: turn.turn_index + 1,
			costUnits: turn.cost ?? 0,
			contextTokens:
				(turn.input_tokens ?? 0) +
				(turn.cache_read_tokens ?? 0) +
				(turn.cache_write_tokens ?? 0),
		});
		for (const call of callsByTurn.get(turn.turn_index) ?? []) feed(call);
		if (stopped) continue;
		const trigger = tracker.due();
		if (trigger !== undefined) stopped = decide(trigger);
	}

	const callsWithHash = calls.filter((call) => Boolean(call.args_hash)).length;
	return {
		run_id: run.run_id,
		role: run.role,
		step_id: run.step_id,
		checkpoint_class: checkpointClass,
		turns: turns.length,
		calls: calls.length,
		calls_with_hash: callsWithHash,
		hash_coverage: calls.length === 0 ? 0 : callsWithHash / calls.length,
		outcome: run.handoff_outcome ?? run.status ?? "(unknown)",
		decisions,
	};
}

function main(): void {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.flags.has("help")) {
		console.log(HELP);
		return;
	}
	const dataset = requireValue(args, "dataset");
	const limit = numberValue(args, "limit", 20);
	const oneRun = optionalValue(args, "run");
	const db = new Database(resolveDataset(dataset), { readonly: true });
	try {
		assertDatasetSchemaVersion(db, resolveDataset(dataset));
		const targets =
			oneRun !== undefined
				? [{ run_id: oneRun }]
				: db
						.query<{ run_id: string }, [number]>(
							`SELECT r.run_id AS run_id
							 FROM v_runs r
							 JOIN (SELECT run_id, COUNT(*) AS turns FROM v_turns GROUP BY run_id) t
								ON t.run_id = r.run_id
							 ORDER BY t.turns DESC, r.run_id
							 LIMIT ?`,
						)
						.all(limit);
		const runs: ReplayRun[] = [];
		for (const target of targets) {
			const replay = replayRun(db, target);
			if (replay) runs.push(replay);
		}
		if (args.flags.has("json")) {
			console.log(JSON.stringify({ runs }, null, 2));
			return;
		}
		const byAction = new Map<string, number>();
		for (const run of runs)
			for (const decision of run.decisions)
				byAction.set(
					`${decision.action}/${decision.rule}`,
					(byAction.get(`${decision.action}/${decision.rule}`) ?? 0) + 1,
				);
		if (args.flags.has("decisions")) {
			console.log(
				formatTable(
					runs.flatMap((run) =>
						run.decisions.map((decision) => ({
							run_id: run.run_id,
							checkpoint_class: run.checkpoint_class,
							turns: run.turns,
							ordinal: decision.ordinal,
							turn: decision.turn,
							trigger: decision.trigger,
							action: decision.action,
							rule: decision.rule,
							hash_coverage: run.hash_coverage.toFixed(2),
						})),
					),
					[
						"run_id",
						"checkpoint_class",
						"turns",
						"ordinal",
						"turn",
						"trigger",
						"action",
						"rule",
						"hash_coverage",
					],
				),
			);
		}
		console.log(
			formatTable(
				runs.map((run) => ({
					run_id: run.run_id,
					checkpoint_class: run.checkpoint_class,
					turns: run.turns,
					calls: run.calls,
					hash_coverage: run.hash_coverage.toFixed(2),
					outcome: run.outcome,
					decisions: run.decisions
						.map(
							(decision) =>
								`${decision.turn}:${decision.action}/${decision.rule}`,
						)
						.join(" "),
				})),
				[
					"run_id",
					"checkpoint_class",
					"turns",
					"calls",
					"hash_coverage",
					"outcome",
					"decisions",
				],
			),
		);
		console.log(
			formatTable(
				[...byAction.entries()].map(([decision, count]) => ({
					decision: `${decision} ×${count}`,
				})),
				["decision"],
			),
		);
		console.log(
			`\n${runs.length} run(s) replayed; ${CHECKPOINT_ACTIONS.length} possible actions. ` +
				"Tick-task, diff and HEAD progress are unknown offline; only edits, writes and, for a read-only run, new calls count. " +
				"The cost ceiling's admission is not recorded, so the context rule can only continue here — never compact.",
		);
	} finally {
		db.close();
	}
}

try {
	main();
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`${error.message}\n\n${HELP}`);
		process.exit(2);
	}
	throw error;
}
