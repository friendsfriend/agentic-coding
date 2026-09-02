// Orchestrator that assembles the builtin step catalog and every workflow
// family's graphs into one populated `WorkflowRegistry`, across every
// verification-round count, wikiGate combination, and the manifest-policy
// tier (design D1). Moved out of definitions.ts (split-workflow-god-modules)
// — the per-family manifest construction now lives under
// `definitions/graphs/*.ts`; this file only combines and registers.
import type { AdapterCapability, EffectKind } from "../contracts.ts";
import { type WorkflowManifest, WorkflowRegistry } from "../registry.ts";
import { assertStepBehaviorCoverage } from "../steps/index.ts";
import { definitionVersionForPolicy } from "./edges.ts";
import { fusionManifests } from "./graphs/fusion.ts";
import { noOpenspecManifests } from "./graphs/no-openspec.ts";
import { openspecManifests } from "./graphs/openspec.ts";
import { researchManifests } from "./graphs/research.ts";
import { wikiManifests } from "./graphs/wiki.ts";
import {
	definitionVersionForManifestPolicy,
	withManifestPolicy,
} from "./manifest-policy.ts";
import { WORKFLOW_STEPS } from "./steps.ts";

const EFFECTS: EffectKind[] = [
	"workspace.setup",
	"artifact.write",
	"agent.launch",
	"agent.prompt",
	"agent.stop",
	"notification.show",
	"openspec.validate",
	"wiki.verify",
	"delivery.commit",
	"delivery.push",
	"pull-request.create",
	"workspace.close",
	"workspace.cleanup",
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
	return registry;
}
