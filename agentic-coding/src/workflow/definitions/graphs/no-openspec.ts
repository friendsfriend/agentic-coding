// The reduced no-OpenSpec family for repositories with no `openspec/`
// directory. Moved verbatim out of definitions.ts's `manifests()`
// (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { commonImplementationSteps } from "../steps.ts";

export function noOpenspecManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
	includeTriageRoute = false,
	stageGates = false,
): WorkflowManifest[] {
	const common = commonImplementationSteps(includeTriageRoute, stageGates);
	return [
		{
			id: "no-openspec",
			version,
			label: "No OpenSpec",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [
				...common,
				...(wikiGate
					? [
							...(stageGates ? ["core.wiki-gate"] : []),
							"core.wiki",
							"core.wiki-approval",
						]
					: []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: workflowEdges(
				false,
				rounds,
				wikiGate,
				true,
				includeTriageRoute,
				stageGates,
			),
		},
	];
}
