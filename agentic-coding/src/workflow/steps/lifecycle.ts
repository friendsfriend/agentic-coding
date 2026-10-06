import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateArchiveEvidence,
} from "./validation.ts";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;
/** Definitions whose `core.completed` never offers `create-pr`: proposal-only
 * workflows never reach delivery, the wiki/research workflows have nothing to
 * push as a repository pull request, and a solo workflow has no delivery step
 * to push from. */
const CLOSE_ONLY_DEFINITIONS = [
	"openspec-propose",
	"openspec-fusion-propose",
	"wiki",
	"wiki-comments",
	"research",
	"solo",
	"rebase",
	"verify",
];

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
		developerActions: ({ snapshot }) => [
			...(CLOSE_ONLY_DEFINITIONS.includes(snapshot.definition.id)
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
