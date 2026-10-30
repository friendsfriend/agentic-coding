import { Schema, SchemaIssue } from "effect";
import {
	type ContractError,
	formatIssuePath,
	sanitizeIssueMessage,
} from "./decode.ts";

const text = (max: number) =>
	Schema.String.pipe(
		Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)),
	);
const integer = Schema.Number.pipe(
	Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
export const schedulingIdentitySchema = text(256).annotate({
	identifier: "SchedulingId",
});
const identity = schedulingIdentitySchema;
export const timingSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("once"),
		at: text(64),
		timezone: text(128),
		sourceDelayMs: Schema.optionalKey(integer),
	}),
	Schema.Struct({
		kind: Schema.Literal("interval"),
		anchor: text(64),
		everyMs: integer,
		timezone: text(128),
	}),
	Schema.Struct({
		kind: Schema.Literal("calendar"),
		weekdays: Schema.Array(integer),
		hour: integer,
		minute: integer,
		timezone: text(128),
	}),
]).annotate({ identifier: "SchedulingTiming" });
export type Timing = typeof timingSchema.Type;
export const latePolicySchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("run-late") }),
	Schema.Struct({ kind: Schema.Literal("expire-after"), graceMs: integer }),
]).annotate({ identifier: "SchedulingLatePolicy" });
export type LatePolicy = typeof latePolicySchema.Type;
export const wakeUpTargetSchema = Schema.Struct({
	kind: Schema.Literal("wake-up"),
	hostId: identity,
	hostSocket: text(4096),
	conversationId: identity,
	runId: identity,
});
const targetSchema = Schema.Union([
	wakeUpTargetSchema,
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("standalone"),
			repository: text(4096),
			model: identity,
			thinking: Schema.optionalKey(identity),
			policy: Schema.Literal("read-only"),
			reviewPolicy: Schema.Literal("none"),
			baseBranch: identity,
			destination: Schema.optionalKey(
				Schema.Struct({
					kind: Schema.Literal("workflowless-session"),
					sessionId: identity,
					owner: identity,
					hostId: identity,
					conversationId: identity,
				}),
			),
		}),
		Schema.Struct({
			kind: Schema.Literal("standalone"),
			repository: text(4096),
			model: identity,
			thinking: Schema.optionalKey(identity),
			policy: Schema.Literal("default"),
			reviewPolicy: Schema.Literal("human"),
			baseBranch: identity,
		}),
	]).annotate({ identifier: "SchedulingStandaloneTarget" }),
	Schema.Struct({
		kind: Schema.Literal("workflow"),
		repository: text(4096),
		workflowType: identity,
		preset: identity,
		mode: Schema.Literals(["worktree", "checkout"]),
		sourceBranch: Schema.optionalKey(identity),
		targetBranch: Schema.optionalKey(identity),
		app: Schema.optionalKey(identity),
		stage: Schema.optionalKey(identity),
	}),
]);
export const jobSchema = Schema.Struct({
	name: text(120),
	task: text(65536),
	originalInstruction: text(65536),
	reason: text(4096),
	references: Schema.Array(text(4096)).pipe(
		Schema.check(Schema.isMaxLength(50)),
	),
	reportingDestination: text(4096),
	target: targetSchema,
}).annotate({ identifier: "SchedulingJobInput" });
export type JobInput = typeof jobSchema.Type;
export type Target = JobInput["target"];
export interface Job extends JobInput {
	id: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	deletedAt?: number;
}
export const scheduleSchema = Schema.Struct({
	name: text(120),
	jobId: identity,
	timing: timingSchema,
	latePolicy: latePolicySchema,
}).annotate({ identifier: "SchedulingScheduleInput" });
export type ScheduleInput = typeof scheduleSchema.Type;
export interface Schedule extends ScheduleInput {
	id: string;
	revision: number;
	state: "enabled" | "paused" | "cancelled" | "deleted";
	nextDue: number | null;
	cursor: number | null;
	overrideDue: number | null;
	createdAt: number;
	updatedAt: number;
}
export const OCCURRENCE_STATES = [
	"pending",
	"reserved",
	"admitted",
	"queued",
	"processing",
	"running",
	"waiting-review",
	"succeeded",
	"execution-failed",
	"launch-failed",
	"reconciling",
	"destination-unavailable",
	"skipped-overlap",
	"missed",
	"expired",
	"cancelled-before-admission",
] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];
export interface TargetReceipt {
	id: string;
	digest: string;
	state: OccurrenceState;
	result?: string;
	/** Native receipt identities, never a guess at the conversation's latest reply. */
	submission?: {
		conversationId: string;
		id: string;
		inputEntryId?: string;
		answerEntryId?: string;
	};
	workflow?: { repository: string; workflowId: string };
	agent?: {
		hostSocket: string;
		hostId: string;
		runId: string;
		conversationId: string;
		outputPath: string;
	};
}
export interface Occurrence {
	id: string;
	slot: string;
	scheduleId: string;
	scheduleRevision: number;
	jobId: string;
	jobRevision: number;
	nominalDue: number;
	createdAt: number;
	updatedAt: number;
	state: OccurrenceState;
	reason?: string;
	job: Job;
	fence: number;
	leaseUntil: number;
	attempts: number;
	nextAttempt: number;
	receipt?: TargetReceipt;
	admittedAt?: number;
	approvedAt?: number;
	approvedBy?: string;
	terminalAt?: number;
	missedCount?: number;
	missedLast?: number;
}
export interface SchedulePreview {
	timing: Timing;
	next: Array<{ at: string; local: string }>;
	dstPolicy: "skip-gap/earlier-fold";
	noOverlap: "job";
}
export interface SchedulingCreation {
	job: Job;
	schedule: Schedule;
	preview: SchedulePreview;
	noOverlap: "job";
}
export type ScheduleAction =
	| "pause"
	| "resume"
	| "cancel"
	| "delete"
	| "run-now"
	| "postpone";
export class SchedulingError extends Error {
	constructor(
		readonly code:
			| "invalid-input"
			| "not-found"
			| "conflict"
			| "limit"
			| "unavailable"
			| "forbidden",
		message: string,
		readonly issues: readonly ContractError[] = [],
	) {
		super(message);
		this.name = "SchedulingError";
	}
}
/** Strict decoding is shared by HTTP, tools and manual clients. Never echo input in diagnostics. */
export function decodeScheduling<A>(
	schema: Schema.Decoder<A>,
	input: unknown,
): A {
	try {
		return Schema.decodeUnknownSync(schema, {
			onExcessProperty: "error",
			reportInput: false,
		})(input);
	} catch (error) {
		const issues = Schema.isSchemaError(error)
			? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
					.issues.slice(0, 8)
					.map((issue) => ({
						path: formatIssuePath(
							(issue.path ?? []).map((part) =>
								typeof part === "object" ? part.key : part,
							),
						),
						message: sanitizeIssueMessage(
							issue.message === "Missing key"
								? "required property is missing"
								: issue.message,
						),
					}))
			: [];
		throw new SchedulingError(
			"invalid-input",
			issues.length
				? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
				: "Invalid scheduling request; check required fields, bounds and unknown properties.",
			issues,
		);
	}
}
