// The manifest-policy tier (design D1): a per-workflow-id `policy` table,
// the version offset that registers graphs with a `policy` block attached,
// and the fallback lookup pre-policy definition versions use at start time.
// Moved verbatim out of definitions.ts (split-workflow-god-modules).
import type {
	WorkflowFamilyTraits,
	WorkflowManifest,
	WorkflowManifestPolicy,
} from "../registry.ts";

/** Historical manifest-policy version tier. The behavior-pin tier is the
 * version used for new workflows; this tier stays registered so in-flight
 * workflows pinned to it keep dispatching without repair. */
export function definitionVersionForManifestPolicy(rounds: number): number {
	return rounds + 200;
}

/** Version tier for definitions that pin exact step and behavior identities.
 * Keeping this separate preserves both legacy digest formats and the already
 * published manifest-policy tier. */
export function definitionVersionForBehaviorPins(rounds: number): number {
	return rounds + 300;
}

/** Research definitions that grant the selected profile's normal tool access. */
export function definitionVersionForResearchTools(rounds: number): number {
	return rounds + 400;
}

/** Version tier for the graphs that select verifier roles with the classifier
 * (classifier-driven-triage-routing). Threaded behind a flag rather than
 * mutating every earlier tier, so a workflow already pinned to one of them
 * keeps its graph, its digest, and its resolvable steps. */
export function definitionVersionForTriageRouting(rounds: number): number {
	return rounds + 500;
}

/** Version tier for the graphs carrying the four configurable stage gates
 * (add-jev-stage-gating). Threaded behind a flag for the same reason as the
 * tier above: editing a registered version changes its digest and would strand
 * every workflow already pinned to it. */
export function definitionVersionForStageGates(rounds: number): number {
	return rounds + 600;
}

/** Version tier for the graphs that select the model of every classifiable
 * step immediately before it runs (classifier-driven-step-model-selection).
 * Threaded behind the same kind of transform as the tiers above, so a workflow
 * pinned to an earlier version keeps its graph, its digest, and its step list. */
export function definitionVersionForStepRouting(rounds: number): number {
	return rounds + 700;
}

/** Version tier that declares the repository family traits
 * (add-definition-family-traits). Every family is registered in it — the
 * repository code-change families with their traits, the documentation
 * families unchanged — so "every family resolves at the newest tier" stays
 * true while the tier below keeps its graph, its digest, and its step list. */
export function definitionVersionForFamilyTraits(rounds: number): number {
	return rounds + 800;
}

/** The declared family traits, per repository code-change family
 * (add-definition-family-traits). This table is both the source of the traits
 * tier's manifests and the fallback `effectiveFamilyTraits` reads for a
 * definition registered before traits existed, so every pinned workflow has
 * traits and the two cannot drift. The documentation families declare none:
 * `research` and `wiki-comments` have their own targets and steps, and `wiki`
 * — although repository-targeted — is its own lifecycle rather than a
 * code-change family, so its id checks stay too.
 *
 * The values mirror the definition-id comparisons this stage does not yet
 * touch; the inventory of those branches lives in the change's `design.md`. */
const FAMILY_TRAITS: Readonly<Record<string, WorkflowFamilyTraits>> = {
	openspec: {
		changeArtifacts: "openspec",
		planning: "single",
		changeIdentity: "planned",
		delivery: "pull-request",
		startRequirements: ["clean-tree", "openspec-project"],
		openspecVerifier: true,
	},
	"openspec-apply": {
		changeArtifacts: "openspec",
		planning: "none",
		changeIdentity: "workflow-id",
		delivery: "pull-request",
		startRequirements: ["clean-tree", "openspec-project", "openspec-change"],
		openspecVerifier: true,
	},
	"openspec-propose": {
		changeArtifacts: "openspec",
		planning: "single",
		changeIdentity: "planned",
		delivery: "none",
		startRequirements: ["openspec-project"],
		openspecVerifier: true,
	},
	"openspec-fusion": {
		changeArtifacts: "openspec",
		planning: "fusion",
		changeIdentity: "planned",
		delivery: "pull-request",
		startRequirements: ["clean-tree", "openspec-project"],
		openspecVerifier: true,
	},
	"openspec-fusion-propose": {
		changeArtifacts: "openspec",
		planning: "fusion",
		changeIdentity: "planned",
		delivery: "none",
		startRequirements: ["openspec-project"],
		openspecVerifier: true,
	},
	"no-openspec": {
		changeArtifacts: "none",
		planning: "none",
		changeIdentity: "none",
		delivery: "pull-request",
		startRequirements: ["task", "clean-tree"],
		openspecVerifier: false,
	},
	solo: {
		changeArtifacts: "none",
		planning: "none",
		changeIdentity: "none",
		delivery: "none",
		startRequirements: ["task", "clean-tree"],
		openspecVerifier: true,
	},
	rebase: {
		changeArtifacts: "none",
		planning: "none",
		changeIdentity: "none",
		delivery: "none",
		startRequirements: ["clean-tree", "rebase-refs"],
		openspecVerifier: true,
	},
	verify: {
		changeArtifacts: "none",
		planning: "none",
		changeIdentity: "none",
		delivery: "none",
		startRequirements: ["base-commit"],
		openspecVerifier: true,
	},
};

