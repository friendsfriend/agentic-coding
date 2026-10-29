import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { decodeScheduling, type Target } from "../contracts/scheduling.ts";
import {
	type SchedulingRequest,
	type SchedulingResponse,
	schedulingAgentRequestSchema,
	schedulingRequestSchema,
	schedulingResponseSchema,
} from "../contracts/scheduling-api.ts";
import { toolViewDetails } from "./tool-view-details.ts";
import type { DurableRunContext, RunContextLookup } from "./tools.ts";

type WakeUpTarget = Extract<Target, { kind: "wake-up" }>;
export type SchedulingDestination = (
	conversationId: Parameters<RunContextLookup>[0],
	context: DurableRunContext,
) => Promise<WakeUpTarget>;
const document = Schema.toJsonSchemaDocument(schedulingAgentRequestSchema);
const MAX_RESULT_CHARS = 60000;
function result(value: unknown, isError = false) {
	const raw = typeof value === "string" ? value : JSON.stringify(value);
	return {
		output: [
			{
				type: "text" as const,
				text:
					raw.length > MAX_RESULT_CHARS
						? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`
						: raw,
			},
		],
		...(isError ? { isError: true } : {}),
		details: toolViewDetails(value, MAX_RESULT_CHARS),
	};
}
function jobSummary(job: Extract<SchedulingResponse, { kind: "job" }>["job"]) {
	return {
		id: job.id,
		revision: job.revision,
		name: job.name,
		target: job.target,
		executionPolicy:
			job.target.kind === "standalone"
				? job.target.policy
				: "normal target authority",
		reviewPolicy:
			job.target.kind === "standalone"
				? job.target.reviewPolicy
				: job.target.kind === "workflow"
					? "normal human reviews"
					: "no additional authorization",
		reportingDestination: job.reportingDestination,
	};
}
function occurrenceSummary(
	value: Extract<SchedulingResponse, { kind: "occurrence" }>["occurrence"],
) {
	return {
		id: value.id,
		scheduleId: value.scheduleId,
		jobId: value.jobId,
		nominalDue: new Date(value.nominalDue).toISOString(),
		state: value.state,
		reason: value.reason,
		admittedAt: value.admittedAt,
		fence: value.fence,
		receipt: value.receipt,
	};
}
export function compactScheduling(value: SchedulingResponse): unknown {
	switch (value.kind) {
		case "created":
			return { ...value, job: jobSummary(value.job) };
		case "jobs":
			return { ...value, items: value.items.map(jobSummary) };
		case "job":
			return { ...value, job: jobSummary(value.job) };
		case "schedule":
			return { ...value, active: value.active.map(occurrenceSummary) };
		case "occurrence":
			return { ...value, occurrence: occurrenceSummary(value.occurrence) };
		case "occurrences":
			return { ...value, items: value.items.map(occurrenceSummary) };
		default:
			return value;
	}
}
/** Tool metadata is derived from the exact shared request schema. The server
 * remains the authority for validation, revisions, request receipts and review. */
export function createSchedulingTools(options: {
	lookup: RunContextLookup;
	destination?: SchedulingDestination;
	call: (
		env: Readonly<Record<string, string>>,
		request: SchedulingRequest,
	) => Promise<unknown>;
}) {
	return [
		defineTool({
			name: "scheduling_destination",
			description:
				"Read the exact pinned host/conversation/run destination for a wake-up to this session. Use this target verbatim in scheduling requests; never invent or substitute another conversation.",
			replay: "safe",
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: async (_args, api) => {
				try {
					const context = options.lookup(api.conversationId);
					if (!context || !options.destination)
						throw new Error("Native scheduling destination unavailable.");
					return result(await options.destination(api.conversationId, context));
				} catch (error) {
					return result(
						error instanceof Error
							? error.message
							: "Scheduling destination unavailable.",
						true,
					);
				}
			},
		}),
		defineTool({
			name: "scheduling",
			description:
				"Manage durable reusable jobs and schedules through the shared server API: status, timing preview, atomic job+schedule create, job/schedule list/get/create/update/delete, postpone, pause/resume, cancel, run-now and paginated occurrence history/results. Use explicit timezone and self-contained task/original instruction/reason/references/report destination. Every mutation requires a stable requestId; reuse the identical request after an ambiguous acknowledgement. Edits/actions require the last revision; shared-job edits require the complete affectedSchedules from jobs.get. Wake-up targets must come from scheduling_destination for this session. Standalone uses explicit repository/model/baseBranch/permission/review policies; writable standalone waits for operator approval, which this tool cannot grant. Workflow starts retain normal validation and human reviews. Preview before creation; confirm target, timing/zone/next run and late/review/no-overlap policies. No OS wake: execution requires the server to be running. Use detail full to inspect complete stored tasks; default results are compact and lists/history use nextCursor.",
			replay: "safe",
			parameters: Type.Object(
				{
					request: Type.Unsafe<SchedulingRequest>(document.schema),
					detail: Type.Optional(Type.Literal("full")),
				},
				{ additionalProperties: false, $defs: document.definitions },
			),
			execute: async (args, api) => {
				try {
					const context = options.lookup(api.conversationId);
					if (!context)
						throw new Error("Orchestrator session context unavailable.");
					const request = decodeScheduling(
						schedulingRequestSchema,
						args.request,
					);
					if (
						(request.operation === "create" ||
							request.operation === "jobs.create" ||
							request.operation === "jobs.update") &&
						request.job.target.kind === "wake-up"
					) {
						if (!options.destination)
							throw new Error("Native scheduling destination unavailable.");
						const expected = await options.destination(
							api.conversationId,
							context,
						);
						const target = request.job.target;
						if (
							target.hostId !== expected.hostId ||
							target.hostSocket !== expected.hostSocket ||
							target.runId !== expected.runId ||
							target.conversationId !== expected.conversationId
						)
							throw new Error(
								"Wake-up destination differs from the calling session; use scheduling_destination.",
							);
					}
					const response = decodeScheduling(
						schedulingResponseSchema,
						await options.call(context.env, request),
					);
					return result(
						args.detail === "full" ? response : compactScheduling(response),
					);
				} catch (error) {
					return result(
						error instanceof Error
							? error.message
							: "Scheduling request failed.",
						true,
					);
				}
			},
		}),
	];
}
