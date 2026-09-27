// The standard OpenSpec family: full classify-through-close, propose-only, and
// the reduced apply-only graph (classifier-driven-model-pools). Every graph
// that reaches implementation starts at the routing phase it needs; the
// `core.plan`/apply pools resolve through `core.route-plan`/`core.route-apply`.
import type { WorkflowManifest } from "../../registry.ts";
import { workflowEdges } from "../edges.ts";
import { commonImplementationSteps } from "../steps.ts";

export function openspecManifests(
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
	/** The plan gate mirrors its definition's own approval target: a skip is
	 * shape-identical to an approval, so the propose flows complete without
	 * ever creating an implementation, verification, or archive effect. */
	const planGateEdges = (approvalTarget: string): WorkflowManifest["edges"] =>
		stageGates
			? ([
					{ from: "core.plan-gate", outcome: "run", to: "core.plan-approval" },
					{ from: "core.plan-gate", outcome: "skip", to: approvalTarget },
				] as const)
			: [];
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
				...(stageGates ? ["core.plan-gate"] : []),
				"core.plan-approval",
				"core.route-apply",
				...common,
				...tail,
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.route-plan", outcome: "complete", to: "core.plan" },
				{
					from: "core.plan",
					outcome: "complete",
					to: stageGates ? "core.plan-gate" : "core.plan-approval",
				},
				...planGateEdges("core.route-apply"),
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
			id: "openspec-propose",
			version,
			label: "Openspec Propose Only",
			initial: "core.route-plan",
			terminal: ["core.closed"],
			steps: [
				"core.route-plan",
				"core.plan",
				...(stageGates ? ["core.plan-gate"] : []),
				"core.plan-approval",
				"core.completed",
				"core.closed",
			],
			edges: [
				{ from: "core.route-plan", outcome: "complete", to: "core.plan" },
				{
					from: "core.plan",
					outcome: "complete",
					to: stageGates ? "core.plan-gate" : "core.plan-approval",
				},
				...planGateEdges("core.completed"),
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
