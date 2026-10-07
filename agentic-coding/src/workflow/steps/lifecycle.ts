import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { WorkflowFamilyTraits } from "../registry.ts";
import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateArchiveEvidence,
} from "./validation.ts";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;
/** Documentation families declare no repository traits, and their
 * `core.completed` never offers `create-pr` either: the wiki and research
 * workflows have nothing to push as a repository pull request. They are the
 * holdout list the trait read falls back to, not a repository code-change
 * family (`read-family-traits-instead-of-ids` keeps the documentation
 * families' own id checks by design). */
const DOCUMENTATION_CLOSE_ONLY = new Set(["wiki", "wiki-comments", "research"]);

/** Whether a definition's `core.completed` offers only `close`: every family
 * that delivers no pull request — the proposal-only workflows, which never
 * reach delivery, the single-agent and ref-shaped families, which have nothing
 * to push, and the documentation families. Read from the `delivery` trait
 * instead of a definition-id list; a caller that passes no traits falls back to
 * the catalog table `effectiveFamilyTraits` reads, so every built-in family
 * keeps its behavior. */
function closeOnly(
	definitionId: string,
	traits?: WorkflowFamilyTraits,
): boolean {
	const effective = traits ?? effectiveFamilyTraits({ id: definitionId });
	return effective
		? effective.delivery === "none"
		: DOCUMENTATION_CLOSE_ONLY.has(definitionId);
}

/** The review decision both review steps offer: approve the work, or send the
 * selected findings back to the worker. `core.developer-review` gates a change
 * the worker produced; `core.findings-review` is the verify-only family's entry
 * into that same worker loop, where the findings — including the critical ones
 * that already fail the round — are what the developer selects from. */
const reviewActions = () => [
	{
		id: "approve-review",
		label: "Approve change",
		confirmation: "confirm" as const,
		requiresInput: true,
	},
	{
		id: "review-comments",
		label: "Request changes",
		confirmation: "confirm" as const,
		input: REVIEW_COMMENTS_INPUT,
		requiresInput: true,
	},
];

export const lifecycleBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan-approval": {
		developerActions: () => [
			{
				id: "approve-plan",
				label: "Approve plan",
				confirmation: "confirm",
				requiresInput: true,
			},
			{
				id: "review-comments",
				label: "Request plan changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
			{
				id: "reject-plan",
				label: "Reject plan",
				confirmation: "reason",
				input: { schemaId: "core.plan-rejection", schemaVersion: 1 },
				requiresInput: true,
			},
		],
	},
	"core.developer-review": {
		developerActions: reviewActions,
	},
	// The verify-only family's review: identical actions and input schema, so the
	// dashboard's review popup and its `review-comments` dispatch work unchanged.
	// The difference is the findings it shows (the observation includes critical
	// findings while this step is current) and the graph edge it leaves on.
	"core.findings-review": {
		developerActions: reviewActions,
	},
	"core.wiki-approval": {
		developerActions: () => [
			{
				id: "approve-wiki",
				label: "Approve wiki",
				confirmation: "confirm",
				requiresInput: true,
			},
			{
				id: "review-comments",
				label: "Request wiki changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
		],
		producesWikiVerificationContext: true,
	},
	"core.delivery": {
		onEffectComplete: ({ snapshot, effect }) => {
			if (effect.kind === "delivery.commit")
				return {
					effects: [
						{
							kind: "delivery.push",
							idempotencyKey: `delivery:${snapshot.workflowId}:push`,
							payload: { workflowId: snapshot.workflowId },
						},
					],
				};
			if (effect.kind === "delivery.push")
				return { transition: { outcome: "complete" } };
			return undefined;
		},
		onEnter: ({ snapshot, enqueue }) => {
			enqueue("delivery.commit", `delivery:${snapshot.workflowId}:commit`, {
				workflowId: snapshot.workflowId,
			});
			return undefined;
		},
	},
	"core.completed": {
		onArrive: () => ({ status: "completed" }),
		developerActions: ({ snapshot, traits }) => [
			...(closeOnly(snapshot.definition.id, traits)
				? []
				: [
						{
							id: "create-pr",
							label: "Create pull request",
							confirmation: "confirm" as const,
						},
					]),
			{ id: "close", label: "Close workflow", confirmation: "confirm" },
		],
	},
	"core.closed": {
		onArrive: () => ({ status: "closed" }),
		onEnter: ({ snapshot, enqueue }) => {
			enqueue("workspace.close", `workspace:${snapshot.workflowId}:close`, {
				workflowId: snapshot.workflowId,
			});
			return undefined;
		},
	},
	"core.archive": {
		classification: "single",
		roles: () => ["archive"],
		candidateRoles: () => ["archive"],
		validateEvidence: ({ evidence }) =>
			validateArchiveEvidence(evidence as PreparedStepEvidence),
		acceptsCommentsContext: true,
	},
};
