import type { ActionRun } from "./action-run";

/**
 * Single source of truth for translating an ActionRun's machine `action` key
 * into a human label. Components must use this table (and the helpers below)
 * instead of inventing their own ad hoc capitalization/formatting logic.
 */
export const ACTION_TYPE_LABELS: Record<string, string> = {
	run: "Start",
	start: "Start",
	build: "Build",
	test: "Test",
	stop: "Stop",
	"task.run": "Run task",
	"git.pull": "Git pull",
	"git.push": "Git push",
	"git.fetch": "Git fetch",
	"git.checkout": "Git checkout",
	"git.worktree.create": "Create worktree",
	"git.worktree.remove": "Remove worktree",
	"kubernetes.cluster.create": "Create Kubernetes cluster",
	"kubernetes.cluster.delete": "Delete Kubernetes cluster",
	"kubernetes.cluster.recreate": "Recreate Kubernetes cluster",
	"kubernetes.cluster.export": "Export Kubernetes kubeconfig",
	"docker.container.start": "Start container",
	"docker.container.stop": "Stop container",
	"docker.container.restart": "Restart container",
};

/** Title-cases an unrecognized machine action key as a last-resort fallback. */
function titleCaseActionKey(action: string): string {
	return action
		.split(/[._-]/)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

/** Resolves an action machine key into its unified human label. */
export function actionTypeLabel(action?: string): string {
	if (!action) return "";
	return ACTION_TYPE_LABELS[action] ?? titleCaseActionKey(action);
}

// Actions where the server title repeats the app's full display name; the
// tree/log/strip rows read better composed as "<Action> <target>" instead.
const targetedActions = new Set(["run", "start", "build", "test"]);

/**
 * Single source of truth for how an action run's row/tree/strip label is
 * rendered. Always prefers the server-provided title (rich, always present
 * for supported operations) and only falls back to composing one from the
 * action type + target when no title is available.
 *
 * `formatProfileLabel` is injected rather than imported to avoid a
 * types -> ui dependency cycle (formatProfileLabel lives in @devenv/ui).
 */
export function actionRunDisplayLabel(
	run: Pick<
		ActionRun,
		"title" | "action" | "targetLabel" | "profile" | "appIdent"
	>,
	formatProfileLabel: (profile?: string) => string,
): string {
	const title = run.title?.trim();
	if (title) {
		if (!targetedActions.has(run.action ?? "")) return title;
		const label = actionTypeLabel(run.action);
		return label
			? `${label} ${run.targetLabel || formatProfileLabel(run.profile)}`
			: title;
	}
	return [actionTypeLabel(run.action), run.targetLabel ?? run.appIdent]
		.filter(Boolean)
		.join(" ");
}
