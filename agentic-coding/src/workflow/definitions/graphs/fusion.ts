// The fusion family: multiple explorers consolidating to one plan, either
// through to close or reduced to propose-only. Moved verbatim out of
// definitions.ts's `manifests()` (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { COMMON_IMPLEMENTATION_STEPS } from "../steps.ts";

export function fusionManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
	wikiBeforeArchive: boolean,
): WorkflowManifest[] {
	const common = COMMON_IMPLEMENTATION_STEPS;
	return [
		{
			id: "openspec-fusion-full",
			version,
			label: "Openspec fusion",
			initial: "fusion.plan",
			terminal: ["core.closed"],
			steps: [
				"fusion.plan",
				"fusion.consolidate",
				"core.plan-approval",
				...common,
				...(wikiGate && wikiBeforeArchive
					? ["core.wiki", "core.wiki-approval"]
					: []),
				"core.archive",
				...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
				"core.delivery",
				"core.completed",
				"core.closed",
			],
			edges: [
				{
					from: "fusion.plan",
					outcome: "complete",
					to: "fusion.consolidate",
				},
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
					to: "core.plan-approval",
				},
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
				{
					from: "core.plan-approval",
					outcome: "approve",
					to: "core.implementation",
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
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-fusion-propose",
			version,
			label: "Openspec fusion propose",
			initial: "fusion.plan",
			terminal: ["core.closed"],
			steps: [
				"fusion.plan",
				"fusion.consolidate",
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
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
					to: "core.plan-approval",
				},
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
