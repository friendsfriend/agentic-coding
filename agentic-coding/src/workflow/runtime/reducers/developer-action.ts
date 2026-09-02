// The `developer.action` reducer: the shared entry point for every
// dashboard/CLI action id (answer-question, retry-effect:*, re-pin,
// close-research, research-follow-up, resume, create-pr, review-comments,
// reject-plan, and the plain approve/close/comments transitions). Moved
// verbatim out of runtime.ts's `reduce()` dispatch
// (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type { WorkflowCommand, WorkflowSnapshot } from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { answerQuestion } from "../dialogue.ts";
import { validateSourceBaseline } from "../evidence.ts";
import {
	enqueue,
	enterStep,
	expireRuns,
	freshStep,
	transition,
} from "../kernel.ts";
import {
	ACTIVE_RUN,
	actions,
	nowIso,
	requireRevision,
	runs,
	validateStructure,
} from "../store.ts";

export function developerAction(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "developer.action" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	requireRevision(snapshot, command.revision);
	if (command.actionId === "answer-question")
		return answerQuestion(snapshot, command.input, now);
	if (command.actionId.startsWith("retry-effect:")) {
		const id = command.actionId.slice(13);
		const row = db
			.query("SELECT status FROM workflow_outbox WHERE id=? AND workflow_id=?")
			.get(id, snapshot.workflowId) as { status: string } | null;
		if (row?.status !== "failed")
			throw new WorkflowRuntimeError(
				"unavailable",
				`retry unavailable: ${command.actionId}`,
				snapshot.revision,
			);
		db.query(
			"UPDATE workflow_outbox SET status='retry', next_attempt_at=NULL, last_error=NULL WHERE id=? AND workflow_id=? AND status='failed'",
		).run(id, snapshot.workflowId);
		snapshot.status = "active";
		snapshot.attention = [];
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	if (command.actionId === "re-pin") {
		requireRevision(snapshot, command.revision);
		const runList = runs(db, snapshot.workflowId);
		validateStructure(snapshot, definition, runList, registry);
		const previous = snapshot.definition.digest;
		snapshot.definition = { ...snapshot.definition, digest: definition.digest };
		snapshot.repinned = { fromDigest: previous, at: nowIso(now) };
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: "re-pin" },
		};
	}
	const action = actions(snapshot, registry).find(
		(item) => item.id === command.actionId,
	);
	if (!action)
		throw new WorkflowRuntimeError(
			"unavailable",
			`action unavailable: ${command.actionId}`,
			snapshot.revision,
		);
	if (command.actionId === "close-research") {
		if (
			snapshot.definition.id !== "research" ||
			snapshot.currentStep !== "core.research"
		)
			throw new WorkflowRuntimeError(
				"unavailable",
				"close-research is only available while research is purely conversational (core.research)",
			);
		validateSourceBaseline(snapshot);
		const active = runs(db, snapshot.workflowId).filter((run) =>
			snapshot.step.activeRunIds.includes(run.id),
		);
		expireRuns(db, snapshot, now);
		for (const run of active)
			if (run.handle)
				enqueue(
					db,
					snapshot,
					"agent.stop",
					`run:${run.id}:stop:${run.generation}`,
					{
						runId: run.id,
					},
				);
		snapshot.currentStep = "core.closed";
		snapshot.metadata.stepEnteredAt = nowIso(now);
		snapshot.status = "closed";
		snapshot.step = freshStep(1);
		enterStep(db, snapshot, definition, registry, now);
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	if (command.actionId === "research-follow-up") {
		if (
			snapshot.definition.id !== "research" ||
			snapshot.currentStep !== "core.research"
		)
			throw new WorkflowRuntimeError(
				"unavailable",
				"research follow-up is only available while research is active",
			);
		const message =
			typeof command.input === "string"
				? command.input
				: command.input &&
						typeof command.input === "object" &&
						"message" in command.input
					? String((command.input as { message: unknown }).message)
					: "";
		if (!message.trim() || message.length > 8192)
			throw new WorkflowRuntimeError(
				"invalid-command",
				"research-follow-up requires a bounded message",
			);
		const run = runs(db, snapshot.workflowId).find(
			(item) =>
				snapshot.step.activeRunIds.includes(item.id) &&
				ACTIVE_RUN.has(item.status),
		);
		if (!run)
			throw new WorkflowRuntimeError(
				"unavailable",
				"researcher run is not available",
			);
		const context =
			snapshot.step.context &&
			typeof snapshot.step.context === "object" &&
			!Array.isArray(snapshot.step.context)
				? snapshot.step.context
				: {};
		const followUps =
			"followUps" in context && Array.isArray(context.followUps)
				? context.followUps.filter(
						(item): item is string => typeof item === "string",
					)
				: [];
		snapshot.step.context = {
			...context,
			followUps: [...followUps, message.trim()].slice(-50),
		};
		enqueue(
			db,
			snapshot,
			"agent.prompt",
			`run:${run.id}:prompt:${snapshot.revision + 1}`,
			{
				runId: run.id,
				message: message.trim(),
			},
		);
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	if (command.actionId === "resume") {
		if (snapshot.status !== "paused")
			throw new WorkflowRuntimeError("unavailable", "workflow is not paused");
		snapshot.status = "active";
		snapshot.attention = [];
		enterStep(db, snapshot, definition, registry, now);
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	if (command.actionId === "create-pr") {
		if (["openspec-propose", "openspec-fusion-propose"].includes(definition.id))
			throw new WorkflowRuntimeError(
				"unavailable",
				"proposal workflows do not support pull-request creation",
				snapshot.revision,
			);
		registry
			.step(snapshot.currentStep)
			.reduce(snapshot, { outcome: "create-pr" });
		enqueue(
			db,
			snapshot,
			"pull-request.create",
			`pr:${snapshot.workflowId}:create`,
			{
				workflowId: snapshot.workflowId,
			},
		);
		return {
			type: "developer.action",
			actor: { kind: "developer" },
			data: { actionId: command.actionId },
		};
	}
	if (
		(command.actionId === "approve-wiki" || command.actionId === "close") &&
		(snapshot.definition.id === "wiki" || snapshot.definition.id === "research")
	)
		validateSourceBaseline(snapshot);
	if (command.actionId === "review-comments") {
		const comments =
			command.input &&
			typeof command.input === "object" &&
			"comments" in command.input
				? (command.input as { comments: unknown }).comments
				: undefined;
		if (!Array.isArray(comments) || !comments.length || comments.length > 100)
			throw new WorkflowRuntimeError(
				"invalid-command",
				"review-comments requires bounded comments",
			);
		for (const [index, value] of comments.entries()) {
			if (
				!value ||
				typeof value !== "object" ||
				typeof (value as { comment?: unknown }).comment !== "string" ||
				!(value as { comment: string }).comment.trim() ||
				(value as { comment: string }).comment.length > 4096
			)
				throw new WorkflowRuntimeError(
					"invalid-command",
					`invalid review comment ${index}`,
				);
		}
	}
	if (command.actionId === "reject-plan") {
		const reason =
			typeof command.input === "string"
				? command.input
				: command.input &&
						typeof command.input === "object" &&
						"reason" in command.input
					? String((command.input as { reason: unknown }).reason)
					: "";
		if (!reason.trim() || reason.length > 2048)
			throw new WorkflowRuntimeError(
				"invalid-command",
				"reject-plan requires bounded reason",
			);
		command.input = { reason: reason.trim() };
	}
	const outcome =
		command.actionId === "approve-plan" ||
		command.actionId === "approve-review" ||
		command.actionId === "approve-wiki"
			? "approve"
			: command.actionId === "reject-plan"
				? "reject"
				: command.actionId === "review-comments"
					? "comments"
					: command.actionId === "close"
						? "close"
						: command.actionId === "create-pr"
							? "create-pr"
							: command.actionId;
	transition(db, snapshot, definition, outcome, command.input, registry, now);
	return {
		type: "developer.action",
		actor: { kind: "developer" },
		data: { actionId: command.actionId },
	};
}
