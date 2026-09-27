// The fusion family: a classified planner roster consolidating to one plan,
// either through to close or reduced to propose-only
// (classifier-driven-model-pools). Both graphs start at the plan-phase routing
// pass, which seeds the planner roster from the `fusion.plan` pool's tagged
// defaults and replaces it with the classified roster.
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { commonImplementationSteps } from "../steps.ts";

export function fusionManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
	wikiBeforeArchive: boolean,
	includeTriageRoute = false,
	stageGates = false,
): WorkflowManifest[] {
	const common = commonImplementationSteps(includeTriageRoute, stageGates);
	const tail = [
		...(wikiGate && wikiBeforeArchive
			? [
					...(stageGates ? ["core.wiki-gate"] : []),
					"core.wiki",
					"core.wiki-approval",
				]
			: []),
		"core.archive",
		...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
		"core.delivery",
	];
	/** The plan gate mirrors this definition's own approval target, so a skip
	 * is shape-identical to an approval. */
	const planGateEdges = (approvalTarget: string): WorkflowManifest["edges"] =>
		stageGates
			? ([
					{ from: "core.plan-gate", outcome: "run", to: "core.plan-approval" },
					{ from: "core.plan-gate", outcome: "skip", to: approvalTarget },
				] as const)
			: [];
	const fusionPlanEdges = (
		approvalTarget: string,
	): WorkflowManifest["edges"] => [
		{ from: "core.route-plan", outcome: "complete", to: "fusion.plan" },
		{ from: "fusion.plan", outcome: "complete", to: "fusion.consolidate" },
		{
			from: "fusion.plan",
			outcome: "blocked",
			to: "fusion.plan",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.plan",
			outcome: "failed",
			to: "fusion.plan",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.consolidate",
			outcome: "complete",
			to: stageGates ? "core.plan-gate" : "core.plan-approval",
		},
		...planGateEdges(approvalTarget),
		{
			from: "fusion.consolidate",
			outcome: "blocked",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.consolidate",
			outcome: "failed",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
	];
	return [
		{
			id: "openspec-fusion",
			version,
			label: "Openspec fusion",
			initial: "core.route-plan",
			terminal: ["core.closed"],
			steps: [
				"core.route-plan",
				"fusion.plan",
				"fusion.consolidate",
				...(stageGates ? ["core.plan-gate"] : []),
				"core.plan-approval",
				"core.route-apply",
				...common,
				...tail,
				"core.completed",
				"core.closed",
			],
			edges: [
				...fusionPlanEdges("core.route-apply"),
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.route-apply",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.route-apply",
					outcome: "complete",
					to: "core.implementation",
				},
				...workflowEdges(
					true,
					rounds,
					wikiGate,
					wikiBeforeArchive,
					includeTriageRoute,
					stageGates,
				),
			],
		},
		{
			id: "openspec-fusion-propose",
			version,
			label: "Openspec fusion propose",
			initial: "core.route-plan",
			terminal: ["core.closed"],
			steps: [
				"core.route-plan",
				"fusion.plan",
				"fusion.consolidate",
				...(stageGates ? ["core.plan-gate"] : []),
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
				...fusionPlanEdges("core.completed"),
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.completed",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "fusion.consolidate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.completed",
					outcome: "create-pr",
					to: "core.completed",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		},
	];
}
