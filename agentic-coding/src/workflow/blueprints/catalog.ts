// The blueprint step catalog (add-workflow-blueprint-compiler):
// the logical steps a model-authored blueprint may use, with the human-facing
// label, the actor and the outcomes read from the registered step catalog, plus
// a one-line description of what the step does.
//
// The catalog is deliberately a *logical* allowlist. The routing steps
// (`core.route-*`), the triage-routing step and the stage gates are internal:
// the compiler inserts them, and a blueprint that names one is rejected with a
// pointer that it is not the author's to place (`./compiler.ts`).
//
// Pure domain: it reads the registered step catalog only.
import { WORKFLOW_STEPS } from "../definitions/steps.ts";
import { GATE_GUARDED_STEP } from "../steps/gates.ts";

export interface BlueprintStepCatalogEntry {
	readonly id: string;
	readonly label: string;
	readonly actor: "agent" | "developer" | "system";
	readonly outcomes: readonly string[];
	/** What the step does, for the orchestrator's tool schema and the docs. */
	readonly description: string;
}

/** One description per logical step. The keys are the blueprint's allowlist:
 * every entry is verified against the registered catalog below. */
const BLUEPRINT_STEP_DESCRIPTIONS: Readonly<Record<string, string>> =
	Object.freeze({
		"core.plan":
			"Plan the change: read the repository and the OpenSpec change and hand the developer a plan for approval.",
		"fusion.plan":
			"One planner in a classified roster: draft an independent plan for the consolidator.",
		"fusion.consolidate":
			"Consolidate the planner roster's drafts into one plan for approval.",
		"core.plan-approval":
			"Developer decision on the plan: approve, request changes, or reject.",
		"core.implementation":
			"The worker applies the approved change in the repository.",
		"core.triage": "Choose the verifier roles and the files each one inspects.",
		"core.verification":
			"Independent verification of the change; reports findings.",
		"core.developer-review":
			"Developer decision on the verified change: approve or request changes.",
		"core.findings-review":
			"Developer decision on a verification round's findings (the verify family's review).",
		"core.wiki": "Update the wiki documentation for the change.",
		"core.wiki-approval": "Developer decision on the wiki update.",
		"core.archive": "Archive the OpenSpec change.",
		"core.delivery": "Commit and push the change.",
		"core.rebase": "Rebase one branch onto another and resolve the conflicts.",
		"core.completed":
			"The workflow's change is complete; the developer closes the workflow.",
		"core.closed": "Terminal step: the workspace is torn down.",
	});

/** The gate steps keyed by the stage they guard (inverted
 * `GATE_GUARDED_STEP`), so a blueprint never names one. */
const GATE_FOR_STAGE: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.entries(GATE_GUARDED_STEP).map(([gate, stage]) => [stage, gate]),
	),
);

function catalogEntry(id: string): BlueprintStepCatalogEntry {
	const description = BLUEPRINT_STEP_DESCRIPTIONS[id];
	const step = WORKFLOW_STEPS.find((candidate) => candidate.id === id);
	if (!step || description === undefined)
		throw new Error(`blueprint step catalog names an unregistered step: ${id}`);
	return {
		id,
		label: step.label,
		actor: step.actor,
		outcomes: [...step.outcomes],
		description,
	};
}

/** Every logical step a blueprint may use, in catalog order. */
export const BLUEPRINT_STEP_IDS: readonly string[] = Object.freeze(
	Object.keys(BLUEPRINT_STEP_DESCRIPTIONS),
);

export const BLUEPRINT_STEP_CATALOG: readonly BlueprintStepCatalogEntry[] =
	Object.freeze(BLUEPRINT_STEP_IDS.map(catalogEntry));

export function isBlueprintStepId(id: string): boolean {
	return BLUEPRINT_STEP_IDS.includes(id);
}

/** A step the compiler inserts: a per-step routing step, the triage-routing
 * step, or a stage gate. A blueprint that names one is rejected. */
export function isInternalStepId(id: string): boolean {
	return (
		id.startsWith("core.route-") ||
		id === "core.triage-route" ||
		GATE_GUARDED_STEP[id] !== undefined
	);
}

/** The gate that guards a stage, or `undefined` when the stage is not gated. */
export function gateForStage(stage: string): string | undefined {
	return GATE_FOR_STAGE[stage];
}

/** Every gated stage and its gate. */
export const GATED_STAGES: readonly (readonly [string, string])[] =
	Object.freeze(
		Object.entries(GATE_FOR_STAGE).map(
			([stage, gate]) => [stage, gate] as const,
		),
	);

export function blueprintStepCatalogEntry(
	id: string,
): BlueprintStepCatalogEntry | undefined {
	return BLUEPRINT_STEP_CATALOG.find((entry) => entry.id === id);
}
