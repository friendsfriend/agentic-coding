// The classifier-routing step behaviors: one per-step routing step
// (classifier-driven-step-model-selection), plus the pre-per-step phase passes
// that definitions pinned to the older tiers still reach, plus
// classifier-driven-triage-routing's `core.triage-route`. Each is a system step
// that enqueues one `model.classify` effect on entry; the reducer applies the
// answered result before the effect-complete transition advances the step.
import { ROUTING_INTEGRATION, TRIAGE_INTEGRATION } from "../classifiers.ts";
import { GATE_GUARDED_STEP, gateDecisionTelemetry } from "./gates.ts";
import {
	classifierDecided,
	decideReverification,
	decisionRecord,
	reverificationRoles,
	withClassifierRoles,
} from "./reverification.ts";
import type {
	CompletionResult,
	CompletionTelemetry,
	StepBehavior,
} from "./types.ts";
import { triageRolesFor } from "./verification.ts";

export type RoutingPhase = "plan" | "apply";

/** One routing step and the classifiable step it selects a model for.
 * `phase` only labels the decision record and telemetry; the selection itself
 * is per step (classifier-driven-step-model-selection). */
export interface StepRoute {
	readonly target: string;
	readonly phase: RoutingPhase;
}

/** Every routing step, keyed by its step id. One entry per classifiable agent
 * step: the route step sits immediately before its target in the graph, so a
 * model is chosen with the state as it stands when that step is about to run,
 * and a loop that re-enters a step re-selects its model. */
export const STEP_ROUTES: Readonly<Record<string, StepRoute>> = Object.freeze({
	"core.route-plan": { target: "core.plan", phase: "plan" },
	"core.route-fusion-consolidate": {
		target: "fusion.consolidate",
		phase: "plan",
	},
	"core.route-fusion-plan": { target: "fusion.plan", phase: "plan" },
	"core.route-implementation": {
		target: "core.implementation",
		phase: "apply",
	},
	"core.route-rebase": { target: "core.rebase", phase: "apply" },
	"core.route-triage": { target: "core.triage", phase: "apply" },
	"core.route-verification": { target: "core.verification", phase: "apply" },
	"core.route-wiki": { target: "core.wiki", phase: "apply" },
	"core.route-debug": { target: "debug.investigate", phase: "apply" },
	"core.route-archive": { target: "core.archive", phase: "apply" },
	"core.route-research": { target: "core.research", phase: "apply" },
});

/** Pre-per-step routing steps that definitions pinned to an older tier still
 * reach. They are deliberately *not* part of {@link STEP_ROUTES}: a target has
 * exactly one per-step route step, and these exist only so those definitions
 * resolve a behavior and run. `core.route-apply` now selects for the one step
 * its pass most affects; an effect it already enqueued with the old
 * `{integration, phase}` payload still resolves through the runner's phase
 * fallback. */
export const LEGACY_ROUTE_STEPS: Readonly<Record<string, StepRoute>> =
	Object.freeze({
		"core.route-apply": { target: "core.implementation", phase: "apply" },
	});

/** The per-step routing step: it asks exactly one pool question, for the step
 * that follows, and always transitions to that step. A fail-open result carries
 * no answer, so the step runs with the pinned default rather than parking the
 * workflow at a system step that has no run and nothing pending. */
function stepRoutingBehavior(route: StepRoute): StepBehavior {
	return {
		// A route step is a pass-through for the edge that entered it: the arriving
		// output is what the step it precedes must receive — a triage plan carries
		// the round's locked role set and each role's scoped files, a review's
		// comments carry the revision request. `carriesOutputContext` records that
		// output as this step's context, and the completion hands the same value on
		// as the transition output, exactly as the edge delivered it before the
		// route step existed. The model answer itself is never forwarded: it is
		// consumed by the routing reducer and recorded in `classifierDecisions`.
		carriesOutputContext: true,
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				"model.classify",
				// The key carries the snapshot revision: a route step is re-entered
				// on every loop back into its target, and the outbox's
				// `INSERT OR IGNORE` would silently drop a repeated key, stranding
				// the step with no run and nothing pending.
				`route:${snapshot.workflowId}:${route.target}:${snapshot.revision}`,
				{
					integration: ROUTING_INTEGRATION,
					phase: route.phase,
					stepId: route.target,
				},
			);
			return undefined;
		},
		onEffectComplete: ({ snapshot, effect }) =>
			effect.kind === "model.classify"
				? {
						transition: {
							outcome: "complete",
							output: snapshot.step.context,
						},
					}
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
	onEffectComplete: (ctx) =>
		ctx.effect.kind === "model.classify"
			? triageRouteCompletion(ctx, ctx.effect.data)
			: undefined,
};

