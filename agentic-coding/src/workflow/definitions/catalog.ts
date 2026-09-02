// Human-facing workflow family catalog (id, label, description) used by the
// CLI's `start` prompt and project listings. Moved verbatim out of
// definitions.ts (split-workflow-god-modules).
export type WorkflowCatalogEntry = Readonly<{
	id: string;
	label: string;
	description: string;
	alias?: string;
}>;

export const PUBLIC_WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] =
	Object.freeze([
		Object.freeze({
			id: "openspec-full",
			label: "Openspec",
			description:
				"Standard openspec flow with explore, propose, plan review, apply, verify, developer review, wiki, wiki review, archive phases",
		}),
		Object.freeze({
			id: "openspec-apply",
			label: "Openspec apply",
			description:
				"Openspec flow with reduced apply, verify, developer-review, wiki, wiki-review, archive phases",
		}),
		Object.freeze({
			id: "no-openspec",
			label: "No OpenSpec",
			description:
				"Workflow for repositories without openspec. Has apply, review, developer-review, wiki, wiki-review phases.",
			alias: "quick",
		}),
		Object.freeze({
			id: "openspec-fusion-full",
			label: "Openspec fusion",
			description:
				"Openspec fusion flow that spawns multiple explorers that consolidate to one plan. Has fusion-plan, fusion-consolidate, plan review, apply, verify, developer review, wiki, wiki-review, archive phases",
		}),
		Object.freeze({
			id: "openspec-propose",
			label: "Openspec Propose Only",
			description:
				"Openspec flow with reduced explore, propose, plan review phases",
		}),
		Object.freeze({
			id: "openspec-fusion-propose",
			label: "Openspec fusion propose",
			description:
				"Openspec fusion workflow with reduced fusion plan, fusion consolidate, plan review phases",
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
