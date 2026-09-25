// The `effect.result` reducer: applies an effect-runner outcome to its
// outbox row and delegates step-owned effect completion decisions to the
// registered behavior. Workspace setup/close and cleanup remain runtime-wide
// lifecycle mechanics.
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { classifierFor } from "../../classifiers.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { loadConfigWithProvenance } from "../../effects.ts";
import {
	categoryProfile,
	enforceReadOnlySteps,
	parseAgentsConfig,
	preflightProfile,
	resolvePreset,
	resolveRouting,
	rolesByStepFromRouting,
} from "../../profiles.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../../registry.ts";
import { applyCompletionResult, enqueue, enterStep } from "../kernel.ts";
import { boundedError, type EffectRow, json, nowIso } from "../store.ts";

/** Rewrite the pinned routing so the classifier integration's target route
 * uses the profile mapped from the answered category. Failures are surfaced
 * as attention and leave the existing (default) route in place rather than
 * stranding the workflow after the classifying effect already completed. */
export function applyClassifierRouting(
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	registry: WorkflowRegistry,
	data: unknown,
): void {
	try {
		const payload =
			data && typeof data === "object"
				? (data as { integration?: unknown; category?: unknown })
				: {};
		if (typeof payload.category !== "string")
			throw new Error("classifier result is missing a category");
		const integration = classifierFor(String(payload.integration ?? ""));
		const loaded = loadConfigWithProvenance({
			repository: snapshot.metadata.repository || undefined,
			repositoryIndependent: !snapshot.metadata.repository,
		});
		const agents = parseAgentsConfig(loaded.config.agents, loaded.config);
		const preset = snapshot.metadata.selectedPreset
			? resolvePreset(agents, snapshot.metadata.selectedPreset)
			: undefined;
		const profileName = categoryProfile(preset, payload.category);
		if (!profileName)
			throw new Error(
				`classifier ${integration.id} chose ${payload.category} with no configured profile`,
			);
		const routing = enforceReadOnlySteps(
			resolveRouting(
				definition,
				rolesByStepFromRouting(snapshot.routing),
				agents,
				preset,
				{
					stepId: integration.target.stepId,
					...(integration.target.role ? { role: integration.target.role } : {}),
					profileName,
				},
			),
			(stepId) => registry.stepForDefinition(definition, stepId).requirements,
		);
		const route = routing.routes.find(
			(item) =>
				item.stepId === integration.target.stepId &&
				(integration.target.role === undefined ||
					item.role === integration.target.role),
		);
		if (route)
			preflightProfile(
				route.profile,
				registry.stepForDefinition(definition, integration.target.stepId)
					.requirements,
			);
		snapshot.routing = routing;
	} catch (error) {
		snapshot.attention = [
			...(snapshot.attention ?? []),
			`classifier routing update failed: ${boundedError(error)}`,
		];
	}
}

