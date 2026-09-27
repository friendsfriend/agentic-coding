// The classifier-routing step behaviors (classifier-driven-model-pools for
// `core.route-plan` / `core.route-apply`, classifier-driven-triage-routing for
// `core.triage-route`). Each is a system step that enqueues one `model.classify`
// effect on entry; the reducer applies the answered result before the
// effect-complete transition advances the step.
import { ROUTING_INTEGRATION, TRIAGE_INTEGRATION } from "../classifiers.ts";
import type { CompletionResult, StepBehavior } from "./types.ts";

export type RoutingPhase = "plan" | "apply";

function routingBehavior(phase: RoutingPhase): StepBehavior {
	return {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				"model.classify",
				`route:${snapshot.workflowId}:${snapshot.currentStep}:${snapshot.step.attempt}`,
				{ integration: ROUTING_INTEGRATION, phase },
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) =>
			effect.kind === "model.classify"
				? { transition: { outcome: "complete", output: effect.data } }
				: undefined,
	};
}

/** `core.triage-route`: the per-round classifier gate that decides whether
 * independent verification is needed at all and, when it is, which verifier
 * roles run. A selection hands the locked role set to `core.triage`; no
 * selection bypasses triage and runs the engine-owned full suite; a failed
 * classification completes the step with no constraint at all, so a classifier
 * outage degrades to today's unconstrained triage instead of blocking
 * verification. The `skip-verification` outcome is the verification gate's own
 * verdict: it bypasses triage AND verification as one unit and always routes
 * through `core.review-gate`, which is what keeps "skip both" reachable only
 * when the developer-review gate is automatic too. */
const triageRouteBehavior: StepBehavior = {
	onEnter: ({ snapshot, enqueue }) => {
		enqueue(
			"model.classify",
			// The step re-runs every verification round with a constant attempt of
			// 1, so the key must carry the snapshot revision: a per-attempt key
			// collides from round 2, and the outbox's `INSERT OR IGNORE` then
			// silently drops the effect, stranding the round at this system step.
			`triage:${snapshot.workflowId}:${snapshot.currentStep}:${snapshot.revision}`,
			{ integration: TRIAGE_INTEGRATION },
		);
		return undefined;
	},
	onEffectComplete: ({ effect }) =>
		effect.kind === "model.classify"
			? triageRouteCompletion(effect.data)
			: undefined,
};

/** Always transitions: an unrecognized result degrades to an unconstrained
 * `core.triage` rather than parking the round at a system step that has no run
 * and no pending effect. A payload that is not a triage classification at all is
 * an outage, not a verdict, so it must not be read as an answer of zero roles:
 * `empty` is reserved for a real selection that came back empty, because
 * bypassing triage on an outage would silently reduce the round. */
function triageRouteCompletion(data: unknown): CompletionResult | undefined {
	const result = data as
		| {
				integration?: unknown;
				failOpen?: unknown;
				roles?: unknown;
				gate?: { decision?: unknown } | undefined;
		  }
		| undefined;
	if (result?.integration !== TRIAGE_INTEGRATION)
		return { transition: { outcome: "complete" } };
	// The verification gate resolves first and unconditionally: only an
	// explicit skip verdict bypasses the round. A fail-open or unusable gate
	// answer leaves the verdict at "run" and falls through to the ordinary
	// role resolution below, so a classifier outage can never skip a stage.
	if (result.gate?.decision === "skip")
		return { transition: { outcome: "skip-verification" } };
	// A fail-open result carries no role constraint, so the transition carries
	// no output and `core.triage` validates against the full eligible catalog.
	if (result.failOpen === true) return { transition: { outcome: "complete" } };
	const roles = Array.isArray(result.roles)
		? result.roles.filter((role): role is string => typeof role === "string")
		: [];
	return roles.length
		? { transition: { outcome: "complete", output: { roles } } }
		: { transition: { outcome: "empty", output: { roles: [] } } };
}

export const routingBehaviors: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		"core.route-plan": routingBehavior("plan"),
		"core.route-apply": routingBehavior("apply"),
		"core.triage-route": triageRouteBehavior,
	});
