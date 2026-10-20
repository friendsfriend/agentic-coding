// The `agent.checkpoint` reducer (efficiency backlog item 19): one run's
// run-progress checkpoint decision, appended to the bounded classifier-decision
// history. It is diagnostic history and nothing else — it never transitions,
// never touches a step's run set, and never changes the snapshot's status — so
// the worst a lost, refused or malformed record can do is leave the run where it
// already was.
//
// The caller is the run itself, like `agent.resume` and the delegated debug
// commands: it resolves its own identity from its launch environment and this
// reducer validates the retained capability inside the command transaction.
import type { Database } from "bun:sqlite";
import type {
	ClassifierDecisionRecord,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import {
	CHECKPOINT_ACTIONS,
	CHECKPOINT_DECIDER,
	CHECKPOINT_INTEGRATION,
	CHECKPOINT_RECORD_LIMIT,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { tokenMatches } from "../capability.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "../store.ts";
import {
	appendClassifierDecisions,
	truncateClassifierInput,
} from "./effect-result.ts";

/** The integration name every record of this feature carries. The dashboard
 * reads it, the CLI refuses any other value, and the host's own telemetry
 * envelope uses the same string. */
export const CHECKPOINT_RECORD_INTEGRATION = CHECKPOINT_INTEGRATION;

/** The digest's key vocabulary, as the record boundary checks it: the
 * checkpoint's content-free digest is the only `input` a record may carry, and
 * these are exactly the keys `CheckpointDigest` has. A test keeps them equal. */
const CHECKPOINT_DIGEST_KEYS: ReadonlySet<string> = new Set([
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
]);

/** The keys of the digest's three nested objects. */
const CHECKPOINT_DIGEST_NESTED_KEYS: Readonly<
	Record<string, ReadonlySet<string>>
> = {
	window: new Set(["turns", "progress"]),
	diff: new Set(["files", "insertions", "deletions"]),
	previous: new Set(["decision", "rule", "progress"]),
};

/** What every string inside a digest may look like: a lowercase closed token
 * (a class, an action, a rule id, a signal, a trigger or a registered tool
 * name). No path, sentence, excerpt or credential matches it. */
const CHECKPOINT_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
/** A record's free-ish text (a step id, an attention line, option criteria):
 * printable ASCII only, so no escape or control sequence can be persisted. */
const CHECKPOINT_PRINTABLE = /^[\x20-\x7e]*$/;
const CHECKPOINT_TEXT_LIMIT = 200;
const CHECKPOINT_QUESTION_ID = /^checkpoint:[A-Za-z0-9-]{1,64}:\d{1,4}$/;
/** A step id: lowercase words joined by `.`, `-` or `_`. A path, a URL or a
 * sentence cannot match it, so the recorded phase cannot name a file. */
const CHECKPOINT_STEP_ID = /^[a-z][a-z0-9_.-]{0,63}$/;

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function boundedPrintable(value: unknown): boolean {
	return (
		typeof value === "string" &&
		value.length <= CHECKPOINT_TEXT_LIMIT &&
		CHECKPOINT_PRINTABLE.test(value)
	);
}

function digestWalk(
	value: unknown,
	keys: ReadonlySet<string> | undefined,
	problems: string[],
): void {
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			problems.push("input carries a non-finite number");
		return;
	}
	if (typeof value === "boolean" || value === null || value === undefined)
		return;
	if (typeof value === "string") {
		if (!CHECKPOINT_TOKEN.test(value))
			problems.push("input carries text outside the closed vocabulary");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) digestWalk(item, undefined, problems);
		return;
	}
	const object = asObject(value);
	if (!object) {
		problems.push("input carries an unsupported value");
		return;
	}
	for (const [key, child] of Object.entries(object)) {
		if (keys !== undefined && !keys.has(key)) {
			problems.push(`input carries the unknown key "${key}"`);
			continue;
		}
		digestWalk(child, CHECKPOINT_DIGEST_NESTED_KEYS[key], problems);
	}
}

/** Everything `workflow checkpoint --record` accepts, checked at the boundary
 * that persists it: the closed decision vocabulary, the closed rule and digest
 * vocabulary, printable bounded text, and a question id that names the recording
 * run. The reducer enforces it inside the command transaction and the CLI
 * refuses the same values before dispatching, so no other caller of the
 * authenticated command can write a decision the feature never declares. */
