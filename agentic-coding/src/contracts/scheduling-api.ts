import { Schema } from "effect";
import {
	jobSchema,
	OCCURRENCE_STATES,
	scheduleSchema,
	schedulingIdentitySchema,
	timingSchema,
	wakeUpTargetSchema,
} from "./scheduling.ts";

const text = (max: number) =>
	Schema.String.pipe(
		Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)),
	);
const key = schedulingIdentitySchema;
const number = Schema.Number.pipe(
	Schema.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
	),
).annotate({ identifier: "SchedulingInteger" });
const page = {
	after: Schema.optionalKey(text(512)),
	limit: Schema.optionalKey(
		number
			.pipe(
				Schema.check(
					Schema.isGreaterThanOrEqualTo(1),
					Schema.isLessThanOrEqualTo(100),
				),
			)
			.annotate({ identifier: "SchedulingPageSize" }),
	),
};
const mutation = { requestId: key };
const entity = { id: key, revision: number };
const affectedSchedules = Schema.Array(key).pipe(
	Schema.check(Schema.isMaxLength(1000)),
);
export const schedulingTimingInputSchema = Schema.Union([
	timingSchema,
	Schema.Struct({
		kind: Schema.Literal("delay"),
		delayMs: number,
		timezone: text(128),
	}),
	Schema.Struct({
		kind: Schema.Literal("local-once"),
		local: text(64),
		timezone: text(128),
		fold: Schema.optionalKey(Schema.Literals(["earlier", "later"])),
	}),
]).annotate({ identifier: "SchedulingTimingInput" });
export type SchedulingTimingInput = typeof schedulingTimingInputSchema.Type;
const requestSchedule = Schema.Struct({
	...scheduleSchema.fields,
	timing: schedulingTimingInputSchema,
}).annotate({ identifier: "SchedulingScheduleRequest" });
const creationSchedule = Schema.Struct({
	name: scheduleSchema.fields.name,
	timing: schedulingTimingInputSchema,
	latePolicy: scheduleSchema.fields.latePolicy,
});
export const schedulingRequestSchema = Schema.Union([
	Schema.Struct({ operation: Schema.Literal("status") }),
	Schema.Struct({ operation: Schema.Literal("destination"), ...mutation }),
	Schema.Struct({
		operation: Schema.Literal("preview"),
		timing: schedulingTimingInputSchema,
	}),
	Schema.Struct({
		operation: Schema.Literal("create"),
		...mutation,
		job: jobSchema,
		schedule: creationSchedule,
	}),
	Schema.Struct({ operation: Schema.Literal("jobs.list"), ...page }),
	Schema.Struct({ operation: Schema.Literal("jobs.get"), id: key }),
	Schema.Struct({
		operation: Schema.Literal("jobs.create"),
		...mutation,
		job: jobSchema,
	}),
	Schema.Struct({
		operation: Schema.Literal("jobs.update"),
		...mutation,
		...entity,
		job: jobSchema,
		affectedSchedules,
	}),
	Schema.Struct({
		operation: Schema.Literal("jobs.delete"),
		...mutation,
		...entity,
	}),
	Schema.Struct({ operation: Schema.Literal("schedules.list"), ...page }),
	Schema.Struct({ operation: Schema.Literal("schedules.get"), id: key }),
	Schema.Struct({
		operation: Schema.Literal("schedules.create"),
		...mutation,
		schedule: requestSchedule,
	}),
	Schema.Struct({
		operation: Schema.Literal("schedules.update"),
		...mutation,
		...entity,
		schedule: requestSchedule,
	}),
	Schema.Struct({
		operation: Schema.Literal("schedules.action"),
		...mutation,
		...entity,
		action: Schema.Literals([
			"pause",
			"resume",
			"cancel",
			"delete",
			"run-now",
			"postpone",
		]),
		until: Schema.optionalKey(number),
	}),
	Schema.Struct({
		operation: Schema.Literal("history"),
		scheduleId: key,
		...page,
	}),
	Schema.Struct({ operation: Schema.Literal("occurrences.get"), id: key }),
	Schema.Struct({
		operation: Schema.Literal("occurrences.approve"),
		...mutation,
		id: key,
		fence: number,
	}),
]);
export function schedulingOperationRequiresOperator(
	operation: string,
): boolean {
	return operation === "destination" || operation === "occurrences.approve";
}
/** Agent metadata is derived from the same API members and authority policy. */
export const schedulingAgentRequestSchema = Schema.Union(
	schedulingRequestSchema.members.filter(
		(member) =>
			!schedulingOperationRequiresOperator(member.fields.operation.literal),
	),
);
export type SchedulingRequest = typeof schedulingRequestSchema.Type;
export const schedulingJobSchema = Schema.Struct({
	...jobSchema.fields,
	id: key,
	revision: number,
	createdAt: number,
	updatedAt: number,
	deletedAt: Schema.optionalKey(number),
});
export const schedulingScheduleSchema = Schema.Struct({
	...scheduleSchema.fields,
	id: key,
	revision: number,
	state: Schema.Literals(["enabled", "paused", "cancelled", "deleted"]),
	nextDue: Schema.Union([Schema.Null, number]),
	cursor: Schema.Union([Schema.Null, number]),
	overrideDue: Schema.Union([Schema.Null, number]),
	createdAt: number,
	updatedAt: number,
});
const receiptSchema = Schema.Struct({
	id: key,
	digest: key,
	state: Schema.Literals(OCCURRENCE_STATES),
	result: Schema.optionalKey(text(65536)),
	submission: Schema.optionalKey(
		Schema.Struct({
			conversationId: key,
			id: key,
			inputEntryId: Schema.optionalKey(key),
			answerEntryId: Schema.optionalKey(key),
		}),
	),
	workflow: Schema.optionalKey(
		Schema.Struct({ repository: text(4096), workflowId: key }),
	),
	agent: Schema.optionalKey(
		Schema.Struct({
			hostSocket: text(4096),
			hostId: key,
			runId: key,
			conversationId: key,
			outputPath: text(4096),
		}),
	),
});
export const schedulingOccurrenceSchema = Schema.Struct({
	id: key,
	slot: text(512),
	scheduleId: key,
	scheduleRevision: number,
	jobId: key,
	jobRevision: number,
	nominalDue: number,
	createdAt: number,
	updatedAt: number,
	state: Schema.Literals(OCCURRENCE_STATES),
	reason: Schema.optionalKey(text(4096)),
	job: schedulingJobSchema,
	fence: number,
	leaseUntil: number,
	attempts: number,
	nextAttempt: number,
	receipt: Schema.optionalKey(receiptSchema),
	admittedAt: Schema.optionalKey(number),
	approvedAt: Schema.optionalKey(number),
	approvedBy: Schema.optionalKey(key),
	terminalAt: Schema.optionalKey(number),
	missedCount: Schema.optionalKey(number),
	missedLast: Schema.optionalKey(number),
});
export const schedulingPreviewSchema = Schema.Struct({
	timing: timingSchema,
	next: Schema.Array(Schema.Struct({ at: text(64), local: text(128) })),
	dstPolicy: Schema.Literal("skip-gap/earlier-fold"),
	noOverlap: Schema.Literal("job"),
});
const pagination = { nextCursor: Schema.optionalKey(text(512)) };
export const schedulingScheduleSummarySchema = Schema.Struct({
	scheduleId: key,
	jobName: text(120),
	targetKind: text(64),
	project: text(4096),
	latenessMs: number,
	activeStates: Schema.Array(Schema.Literals(OCCURRENCE_STATES)),
	lastOutcome: Schema.optionalKey(
		Schema.Struct({
			id: key,
			state: Schema.Literals(OCCURRENCE_STATES),
			at: number,
		}),
	),
});
export const schedulingResponseSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("destination"),
		target: wakeUpTargetSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("status"),
		status: Schema.Struct({
			available: Schema.Boolean,
			storeId: key,
			pollingAllowanceMs: number,
			machineWake: Schema.Literal(false),
			operatesOnlyWhileServiceRunning: Schema.Literal(true),
		}),
	}),
	Schema.Struct({
		kind: Schema.Literal("preview"),
		preview: schedulingPreviewSchema,
	}),
	Schema.Struct({
		kind: Schema.Literal("created"),
		job: schedulingJobSchema,
		schedule: schedulingScheduleSchema,
		preview: schedulingPreviewSchema,
		noOverlap: Schema.Literal("job"),
	}),
	Schema.Struct({
		kind: Schema.Literal("jobs"),
		items: Schema.Array(schedulingJobSchema),
		...pagination,
	}),
	Schema.Struct({
		kind: Schema.Literal("job"),
		job: schedulingJobSchema,
		affectedSchedules,
	}),
	Schema.Struct({
		kind: Schema.Literal("schedules"),
		items: Schema.Array(schedulingScheduleSchema),
		summaries: Schema.Array(schedulingScheduleSummarySchema),
		...pagination,
	}),
	Schema.Struct({
		kind: Schema.Literal("schedule"),
		schedule: schedulingScheduleSchema,
		preview: schedulingPreviewSchema,
		active: Schema.Array(schedulingOccurrenceSchema),
	}),
	Schema.Struct({
		kind: Schema.Literal("occurrences"),
		items: Schema.Array(schedulingOccurrenceSchema),
		...pagination,
	}),
	Schema.Struct({
		kind: Schema.Literal("occurrence"),
		occurrence: schedulingOccurrenceSchema,
	}),
]);
export type SchedulingResponse = typeof schedulingResponseSchema.Type;
