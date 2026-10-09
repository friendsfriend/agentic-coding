// Orchestrator that assembles the builtin step catalog and every workflow
// family's graphs into one populated `WorkflowRegistry`, across every
// verification-round count, wikiGate combination, and the manifest-policy
// tier (design D1). Moved out of definitions.ts (split-workflow-god-modules)
// — the per-family manifest construction now lives under
// `definitions/graphs/*.ts`; this file only combines and registers.
import type {
	AdapterCapability,
	EffectKind,
} from "../../contracts/workflow.ts";
import { type WorkflowManifest, WorkflowRegistry } from "../registry.ts";
import { assertStepBehaviorCoverage } from "../steps/index.ts";
import { definitionVersionForPolicy, withPerStepRouting } from "./edges.ts";
import { fusionManifests } from "./graphs/fusion.ts";
import { noOpenspecManifests } from "./graphs/no-openspec.ts";
import { openspecManifests } from "./graphs/openspec.ts";
import { rebaseManifests } from "./graphs/rebase.ts";
import { researchManifests } from "./graphs/research.ts";
import { soloManifests } from "./graphs/solo.ts";
import { verifyManifests } from "./graphs/verify.ts";
import { wikiManifests } from "./graphs/wiki.ts";
import {
	definitionVersionForBehaviorPins,
	definitionVersionForFamilyTraits,
	definitionVersionForManifestPolicy,
	definitionVersionForResearchTools,
	definitionVersionForStageGates,
	definitionVersionForStepRouting,
	definitionVersionForTriageRouting,
	withFamilyTraits,
	withFullToolResearchPolicy,
	withManifestPolicy,
} from "./manifest-policy.ts";
import { exactStepReferences, WORKFLOW_STEPS } from "./steps.ts";

const EFFECTS: EffectKind[] = [
	"workspace.setup",
	"artifact.write",
	"agent.launch",
	"agent.prompt",
	"agent.stop",
	"model.classify",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
	"environment.teardown",
];
const CAPABILITIES: AdapterCapability[] = [
	"interactive",
	"prompt",
	"persistent-session",
	"run-environment",
	"observe",
	"read-only",
	"shell",
	"edit",
	"runtime-bridge",
];
export const BUILTIN_EFFECTS = EFFECTS;
export const BUILTIN_CAPABILITIES = CAPABILITIES;

function manifests(
	rounds: number,
	version: number,
	wikiGate = true,
	wikiBeforeArchive = true,
): WorkflowManifest[] {
	return [
		...openspecManifests(rounds, version, wikiGate, wikiBeforeArchive),
		...noOpenspecManifests(rounds, version, wikiGate),
		...fusionManifests(rounds, version, wikiGate, wikiBeforeArchive),
		...researchManifests(version, wikiGate),
		...wikiManifests(version, wikiGate),
		...soloManifests(version),
		...rebaseManifests(version),
		...verifyManifests(rounds, version),
	];
}

