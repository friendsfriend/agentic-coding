import type { ChangeRequest } from "@devenv/types";

/**
 * Builds the default review prompt shown to the user before they start the
 * review. The server appends the inline-comment callback instructions
 * automatically, so this just describes what the agent should review.
 */
export function buildCrReviewPrompt(cr: ChangeRequest): string {
	const descLine = cr.description?.trim()
		? `\nDescription: ${cr.description.trim()}`
		: "";

	return `You are reviewing a change request. You are already inside the feature branch worktree.

CR: ${cr.title}
Branch: ${cr.source_branch} → ${cr.target_branch}
Author: ${cr.author?.name ?? "unknown"} (@${cr.author?.username ?? "unknown"})${descLine}

Start by running:
  git diff origin/${cr.target_branch}...HEAD

Review all changes and provide a structured code review. Browse relevant files for additional context as needed.`;
}
