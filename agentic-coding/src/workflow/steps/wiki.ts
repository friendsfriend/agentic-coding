import type { StepBehavior } from "./types.ts";

function wikiRole(definitionId: string): string {
	return definitionId === "research" ? "research-wiki" : "wiki";
}

export const wikiBehavior: StepBehavior = {
	roles: ({ snapshot }) => [wikiRole(snapshot.definition.id)],
	candidateRoles: ({ definitionId }) => [wikiRole(definitionId)],
};
