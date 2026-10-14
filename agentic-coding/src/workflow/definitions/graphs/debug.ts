// The `debug` family (add-debug-workflow): a standalone investigation on a
// chosen branch. An agent reproduces a behavior in a **detached** worktree —
// the selected branch may be checked out elsewhere and is never modified — and
// reports; the developer approves the report or asks for a bounded follow-up
// investigation. Nothing is delivered, archived or pushed: completion holds the
// workflow until the developer closes it, which releases the apps it held and
// removes the worktree.
import type { WorkflowManifest } from "../../registry.ts";

export function debugManifests(version: number): WorkflowManifest[] {
	return [
		{
			id: "debug",
			version,
			label: "Debug",
			initial: "debug.investigate",
			terminal: ["core.closed"],
			steps: [
				"debug.investigate",
				"debug.review",
				"core.completed",
				"core.closed",
			],
			// The family delivers nothing, so completion offers close only: it
			// holds in `core.completed` until the developer closes it.
			allowedOutcomes: { "core.completed": ["close"] },
			policy: {
				targetKind: "repository",
				// The investigation runs in its own detached worktree, never the
				// repository checkout, so `checkoutRequired` stays false.
				checkoutRequired: false,
				requiresReadOnlyResearcher: false,
				traits: {
					changeArtifacts: "none",
					planning: "none",
					changeIdentity: "none",
					delivery: "none",
					startRequirements: ["branch", "task"],
					openspecVerifier: false,
				},
			},
			edges: [
				{
					from: "debug.investigate",
					outcome: "complete",
					to: "debug.review",
				},
				// A blocked or failed investigation is retried like every other
				// agent step; past the limit the engine parks the workflow in
				// attention-required instead of looping forever.
				{
					from: "debug.investigate",
					outcome: "blocked",
					to: "debug.investigate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "debug.investigate",
					outcome: "failed",
					to: "debug.investigate",
					loop: { maxAttempts: 3 },
				},
				{
					from: "debug.review",
					outcome: "approve",
					to: "core.completed",
				},
				// The follow-up cycle carries its budget on the edge that closes it:
				// five investigation rounds with the developer's comment, then the
				// engine parks the workflow for the developer instead of looping.
				{
					from: "debug.review",
					outcome: "comments",
					to: "debug.investigate",
					loop: { maxAttempts: 5 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
