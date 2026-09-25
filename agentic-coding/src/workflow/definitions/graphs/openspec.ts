// The standard OpenSpec family: full classify-through-close, propose-only, and
// the reduced apply-only graph (classifier-driven-model-pools). Every graph
// that reaches implementation starts at the routing phase it needs; the
// `core.plan`/apply pools resolve through `core.route-plan`/`core.route-apply`.
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
	const tail = [
		...(wikiGate && wikiBeforeArchive
			? ["core.wiki", "core.wiki-approval"]
			: []),
		"core.archive",
		...(wikiGate && !wikiBeforeArchive ? ["core.wiki-approval"] : []),
		"core.delivery",
	];
	return [
		{
			id: "openspec",
			version,
			label: "Openspec",
			initial: "core.route-plan",
			terminal: ["core.closed"],
			steps: [
				"core.route-plan",
				"core.plan",
				"core.plan-approval",
				"core.route-apply",
				...common,
				...tail,
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.route-plan", outcome: "complete", to: "core.plan" },
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
					to: "core.route-apply",
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
					from: "core.route-apply",
					outcome: "complete",
					to: "core.implementation",
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-apply",
			version,
			label: "Openspec apply",
			initial: "core.route-apply",
			terminal: ["core.closed"],
			steps: [
				"core.route-apply",
				...common,
				...tail,
				"core.completed",
				"core.closed",
			],
			edges: [
				{
					from: "core.route-apply",
					outcome: "complete",
					to: "core.implementation",
				},
				...workflowEdges(true, rounds, wikiGate, wikiBeforeArchive),
			],
		},
		{
			id: "openspec-propose",
			version,
			label: "Openspec Propose Only",
			initial: "core.route-plan",
			terminal: ["core.closed"],
			steps: [
				"core.route-plan",
				"core.plan",
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.route-plan", outcome: "complete", to: "core.plan" },
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
	];
}