const MANIFEST_POLICY: Readonly<Record<string, WorkflowManifestPolicy>> = {
	openspec: {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	"openspec-propose": {
		targetKind: "repository",
		checkoutRequired: true,
		requiresReadOnlyResearcher: false,
	},
	"openspec-apply": {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	"no-openspec": {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	// The solo family is repository-backed and starts in the implementation
	// step: like no-openspec it has no OpenSpec planning phase, but it also runs
	// one agent only.
	solo: {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	// The rebase family runs one agent in the repository checkout on the source
	// branch the launch selected, which is not necessarily the branch that is
	// checked out: `checkoutRequired` stays false so start does not demand
	// `metadata.branch === current branch`, while the startup boundary still
	// forces checkout mode and `workspace.setup` switches the checkout.
	rebase: {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	"openspec-fusion": {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	"openspec-fusion-propose": {
		targetKind: "repository",
		checkoutRequired: true,
		requiresReadOnlyResearcher: false,
	},
	// The verify-only family runs on the branch that is already checked out and
	// must never switch it: `checkoutRequired` is exactly that contract (mode
	// checkout, the repository checkout, `metadata.branch` = the current branch).
	// Its start also skips the clean-tree rule, because verifying the current
	// state — uncommitted work included — is the point.
	verify: {
		targetKind: "repository",
		checkoutRequired: true,
		requiresReadOnlyResearcher: false,
	},
	// The repository-backed `wiki` workflow runs against a real checkout, in
	// contrast to `wiki-comments`'s repository-independent centralized target.
	wiki: {
		targetKind: "repository",
		checkoutRequired: true,
		requiresReadOnlyResearcher: false,
	},
	"wiki-comments": {
		targetKind: "wiki",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	research: {
		targetKind: "research",
		checkoutRequired: false,
		requiresReadOnlyResearcher: true,
	},
};

export function withManifestPolicy(
	manifest: WorkflowManifest,
): WorkflowManifest {
	const policy = MANIFEST_POLICY[manifest.id];
	if (!policy) throw new Error(`missing manifest policy for ${manifest.id}`);
	return { ...manifest, policy };
}

export function withFullToolResearchPolicy(
	manifest: WorkflowManifest,
): WorkflowManifest {
	const withPolicy = withManifestPolicy(manifest);
	const policy = withPolicy.policy;
	if (!policy) throw new Error("research manifest policy is missing");
	return {
		...withPolicy,
		policy: { ...policy, requiresReadOnlyResearcher: false },
	};
}

/** Attach a family's declared traits (add-definition-family-traits) to a
 * manifest that already carries its policy block. A definition whose id has no
 * traits — `wiki`, `wiki-comments`, `research` — is returned untouched, and a
 * caller's already-resolved policy is never replaced. */
export function withFamilyTraits(manifest: WorkflowManifest): WorkflowManifest {
	const traits = FAMILY_TRAITS[manifest.id];
	if (!traits) return manifest;
	const policy = manifest.policy;
	if (!policy) throw new Error(`missing manifest policy for ${manifest.id}`);
	return { ...manifest, policy: { ...policy, traits } };
}

/** The catalog's declared policy for a built-in family id, or `undefined` for
 * an id the catalog does not carry. The start launcher (`startArgs`) has no
 * verification-round count to resolve a definition with, so it reads the
 * family's declared `checkoutRequired` from here instead of an id list; an
 * unknown id stays unstyled and fails at the start boundary with the
 * registered-definitions diagnostic. */
export function catalogManifestPolicy(
	id: string,
): WorkflowManifestPolicy | undefined {
	return MANIFEST_POLICY[id];
}

/** A pre-policy definition version has no `policy` block (adding one would
 * change its digest and strand every in-flight workflow pinned to it — see
 * D1). `start()` still needs a policy value for every version, so it falls
 * back to the same per-id table the current manifest-policy tier is built
 * from; this is catalog data (identical to `PUBLIC_WORKFLOW_CATALOG` and
 * `INSTRUCTION_BY_STEP` already being keyed by definition id), not a
 * re-introduction of the scattered start-time id comparisons this stage
 * removes. */
export function effectiveManifestPolicy(definition: {
	id: string;
	policy?: WorkflowManifestPolicy;
}): WorkflowManifestPolicy {
	const policy = definition.policy ?? MANIFEST_POLICY[definition.id];
	if (!policy) throw new Error(`missing manifest policy for ${definition.id}`);
	return policy;
}

/** The effective family traits of a definition: the declared ones, or — for a
 * definition version registered before the family-traits tier — the same
 * per-id fallback table that tier's manifests are built from. `undefined` for
 * the documentation families, which declare none. */
export function effectiveFamilyTraits(definition: {
	id: string;
	policy?: WorkflowManifestPolicy;
}): WorkflowFamilyTraits | undefined {
	return definition.policy?.traits ?? FAMILY_TRAITS[definition.id];
}
