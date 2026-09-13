/** @jsxImportSource @opentui/solid */
// Shared markdown rendering — single source: src/tui/shared/MarkdownViewer.tsx.
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { MarkdownViewer } from "../../../../../src/tui/shared/MarkdownViewer";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { ScrollableContent } from "./ScrollableContent";

export interface MarkdownModalProps {
	title: string;
	content: string;
	hideTitle?: boolean;
	onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
}

export function MarkdownModal(props: MarkdownModalProps) {
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(40, Math.floor(dimensions().width * 0.7) - 8);

	return (
		<GenericModal
			title={props.title}
			helpText={formatHelpText([{ key: "Esc", action: "Close" }])}
			widthPercent={0.7}
			heightPercent={0.75}
			customHeader={props.hideTitle ? <box style={{ height: 0 }} /> : undefined}
		>
			<ScrollableContent axes={["y"]} onScrollBoxReady={props.onScrollBoxReady}>
				<MarkdownViewer content={props.content} width={contentWidth()} />
			</ScrollableContent>
		</GenericModal>
	);
}
