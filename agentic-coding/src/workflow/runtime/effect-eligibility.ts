// Pure lifecycle decisions shared by action exposure, transactional retry and
// effect validation. A failed effect is history, not authority to revive a run.
import type {
	WorkflowEffect,
	WorkflowRun,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { DEBUG_ROLE } from "../steps/debug.ts";
import { DEBUG_INVESTIGATE_STEP } from "./debug-requests.ts";

export type EffectEligibility =
	| { eligible: true }
	| { eligible: false; reason: string };
const eligible: EffectEligibility = { eligible: true };

export function effectCancelled(
	effect: Pick<WorkflowEffect, "payload">,
): boolean {
	const payload = effect.payload;
	return Boolean(
		payload &&
			typeof payload === "object" &&
			!Array.isArray(payload) &&
			(payload.cancelRequested === true || payload.cancelRequested === 1),
	);
}

export function effectEligibility(
	effect: Pick<WorkflowEffect, "kind" | "payload" | "workflowId">,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	runs: readonly WorkflowRun[],
	registry: WorkflowRegistry,
): EffectEligibility {
	const refuse = (reason: string): EffectEligibility => ({
		eligible: false,
		reason,
	});
	if (effect.workflowId !== snapshot.workflowId)
		return refuse("effect belongs to another workflow");
	const payload =
		effect.payload &&
		typeof effect.payload === "object" &&
		!Array.isArray(effect.payload)
			? effect.payload
			: {};
	const runBound = [
		"artifact.write",
		"agent.launch",
		"agent.prompt",
		"agent.stop",
	].includes(effect.kind);
	const run = runBound
		? runs.find(
				(item) =>
					item.id === payload.runId && item.workflowId === snapshot.workflowId,
			)
		: undefined;
	if (runBound && !run) return refuse("effect run is missing");
	if (run) {
		if (effect.kind === "agent.stop" || effectCancelled(effect))
			return eligible;
		// Addressed consult delivery survives replacement; its handler checks
		// the addressed question again and may no-op without reviving the run.
		if (
			effect.kind === "agent.prompt" &&
			typeof payload.questionId === "string" &&
			snapshot.developerDialogue.some(
				(item) => item.id === payload.questionId && item.targetRunId === run.id,
			)
		)
			return eligible;
		if (!["pending", "working"].includes(run.status))
			return refuse(`effect run is ${run.status}; it cannot be revived`);
		if (
			effect.kind === "agent.launch" &&
			run.role === DEBUG_ROLE &&
			run.stepId === DEBUG_INVESTIGATE_STEP &&
			!definition.steps.includes(run.stepId) &&
			run.generation === 1 &&
			run.attempt === 1 &&
			typeof payload.debugRequestId === "string"
		)
			return eligible;
	}
	const independent = [
		"agent.stop",
		"environment.teardown",
		"environment.setup-cleanup",
		"debug.request.run",
		"debug.request.deliver",
	].includes(effect.kind);
	const setup =
		effect.kind === "workspace.setup" &&
		((snapshot.currentStep === definition.initial &&
			!snapshot.step.activeRunIds.length) ||
			(snapshot.definition.id === "research" &&
				snapshot.currentStep === "core.research"));
	if (
		!independent &&
		!setup &&
		!registry
			.stepForDefinition(definition, snapshot.currentStep)
			.allowedEffects.includes(effect.kind) &&
		!definition.edges.some(
			(edge) =>
				edge.to === snapshot.currentStep &&
				(edge.effects ?? []).some((item) => item.kind === effect.kind),
		)
	)
		return refuse(
			`effect ${effect.kind} is illegal at ${snapshot.currentStep}`,
		);
	if (!run) return eligible;
	if (run.generation !== snapshot.step.attempt)
		return refuse("effect run belongs to an obsolete generation");
	if (run.stepId !== snapshot.currentStep)
		return refuse("effect run belongs to another step");
	if (run.attempt !== snapshot.step.attempt)
		return refuse("effect run belongs to an obsolete attempt");
	if (!snapshot.step.activeRunIds.includes(run.id))
		return refuse("effect run is superseded");
	return eligible;
}

export function effectRetryEligibility(
	effect: WorkflowEffect,
	snapshot: WorkflowSnapshot,
	definition: CompiledWorkflowDefinition,
	runs: readonly WorkflowRun[],
	registry: WorkflowRegistry,
): EffectEligibility {
	if (effect.status !== "failed")
		return { eligible: false, reason: "only failed effects can be retried" };
	if (effectCancelled(effect))
		return {
			eligible: false,
			reason: "cancelled effect requires cleanup, not retry",
		};
	return effectEligibility(effect, snapshot, definition, runs, registry);
}