/** Always transitions: an unrecognized result degrades to an unconstrained
 * `core.triage` rather than parking the round at a system step that has no run
 * and no pending effect. A payload that is not a triage classification at all is
 * an outage, not a verdict, so it must not be read as an answer of zero roles:
 * `empty` is reserved for a real selection that came back empty, because
 * bypassing triage on an outage would silently reduce the round. */
function triageRouteCompletion(
	ctx: Parameters<NonNullable<StepBehavior["onEffectComplete"]>>[0],
	data: unknown,
): CompletionResult | undefined {
	const snapshot = ctx.snapshot;
	const eligible = triageRolesFor(ctx.definitionId, ctx.traits);
	// `core.verification`'s arrival increments the round counter, so the counter
	// still holds the last completed round while this round's decision is taken.
	const completedRound = snapshot.loopCounts["core.verification:round"] ?? 0;
	const openingRound = completedRound + 1;
	// The scope decision (role-scoped re-verification) is computed before the
	// classifier is read: it depends on the previous round's plan, the fix delta
	// the runtime measured, and nothing the classifier answered — which is why a
	// classifier outage keeps a scoped round's role set instead of widening it.
	const scope = decideReverification({
		eligibleRoles: eligible,
		round: completedRound,
		record: snapshot.verificationScope,
		threshold: snapshot.verificationScope?.delta?.threshold,
	});
	const result = data as
		| {
				integration?: unknown;
				failOpen?: unknown;
				reason?: unknown;
				roles?: unknown;
				gate?: { decision?: unknown } | undefined;
		  }
		| undefined;
	const answered =
		result?.integration === TRIAGE_INTEGRATION ? result : undefined;
	const answeredRoles =
		answered === undefined
			? undefined
			: Array.isArray(answered.roles)
				? answered.roles.filter(
						(role): role is string => typeof role === "string",
					)
				: undefined;
	// A fail-open round carries no selection at all — the unconstrained triage
	// agent chooses — so its record reports the mode and the reason and no
	// per-role reason that has not happened yet.
	const decision =
		answered === undefined || answered.failOpen === true
			? scope
			: withClassifierRoles(scope, eligible, answeredRoles ?? []);
	const completed = (
		completion: CompletionResult,
		plan?: CompletionTelemetry,
	): CompletionResult => {
		const telemetry = [
			gateDecisionTelemetry(answered?.gate),
			scopeTelemetry(decision, openingRound),
			plan,
		].filter((item): item is CompletionTelemetry => item !== undefined);
		return {
			...completion,
			attention: [
				...(completion.attention ?? []),
				// An engine-scoped round that continues without the classifier is
				// smaller than the round today's path would have run, so it stays
				// audible.
				...(answered === undefined && !classifierDecided(decision)
					? [
							`verifier role classification unavailable; verification round ${openingRound} continued with the engine-scoped role set (${decision.mode}: ${decision.reason})`,
						]
					: []),
			],
			telemetry,
			// The decision is persisted before the transition, so the round's own
			// triage completion can attribute the role set the engine supplied and
			// the next round can read the plan that round recorded.
			verificationScope: { decision: decisionRecord(decision, openingRound) },
		};
	};
	// The verification gate resolves first and unconditionally: only an explicit
	// skip verdict bypasses the round, and a skipped round is no round — it
	// records the gate decision and no scope.
	if (answered?.gate?.decision === "skip")
		return {
			transition: { outcome: "skip-verification" },
			telemetry: [gateDecisionTelemetry(answered.gate)].filter(
				(item): item is CompletionTelemetry => item !== undefined,
			),
		};
	// An engine-scoped round supplies the outcome's role set exactly as a
	// classifier selection does, so triage's locked-set validation, the rendered
	// step input, and the verification fan-out are all unchanged.
	if (decision.mode === "scoped")
		return completed({
			transition: {
				outcome: "complete",
				output: { roles: reverificationRoles(decision) },
			},
		});
	// A fix below the minimum changed-file count opens no domain round: the
	// routing step's own zero-role outcome bypasses triage and runs the
	// engine-owned full suite only, and an attention entry keeps it audible.
	if (decision.mode === "suite-only")
		return completed(
			{
				transition: { outcome: "empty", output: { roles: [] } },
				attention: [
					`verification round ${openingRound} runs only the engine-owned full suite: ` +
						`the fix changed ${decision.touched} file(s) in content, below the minimum of ${decision.threshold}`,
				],
			},
			{
				event: "triage.plan.selected",
				payload: {
					"herdr.triage.source": "reverification-empty",
					"herdr.triage.round": openingRound,
					"herdr.triage.roles": "",
					"herdr.triage.roles.count": 0,
					"herdr.triage.files.count": 0,
					// The measured fix size, so an operator can see why the round
					// opened no domain role: no triage step runs to record it.
					"herdr.triage.changed.count": decision.changed,
				},
			},
		);
	// A classifier-decided round keeps today's path exactly: a fail-open result
	// carries no role constraint (so triage validates against the full eligible
	// catalog) and an outage carries no verdict at all.
	if (answered === undefined || answered.failOpen === true)
		return completed({ transition: { outcome: "complete" } });
	// A round the engine left to the classifier still re-runs the roles that
	// reported the findings the fix resolved: the floor is not a scope, so a role
	// the classifier left out stays in the run set. The classifier's own roles
	// keep their order and are not filtered here — triage validates them against
	// the eligible catalog exactly as before.
	const roles = [...new Set([...(answeredRoles ?? []), ...scope.reported])];
	return roles.length
		? completed({ transition: { outcome: "complete", output: { roles } } })
		: completed(
				{ transition: { outcome: "empty", output: { roles: [] } } },
				// A zero-role verdict is a real selection that bypasses triage, so the
				// round still records which path produced its role set.
				{
					event: "triage.plan.selected",
					payload: {
						"herdr.triage.source": "empty-bypass",
						"herdr.triage.roles": "",
						"herdr.triage.roles.count": 0,
						"herdr.triage.files.count": 0,
					},
				},
			);
}

