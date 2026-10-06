import type { StepBehavior } from "./types.ts";

/** One rebase agent, start to finish. The step's own knowledge is the two refs
 * the workflow selected: the source branch (the branch being rebased, which the
 * engine checked out) and the target ref (`metadata.baseBranch`). Both are
 * validated before the workflow exists and again by `workspace.setup`, so the
 * assignment renders them as fact rather than as something to discover. */
export const rebaseBehavior: StepBehavior = {
	classification: "single",
	roles: () => ["worker"],
	candidateRoles: () => ["worker"],
	assignmentInputs: ({ snapshot }) => ({
		objective: `Rebase ${snapshot.metadata.branch} onto ${snapshot.metadata.baseBranch} in this checkout, resolving every conflict.`,
		introLines: [
			`Source branch (rebased, already checked out): ${snapshot.metadata.branch}`,
			`Target ref (rebased onto): ${snapshot.metadata.baseBranch}`,
			"The engine fetched the target remote and verified both refs before this run started; neither is a free choice.",
		],
		checks: [
			"git rebase finished with no stopped conflict",
			"git status --short prints nothing",
			"the source branch's commits sit on top of the target ref",
		],
		suppressStepInputLine: true,
	}),
	handoffNote: [
		"Finish the run by reporting exactly one outcome with the workflow CLI. A completed rebase reports `complete`; a conflict you could not reconcile without dropping behavior reports `blocked` after `git rebase --abort` restored the branch:",
	],
};
