// The reduced no-OpenSpec family for repositories with no `openspec/`
// directory. Moved verbatim out of definitions.ts's `manifests()`
// (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { COMMON_IMPLEMENTATION_STEPS } from "../steps.ts";

export function noOpenspecManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
): WorkflowManifest[] {
	const common = COMMON_IMPLEMENTATION_STEPS;
	return [
		{
			id: "no-openspec",
			version,
			label: "No OpenSpec",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [
				...common,
				...(wikiGate ? ["core.wiki", "core.wiki-approval"] : []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: workflowEdges(false, rounds, wikiGate),
		},
	];
}
