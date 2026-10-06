// The rebase family: one agent that rebases one selected branch onto another
// and resolves the conflicts. No planning, triage, verification, developer
// review, wiki, delivery or archive — the workflow's whole product is the
// rebased branch in its own checkout, and the two steps after the agent are
// lifecycle bookkeeping only: `core.completed` marks the status completed and
// offers the developer `close`, and `core.closed` runs the teardown every
// family uses (a no-op for a checkout run, which owns no worktree).
import type { WorkflowManifest } from "../../registry.ts";

export function rebaseManifests(version: number): WorkflowManifest[] {
	return [
		{
			id: "rebase",
			version,
			label: "Rebase",
			initial: "core.rebase",
			terminal: ["core.closed"],
			steps: ["core.rebase", "core.completed", "core.closed"],
			// Booking first: a rebase delivers a branch, never a pull request, so
			// completion offers close instead of create-pr.
			allowedOutcomes: {
				"core.completed": ["close"],
			},
			edges: [
				{ from: "core.rebase", outcome: "complete", to: "core.completed" },
				// A blocked or failed rebase agent gets the same bounded retry every
				// other single-agent family gives it; past the limit the engine parks
				// the workflow in attention-required.
				{
					from: "core.rebase",
					outcome: "blocked",
					to: "core.rebase",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.rebase",
					outcome: "failed",
					to: "core.rebase",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
