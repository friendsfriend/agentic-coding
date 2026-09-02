// The standalone research family: research through to an optional wiki
// handoff. Only registered while wikiGate is enabled. Moved verbatim out of
// definitions.ts's `manifests()` (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";

export function researchManifests(
	version: number,
	wikiGate: boolean,
): WorkflowManifest[] {
	if (!wikiGate) return [];
	return [
		{
			id: "research",
			version,
			label: "Research",
			initial: "core.research",
			terminal: ["core.closed"],
			steps: [
				"core.research",
				"core.wiki",
				"core.wiki-approval",
				"core.completed",
				"core.closed",
			],
			allowedOutcomes: {
				"core.research": [
					"blocked",
					"failed",
					"request-wiki",
					"close-research",
				],
				"core.completed": ["close"],
			},
			edges: [
				{
					from: "core.research",
					outcome: "request-wiki",
					to: "core.wiki",
				},
				{
					from: "core.research",
					outcome: "blocked",
					to: "core.research",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.research",
					outcome: "failed",
					to: "core.research",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.research",
					outcome: "close-research",
					to: "core.closed",
				},
				{
					from: "core.wiki",
					outcome: "complete",
					to: "core.wiki-approval",
				},
				{
					from: "core.wiki",
					outcome: "blocked",
					to: "core.wiki",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.wiki",
					outcome: "failed",
					to: "core.wiki",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.wiki-approval",
					outcome: "approve",
					to: "core.completed",
					effects: [
						{
							kind: "wiki.verify",
							idempotencyKey: "wiki.verify",
							payload: {},
						},
					],
				},
				{
					from: "core.wiki-approval",
					outcome: "comments",
					to: "core.wiki",
					loop: { maxAttempts: 6 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
