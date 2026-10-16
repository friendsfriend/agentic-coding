// The `env-setup` family: an agent authors build/test/run and infrastructure
// definitions as drafts, the system validates them by discovering, compiling
// and starting them, the developer approves a diff of the drafts against the
// live configuration, and the system promotes them atomically.
//
// Nothing an agent writes becomes runnable before the approval gate, and the
// repository is read-only evidence throughout: the drafts live outside the
// checkout, in the configuration directory's `.drafts/env-setup/<id>`.
import type { WorkflowManifest } from "../../registry.ts";

/**
 * The family's manifests. `smoke` adds the post-promotion smoke check, its
 * developer review and the rollback behind it
 * (`staged-env-setup-config-root`).
 *
 * The flag exists because a manifest's digest covers the whole document:
 * changing this graph unconditionally would move every *registered* env-setup
 * version's digest and strand every workflow already pinned to one
 * (`registry.ts`'s `digest()`), so the new steps arrive as a new tier
 * (`definitionVersionForStagedRoot`) while every earlier tier keeps the graph it
 * published.
 */
export function envSetupManifests(
	version: number,
	smoke = false,
): WorkflowManifest[] {
	return [
		{
			id: "env-setup",
			version,
			label: "Environment setup",
			initial: "setup.author",
			terminal: ["core.closed"],
			steps: [
				"setup.author",
				"setup.validate",
				"setup.approval",
				"setup.promote",
				...(smoke
					? ["setup.smoke", "setup.smoke.review", "setup.rollback"]
					: []),
				"core.completed",
				"core.closed",
			],
			// The family delivers nothing to the app repository: completion offers
			// close only.
			allowedOutcomes: { "core.completed": ["close"] },
			policy: {
				targetKind: "repository",
				// The drafts are outside the checkout and the checkouts stay
				// untouched, so the workflow runs against the repository checkout
				// itself (never a worktree).
				checkoutRequired: true,
				requiresReadOnlyResearcher: false,
				traits: {
					changeArtifacts: "none",
					planning: "none",
					changeIdentity: "none",
					delivery: "none",
					startRequirements: ["clean-tree"],
					openspecVerifier: false,
				},
			},
			edges: [
				{
					from: "setup.author",
					outcome: "complete",
					to: "setup.validate",
				},
				// A blocked or failed author is retried like every other agent step;
				// past the limit the engine parks the workflow in attention-required.
				{
					from: "setup.author",
					outcome: "blocked",
					to: "setup.author",
					loop: { maxAttempts: 3 },
				},
				{
					from: "setup.author",
					outcome: "failed",
					to: "setup.author",
					loop: { maxAttempts: 3 },
				},
				{
					from: "setup.validate",
					outcome: "complete",
					to: "setup.approval",
				},
				// The cycle-closing edge carries the budget: five validation rounds,
				// each returning the failure report to the author, then the engine
				// parks the workflow for the developer instead of looping forever.
				{
					from: "setup.validate",
					outcome: "failed",
					to: "setup.author",
					loop: { maxAttempts: 5 },
				},
				{
					from: "setup.approval",
					outcome: "approve",
					to: "setup.promote",
				},
				{
					from: "setup.approval",
					outcome: "comments",
					to: "setup.author",
					loop: { maxAttempts: 6 },
				},
				...(smoke
					? [
							{
								from: "setup.promote",
								outcome: "complete" as const,
								to: "setup.smoke",
							},
						]
					: [
							{
								from: "setup.promote",
								outcome: "complete" as const,
								to: "core.completed",
							},
						]),
				// A promotion failure restores the live configuration and retries through
				// the bounded loop; when the budget is spent the engine parks the
				// workflow for the developer with the rollback result.
				{
					from: "setup.promote",
					outcome: "failed",
					to: "setup.promote",
					loop: { maxAttempts: 3 },
				},
				// The smoke check is only reachable from the promotion's success edge,
				// which is only reachable from the approval edge: nothing here can run
				// before the developer approved. The developer either rolls the promotion
				// back (the live configuration is restored from its own backup and the
				// author resumes) or keeps it with the failed check recorded.
				...(smoke
					? [
							{
								from: "setup.smoke",
								outcome: "complete" as const,
								to: "core.completed",
							},
							{
								from: "setup.smoke",
								outcome: "failed" as const,
								to: "setup.smoke.review",
							},
							{
								from: "setup.smoke.review",
								outcome: "rollback-promotion" as const,
								to: "setup.rollback",
							},
							{
								from: "setup.smoke.review",
								outcome: "accept-smoke-failure" as const,
								to: "core.completed",
							},
							// A rollback returns the author to its staged root with the rollback
							// report as context (bounded); a rollback that cannot be proven retries
							// a bounded number of times and then parks the workflow.
							{
								from: "setup.rollback",
								outcome: "complete" as const,
								to: "setup.author",
								loop: { maxAttempts: 5 },
							},
							{
								from: "setup.rollback",
								outcome: "failed" as const,
								to: "setup.rollback",
								loop: { maxAttempts: 3 },
							},
						]
					: []),
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
