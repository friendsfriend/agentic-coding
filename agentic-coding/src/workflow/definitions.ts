// Barrel re-exporting the full public surface that used to live directly in
// this file, split into `definitions/*.ts` by concern
// (split-workflow-god-modules). Every current importer keeps working
// unchanged; see `src/workflow/README.md` for the module map.
export type { WorkflowCatalogEntry } from "./definitions/catalog.ts";
export { PUBLIC_WORKFLOW_CATALOG } from "./definitions/catalog.ts";
export type {
	ResearchHandoff,
	ResearchHandoffDirective,
	ResearchHandoffDirectiveIntent,
} from "./definitions/contracts.ts";
export { researchHandoffContract } from "./definitions/contracts.ts";
export { definitionVersionForPolicy } from "./definitions/edges.ts";
export {
	definitionVersionForManifestPolicy,
	effectiveManifestPolicy,
} from "./definitions/manifest-policy.ts";
export {
	BUILTIN_CAPABILITIES,
	BUILTIN_EFFECTS,
	registerBuiltins,
} from "./definitions/registerBuiltins.ts";