export function registerBuiltins(
	registry = new WorkflowRegistry(EFFECTS, CAPABILITIES),
	maxVerificationRounds = 6,
): WorkflowRegistry {
	if (
		!Number.isInteger(maxVerificationRounds) ||
		maxVerificationRounds < 1 ||
		maxVerificationRounds > 20
	)
		throw new Error("max_verification_rounds must be an integer from 1 to 20");
	for (const item of WORKFLOW_STEPS) registry.registerStep(item);
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const legacyVersion = rounds === 6 ? 1 : rounds === 1 ? 21 : rounds;
		for (const definition of manifests(rounds, legacyVersion, false)) {
			assertStepBehaviorCoverage(definition.steps);
			registry.registerWorkflow(definition);
		}
		const version = definitionVersionForPolicy(rounds);
		for (const definition of manifests(rounds, version, true)) {
			assertStepBehaviorCoverage(definition.steps);
			registry.registerWorkflow(definition);
		}
		if (rounds === 6)
			for (const definition of manifests(20, 1000, true, false)) {
				assertStepBehaviorCoverage(definition.steps);
				registry.registerWorkflow(definition);
			}
	}
	// Manifest-policy tier (design D1): identical graphs to the wikiGate policy
	// tier above, plus a declared `policy` block. Registered under its own
	// version — per the digest-spreads-the-whole-manifest constraint in
	// registry.ts's `digest()`, adding a field to an existing version would
	// silently strand every in-flight workflow pinned to that digest — and in
	// its own pass after every prior-tier round so it only ever appends to the
	// registration order instead of interleaving with the tiers above.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const manifestPolicyVersion = definitionVersionForManifestPolicy(rounds);
		for (const definition of manifests(rounds, manifestPolicyVersion, true)) {
			const withPolicy = withManifestPolicy(definition);
			assertStepBehaviorCoverage(withPolicy.steps);
			registry.registerWorkflow(withPolicy);
		}
	}
	// Exact semantic references are introduced in a new tier. Older definitions
	// remain byte-compatible and continue resolving through the explicit legacy
	// baseline mapping in WorkflowRegistry.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForBehaviorPins(rounds);
		for (const definition of manifests(rounds, version, true)) {
			const pinnedBase = withManifestPolicy(definition);
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	// Research tool policy changed independently. Keep every earlier version
	// byte-compatible while new research starts use the selected profile as-is.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForResearchTools(rounds);
		for (const definition of researchManifests(version, true)) {
			const pinnedBase = withFullToolResearchPolicy(definition);
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	// Classifier-driven verifier-role routing adds `core.triage-route` to the
	// shared implementation loop. Published as its own tier so definitions
	// pinned to an earlier version keep their previous graph, digest, and step
	// list. Every non-research family is registered here — the loop-bearing
	// ones extended, the wiki-only ones unchanged — because a new non-research
	// start resolves this tier; research keeps the tool-policy tier above.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForTriageRouting(rounds);
		for (const definition of [
			...openspecManifests(rounds, version, true, true, true),
			...noOpenspecManifests(rounds, version, true, true),
			...fusionManifests(rounds, version, true, true, true),
			...wikiManifests(version, true),
			...soloManifests(version),
			...rebaseManifests(version),
			...verifyManifests(rounds, version),
		]) {
			const pinnedBase = withManifestPolicy(definition);
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	// Configurable stage gates add `core.plan-gate`, `core.review-gate`, and
	// `core.wiki-gate` to the implementation-loop families, and give
	// `core.triage-route` its third outcome. Published as its own tier: a
	// digest spreads the whole manifest, so mutating the tier above would
	// strand every workflow pinned to it. The `core.triage-route` outcome
	// change is a step version bump for the same reason — version 1 stays
	// registered for the earlier tier, and only this one pins version 2.
	// The standalone wiki and research lifecycles are registered unchanged:
	// their gated-shaped stage is the whole workflow, so a gate in front of it
	// would have nothing to fall through to.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForStageGates(rounds);
		for (const definition of [
			...openspecManifests(rounds, version, true, true, true, true),
			...noOpenspecManifests(rounds, version, true, true, true),
			...fusionManifests(rounds, version, true, true, true, true),
			...wikiManifests(version, true),
			...soloManifests(version),
			...rebaseManifests(version),
			...verifyManifests(rounds, version, true),
		]) {
			const pinnedBase = withManifestPolicy(definition);
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps, {
					"core.triage-route": 2,
				}),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	// Per-step model selection adds one routing step before every classifiable
	// agent step in every family, so each model is chosen immediately before its
	// step runs rather than in two phase-wide passes that only the OpenSpec
	// families reached. Published as its own tier for the same reason as every
	// tier above: a digest spreads the whole manifest.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForStepRouting(rounds);
		for (const definition of [
			...openspecManifests(rounds, version, true, true, true, true),
			...noOpenspecManifests(rounds, version, true, true, true),
			...fusionManifests(rounds, version, true, true, true, true),
			...wikiManifests(version, true),
			...soloManifests(version),
			...rebaseManifests(version),
			...verifyManifests(rounds, version, true),
			...researchManifests(version, true).map(withFullToolResearchPolicy),
		]) {
			const pinnedBase = withPerStepRouting(withManifestPolicy(definition));
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps, {
					"core.triage-route": 2,
				}),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	// Declared family traits (add-definition-family-traits) are attached in
	// another new tier, for the same reason as every tier above: a digest spreads
	// the whole manifest, so a `traits` block cannot be added to the step-routing
	// version the engine resolves today without stranding every workflow pinned
	// to it. Every family is registered here — the repository code-change families
	// with the block, the documentation families without one, all of them with
	// the tier below's graph — so "every family resolves at the newest tier" stays
	// true.
	//
	// `research` is also the one family whose policy this tier corrects: the
	// per-step routing pass re-applies `withManifestPolicy` after the research
	// family's full-tool transform, so the `requiresReadOnlyResearcher: false`
	// that `definitionVersionForResearchTools` documents never reached the tier
	// new starts resolved. There the start guard then looks for a route named
	// `core.route-research` — the initial the routing pass installed, a system
	// step no route table ever names — and refuses every research start, whatever
	// the researcher profile. The full-tool policy therefore has to be applied
	// *after* `withManifestPolicy` here, which makes `research` startable again
	// on the tier new starts pin. Only versions 801..820 move; every earlier tier
	// keeps its policy, its graph, and its digest, and nothing is pinned to the
	// new tier yet.
	for (const rounds of Array.from({ length: 20 }, (_, index) => index + 1)) {
		const version = definitionVersionForFamilyTraits(rounds);
		for (const definition of [
			...openspecManifests(rounds, version, true, true, true, true),
			...noOpenspecManifests(rounds, version, true, true, true),
			...fusionManifests(rounds, version, true, true, true, true),
			...wikiManifests(version, true),
			...soloManifests(version),
			...rebaseManifests(version),
			...verifyManifests(rounds, version, true),
			...researchManifests(version, true),
		]) {
			const catalogPolicy = withPerStepRouting(withManifestPolicy(definition));
			const pinnedBase =
				definition.id === "research"
					? withFullToolResearchPolicy(catalogPolicy)
					: withFamilyTraits(catalogPolicy);
			const pinned: WorkflowManifest = {
				...pinnedBase,
				stepRefs: exactStepReferences(pinnedBase.steps, {
					"core.triage-route": 2,
				}),
			};
			assertStepBehaviorCoverage(pinned.steps);
			registry.registerWorkflow(pinned);
		}
	}
	return registry;
}
