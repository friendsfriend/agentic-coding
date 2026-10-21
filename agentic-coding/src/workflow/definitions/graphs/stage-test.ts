// Hosted stage testing with an engine-owned plan gate and an evidence report
// review. Wiki authoring is reachable only through the explicit report-review action.
import type { WorkflowManifest } from "../../registry.ts";

export function stageTestManifests(version: number): WorkflowManifest[] {
	return [
		{
			id: "stage-test",
			version,
			label: "Stage test",
			initial: "stage.plan",
			terminal: ["core.closed"],
			steps: [
				"stage.plan",
				"stage.plan-review",
				"stage.execute",
				"stage.replay",
				"stage.review",
				"core.wiki",
				"core.wiki-approval",
				"core.completed",
				"core.closed",
			],
			allowedOutcomes: {
				"stage.plan": ["needs-approval", "execute", "blocked", "failed"],
				"stage.plan-review": ["approve", "approve-and-replay", "comments"],
				"stage.execute": ["complete", "blocked", "failed"],
				"stage.replay": ["complete", "failed", "fallback"],
				"stage.review": ["approve", "approve-and-update-wiki", "comments"],
				"core.wiki": ["complete", "blocked", "failed"],
				"core.wiki-approval": ["approve", "comments"],
				"core.completed": ["close"],
			},
			policy: {
				targetKind: "stage-test",
				checkoutRequired: false,
				requiresReadOnlyResearcher: false,
			},
			edges: [
				{
					from: "stage.plan",
					outcome: "needs-approval",
					to: "stage.plan-review",
				},
				{ from: "stage.plan", outcome: "execute", to: "stage.execute" },
				{
					from: "stage.plan",
					outcome: "blocked",
					to: "stage.plan",
					loop: { maxAttempts: 3 },
				},
				{
					from: "stage.plan",
					outcome: "failed",
					to: "stage.plan",
					loop: { maxAttempts: 3 },
				},
				{ from: "stage.plan-review", outcome: "approve", to: "stage.execute" },
				{
					from: "stage.plan-review",
					outcome: "approve-and-replay",
					to: "stage.replay",
				},
				{
					from: "stage.plan-review",
					outcome: "comments",
					to: "stage.plan",
					loop: { maxAttempts: 3 },
				},
				{ from: "stage.execute", outcome: "complete", to: "stage.review" },
				{ from: "stage.replay", outcome: "complete", to: "stage.review" },
				{ from: "stage.replay", outcome: "failed", to: "stage.execute" },
				{ from: "stage.replay", outcome: "fallback", to: "stage.execute" },
				{
					from: "stage.execute",
					outcome: "blocked",
					to: "stage.execute",
					loop: { maxAttempts: 3 },
				},
				{
					from: "stage.execute",
					outcome: "failed",
					to: "stage.execute",
					loop: { maxAttempts: 3 },
				},
				{ from: "stage.review", outcome: "approve", to: "core.completed" },
				{
					from: "stage.review",
					outcome: "approve-and-update-wiki",
					to: "core.wiki",
				},
				{
					from: "stage.review",
					outcome: "comments",
					to: "stage.execute",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
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
						{ kind: "wiki.verify", idempotencyKey: "wiki.verify", payload: {} },
					],
				},
				{
					from: "core.wiki-approval",
					outcome: "comments",
					to: "core.wiki",
					loop: { maxAttempts: 6 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		},
	];
}
