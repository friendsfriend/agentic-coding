// The standard OpenSpec family: full explore-through-close, propose-only,
// and the reduced apply-only graph. Moved verbatim out of definitions.ts's
// `manifests()` (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { COMMON_IMPLEMENTATION_STEPS } from "../steps.ts";

export function openspecManifests(
	rounds: number,
	version: number,
	wikiGate: boolean,
	wikiBeforeArchive: boolean,
): WorkflowManifest[] {
	const common = COMMON_IMPLEMENTATION_STEPS;
	return [
		{
			id: "openspec-full",
			version,
			label: "Openspec",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
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
					to: "core.implementation",
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
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-propose",
			version,
			label: "Openspec Propose Only",
			initial: "core.plan",
			terminal: ["core.closed"],
			steps: [
				"core.plan",
				"core.plan-approval",
				"core.completed",
				"core.closed",
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
					to: "core.completed",
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
					from: "core.completed",
					outcome: "create-pr",
					to: "core.completed",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		},
		{
			id: "openspec-apply",
			version,
			label: "Openspec apply",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: [
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
			edges: workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
		},
	];
}
