// Hosted stage testing on one pinned (test) stage, followed by an evidence
// report review. Wiki authoring is reachable only through the explicit
// report-review action.
//
// Three tiers are registered from this module and each keeps its own graph, so
// a workflow pinned to an earlier one still resolves and completes:
// - `rounds + 1001`: the plan gate (`stage.plan` -> `stage.plan-review`);
// - `rounds + 1100`: the same graph plus review-approval block promotion;
// - `rounds + 1200` (`remove-stage-test-planner`): one agent and one execution
//   step — the tester explores the stage and decides its own expectations, so
//   there is no plan step, no plan review and no replay step.
import type { WorkflowManifest } from "../../registry.ts";

/** One manifest for the pinned-stage family. `authoredBlocks` adds the
 * review-approval promotion of the run's authored block drafts
 * (`author-stage-blocks-as-data`); `exploration` drops the plan gate
 * (`remove-stage-test-planner`). Both are parameters rather than edits because a
 * registered version's digest covers the whole manifest — including the edge
 * order — so a new tier has to be registered beside the old ones and the old
 * ones must stay byte-identical to their stored digests. */
export function stageTestManifests(
	version: number,
	authoredBlocks = false,
	exploration = false,
): WorkflowManifest[] {
	if (exploration) return [explorationManifest(version, authoredBlocks)];
	const promote = authoredBlocks
		? [
				{
					kind: "stage.blocks.promote" as const,
					idempotencyKey: "stage-blocks-promote",
					payload: {},
				},
			]
		: undefined;
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
			policy: STAGE_TEST_POLICY(),
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
				...reportReviewEdges(promote),
			],
		},
	];
}

/** The manifest policy every tier of the family declares. A function because
 * each manifest owns its own frozen copy. */
function STAGE_TEST_POLICY(): WorkflowManifest["policy"] {
	return {
		targetKind: "stage-test",
		checkoutRequired: false,
		requiresReadOnlyResearcher: false,
	};
}

/** The report-review tail every tier shares: approval (with the block
 * promotion when the tier carries it), the optional wiki step and its own
 * approval, then completion. */
function reportReviewEdges(
	promote: WorkflowManifest["edges"][number]["effects"],
): WorkflowManifest["edges"] {
	return [
		{
			from: "stage.review",
			outcome: "approve",
			to: "core.completed",
			...(promote === undefined ? {} : { effects: promote }),
		},
		{
			from: "stage.review",
			outcome: "approve-and-update-wiki",
			to: "core.wiki",
			...(promote === undefined ? {} : { effects: promote }),
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
	];
}

/** The one-agent tier (`remove-stage-test-planner`): the tester is the only
 * agent, so the graph has one execution step and no plan gate. The routing step
 * that selects its model is derived from the initial step
 * (`withPerStepRouting`), exactly like every other classifiable step. */
function explorationManifest(
	version: number,
	authoredBlocks: boolean,
): WorkflowManifest {
	const promote = authoredBlocks
		? [
				{
					kind: "stage.blocks.promote" as const,
					idempotencyKey: "stage-blocks-promote",
					payload: {},
				},
			]
		: undefined;
	return {
		id: "stage-test",
		version,
		label: "Stage test",
		initial: "stage.execute",
		terminal: ["core.closed"],
		steps: [
			"stage.execute",
			"stage.review",
			"core.wiki",
			"core.wiki-approval",
			"core.completed",
			"core.closed",
		],
		allowedOutcomes: {
			"stage.execute": ["complete", "blocked", "failed"],
			"stage.review": ["approve", "approve-and-update-wiki", "comments"],
			"core.wiki": ["complete", "blocked", "failed"],
			"core.wiki-approval": ["approve", "comments"],
			"core.completed": ["close"],
		},
		policy: STAGE_TEST_POLICY(),
		edges: [
			{ from: "stage.execute", outcome: "complete", to: "stage.review" },
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
			...reportReviewEdges(promote),
		],
	};
}
