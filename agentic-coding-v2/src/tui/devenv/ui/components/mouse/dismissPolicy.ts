/**
 * Which dialogs a backdrop tap may dismiss (design D5).
 *
 * The rule is data, not a per-caller decision: a dialog names its kind and the
 * shadow layer decides whether a backdrop tap is the same thing `Esc` is. A
 * dialog that holds unsaved draft or secret input, or that performs an
 * irreversible action, is `"explicit"` and keeps its own control.
 */

export type DialogDismissKind =
	// Escape-parity: read-only or reversible, a backdrop tap is the same
	// dismissal the key performs.
	| "help"
	| "theme-picker"
	| "workflow-graph"
	| "findings"
	| "debug-requests"
	| "cost"
	| "repair-target"
	| "completed-action-picker"
	| "plan-rejection"
	| "location-picker"
	| "user-action"
	| "list-picker"
	| "filter"
	| "sort"
	| "markdown-viewer"
	| "artifact-preview"
	| "error-dialog"
	| "agent-session-picker"
	| "trace-detail"
	| "metric-detail"
	| "log-detail"
	| "topology-detail"
	| "settings-picker"
	// Explicit-only: a draft, a secret, a typed answer or an irreversible
	// action keeps an explicit control.
	| "new-workflow"
	| "developer-question"
	| "credentials"
	| "number-editor"
	// A credential typed into the protected `.env` flow: the draft is secret, so
	// the backdrop never dismisses it.
	| "stage-credential"
	| "review"
	| "comment"
	| "review-files"
	| "quit-confirm"
	| "delete-workflow"
	| "close-reason"
	| "confirm"
	| "progress"
	| "action-run"
	| "passphrase"
	| "task-add";

export type DialogDismissMode = "escape" | "explicit";

export const DIALOG_DISMISS_MODES: Record<
	DialogDismissKind,
	DialogDismissMode
> = {
	help: "escape",
	"theme-picker": "escape",
	"workflow-graph": "escape",
	findings: "escape",
	"debug-requests": "escape",
	cost: "escape",
	"repair-target": "escape",
	"completed-action-picker": "escape",
	"plan-rejection": "escape",
	"location-picker": "escape",
	"user-action": "escape",
	"list-picker": "escape",
	filter: "escape",
	sort: "escape",
	"markdown-viewer": "escape",
	"artifact-preview": "escape",
	"error-dialog": "escape",
	"agent-session-picker": "escape",
	"trace-detail": "escape",
	"metric-detail": "escape",
	"log-detail": "escape",
	"topology-detail": "escape",
	"settings-picker": "escape",
	"new-workflow": "explicit",
	"developer-question": "explicit",
	credentials: "explicit",
	"number-editor": "explicit",
	"stage-credential": "explicit",
	review: "explicit",
	comment: "explicit",
	"review-files": "escape",
	"quit-confirm": "explicit",
	"delete-workflow": "explicit",
	"close-reason": "explicit",
	confirm: "explicit",
	progress: "explicit",
	"action-run": "explicit",
	passphrase: "explicit",
	"task-add": "explicit",
};

export interface DialogDismissState {
	/** The dialog holds unsaved typed input. */
	hasDraft?: boolean;
	/** An operation is in flight; dismissal would lose sight of it. */
	running?: boolean;
	/** The dismissal would confirm something irreversible. */
	irreversible?: boolean;
}

/** Whether a backdrop tap on this dialog kind may dismiss it. */
export function backdropDismiss(
	kind: DialogDismissKind,
	state: DialogDismissState = {},
): boolean {
	if (state.hasDraft || state.running || state.irreversible) return false;
	return DIALOG_DISMISS_MODES[kind] === "escape";
}

/** True when a dialog kind keeps its own control instead of a backdrop tap. */
export function isExplicitDismiss(kind: DialogDismissKind): boolean {
	return DIALOG_DISMISS_MODES[kind] === "explicit";
}
