// The blueprint domain surface (add-workflow-blueprint-compiler): the logical
// step catalog, the human-review validator, and the pure compiler. Consumers
// (the server validation/start routes, the orchestrator tools) import this
// barrel, never a module inside it.
export type { BlueprintStepCatalogEntry } from "./catalog.ts";
export {
	BLUEPRINT_STEP_CATALOG,
	BLUEPRINT_STEP_IDS,
	blueprintStepCatalogEntry,
	GATED_STAGES,
	gateForStage,
	isBlueprintStepId,
	isInternalStepId,
} from "./catalog.ts";
export type {
	BlueprintCompilation,
	BlueprintDiagnostic,
	BlueprintSummary,
} from "./compiler.ts";
export {
	compileBlueprint,
	decodeBlueprint,
	MAX_BLUEPRINT_STEPS,
	MAX_LOOP_ATTEMPTS,
	MAX_VERIFICATION_ROUNDS,
} from "./compiler.ts";
export type {
	BlueprintReviewRule,
	BlueprintReviewViolation,
} from "./review.ts";
export { validateBlueprintReviews } from "./review.ts";
