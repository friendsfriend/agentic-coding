import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SchedulingStore } from "../src/server/scheduling/store.ts";
import {
	schedulingDraft,
	schedulingFields,
	schedulingSave,
} from "../src/tui/schedules/editor.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-editor-"));
	roots.push(root);
	return SchedulingStore.open(path.join(root, "scheduling"));
}
const target = {
	kind: "wake-up" as const,
	hostId: "host",
	hostSocket: "/fixture",
	conversationId: "conversation",
	runId: "orchestrator",
};
const input = {
	name: "Reusable",
	task: "Report a complete result",
	originalInstruction: "Report a complete result",
	reason: "Follow-up",
	references: [],
	reportingDestination: "transcript",
	target,
};
function draft() {
	const basis = { mode: "create" as const, requestId: "form-create" },
		values = schedulingDraft(basis, 0);
	Object.assign(values, {
		jobName: "Follow-up",
		scheduleName: "Later",
		task: "Report the result",
		...target,
	});
	values.target = "wake-up";
	return { basis, values };
}

test("manual creation serializes relative and local timing through the shared contract", () => {
	const { basis, values } = draft();
	const request = schedulingSave(values, basis);
	expect(request.operation).toBe("create");
	if (request.operation !== "create")
		throw new Error("Expected combined creation");
	expect(request.schedule.timing).toEqual({
		kind: "delay",
		delayMs: 3600000,
		timezone: "UTC",
	});
	expect(request.job.originalInstruction).toBe("Report the result");
	values.timing = "local-once";
	values.timezone = "Europe/Berlin";
	values.local = "2030-10-27T02:30";
	values.fold = "later";
	const local = schedulingSave(values, basis);
	if (local.operation !== "create")
		throw new Error("Expected combined creation");
	expect(local.schedule.timing).toEqual({
		kind: "local-once",
		local: values.local,
		timezone: "Europe/Berlin",
		fold: "later",
	});
	values.timing = "calendar";
	values.weekdays = "1,3,7";
	const calendar = schedulingSave(values, basis);
	if (calendar.operation !== "create")
		throw new Error("Expected combined creation");
	expect(calendar.schedule.timing).toEqual({
		kind: "calendar",
		weekdays: [1, 3, 7],
		hour: 9,
		minute: 0,
		timezone: "Europe/Berlin",
	});
});

test("manual forms expose every target and writable standalone requires human review", () => {
	const { basis, values } = draft();
	values.target = "standalone";
	values.repository = "/repository";
	values.model = "fixture/model";
	values.policy = "default";
	const request = schedulingSave(values, basis);
	if (request.operation !== "create")
		throw new Error("Expected combined creation");
	expect(request.job.target).toEqual({
		kind: "standalone",
		repository: "/repository",
		model: "fixture/model",
		baseBranch: "main",
		policy: "default",
		reviewPolicy: "human",
	});
	expect(
		schedulingFields(values, "create", []).map((field) => field.key),
	).toContain("model");
	values.target = "workflow";
	values.workflowType = "feature";
	values.sourceBranch = "main";
	values.targetBranch = "feature/scheduled";
	values.app = "app";
	values.stage = "test";
	const workflow = schedulingSave(values, basis);
	if (workflow.operation !== "create")
		throw new Error("Expected combined creation");
	expect(workflow.job.target).toEqual({
		kind: "workflow",
		repository: "/repository",
		workflowType: "feature",
		preset: "default",
		mode: "worktree",
		sourceBranch: "main",
		targetBranch: "feature/scheduled",
		app: "app",
		stage: "test",
	});
	expect(
		schedulingFields(values, "create", []).map((field) => field.key),
	).toContain("preset");
});

test("editing preserves exact interval anchors and revisions instead of rounding milliseconds", () => {
	const store = fixture();
	try {
		const job = store.createJob(input, 0),
			schedule = store.createSchedule(
				{
					jobId: job.id,
					name: "Precise",
					timing: {
						kind: "interval",
						everyMs: 90001,
						anchor: "2030-01-01T00:00:00Z",
						timezone: "UTC",
					},
					latePolicy: { kind: "run-late" },
				},
				0,
			);
		const basis = {
				mode: "schedule-edit" as const,
				requestId: "edit-interval",
				job,
				schedule,
			},
			values = schedulingDraft(basis, 10000);
		values.scheduleName = "Renamed";
		const request = schedulingSave(values, basis);
		if (request.operation !== "schedules.update")
			throw new Error("Expected schedule update");
		expect(request.revision).toBe(schedule.revision);
		expect(request.schedule.timing).toEqual(schedule.timing);
		expect(request.schedule.jobId).toBe(job.id);
	} finally {
		store.close();
	}
});

test("resolved relative once edits retain the instant and provenance", () => {
	const store = fixture();
	try {
		const job = store.createJob(input, 0),
			schedule = store.createSchedule(
				{
					jobId: job.id,
					name: "Once",
					timing: {
						kind: "once",
						at: "2030-01-01T00:00:00Z",
						sourceDelayMs: 3600000,
						timezone: "UTC",
					},
					latePolicy: { kind: "run-late" },
				},
				0,
			);
		const basis = {
				mode: "schedule-edit" as const,
				requestId: "edit-once",
				job,
				schedule,
			},
			values = schedulingDraft(basis, 10000000);
		const request = schedulingSave(values, basis);
		if (request.operation !== "schedules.update")
			throw new Error("Expected schedule update");
		expect(request.schedule.timing).toEqual(schedule.timing);
	} finally {
		store.close();
	}
});

test("reusable-job editing preserves metadata and explicit affected-schedule confirmation", () => {
	const store = fixture();
	try {
		const job = store.createJob(input, 0),
			basis = {
				mode: "job-edit" as const,
				requestId: "edit-job",
				job,
				affectedSchedules: ["schedule-a", "schedule-b"],
			};
		const values = schedulingDraft(basis, 0);
		values.task = "An updated self-contained task";
		const request = schedulingSave(values, basis);
		if (request.operation !== "jobs.update")
			throw new Error("Expected job update");
		expect(request.id).toBe(job.id);
		expect(request.revision).toBe(job.revision);
		expect(request.affectedSchedules).toEqual(basis.affectedSchedules);
		expect(request.job.originalInstruction).toBe(input.originalInstruction);
		expect(request.job.target).toEqual(target);
		const create = schedulingSave(values, {
			mode: "job-create",
			requestId: "new-job",
		});
		expect(create.operation).toBe("jobs.create");
	} finally {
		store.close();
	}
});

test("reusing a job does not require or duplicate new-job fields and malformed numeric drafts fail closed", () => {
	const { basis, values } = draft();
	values.jobId = "existing-job";
	values.jobName = "";
	values.task = "";
	const request = schedulingSave(values, basis);
	expect(request.operation).toBe("schedules.create");
	if (request.operation !== "schedules.create")
		throw new Error("Expected schedule-only creation");
	expect(request.schedule.jobId).toBe("existing-job");
	expect(
		schedulingFields(values, "create", []).map((field) => field.key),
	).not.toContain("task");
	values.delay = "1.5";
	expect(() => schedulingSave(values, basis)).toThrow("integer");
	values.delay = "9007199254740991";
	values.delayUnit = "days";
	expect(() => schedulingSave(values, basis)).toThrow("supported range");
});
