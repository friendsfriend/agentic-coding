// Human-facing workflow family catalog (id, label, description) used by the
// CLI's `start` prompt and project listings. Moved verbatim out of
// definitions.ts (split-workflow-god-modules).
export type WorkflowCatalogEntry = Readonly<{
	id: string;
	label: string;
	description: string;
	alias?: string;
}>;

/** Definitions removed by the classifier-driven-model-pools hard cut, mapped to
 * the registered replacement a caller should use instead. */
export const REMOVED_WORKFLOW_REPLACEMENTS: Readonly<Record<string, string>> =
	Object.freeze({
		"openspec-full": "openspec",
		"openspec-jev": "openspec",
		"openspec-jev-apply": "openspec-apply",
		"openspec-fusion-full": "openspec-fusion",
	});

/** An actionable `unknown/removed definition` hint for an unregistered id. */
export function removedWorkflowHint(id: string): string | undefined {
	const replacement = REMOVED_WORKFLOW_REPLACEMENTS[id];
	return replacement
		? `unknown/removed definition: ${id} (use ${replacement})`
		: undefined;
}

export const PUBLIC_WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] =
	Object.freeze([
		Object.freeze({
			id: "openspec",
			label: "Openspec",
			description:
				"Standard openspec flow that routes per-step model pools before planning and after approval, then runs apply, verify, developer review, wiki, archive, delivery phases",
		}),
		Object.freeze({
			id: "openspec-apply",
			label: "Openspec apply",
			description:
				"Openspec flow that classifies apply-phase model pools before the first implementation round, then verifies, reviews, documents, and archives",
		}),
		Object.freeze({
			id: "openspec-propose",
			label: "Openspec Propose Only",
			description:
				"Openspec flow that classifies the plan pool, plans, and stops at plan approval and completion",
		}),
		Object.freeze({
			id: "no-openspec",
			label: "No OpenSpec",
			description:
				"Workflow for repositories without openspec. Has apply, review, developer-review, wiki, wiki-review phases.",
			alias: "quick",
		}),
		Object.freeze({
			id: "openspec-fusion",
			label: "Openspec fusion",
			description:
				"Openspec fusion flow that classifies a planner roster, consolidates to one plan, then runs plan review, apply, verify, developer review, wiki, and archive phases",
		}),
		Object.freeze({
			id: "openspec-fusion-propose",
			label: "Openspec fusion propose",
			description:
				"Openspec fusion workflow that classifies a planner roster, consolidates to one plan, and stops at plan approval and completion",
		}),
		Object.freeze({
			id: "wiki",
			label: "Wiki",
			description: "Wiki workflow used for interacting with the wiki",
		}),
		Object.freeze({
			id: "research",
			label: "Research",
			description: "Research with research, wiki, wiki review phases",
		}),
	] as const);
