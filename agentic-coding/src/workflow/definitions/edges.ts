// The shared implementation-loop edge builder used by every workflow family
// that runs core.implementation through core.developer-review (openspec,
// no-openspec, fusion), plus the wikiGate=false legacy-tier version helper.
// Moved verbatim out of definitions.ts (split-workflow-god-modules).
import type { WorkflowManifest } from "../registry.ts";

export function definitionVersionForPolicy(rounds: number): number {
	return rounds + 100;
}

export function workflowEdges(
	archive: boolean,
	maxVerificationRounds: number,
	wikiGate = true,
	wikiBeforeArchive = true,
): WorkflowManifest["edges"] {
	const approved = archive
		? wikiGate && wikiBeforeArchive
			? "core.wiki"
			: "core.archive"
		: wikiGate
			? "core.wiki"
			: "core.delivery";
	return [
		{ from: "core.implementation", outcome: "complete", to: "core.triage" },
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
		{ from: "core.verification", outcome: "pass", to: "core.developer-review" },
		{
			from: "core.verification",
			outcome: "fix",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
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
			loop: { maxAttempts: maxVerificationRounds },
		},
		{
			from: "core.verification",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{ from: "core.developer-review", outcome: "approve", to: approved },
		{
			from: "core.developer-review",
			outcome: "comments",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		...(archive
			? wikiGate
				? wikiBeforeArchive
					? ([
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
								to: "core.archive",
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
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.delivery",
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
					: ([
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.delivery",
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
								to: "core.archive",
								loop: { maxAttempts: 6 },
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
				: ([
						{ from: "core.archive", outcome: "complete", to: "core.delivery" },
						{
							from: "core.archive",
							outcome: "blocked",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
						{
							from: "core.archive",
							outcome: "failed",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
					] as const)
			: wikiGate
				? ([
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
							to: "core.delivery",
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
					] as const)
				: []),
		{ from: "core.delivery", outcome: "complete", to: "core.completed" },
		{
			from: "core.delivery",
			outcome: "failed",
			to: "core.delivery",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.completed",
			outcome: "create-pr",
			to: "core.completed",
			loop: { maxAttempts: 3 },
		},
		{ from: "core.completed", outcome: "close", to: "core.closed" },
	];
}