export function checkpointRecordProblems(
	input: unknown,
	runId: string,
	maxRecords: number,
): string[] {
	const problems: string[] = [];
	const record = asObject(input);
	if (!record) return ["record must be a JSON object"];
	if (record.integration !== CHECKPOINT_RECORD_INTEGRATION)
		problems.push(`integration must be "${CHECKPOINT_RECORD_INTEGRATION}"`);
	if (record.model !== CHECKPOINT_DECIDER)
		problems.push(`model must be "${CHECKPOINT_DECIDER}"`);
	const questionId = record.questionId;
	if (
		typeof questionId !== "string" ||
		!CHECKPOINT_QUESTION_ID.test(questionId)
	)
		problems.push("questionId must be checkpoint:<run id>:<ordinal>");
	else if (!questionId.startsWith(`checkpoint:${runId}:`))
		problems.push("questionId must name the recording run");
	if (
		record.phase !== undefined &&
		(typeof record.phase !== "string" || !CHECKPOINT_STEP_ID.test(record.phase))
	)
		problems.push("phase must be a step id");
	if (typeof record.input !== "string") problems.push("input must be a string");
	else {
		let digest: unknown;
		try {
			digest = JSON.parse(record.input);
		} catch {
			problems.push("input must be the digest as JSON");
		}
		if (digest !== undefined)
			digestWalk(digest, CHECKPOINT_DIGEST_KEYS, problems);
	}
	if (!Array.isArray(record.options))
		problems.push("options must list the five checkpoint actions");
	else {
		if (record.options.length !== CHECKPOINT_ACTIONS.length)
			problems.push("options must list the five checkpoint actions");
		for (const [index, raw] of record.options.entries()) {
			const option = asObject(raw);
			const expected = CHECKPOINT_ACTIONS[index];
			if (!option || option.label !== expected || option.profile !== expected)
				problems.push(`option ${index + 1} must be "${expected}"`);
			if (option?.criteria !== undefined && !boundedPrintable(option.criteria))
				problems.push(
					`option ${index + 1} criteria must be short printable text`,
				);
		}
	}
	const answer = asObject(record.answer);
	const isAction = (value: unknown) =>
		typeof value === "string" &&
		(CHECKPOINT_ACTIONS as readonly string[]).includes(value);
	if (answer?.type !== "choice" || !isAction(answer.choice))
		problems.push("answer must choose one checkpoint action");
	const probabilities = asObject(answer?.probabilities);
	if (probabilities)
		for (const [label, value] of Object.entries(probabilities)) {
			if (
				!isAction(label) ||
				typeof value !== "number" ||
				!(value >= 0 && value <= 1)
			)
				problems.push("answer probabilities must cover the closed actions");
		}
	const result = asObject(record.result);
	if (!result || typeof result.applied !== "boolean")
		problems.push("result must state whether the decision was applied");
	const profiles = result?.profiles;
	if (!Array.isArray(profiles)) problems.push("result profiles must be a list");
	else
		for (const profile of profiles)
			if (!isAction(profile))
				problems.push("result profiles must be checkpoint actions");
	if (result?.attention !== undefined && !boundedPrintable(result.attention))
		problems.push("result attention must be short printable text");
	if (maxRecords < 1) problems.push("no checkpoint record may be written");
	return problems;
}

export interface RecordedCheckpoint {
	recorded: boolean;
	/** Why nothing was appended, for the caller's log line. */
	reason?: "record-cap" | "storage-error";
	/** How many checkpoint records the workflow holds after this command. */
	records: number;
}

export function agentCheckpoint(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.checkpoint" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		(command.generation !== undefined &&
			run.generation !== command.generation) ||
		!ACTIVE_RUN.has(run.status) ||
		run.stepId !== snapshot.currentStep ||
		run.stepId !== command.stepId ||
		run.role !== command.role ||
		!snapshot.step.activeRunIds.includes(run.id)
	)
		throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
	if (
		!run.capabilityHash ||
		!tokenMatches(command.token, run.capabilityHash) ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or expired run capability",
		);
	// The record is diagnostic, but it is persisted and rendered: the boundary
	// that stores it is where the closed-vocabulary and content-free invariants
	// are enforced for every caller of this command.
	const problems = checkpointRecordProblems(
		command.record,
		run.id,
		CHECKPOINT_RECORD_LIMIT,
	);
	if (problems.length > 0)
		throw new WorkflowRuntimeError(
			"invalid-command",
			`checkpoint record refused: ${problems[0]}`,
		);
	const record: ClassifierDecisionRecord = {
		id: [
			snapshot.workflowId,
			snapshot.revision,
			CHECKPOINT_RECORD_INTEGRATION,
			command.record.questionId,
		].join(":"),
		at: nowIso(now),
		integration: CHECKPOINT_RECORD_INTEGRATION,
		...(command.record.phase === undefined
			? {}
			: { phase: command.record.phase }),
		questionId: command.record.questionId,
		model: command.record.model,
		...truncateClassifierInput(command.record.input),
		options: [...command.record.options],
		answer: { ...command.record.answer },
		result: {
			applied: command.record.result.applied,
			profiles: [...command.record.result.profiles],
			...(command.record.result.attention === undefined
				? {}
				: { attention: command.record.result.attention }),
		},
	};
	const before = runCheckpointRecords(snapshot, run.id).length;
	if (before >= CHECKPOINT_RECORD_LIMIT)
		return {
			type: "agent.checkpoint",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				recorded: false,
				reason: "record-cap",
				records: before,
			} satisfies RecordedCheckpoint,
		};
	try {
		appendClassifierDecisions(snapshot, [record]);
	} catch {
		// History is diagnostic: a record that cannot be stored must never fail
		// the command that recorded it.
		return {
			type: "agent.checkpoint",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				recorded: false,
				reason: "storage-error",
				records: before,
			} satisfies RecordedCheckpoint,
		};
	}
	return {
		type: "agent.checkpoint",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			recorded: true,
			records: checkpointRecords(snapshot).length,
		} satisfies RecordedCheckpoint,
	};
}

/** Every checkpoint record this workflow's bounded history holds. */
export function checkpointRecords(
	snapshot: WorkflowSnapshot,
): ClassifierDecisionRecord[] {
	return (snapshot.classifierDecisions ?? []).filter(
		(record) => record.integration === CHECKPOINT_RECORD_INTEGRATION,
	);
}

/** One run's checkpoint records. The cap is per run, so a later run of the same
 * workflow starts with its own budget and its first decision is never refused
 * because an earlier run used the twelve. */
export function runCheckpointRecords(
	snapshot: WorkflowSnapshot,
	runId: string,
): ClassifierDecisionRecord[] {
	const prefix = `checkpoint:${runId}:`;
	return checkpointRecords(snapshot).filter((record) =>
		record.questionId.startsWith(prefix),
	);
}
