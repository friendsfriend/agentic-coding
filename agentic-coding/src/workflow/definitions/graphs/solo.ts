// The solo family: one implementation agent, start to finish. No planning,
// triage, verification, wiki, review gate, or delivery — the agent applies the
// assigned task, hands off, and the workflow is completed. The two steps after
// the agent are lifecycle bookkeeping only: `core.completed` marks the status
// completed and offers the developer `close`, and `core.closed` runs the
// workspace teardown every family uses.
import type { WorkflowManifest } from "../../registry.ts";

export function soloManifests(version: number): WorkflowManifest[] {
	return [
		{
			id: "solo",
			version,
			label: "Solo",
			initial: "core.implementation",
			terminal: ["core.closed"],
			steps: ["core.implementation", "core.completed", "core.closed"],
			// Booking first: a solo workflow has nothing to deliver, so its
			// completion step offers close instead of create-pr.
			allowedOutcomes: {
				"core.completed": ["close"],
			},
			edges: [
				{
					from: "core.implementation",
					outcome: "complete",
					to: "core.completed",
				},
				// A blocked or failed solo agent gets the same bounded retry every
				// other implementation loop gives it; past the limit the engine
				// parks the workflow in attention-required.
				{
					from: "core.implementation",
					outcome: "blocked",
					to: "core.implementation",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.implementation",
					outcome: "failed",
					to: "core.implementation",
					loop: { maxAttempts: 3 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