export function effectResult(
	db: Database,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	command: Extract<WorkflowCommand, { type: "effect.result" }>,
	registry: WorkflowRegistry,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_outbox WHERE id=?")
		.get(command.effectId) as EffectRow | null;
	if (
		!row ||
		row.workflow_id !== snapshot.workflowId ||
		row.status !== "running" ||
		row.lease !== command.lease ||
		Date.parse(row.lease_expires_at ?? "") <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"stale-effect",
			"effect lease is invalid or expired",
		);
	if (command.outcome === "complete") {
		db.query(
			"UPDATE workflow_outbox SET status='completed', lease=NULL, lease_expires_at=NULL WHERE id=?",
		).run(row.id);
		if (row.kind === "agent.launch") {
			const runId = String(
				(JSON.parse(row.payload_json) as { runId?: string }).runId ?? "",
			);
			if (runId && command.data && typeof command.data === "object")
				db.query(
					"UPDATE workflow_runs SET handle_json=?, status='working' WHERE id=? AND status IN ('pending','working')",
				).run(json(command.data), runId);
		}
		if (row.kind === "agent.prompt") {
			// A delivered peer prompt reports the hash of the nonce it minted; the
			// raw nonce only ever reached the addressed live session.
			const payload = JSON.parse(row.payload_json) as {
				questionId?: unknown;
			};
			const data =
				command.data && typeof command.data === "object"
					? (command.data as { answerNonceHash?: unknown })
					: {};
			if (
				typeof payload.questionId === "string" &&
				typeof data.answerNonceHash === "string"
			) {
				const question = snapshot.developerDialogue.find(
					(item) =>
						item.id === payload.questionId &&
						item.targetRunId !== undefined &&
						item.status === "pending",
				);
				if (question) question.answerNonceHash = data.answerNonceHash;
			}
		}
	} else if (command.outcome === "retry" && row.attempts < row.max_attempts) {
		const next = new Date(
			now().getTime() + Math.min(60_000, 1000 * 2 ** row.attempts),
		).toISOString();
		db.query(
			"UPDATE workflow_outbox SET status='retry', lease=NULL, lease_expires_at=NULL, next_attempt_at=?, last_error=? WHERE id=?",
		).run(next, boundedError(command.data), row.id);
	} else {
		db.query(
			"UPDATE workflow_outbox SET status='failed', lease=NULL, lease_expires_at=NULL, last_error=? WHERE id=?",
		).run(boundedError(command.data), row.id);
		// A failed peer-question prompt must resolve its dialogue record rather
		// than brick the whole workflow: the asking agent gets a bounded expired
		// answer and the workflow keeps running.
		const payload = JSON.parse(row.payload_json) as { questionId?: unknown };
		const peerQuestion =
			row.kind === "agent.prompt" && typeof payload.questionId === "string"
				? snapshot.developerDialogue.find(
						(item) =>
							item.id === payload.questionId &&
							item.status === "pending" &&
							item.targetRunId !== undefined,
					)
				: undefined;
		if (peerQuestion) {
			peerQuestion.status = "expired";
			peerQuestion.answeredAt = nowIso(now);
			peerQuestion.answer = { kind: "cancel" };
		} else {
			snapshot.status = "attention-required";
			snapshot.attention = [
				`effect ${row.kind} failed: ${boundedError(command.data)}`,
			];
		}
	}
	if (command.outcome === "complete" && row.kind === "workspace.setup") {
		const data =
			command.data && typeof command.data === "object"
				? (command.data as Record<string, unknown>)
				: {};
		if (typeof data.worktree === "string") {
			const candidate = path.resolve(data.worktree);
			const allowed = new Set<string>([
				path.resolve(snapshot.metadata.worktree),
			]);
			if (snapshot.metadata.repository) {
				allowed.add(path.resolve(snapshot.metadata.repository));
				const listed = Bun.spawnSync(
					[
						"git",
						"-C",
						snapshot.metadata.repository,
						"worktree",
						"list",
						"--porcelain",
					],
					{ stdout: "pipe", stderr: "ignore" },
				);
				for (const line of listed.stdout.toString().split("\n"))
					if (line.startsWith("worktree "))
						allowed.add(path.resolve(line.slice(9)));
			}
			const candidateReal = fs.realpathSync(candidate);
			const allowedReal = [...allowed].some((item) => {
				try {
					return fs.realpathSync(item) === candidateReal;
				} catch {
					return path.resolve(item) === candidate;
				}
			});
			if (!allowedReal)
				throw new WorkflowRuntimeError(
					"source-isolation",
					"workspace setup returned an unregistered worktree",
				);
			snapshot.metadata.worktree = candidateReal;
		}
		if (typeof data.workspace === "string")
			snapshot.metadata.workspace = data.workspace;
		if (typeof data.branch === "string") snapshot.metadata.branch = data.branch;
		enterStep(db, snapshot, definition, registry, now);
	}
	if (command.outcome === "complete" && row.kind === "model.classify")
		applyClassifierRouting(snapshot, definition, registry, command.data);
	if (command.outcome === "complete") {
		const step = registry.stepForDefinition(definition, snapshot.currentStep);
		const completion = step.behavior?.onEffectComplete?.({
			snapshot: structuredClone(snapshot),
			effect: {
				kind: row.kind,
				payload: JSON.parse(row.payload_json),
				data: command.data,
			},
		});
		applyCompletionResult(
			db,
			snapshot,
			definition,
			step,
			completion,
			registry,
			now,
		);
	}
	if (command.outcome === "complete" && row.kind === "workspace.close")
		enqueue(
			db,
			snapshot,
			"workspace.cleanup",
			`workspace:${snapshot.workflowId}:cleanup`,
			{ workflowId: snapshot.workflowId },
		);
	return {
		type: "effect.result",
		actor: { kind: "system", effectId: row.id },
		data: { outcome: command.outcome },
	};
}
