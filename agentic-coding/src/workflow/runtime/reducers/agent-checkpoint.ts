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
	CHECKPOINT_ACTION_SUMMARY,
	CHECKPOINT_ACTIONS,
	CHECKPOINT_DECIDER,
	CHECKPOINT_INTEGRATION,
	CHECKPOINT_RECORD_LIMIT,
	CHECKPOINT_RULE_IDS,
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

/** The digest's shape, as the record boundary checks it: one entry per key of
 * `CheckpointDigest`, each with the kind of value that key carries. The boundary
 * refuses an unknown key at any depth, a missing key, and a value of the wrong
 * kind — a sentence where a count belongs is content trying to reach the
 * history, so the check is structural rather than a list of forbidden strings. A
 * test keeps this table and the interface equal. */
type DigestShapes = Readonly<Record<string, DigestShape>>;
type DigestShape =
	| "number"
	| "boolean"
	| "token"
	| "nullable-token"
	| "tool"
	| "nullable-tool"
	| "nullable-number"
	| "token-list"
	| { readonly fields: DigestShapes }
	| { readonly nullableFields: DigestShapes };

const CHECKPOINT_DIGEST_SHAPE: DigestShapes = {
	ordinal: "number",
	trigger: "token",
	checkpointClass: "token",
	readOnly: "boolean",
	turns: "number",
	costUnits: "number",
	contextTokens: "number",
	peakContextTokens: "number",
	softTurns: "number",
	hardTurns: "number",
	contextLimit: "number",
	compactionAdmissible: "boolean",
	successfulCalls: "number",
	failingToolEligible: "boolean",
	failingTool: "nullable-tool",
	failingToolStreak: "number",
	repeatCalls: "number",
	windowCalls: "number",
	turnsSinceProgress: "number",
	costRisingRatio: "number",
	window: { fields: { turns: "number", progress: "number" } },
	diff: {
		nullableFields: {
			files: "number",
			insertions: "number",
			deletions: "number",
		},
	},
	tickedTasks: "nullable-number",
	previous: {
		nullableFields: { decision: "token", rule: "token", progress: "number" },
	},
	steeredSignals: "token-list",
};

/** What every string inside a digest may look like: a lowercase closed token
 * (a class, an action, a rule id, a signal, a trigger) or a registered tool
 * name. The host publishes dotted tool names (`agentic.codemode`), which is why
 * the dot is part of the shape. No path, sentence, excerpt or credential
 * matches it. */
const CHECKPOINT_TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;
/** The decider's own stand-in for a failing tool name the host did not publish:
 * the digest records `"a tool"` rather than a name it cannot vouch for, so the
 * boundary admits exactly this one string with a space and nothing else. */
const CHECKPOINT_UNREGISTERED_TOOL = "a tool";
const CHECKPOINT_QUESTION_ID = /^checkpoint:[A-Za-z0-9-]{1,64}:\d{1,4}$/;
/** A step id: lowercase words joined by `.`, `-` or `_`. A path, a URL or a
 * sentence cannot match it, so the recorded phase cannot name a file. */
const CHECKPOINT_STEP_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
/** The exact reasons this feature writes after a rule id: the attention line is
 * read by a developer and measured by the queries, so it is a closed
 * vocabulary, not free text a caller chooses. The question's own fate is the
 * one reason that carries an id. */
const CHECKPOINT_ATTENTION_REASONS = [
	"steer disabled",
	"steer not delivered",
	"no signal to steer",
	"switch-model is not enabled",
	"compaction not admitted",
	"compaction failed",
	"context above limit, compaction not admissible",
	"question not filed",
] as const;
const CHECKPOINT_QUESTION_FATE =
	"question [A-Za-z0-9_.:-]{1,80} (?:answered|unanswered|cancelled)";
/** `rule <id>`, then up to three closed reasons — a steer disabled over a
 * blocked context states both. */
const CHECKPOINT_ATTENTION = new RegExp(
	`^rule (?:${CHECKPOINT_RULE_IDS.join("|")})(?:; (?:${[
		...CHECKPOINT_ATTENTION_REASONS,
		CHECKPOINT_QUESTION_FATE,
	].join("|")})){0,3}$`,
);

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function closedToken(value: unknown): boolean {
	return (
		typeof value === "string" &&
		(value === CHECKPOINT_UNREGISTERED_TOOL || CHECKPOINT_TOKEN.test(value))
	);
}

function digestWalk(
	value: unknown,
	shape: DigestShape,
	path: string,
	problems: string[],
): void {
	if (typeof shape === "object") {
		const fields =
			"fields" in shape ? shape.fields : (shape.nullableFields ?? {});
		if (value === null && "nullableFields" in shape) return;
		const object = asObject(value);
		if (!object) {
			problems.push(`input ${path} must be an object`.trimStart());
			return;
		}
		for (const [key, child] of Object.entries(object)) {
			const childShape = fields[key];
			if (childShape === undefined) {
				problems.push(`input carries the unknown key "${key}"`);
				continue;
			}
			digestWalk(
				child,
				childShape,
				path === "" ? key : `${path}.${key}`,
				problems,
			);
		}
		for (const key of Object.keys(fields))
			if (!(key in object)) problems.push(`input is missing the key "${key}"`);
		return;
	}
	if (value === null || value === undefined) {
		if (
			shape === "nullable-token" ||
			shape === "nullable-tool" ||
			shape === "nullable-number"
		)
			return;
		problems.push(`input ${path} must be a ${shape}`.trimStart());
		return;
	}
	if (shape === "number" || shape === "nullable-number") {
		if (typeof value !== "number")
			problems.push(`input ${path} must be a number`.trimStart());
		else if (!Number.isFinite(value))
			problems.push(`input ${path} carries a non-finite number`.trimStart());
		return;
	}
	if (shape === "boolean") {
		if (typeof value !== "boolean")
			problems.push(`input ${path} must be a boolean`.trimStart());
		return;
	}
	if (shape === "token-list") {
		if (!Array.isArray(value) || !value.every((item) => closedToken(item)))
			problems.push(
				`input ${path} must be a list of closed tokens`.trimStart(),
			);
		return;
	}
	// `token`, `tool`, `nullable-token` and `nullable-tool` carry one string.
	if (!closedToken(value))
		problems.push(
			`input ${path} carries text outside the closed vocabulary`.trimStart(),
		);
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
			digestWalk(digest, { fields: CHECKPOINT_DIGEST_SHAPE }, "", problems);
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
			// The criteria is the action's own closed line: the options are
			// rendered in the dashboard, so free text here would be a way around
			// the digest's content-free rule.
			if (option?.criteria !== CHECKPOINT_ACTION_SUMMARY[expected])
				problems.push(
					`option ${index + 1} criteria must be the action's own line`,
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
	if (
		result?.attention !== undefined &&
		!(typeof result.attention === "string"
			? CHECKPOINT_ATTENTION.test(result.attention)
			: false)
	)
		problems.push("result attention must be a rule id and a closed reason");
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
	// One question id is one record: a retried command — a timeout, a second
	// report of the same checkpoint — must not consume a second slot of the
	// run's budget or push an identical row into the history.
	const existing = runCheckpointRecords(snapshot, run.id);
	if (existing.some((entry) => entry.questionId === command.record.questionId))
		return {
			type: "agent.checkpoint",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				recorded: true,
				records: existing.length,
			} satisfies RecordedCheckpoint,
		};
	const before = existing.length;
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
