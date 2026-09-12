/** @jsxImportSource @opentui/solid */
import { onMount } from "solid-js";
import { uiColors } from "../colors";
import { focusSoon } from "../utils/focusSoon";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";

export interface BranchCreateModalProps {
	/** Current value of the branch name input */
	branchName: string;
	/** Called whenever the input value changes */
	onBranchNameChange: (value: string) => void;
}

/**
 * Modal for creating a new branch or worktree.
 * Keyboard handling (Enter to confirm, Esc to cancel) is done
 * by the parent keyboard handler layer (table-keys.ts).
 */
export function BranchCreateModal(props: BranchCreateModalProps) {
	let inputRef: { focus: () => void } | undefined;

	onMount(() => {
		if (inputRef) {
			focusSoon(inputRef);
		}
	});

	return (
		<GenericModal
			title="Create New Branch"
			helpText={formatHelpText([
				{ key: "Enter", action: "Confirm" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.4}
			heightPercent={0.2}
		>
			{/* Label */}
			<box
				style={{
					width: "100%",
					height: 1,
					flexShrink: 0,
					marginBottom: 1,
				}}
			>
				<text fg={uiColors.textMuted}>
					Branch name (e.g. feature/1234-my-feature):
				</text>
			</box>

			{/* Input */}
			<box
				style={{
					width: "100%",
					height: 1,
					flexShrink: 0,
				}}
			>
				<input
					ref={(r) => (inputRef = r)}
					onInput={(value) => props.onBranchNameChange(value)}
					placeholder="feature/..."
					focusedBackgroundColor={uiColors.bgBase}
					focusedTextColor={uiColors.textPrimary}
				/>
			</box>
		</GenericModal>
	);
}
