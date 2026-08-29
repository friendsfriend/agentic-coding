/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import type { DeveloperDialogueRecord } from "../../../workflow/contracts";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { SelectableList } from "./Selectable";

export function DeveloperQuestionModal(props: {
	question: DeveloperDialogueRecord;
	selected: number;
	custom: boolean;
	customText: string;
	onCustomTextChange: (value: string) => void;
}) {
	const items = () => [
		...props.question.options.map((option) => option.label),
		"Custom response…",
	];
	return (
		<GenericModal
			title={`Developer input · ${props.question.role}`}
			fieldLabel="Question"
			widthPercent={0.7}
			heightPercent={0.65}
			zIndex={20}
			help={
				props.custom
					? [
							{ key: "Enter", action: "Submit response" },
							{ key: "Esc", action: "Cancel question" },
						]
					: [
							{ key: "↑↓", action: "Choose" },
							{ key: "Enter", action: "Select" },
							{ key: "Esc", action: "Cancel" },
						]
			}
		>
			<box width="100%" flexDirection="column" gap={1}>
				<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
					{props.question.description}
				</text>
				<text fg={uiColors.textMuted}>
					Requester: {props.question.role} · {props.question.stepId}
				</text>
				{props.custom ? (
					<box flexDirection="column" gap={1}>
						<text fg={uiColors.textMuted}>Custom response (required)</text>
						<input
							focused
							value={props.customText}
							placeholder="Type your response…"
							onInput={(value: string) =>
								props.onCustomTextChange(value.slice(0, 8192))
							}
							focusedBackgroundColor={uiColors.bgBase}
							focusedTextColor={uiColors.textPrimary}
						/>
					</box>
				) : (
					<SelectableList
						items={items()}
						selectedIndex={props.selected}
						renderItem={(item) => (
							<box paddingLeft={1} height={1}>
								<text fg={uiColors.textPrimary}>{item}</text>
							</box>
						)}
					/>
				)}
			</box>
		</GenericModal>
	);
}
