import { createHash } from "node:crypto";
import type {
	Job,
	Occurrence,
	TargetReceipt,
} from "../../contracts/scheduling.ts";
import { SchedulingError } from "../../contracts/scheduling.ts";
import type { WorkflowView } from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../workflow/contracts.ts";
import type { WorkflowEngine } from "../../workflow/runtime.ts";
import { prepareWorkflowStart } from "../../workflow/startup.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "./adapters.ts";

function prepare(job: Job, workflowId: string) {
	const target = job.target;
	if (target.kind !== "workflow")
		throw new SchedulingError("invalid-input", "Expected a workflow target.");
	return prepareWorkflowStart({
		repo: target.repository,
		workflowId,
		definitionId: target.workflowType,
		task: job.task,
		preset: target.preset,
		mode: target.mode,
		sourceBranch: target.sourceBranch,
		targetBranch: target.targetBranch,
		app: target.app,
		stage: target.stage,
		enforceHumanReviewGates: true,
		startedBy: "orchestrator",
	});
}
function owner(value: Occurrence) {
	return {
		occurrenceId: value.id,
		contentDigest: createHash("sha256")
			.update(JSON.stringify(value.job))
			.digest("hex"),
	};
}
function receipt(
	value: Occurrence,
	repository: string,
	workflowId: string,
	view?: WorkflowView,
): TargetReceipt {
	const state = !view
		? "reserved"
		: view.status === "completed"
			? "succeeded"
			: view.status === "closed"
				? view.runs.some((run) => run.status === "failed")
					? "execution-failed"
					: "succeeded"
				: view.waiting ||
						view.status === "paused" ||
						view.status === "attention-required"
					? "waiting-review"
					: "running";
	return {
		id: value.id,
		digest: owner(value).contentDigest,
		state,
		workflow: { repository, workflowId },
		result: `workflow:${workflowId}`,
	};
}
function classify(error: unknown): never {
	if (error instanceof WorkflowRuntimeError) {
		if (error.code === "not-found")
			throw new SchedulingDestinationUnavailable(
				"Pinned native workflow reservation/instance unavailable.",
			);
		if (error.code === "unavailable")
			throw new SchedulingInfrastructureError(
				"Native workflow store temporarily unavailable.",
			);
	}
	throw error;
}
/** All runnable work still enters native engine start/outbox and the normal execution driver. */
export function workflowAdapter(
	engine: () => WorkflowEngine,
	requestExecution: (repository: string, workflowId: string) => void,
): SchedulingTargetAdapter {
	return {
		async resolve(job) {
			prepare(job, `schedule-validation-${job.id}`);
			return job;
		},
		async reserve(value) {
			try {
				const prepared = prepare(value.job, `schedule-${value.id}`);
				const reservation = engine().reserveScheduled(
					prepared.input,
					owner(value),
				);
				return receipt(value, prepared.target, reservation.workflowId);
			} catch (error) {
				return classify(error);
			}
		},
		async activate(value) {
			if (value.admittedAt === undefined || !value.receipt?.workflow)
				throw new SchedulingError(
					"conflict",
					"Native workflow activation requires durable scheduling authority and receipt.",
				);
			const target = value.receipt.workflow;
			try {
				const result = engine().activateScheduled(target.repository, {
					...owner(value),
					admittedAt: value.admittedAt,
					fence: value.fence,
				});
				requestExecution(target.repository, target.workflowId);
				return receipt(
					value,
					target.repository,
					target.workflowId,
					result.view,
				);
			} catch (error) {
				return classify(error);
			}
		},
		async query(value) {
			const target = value.receipt?.workflow;
			if (!target)
				throw new SchedulingError(
					"conflict",
					"Pinned native workflow receipt required.",
				);
			try {
				const runtime = engine();
				const result = runtime.queryScheduled(target.repository, owner(value));
				if (result.reservation.workflowId !== target.workflowId)
					throw new SchedulingError(
						"conflict",
						"Native workflow target mismatch.",
					);
				const view = result.snapshot
					? runtime.status(target.repository, target.workflowId)
					: undefined;
				return receipt(value, target.repository, target.workflowId, view);
			} catch (error) {
				return classify(error);
			}
		},
	};
}
