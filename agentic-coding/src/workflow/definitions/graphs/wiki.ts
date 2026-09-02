// The standalone wiki-editing family: `wiki` (repository-backed, with an
// approval gate) and `wiki-comments` (centralized wiki target, single-step
// close). Both are only registered while wikiGate is enabled. Moved
// verbatim out of definitions.ts's `manifests()`
// (split-workflow-god-modules).
import type { WorkflowManifest } from "../../registry.ts";

export function wikiManifests(
	version: number,
	wikiGate: boolean,
): WorkflowManifest[] {
	if (!wikiGate) return [];
	return [
		{
			id: "wiki",
			version,
			label: "Wiki",
			initial: "core.wiki",
			terminal: ["core.closed"],
			steps: [
				"core.wiki",
				"core.wiki-approval",
				"core.completed",
				"core.closed",
			],
			allowedOutcomes: { "core.completed": ["close"] },
			edges: [
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
		{
			id: "wiki-comments",
			version,
			label: "Wiki Comments",
			initial: "core.wiki",
			terminal: ["core.closed"],
			steps: ["core.wiki", "core.completed", "core.closed"],
			allowedOutcomes: { "core.completed": ["close"] },
			edges: [
				{
					from: "core.wiki",
					outcome: "complete",
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
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
