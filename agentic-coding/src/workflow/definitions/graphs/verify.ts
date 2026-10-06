// The verify-only family: verification of the current branch against the
// configured base branch, entered without a planning or implementation phase.
//
// The loop it enters is the standard one — `core.verification` → worker →
// `core.verification` — but its fix edge lands on a developer findings review
// instead of straight on the worker, because there is no implementation work
// the engine could infer: the round's findings (critical ones included) are the
// developer's to select from, and the worker only fixes what was selected.
// There is no plan, review gate, wiki, archive, or delivery step; completion
// offers `close` only.
import type { WorkflowManifest } from "../../registry.ts";

export function verifyManifests(
	rounds: number,
	version: number,
	stageGates = false,
): WorkflowManifest[] {
	return [
		{
			id: "verify",
			version,
			label: "Verify",
			// The per-round classifier pass decides the verifier roles (and,
			// under an automatic verification gate, whether the round runs at
			// all). `withPerStepRouting` inserts the model-routing steps for
			// triage, verification, and the worker in the newest tier.
			initial: "core.triage-route",
			terminal: ["core.closed"],
			steps: [
				"core.triage-route",
				"core.triage",
				"core.verification",
				"core.findings-review",
				"core.implementation",
				"core.completed",
				"core.closed",
			],
			allowedOutcomes: {
				"core.completed": ["close"],
			},
			edges: [
				{ from: "core.triage-route", outcome: "complete", to: "core.triage" },
				// An empty role selection bypasses triage for a full-suite-only
				// round, exactly as it does in the shared implementation loop.
				{
					from: "core.triage-route",
					outcome: "empty",
					to: "core.verification",
				},
				// The verification gate's skip means the classifier judged this
				// change to need no verification: a verify-only workflow then has
				// nothing left to do. Present only in the tiers whose
				// `core.triage-route` declares the outcome.
				...(stageGates
					? [
							{
								from: "core.triage-route",
								outcome: "skip-verification",
								to: "core.completed",
							},
						]
					: []),
				{ from: "core.triage", outcome: "complete", to: "core.verification" },
				{
					from: "core.triage",
					outcome: "blocked",
					to: "core.triage",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.triage",
					outcome: "failed",
					to: "core.triage",
					loop: { maxAttempts: 3 },
				},
				// Both verdicts land on the review: a passing round still has
				// advisory findings the developer may want fixed, and a failing one
				// has the critical findings that must be selected explicitly.
				{
					from: "core.verification",
					outcome: "pass",
					to: "core.findings-review",
				},
				{
					from: "core.verification",
					outcome: "fix",
					to: "core.findings-review",
					// The standard bounded fix budget: after `rounds` review-and-fix
					// rounds the workflow parks in attention-required instead of
					// looping forever.
					loop: { maxAttempts: rounds },
				},
				{
					from: "core.verification",
					outcome: "limit",
					to: "core.verification",
					loop: { maxAttempts: 1 },
				},
				{
					from: "core.verification",
					outcome: "blocked",
					to: "core.verification",
					loop: { maxAttempts: 3 },
				},
				{
					from: "core.verification",
					outcome: "failed",
					to: "core.verification",
					loop: { maxAttempts: 3 },
				},
				// Approving the findings ends the workflow; requesting changes
				// enters the standard worker loop, which re-runs verification.
				{
					from: "core.findings-review",
					outcome: "approve",
					to: "core.completed",
				},
				{
					from: "core.findings-review",
					outcome: "comments",
					to: "core.implementation",
					// This is the edge that closes the review-and-fix cycle, so it carries
					// the loop declaration the registry requires of a cycle-closing edge.
					// The budget matches the verification fix budget: both counters advance
					// once per round, and `core.verification`'s `limit` verdict parks the
					// workflow at the same round rather than looping forever.
					loop: { maxAttempts: rounds },
				},
				{
					from: "core.implementation",
					outcome: "complete",
					to: "core.triage-route",
					// The worker's edge back into the round is what closes this graph's
					// review-and-fix cycle, so it carries the loop declaration the registry
					// requires of a cycle-closing edge. Same budget as the verification fix
					// edge: both counters advance once per round, and the `limit` verdict
					// parks the workflow at that round first.
					loop: { maxAttempts: rounds },
				},
				{
					from: "core.implementation",
					outcome: "blocked",
					to: "core.implementation",
					loop: { maxAttempts: 6 },
				},
				{
					from: "core.implementation",
					outcome: "failed",
					to: "core.implementation",
					loop: { maxAttempts: 6 },
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			] as const,
		},
	];
}
