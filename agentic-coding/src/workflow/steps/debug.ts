// The `debug` family's step behaviors (add-debug-workflow).
//
// The family is two steps and two lifecycle bookkeepers: an agent reproduces a
// behavior on a detached worktree and reports, and the developer either
// approves the report or asks for a bounded follow-up investigation. Nothing is
// delivered and nothing is archived; a completed workflow is held until the
// developer closes it, which releases the apps it held.
import type { StepBehavior } from "./types.ts";

export const DEBUG_ROLE = "debug";
/** The report artifact the engine writes from the agent's output. */
export const DEBUG_REPORT_FILE = "debug-report.md";
/** The patch artifact the engine writes when the detached worktree is dirty. */
export const DEBUG_PATCH_FILE = "changes.patch";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;

export const debugBehaviors: Readonly<Record<string, StepBehavior>> = {
	"debug.investigate": {
		classification: "single",
		roles: () => [DEBUG_ROLE],
		candidateRoles: () => [DEBUG_ROLE],
		instructionAssetForRole: () => "debug.md",
		// The developer's follow-up comment arrives as this step's context on the
		// next attempt, exactly like the env-setup author's review comments: the
		// bounded `comments` edge re-enters this step and the step carries the
		// output forward.
		carriesOutputContext: true,
		acceptsCommentsContext: true,
		assignmentInputs: ({ snapshot }) => ({
			objective: `Investigate "${snapshot.metadata.task ?? "the reported behavior"}" on branch ${snapshot.metadata.branch} and report what you found.`,
			introLines: [
				`Branch (checked out detached in this worktree, never modified on the branch itself): ${snapshot.metadata.branch}`,
				snapshot.metadata.app
					? `Configured app under investigation: ${snapshot.metadata.app}.`
					: "No app was named: pick the repository's configured app from `env_list` (a repository that maps to several apps requires the developer to name one).",
				"The full markdown report is the `report` field of your output artifact; the engine writes it to `debug-report.md`.",
				"Edits you make are preserved as `changes.patch` evidence when you hand off, so this worktree can be removed without losing them.",
			],
			permissions: [
				"reproduce and probe the running app with the env, browser and debug tools",
				"edit the checkout to probe or to prove a candidate fix",
				"attach evidence only when it shows the problem or the fix",
				"stop the apps you started when you are done; another workflow may be waiting",
			],
			checks: [
				"the reported behavior is reproduced (or its irreproducibility is stated)",
				"every finding names the evidence id that shows it",
				"the report carries every required heading",
				"nothing was committed, switched or landed on a branch",
			],
		}),
	},
	"debug.review": {
		developerActions: () => [
			{
				id: "approve-review",
				label: "Approve report",
				confirmation: "confirm" as const,
				requiresInput: true,
			},
			{
				id: "review-comments",
				label: "Request follow-up",
				confirmation: "confirm" as const,
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
		],
	},
};
