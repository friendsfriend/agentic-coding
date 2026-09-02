import type { StepBehavior } from "./types.ts";
import { validateArchiveEvidence } from "./validation.ts";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;
/** Definitions whose `core.completed` never offers `create-pr`: proposal-only
 * workflows never reach delivery, and the wiki/research workflows have
 * nothing to push as a repository pull request. */
const CLOSE_ONLY_DEFINITIONS = [
	"openspec-propose",
	"openspec-fusion-propose",
	"wiki",
	"wiki-comments",
	"research",
];

export const lifecycleBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan-approval": {
		developerActions: () => [
			{ id: "approve-plan", label: "Approve plan", confirmation: "confirm" },
			{
				id: "review-comments",
				label: "Request plan changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
			},
			{
				id: "reject-plan",
				label: "Reject plan",
				confirmation: "reason",
				input: { schemaId: "core.plan-rejection", schemaVersion: 1 },
			},
		],
	},
	"core.developer-review": {
		developerActions: () => [
			{
				id: "approve-review",
				label: "Approve change",
				confirmation: "confirm",
			},
			{
				id: "review-comments",
				label: "Request changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
			},
		],
	},
	"core.wiki-approval": {
		developerActions: () => [
			{ id: "approve-wiki", label: "Approve wiki", confirmation: "confirm" },
			{
				id: "review-comments",
				label: "Request wiki changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
			},
		],
		producesWikiVerificationContext: true,
	},
	"core.delivery": {
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
		roles: () => ["archive"],
		candidateRoles: () => ["archive"],
		validateEvidence: ({ snapshot }) => validateArchiveEvidence(snapshot),
		acceptsCommentsContext: true,
	},
};
