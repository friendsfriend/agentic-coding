// The OpenSpec-with-JEV-classification family
// (introduce-jev-for-model-range-decision). Same graph as the standard
// OpenSpec family, with a `core.model-selection` system step between plan
// approval and implementation: it classifies the plan complexity with the
// configured JEV integration and pins the matching worker profile before
// `core.implementation` launches its run. The apply variant classifies the
// pre-existing change before its first implementation round.
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { COMMON_IMPLEMENTATION_STEPS } from "../steps.ts";

export function openspecJevManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
	wikiBeforeArchive: boolean,
): WorkflowManifest[] {
	const common = COMMON_IMPLEMENTATION_STEPS;
	const tail = [
		...(wikiGate && wikiBeforeArchive
			? ["core.wiki", "core.wiki-approval"]
			: []),
		"core.archive",
		...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
		"core.delivery",
		"core.completed",
		"core.closed",
	];
	return [
		{
			id: "openspec-jev",
			version,
			label: "Openspec (JEV)",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
				"core.plan-approval",
				"core.model-selection",
				...common,
				...tail,
			],
			edges: [
				{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
				{
					from: "core.plan",
					outcome: "blocked",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan",
					outcome: "failed",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.model-selection",
				},
				{
					from: "core.plan-approval",
					outcome: "reject",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.plan-approval",
					outcome: "comments",
					to: "core.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.model-selection",
					outcome: "complete",
					to: "core.implementation",
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-jev-apply",
			version,
			label: "Openspec apply (JEV)",
			initial: "core.model-selection",
			terminal: ["core.closed"],
			steps: ["core.model-selection", ...common, ...tail],
			edges: [
				{
					from: "core.model-selection",
					outcome: "complete",
					to: "core.implementation",
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
	];
}
