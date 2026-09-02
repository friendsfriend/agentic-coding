// The manifest-policy tier (design D1): a per-workflow-id `policy` table,
// the version offset that registers graphs with a `policy` block attached,
// and the fallback lookup pre-policy definition versions use at start time.
// Moved verbatim out of definitions.ts (split-workflow-god-modules).
import type { WorkflowManifest, WorkflowManifestPolicy } from "../registry.ts";

/** The version the app actually starts new workflows against — see D1. Prior
 * tiers (legacy `wikiGate=false`, and the `wikiGate=true` tier without a
 * `policy` block) stay registered so in-flight workflows pinned to them keep
 * dispatching without repair. */
export function definitionVersionForManifestPolicy(rounds: number): number {
	return rounds + 200;
}

const MANIFEST_POLICY: Readonly<Record<string, WorkflowManifestPolicy>> = {
	"openspec-full": {
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
	"openspec-fusion-full": {
		targetKind: "repository",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	},
	"openspec-fusion-propose": {
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
