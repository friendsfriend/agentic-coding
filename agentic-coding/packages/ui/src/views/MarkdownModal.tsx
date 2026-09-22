/** @jsxImportSource @opentui/solid */
// Shared markdown rendering — single source: src/tui/shared/MarkdownViewer.tsx.
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { GenericModal } from "../components/GenericModal";
import { formatHelpText } from "../components/HelpText.tsx";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { ScrollableContent } from "../components/ScrollableContent";

export interface MarkdownModalProps {
	title: string;
	content: string;
	hideTitle?: boolean;
	/** Portal z-order; provided when the modal must stack above another dialog. */
	zIndex?: number;
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
			zIndex={props.zIndex}
			customHeader={props.hideTitle ? <box style={{ height: 0 }} /> : undefined}
		>
			<ScrollableContent axes={["y"]} onScrollBoxReady={props.onScrollBoxReady}>
				<MarkdownViewer content={props.content} width={contentWidth()} />
			</ScrollableContent>
		</GenericModal>
	);
}