/** One `verification_scope` event per round that reaches the decision: the mode,
 * the reason, the threshold in force, the counts, and one `role=reason` pair per
 * role in the run set and in the skip set. Role names come from the registered
 * verifier catalog and reasons from a closed vocabulary, so both lists are
 * bounded by construction; no path, no file body, and no task text is exported. */
function scopeTelemetry(
	decision: ReturnType<typeof decideReverification>,
	round: number,
): CompletionTelemetry {
	const pairs = (roles: readonly { role: string; reason: string }[]) =>
		[...roles]
			.sort((left, right) => (left.role < right.role ? -1 : 1))
			.map((entry) => `${entry.role}=${entry.reason}`)
			.join(",");
	return {
		event: "verification_scope",
		payload: {
			"herdr.verification.scope.round": round,
			"herdr.verification.scope.mode": decision.mode,
			"herdr.verification.scope.reason": decision.reason,
			"herdr.verification.scope.threshold": decision.threshold,
			"herdr.verification.scope.touched.count": decision.touched,
			"herdr.verification.scope.touched.changed": decision.changed,
			"herdr.verification.scope.baseline.count": decision.baselineCount,
			"herdr.verification.scope.roles.rerun": pairs(decision.rerun),
			"herdr.verification.scope.roles.skipped": pairs(decision.skipped),
		},
	};
}

/** A step the engine inserts around a graph rather than one an author
 * composed: a per-step routing step (`core.route-*`), the triage-routing step,
 * or a stage gate. It is the one place the vocabulary lives, so the blueprint
 * compiler (which refuses to let an author place one) and the read model
 * (which marks them in the graph dialog) cannot disagree about what is
 * machinery and what is a logical step. */
export function isInsertedStep(id: string): boolean {
	return (
		id.startsWith("core.route-") ||
		id === "core.triage-route" ||
		GATE_GUARDED_STEP[id] !== undefined
	);
}

export const routingBehaviors: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		// One behavior per route step, reading its target from the catalog.
		// Behaviors are keyed by step id, so a versioned step definition and a
		// legacy phase pass share the one registration here.
		...Object.fromEntries(
			[
				...Object.entries(STEP_ROUTES),
				...Object.entries(LEGACY_ROUTE_STEPS),
			].map(([id, route]) => [id, stepRoutingBehavior(route)]),
		),
		"core.triage-route": triageRouteBehavior,
	});
