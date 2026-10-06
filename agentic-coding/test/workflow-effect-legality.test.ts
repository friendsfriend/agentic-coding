// Effect-legality at the steps that receive an edge effect the step's own
// contract deliberately does not list. The wiki approval promotion is enqueued
// by the approval edge, so it is legal while the destination step is current —
// including the per-step routing step that now precedes archive, which the
// step-id exception list missed (classifier-driven-step-model-selection).
import { expect, test } from "bun:test";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	type EffectRow,
	validateEffect,
} from "../src/workflow/runtime/store.ts";

const registry = registerBuiltins();

function effectRow(kind: string): EffectRow {
	return { id: "row", kind, payload_json: "{}" } as unknown as EffectRow;
}

/** Only the fields `validateEffect` reads before the effect-legality check. */
function at(currentStep: string, definitionId: string): WorkflowSnapshot {
	return {
		workflowId: "wf",
		currentStep,
		definition: { id: definitionId },
		step: { activeRunIds: [] },
		developerDialogue: [],
	} as unknown as WorkflowSnapshot;
}

function legality(
	definitionId: string,
	version: number,
	kind: string,
	currentStep: string,
): () => void {
	return () =>
		validateEffect(
			effectRow(kind),
			at(currentStep, definitionId),
			registry.definition(definitionId, version),
			[],
			registry,
		);
}

test("the wiki approval promotion stays legal at the archive routing step", () => {
	const version = definitionVersionForStepRouting(6);
	for (const definitionId of [
		"openspec",
		"openspec-apply",
		"openspec-fusion",
	]) {
		expect(
			legality(definitionId, version, "wiki.verify", "core.route-archive"),
		).not.toThrow();
	}
});

test("the promotion stays legal at the close gate the wiki family reaches", () => {
	const version = definitionVersionForStepRouting(6);
	for (const [definitionId, currentStep] of [
		["wiki", "core.completed"],
		["wiki-comments", "core.completed"],
		["research", "core.completed"],
	] as const)
		expect(
			legality(definitionId, version, "wiki.verify", currentStep),
		).not.toThrow();
});

test("an inbound declaration does not legalize the effect anywhere else", () => {
	const version = definitionVersionForStepRouting(6);
	expect(
		legality("openspec-apply", version, "wiki.verify", "core.route-wiki"),
	).toThrow(/effect wiki.verify is illegal at core.route-wiki/);
	expect(
		legality(
			"openspec-apply",
			version,
			"delivery.commit",
			"core.route-archive",
		),
	).toThrow(/effect delivery.commit is illegal at core.route-archive/);
});
