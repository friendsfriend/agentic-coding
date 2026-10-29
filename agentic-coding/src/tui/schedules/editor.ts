// Pure form projection. The authenticated server remains validation/authority.
import type { FormField, FormValues } from "@agentic-coding/ui";
import {
	decodeScheduling,
	type Job,
	type Schedule,
} from "../../contracts/scheduling.ts";
import {
	type SchedulingRequest,
	schedulingRequestSchema,
} from "../../contracts/scheduling-api.ts";
export type EditorMode = "create" | "schedule-edit" | "job-edit" | "job-create";
export interface EditorBasis {
	mode: EditorMode;
	requestId: string;
	job?: Job;
	schedule?: Schedule;
	affectedSchedules?: readonly string[];
}
const text = (key: string, label: string, hint?: string): FormField => ({
	key,
	label,
	kind: "text",
	...(hint ? { hint } : {}),
});
const select = (
	key: string,
	label: string,
	options: readonly string[],
	hint?: string,
): FormField => ({
	key,
	label,
	kind: "select",
	options,
	...(hint ? { hint } : {}),
});
export function schedulingDraft(basis: EditorBasis, now: number): FormValues {
	const job = basis.job,
		schedule = basis.schedule,
		target = job?.target;
	const values: FormValues = {
		jobId: schedule?.jobId ?? "new",
		jobName: job?.name ?? "",
		scheduleName: schedule?.name ?? "",
		task: job?.task ?? "",
		originalInstruction: job?.originalInstruction ?? "",
		reason: job?.reason ?? "User-scheduled task",
		references: job?.references.join("\n") ?? "",
		reportingDestination: job?.reportingDestination ?? "transcript",
		target: target?.kind ?? "wake-up",
		timezone: schedule?.timing.timezone ?? "UTC",
		timing: "delay",
		delay: "60",
		delayUnit: "minutes",
		at: new Date(now + 3600000).toISOString(),
		local: "",
		fold: "choose",
		every: "60",
		everyUnit: "minutes",
		anchor: new Date(now + 3600000).toISOString(),
		weekdays: "1,2,3,4,5",
		hour: "9",
		minute: "0",
		late: schedule?.latePolicy.kind ?? "run-late",
		grace:
			schedule?.latePolicy.kind === "expire-after"
				? String(schedule.latePolicy.graceMs)
				: "3600000",
		repository: "",
		model: "",
		thinking: "",
		policy: "read-only",
		review: "none",
		baseBranch: "main",
		workflowType: "",
		preset: "default",
		mode: "worktree",
		sourceBranch: "",
		targetBranch: "",
		app: "",
		stage: "",
		hostId: "",
		hostSocket: "",
		conversationId: "",
		runId: "",
	};
	if (target?.kind === "wake-up")
		Object.assign(values, {
			hostId: target.hostId,
			hostSocket: target.hostSocket,
			conversationId: target.conversationId,
			runId: target.runId,
		});
	if (target?.kind === "standalone")
		Object.assign(values, {
			repository: target.repository,
			model: target.model,
			thinking: target.thinking ?? "",
			policy: target.policy,
			review: target.reviewPolicy,
			baseBranch: target.baseBranch,
		});
	if (target?.kind === "workflow")
		Object.assign(values, {
			repository: target.repository,
			workflowType: target.workflowType,
			preset: target.preset,
			mode: target.mode,
			sourceBranch: target.sourceBranch ?? "",
			targetBranch: target.targetBranch ?? "",
			app: target.app ?? "",
			stage: target.stage ?? "",
		});
	const timing = schedule?.timing;
	if (timing) {
		values.timing = timing.kind;
		if (timing.kind === "once") values.at = timing.at;
		if (timing.kind === "interval")
			Object.assign(values, {
				every: String(timing.everyMs),
				everyUnit: "milliseconds",
				anchor: timing.anchor,
			});
		if (timing.kind === "calendar")
			Object.assign(values, {
				weekdays: timing.weekdays.join(","),
				hour: String(timing.hour),
				minute: String(timing.minute),
			});
	}
	return values;
}
export function schedulingFields(
	values: FormValues,
	mode: EditorMode,
	jobs: readonly Job[],
): FormField[] {
	const fields: FormField[] = [];
	const editsJob =
		mode === "job-edit" ||
		mode === "job-create" ||
		(mode === "create" && values.jobId === "new");
	const editsSchedule = mode === "create" || mode === "schedule-edit";
	if (editsSchedule) {
		fields.push(text("scheduleName", "Schedule name"));
		fields.push(
			select(
				"jobId",
				"Reusable job",
				[
					...(mode === "create" ? ["new"] : []),
					...jobs
						.filter((job) => job.deletedAt === undefined)
						.map((job) => job.id),
				],
				jobs.map((job) => `${job.id}: ${job.name}`).join(" · "),
			),
		);
	}
	if (editsJob) {
		fields.push(
			text("jobName", "Job name"),
			text(
				"task",
				"Self-contained task",
				"All instructions needed by a future isolated execution.",
			),
			text(
				"originalInstruction",
				"Original instruction",
				"Blank uses the task entered here; never a transcript excerpt.",
			),
			text("reason", "Reason"),
			text("references", "References", "One reference per line; at most 50."),
			text("reportingDestination", "Reporting destination"),
			select("target", "Execution target", [
				"wake-up",
				"standalone",
				"workflow",
			]),
		);
		if (values.target === "wake-up")
			fields.push(
				{
					key: "destination",
					label: "Current orchestrator destination",
					kind: "action",
					hint: "Explicitly initialize or reuse the current native orchestrator conversation; no model turn is submitted.",
				},
				text("hostId", "Pinned host identity"),
				text("hostSocket", "Pinned host socket"),
				text("conversationId", "Pinned conversation"),
				text("runId", "Pinned run association"),
			);
		if (values.target === "standalone")
			fields.push(
				text("repository", "Repository"),
				text("baseBranch", "Base branch"),
				text("model", "Configured provider/model"),
				text("thinking", "Thinking level (optional)"),
				select(
					"policy",
					"Execution policy",
					["read-only", "default"],
					"Read-only is automatic. Writable default policy waits for operator approval for every occurrence.",
				),
				select(
					"review",
					"Review policy",
					values.policy === "default" ? ["human"] : ["none"],
				),
			);
		if (values.target === "workflow")
			fields.push(
				text("repository", "Repository"),
				text("workflowType", "Workflow type"),
				text("preset", "Configuration preset"),
				select("mode", "Execution workspace", ["worktree", "checkout"]),
				text("sourceBranch", "Source branch (when required)"),
				text("targetBranch", "Target branch (when required)"),
				text("app", "Application (when required)"),
				text("stage", "Stage (when required)"),
			);
	}
	if (editsSchedule) {
		fields.push(
			select("timing", "Timing", [
				"delay",
				"once",
				"local-once",
				"interval",
				"calendar",
			]),
			text(
				"timezone",
				"IANA timezone",
				"Explicit zone used for previews and calendar recurrence.",
			),
		);
		switch (values.timing) {
			case "delay":
				fields.push(
					text("delay", "Delay"),
					select("delayUnit", "Delay unit", [
						"milliseconds",
						"seconds",
						"minutes",
						"hours",
						"days",
					]),
				);
				break;
			case "once":
				fields.push(
					text(
						"at",
						"Absolute instant",
						"ISO instant with UTC/offset. Existing relative once schedules retain their resolved instant.",
					),
				);
				break;
			case "local-once":
				fields.push(
					text(
						"local",
						"Local date and time",
						"ISO local date/time without an offset. Gaps are rejected.",
					),
					select(
						"fold",
						"Ambiguous local time",
						["choose", "earlier", "later"],
						"An ambiguous local time requires an explicit earlier/later choice.",
					),
				);
				break;
			case "interval":
				fields.push(
					text("every", "Elapsed interval"),
					select("everyUnit", "Interval unit", [
						"milliseconds",
						"seconds",
						"minutes",
						"hours",
						"days",
					]),
					text(
						"anchor",
						"Explicit anchor instant",
						"Intervals stay anchored; minimum interval is one minute.",
					),
				);
				break;
			case "calendar":
				fields.push(
					text(
						"weekdays",
						"ISO weekdays",
						"Comma-separated 1 (Monday) through 7 (Sunday).",
					),
					text("hour", "Local hour"),
					text("minute", "Local minute"),
				);
				break;
		}
		fields.push(
			select(
				"late",
				"Late-run policy",
				["run-late", "expire-after"],
				"Calendar gaps skip; repeated local times use the earlier fold. Active jobs never overlap.",
			),
		);
		if (values.late === "expire-after")
			fields.push(text("grace", "Expiry grace (milliseconds)"));
	}
	return fields;
}
const units: Readonly<Record<string, number>> = {
	milliseconds: 1,
	seconds: 1000,
	minutes: 60000,
	hours: 3600000,
	days: 86400000,
};
function integer(value: string | undefined, label: string): number {
	if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error(`${label} must be a nonnegative safe integer.`);
	return Number(value);
}
function duration(
	value: string | undefined,
	unit: string | undefined,
	label: string,
): number {
	const multiplier = units[unit ?? ""];
	if (!multiplier) throw new Error(`Select a ${label} unit.`);
	const result = integer(value, label) * multiplier;
	if (!Number.isSafeInteger(result))
		throw new Error(`${label} is outside the supported range.`);
	return result;
}
export function schedulingSave(
	values: FormValues,
	basis: EditorBasis,
): SchedulingRequest {
	const original = basis.job,
		target: Record<string, unknown> = { kind: values.target };
	if (values.target === "wake-up")
		Object.assign(target, {
			hostId: values.hostId,
			hostSocket: values.hostSocket,
			conversationId: values.conversationId,
			runId: values.runId,
		});
	if (values.target === "standalone")
		Object.assign(target, {
			repository: values.repository,
			model: values.model,
			...(values.thinking ? { thinking: values.thinking } : {}),
			baseBranch: values.baseBranch,
			policy: values.policy,
			reviewPolicy: values.policy === "default" ? "human" : "none",
		});
	if (values.target === "workflow") {
		Object.assign(target, {
			repository: values.repository,
			workflowType: values.workflowType,
			preset: values.preset,
			mode: values.mode,
		});
		for (const key of ["sourceBranch", "targetBranch", "app", "stage"])
			if (values[key]) target[key] = values[key];
	}
	const job = {
		name: values.jobName,
		task: values.task,
		originalInstruction: values.originalInstruction || values.task,
		reason: values.reason,
		references: (values.references ?? "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean),
		reportingDestination: values.reportingDestination,
		target,
	};
	if (basis.mode === "job-create")
		return decodeScheduling(schedulingRequestSchema, {
			operation: "jobs.create",
			requestId: basis.requestId,
			job,
		});
	if (basis.mode === "job-edit") {
		if (!original) throw new Error("Reload the reusable job before editing.");
		return decodeScheduling(schedulingRequestSchema, {
			operation: "jobs.update",
			requestId: basis.requestId,
			id: original.id,
			revision: original.revision,
			job,
			affectedSchedules: [...(basis.affectedSchedules ?? [])],
		});
	}
	const timing: Record<string, unknown> = {
		kind: values.timing,
		timezone: values.timezone,
	};
	switch (values.timing) {
		case "delay":
			timing.delayMs = duration(values.delay, values.delayUnit, "Delay");
			break;
		case "once": {
			timing.at = values.at;
			const previous = basis.schedule?.timing;
			if (
				previous?.kind === "once" &&
				previous.at === values.at &&
				previous.timezone === values.timezone &&
				previous.sourceDelayMs !== undefined
			)
				timing.sourceDelayMs = previous.sourceDelayMs;
			break;
		}
		case "local-once":
			timing.local = values.local;
			if (values.fold === "earlier" || values.fold === "later")
				timing.fold = values.fold;
			break;
		case "interval":
			timing.everyMs = duration(values.every, values.everyUnit, "Interval");
			timing.anchor = values.anchor;
			break;
		case "calendar":
			timing.weekdays = (values.weekdays ?? "")
				.split(",")
				.map((value) => integer(value.trim(), "Weekday"));
			timing.hour = integer(values.hour, "Hour");
			timing.minute = integer(values.minute, "Minute");
			break;
	}
	const schedule = {
		name: values.scheduleName,
		timing,
		latePolicy:
			values.late === "expire-after"
				? {
						kind: "expire-after",
						graceMs: integer(values.grace, "Expiry grace"),
					}
				: { kind: "run-late" },
	};
	if (basis.mode === "schedule-edit") {
		if (!basis.schedule) throw new Error("Reload the schedule before editing.");
		return decodeScheduling(schedulingRequestSchema, {
			operation: "schedules.update",
			requestId: basis.requestId,
			id: basis.schedule.id,
			revision: basis.schedule.revision,
			schedule: { ...schedule, jobId: values.jobId },
		});
	}
	if (values.jobId !== "new")
		return decodeScheduling(schedulingRequestSchema, {
			operation: "schedules.create",
			requestId: basis.requestId,
			schedule: { ...schedule, jobId: values.jobId },
		});
	return decodeScheduling(schedulingRequestSchema, {
		operation: "create",
		requestId: basis.requestId,
		job,
		schedule,
	});
}
