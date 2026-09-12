/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { SearchHeader } from "./SearchHeader";

export interface ConfirmDialogProps {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
	const dimensions = useTerminalDimensions();
	const confirmText = () => props.confirmText || "y";
	const heightLines = () =>
		Math.min(
			Math.max(8, props.message.split("\n").length + 6),
			Math.max(8, dimensions().height - 2),
		);
	const cancelText = () => props.cancelText || "n";

	return (
		<GenericModal
			title={props.title}
			helpText={formatHelpText([
				{ key: confirmText(), action: "Confirm" },
				{ key: cancelText(), action: "Cancel" },
			])}
			widthPercent={0.4}
			heightLines={heightLines()}
			customHeader={
				<SearchHeader>
					<box style={{ width: "100%", flexDirection: "row" }}>
						<text fg={uiColors.warning} attributes={TextAttributes.BOLD}>
							⚠ {props.title}
						</text>
					</box>
				</SearchHeader>
			}
		>
			<box
				style={{
					width: "100%",
					flexDirection: "column",
					paddingTop: 1,
					paddingBottom: 1,
					justifyContent: "center",
					alignItems: "center",
					flexGrow: 1,
				}}
			>
				<text fg={uiColors.textPrimary}>{props.message}</text>
			</box>
		</GenericModal>
	);
}
