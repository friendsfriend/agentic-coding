// Custom workflow definitions (persist-custom-workflow-definitions): the
// reserved `custom.` identifier namespace and the newest-tier invariants a
// stored manifest must keep. Pure: the store, the CLI and the resolver all
// call into this module, and none of them may skip it.
import type { WorkflowManifest } from "../registry.ts";
import { GATE_GUARDED_STEP } from "../steps/gates.ts";
import { digest } from "./digest.ts";
import { ROUTE_STEP_FOR_TARGET } from "./edges.ts";

/** The namespace reserved for operator-stored definitions. A built-in
 * definition may never claim it, and a stored definition is always derived
 * from its digest, so two manifests can never share one identity. */
export const CUSTOM_DEFINITION_PREFIX = "custom.";

/** Stored definitions are always version 1: identity is the content digest,
 * so a changed manifest is a new definition rather than a new version. */
export const CUSTOM_DEFINITION_VERSION = 1;

export function isCustomDefinitionId(id: string): boolean {
	return id.startsWith(CUSTOM_DEFINITION_PREFIX);
}

/** The content-addressed identifier of a manifest digest. */
export function customDefinitionId(identity: string): string {
	return `${CUSTOM_DEFINITION_PREFIX}${identity.slice(0, 12)}`;
}

/** The identity digest of a custom manifest. The derived identity fields
 * themselves (`id`, `version`) are forced to their canonical values first, so
 * the digest is a fixed point: `id === customDefinitionId(digest(manifest))`
 * holds for the stored manifest, and an author never has to compute their own
 * identifier. Everything else — the graph, the policy and traits, the exact
 * step references, the label — is content, so an identical manifest stored
 * twice yields one identity. */
export function customDefinitionDigest(manifest: WorkflowManifest): string {
	return digest({
		...manifest,
		id: CUSTOM_DEFINITION_PREFIX,
		version: CUSTOM_DEFINITION_VERSION,
	});
}

/** Assign the derived identity to an authored manifest: the operator supplies
 * the graph and policy, the store supplies the id and version. */
export function withCustomIdentity(
	manifest: WorkflowManifest,
): WorkflowManifest {
	return {
		...manifest,
		id: customDefinitionId(customDefinitionDigest(manifest)),
		version: CUSTOM_DEFINITION_VERSION,
	};
}

function routingStepFor(target: string): string | undefined {
	return ROUTE_STEP_FOR_TARGET[target];
}

/**
 * The newest built-in tier's invariants, enforced on a custom manifest instead
 * of trusted from its author (design: "Newest-tier invariants are enforced at
 * store time"). A custom graph must:
 *
 * - pin exact step references (a bare step id would silently follow whatever
 *   the step catalog registers later);
 * - declare a non-empty label (the view projection and the wire schema require
 *   one, so a stored definition without it would break every reader);
 * - declare a manifest policy with family traits for a repository target (the
 *   documentation families declare none, and custom graphs never produce
 *   them);
 * - place the routing step immediately before every classifiable agent step,
 *   with every inbound edge entering the route step and the route step
 *   transitioning to its target;
 * - place the stage gate in front of every gated stage it contains, so the
 *   stage is entered only through the gate's `run` outcome.
 *
 * The messages name the violated invariant and the step involved so a rejected
 * definition is actionable. `test/workflow-custom-definitions.test.ts` proves
 * the newest built-in tier satisfies exactly these rules.
 */
export function assertNewestTierInvariants(manifest: WorkflowManifest): void {
	const id = manifest.id;
	const policy = manifest.policy;
	if (!policy)
		throw new Error(`custom definition ${id} must declare a manifest policy`);
	if (policy.targetKind !== "repository")
		throw new Error(
			`custom definition ${id} must target a repository (policy.targetKind is ${policy.targetKind})`,
		);
	if (!policy.traits)
		throw new Error(
			`custom definition ${id} must declare family traits for a repository code-change target`,
		);
	if (!manifest.stepRefs)
		throw new Error(
			`custom definition ${id} must pin exact step references for every step`,
		);
	if (typeof manifest.label !== "string" || !manifest.label.trim())
		throw new Error(`custom definition ${id} must declare a non-empty label`);
	const steps = new Set(manifest.steps);
	const edges = manifest.edges;
	for (const target of manifest.steps) {
		const routeStep = routingStepFor(target);
		if (!routeStep) continue;
		if (!steps.has(routeStep))
			throw new Error(
				`custom definition ${id} is missing routing step ${routeStep} before ${target}`,
			);
		const inbound = edges.filter((edge) => edge.to === target);
		if (!inbound.length)
			throw new Error(`custom definition ${id} routes no edge into ${target}`);
		const misrouted = inbound.find((edge) => edge.from !== routeStep);
		if (misrouted)
			throw new Error(
				`custom definition ${id} routes ${target} from ${misrouted.from} instead of ${routeStep}`,
			);
		const outbound = edges.filter((edge) => edge.from === routeStep);
		if (
			outbound.length !== 1 ||
			outbound[0]?.to !== target ||
			outbound[0]?.outcome !== "complete"
		)
			throw new Error(
				`custom definition ${id} routing step ${routeStep} must transition to ${target} with outcome complete`,
			);
	}
	for (const [gate, stage] of Object.entries(GATE_GUARDED_STEP)) {
		if (!steps.has(stage)) continue;
		if (!steps.has(gate))
			throw new Error(
				`custom definition ${id} is missing gate ${gate} before ${stage}`,
			);
		const routeStep = routingStepFor(stage);
		const entry = routeStep && steps.has(routeStep) ? routeStep : stage;
		const entries = edges.filter((edge) => edge.to === entry && !edge.loop);
		if (!entries.length)
			throw new Error(
				`custom definition ${id} has no entry into gated stage ${stage}`,
			);
		const unguarded = entries.find(
			(edge) => edge.from !== gate || edge.outcome !== "run",
		);
		if (unguarded)
			throw new Error(
				`custom definition ${id} enters gated stage ${stage} from ${unguarded.from} instead of gate ${gate}`,
			);
	}
}
