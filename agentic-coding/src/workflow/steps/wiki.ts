import type { StepBehavior } from "./types.ts";

function wikiRole(definitionId: string): string {
	return definitionId === "research" ? "research-wiki" : "wiki";
}

/** Maps a wiki-family role to the one role-specific approach asset it reads,
 * out of the several pinned under the core.wiki step (see registerBuiltins'
 * INSTRUCTION_BY_STEP in definitions.ts). */
const WIKI_ROLE_ASSET: Readonly<Record<string, string>> = {
	wiki: "wiki-openspec.md",
	"research-wiki": "wiki-research.md",
};

export const wikiBehavior: StepBehavior = {
	roles: ({ snapshot }) => [wikiRole(snapshot.definition.id)],
	candidateRoles: ({ definitionId }) => [wikiRole(definitionId)],
	instructionAssetForRole: ({ role }) => WIKI_ROLE_ASSET[role],
	assignmentInputs: ({ run, snapshot }) => {
		// The research-handoff wiki agent is a distinct role (research-wiki),
		// not a conditional branch of the shared wiki role — see wiki-research.md.
		const isResearchWikiRole = run.role === "research-wiki";
		return {
			introLines: isResearchWikiRole
				? [
						"Directive-first: the completed research handoff below already decided what to document. Start immediately by creating or updating exactly the concepts its directives name, with exactly the claims each directive lists — do not run a broad open-ended rediscovery pass over the repository or wiki to figure out what to document.",
						"Limit repository/wiki inspection to targeted corroboration of the recorded directives: confirm each directive's claim against its cited source, and use `wiki search`/`wiki show` only to resolve the update-vs-create choice for each named target, not to search for other undocumented material.",
						`Centralized wiki boundary: ${snapshot.metadata.wikiRoot ?? "configured wiki root"}`,
						"Write only an unverified centralized draft; developer approval follows this stage.",
					]
				: undefined,
			objective: isResearchWikiRole
				? "Execute the recorded research handoff directives directive-first: create or update exactly the named concepts with the listed claims, limiting inspection to targeted corroboration of those directives (no broad rediscovery), then wait for developer approval."
				: undefined,
			permissions: [
				"read repository evidence only",
				"write only centralized unverified wiki drafts",
				...(isResearchWikiRole
					? [
							"act on the recorded handoff directives first; do not perform broad rediscovery",
							"developer approval is required next",
						]
					: []),
			],
			checks: ["documentation scope and source-isolation checks"],
			suppressStepInputLine: isResearchWikiRole,
		};
	},
	carriesOutputContext: true,
	acceptsCommentsContext: true,
};
