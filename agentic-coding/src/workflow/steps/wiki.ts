import { STAGE_TEST_WIKI_ROLE } from "./stage-test.ts";
import type { StepBehavior } from "./types.ts";

function wikiRole(definitionId: string): string {
	return definitionId === "research"
		? "research-wiki"
		: definitionId === "stage-test"
			? STAGE_TEST_WIKI_ROLE
			: "wiki";
}

/** Maps a wiki-family role to the one role-specific approach asset it reads,
 * out of the several pinned under the core.wiki step (see registerBuiltins'
 * INSTRUCTION_BY_STEP in definitions.ts). */
const WIKI_ROLE_ASSET: Readonly<Record<string, string>> = {
	wiki: "wiki-openspec.md",
	"research-wiki": "wiki-research.md",
	[STAGE_TEST_WIKI_ROLE]: "wiki-stage-test.md",
};

export const wikiBehavior: StepBehavior = {
	classification: "single",
	// The stage wiki role is a stage-test role: it receives the core only.
	protocolSections: ({ role }) =>
		role === STAGE_TEST_WIKI_ROLE ? [] : ["jev"],
	onAgentComplete: ({ definitionId, outcome }) =>
		outcome === "blocked" &&
		["wiki", "wiki-comments", "research", "stage-test"].includes(definitionId)
			? { transition: { outcome: "blocked" } }
			: undefined,
	roles: ({ snapshot }) => [wikiRole(snapshot.definition.id)],
	candidateRoles: ({ definitionId }) => [wikiRole(definitionId)],
	instructionAssetForRole: ({ role }) => WIKI_ROLE_ASSET[role],
	developerActions: ({ snapshot }) =>
		snapshot.definition.id === "research"
			? [
					{
						id: "close-research",
						label: "Close research",
						confirmation: "confirm",
					},
				]
			: [],
	assignmentInputs: ({ run, snapshot }) => {
		// The research-handoff wiki agent is a distinct role (research-wiki),
		// not a conditional branch of the shared wiki role — see wiki-research.md.
		const isResearchWikiRole = run.role === "research-wiki";
		const isStageTestWikiRole = run.role === STAGE_TEST_WIKI_ROLE;
		const stageReport = snapshot.metadata.stageTestReport as
			| { knowledgeObservations?: readonly unknown[] }
			| undefined;
		return {
			introLines: isStageTestWikiRole
				? [
						"Document only reusable process knowledge from the approved stage-test report and journal; do not copy credentials, user-specific data, or raw application records.",
						`Pinned stage: ${snapshot.metadata.stage}; system: ${snapshot.metadata.stageSystem}; workflow: ${snapshot.workflowId}.`,
						`Approved observations: ${JSON.stringify(stageReport?.knowledgeObservations ?? [])}`,
						`Centralized wiki boundary: ${snapshot.metadata.wikiRoot ?? "configured wiki root"}`,
						`Required source URI: stage://${snapshot.metadata.stage}/${snapshot.workflowId}`,
						"Write only process/stage concepts in this system namespace as unverified drafts, then wait for developer approval.",
						"Only missing/new observations and product-change contradictions update claims. Regression/unknown contradictions add a dated Disputed callout and preserve the claim. Confirmed observations cause no write.",
					]
				: isResearchWikiRole
					? [
							"Directive-first: the completed research handoff below already decided what to document. Start immediately by creating or updating exactly the concepts its directives name, with exactly the claims each directive lists — do not run a broad open-ended rediscovery pass over the repository or wiki to figure out what to document.",
							"Limit repository/wiki inspection to targeted corroboration of the recorded directives: confirm each directive's claim against its cited source, and use `wiki search`/`wiki show` only to resolve the update-vs-create choice for each named target, not to search for other undocumented material.",
							`Centralized wiki boundary: ${snapshot.metadata.wikiRoot ?? "configured wiki root"}`,
							"Write only an unverified centralized draft; developer approval follows this stage.",
						]
					: undefined,
			objective: isStageTestWikiRole
				? "Write the smallest useful centralized wiki update containing only reusable, evidence-backed process knowledge from the reviewed stage-test report."
				: isResearchWikiRole
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
					: isStageTestWikiRole
						? [
								"write only sanitized process knowledge that the report or journal supports",
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
