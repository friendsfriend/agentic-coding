/** @jsxImportSource @opentui/solid */
// Destructive workflow confirmation (workspace sidebar `d`).
//
// Deleting a workflow is irreversible and spans two boundaries — the workflow
// store and the worktree directory — so it is never one keypress: this dialog
// names the workflow, states what goes and what stays, and leaves the answer to
// the shell's key dispatcher. It renders no keys of its own; the footer help
// advertises the two answers.
import { TextAttributes } from "@opentui/core";
import { GenericModal, uiColors } from "@ui";
import type { WorkflowOverview } from "../../../contracts/workflow.ts";
import { workflowDisplayName, workflowMeta } from "../app/sidebar-model.ts";

export function DeleteWorkflowModal(props: { overview: WorkflowOverview }) {
	return (
		<GenericModal
			title="Delete workflow?"
			widthPercent={0.6}
			heightLines={11}
			zIndex={20}
			help={[
				{ key: "y", action: "Delete the workflow and its worktree" },
				{ key: "n", action: "Keep it" },
			]}
			helpSections={false}
		>
			<box flexDirection="column" gap={1}>
				<text fg={uiColors.textPrimary}>
					{workflowDisplayName(props.overview)}
				</text>
				<text fg={uiColors.textSecondary}>{workflowMeta(props.overview)}</text>
				<text fg={uiColors.textMuted} attributes={TextAttributes.DIM}>
					Its stored state and worktree directory are removed. The branch is
					kept, so the committed work stays reviewable.
				</text>
			</box>
		</GenericModal>
	);
}
