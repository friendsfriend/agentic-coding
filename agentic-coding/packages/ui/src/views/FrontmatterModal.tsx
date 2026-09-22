/** @jsxImportSource @opentui/solid */
import { FrontmatterView } from "../components/FrontmatterView.tsx";
import { GenericModal } from "../components/GenericModal.tsx";
import { formatHelpText } from "../components/HelpText.tsx";
import { ScrollableContent } from "../components/ScrollableContent.tsx";

export interface FrontmatterModalProps {
	/** Parsed YAML frontmatter mapping to present. */
	frontmatter: Record<string, unknown>;
	/** Dialog title; defaults to "Frontmatter". */
	title?: string;
	onClose?: () => void;
}

/**
 * Read-only dialog that renders a document's frontmatter as structured rows.
 * Used by the wiki note page, which hides frontmatter from the default reading
 * view and reveals it on demand.
 */
export function FrontmatterModal(props: FrontmatterModalProps) {
	return (
		<GenericModal
			title={props.title ?? "Frontmatter"}
			helpText={formatHelpText([{ key: "Esc", action: "Close" }])}
			widthPercent={0.7}
			heightPercent={0.7}
			onBackdropClick={props.onClose}
		>
			<ScrollableContent axes={["y"]}>
				<FrontmatterView frontmatter={props.frontmatter} />
			</ScrollableContent>
		</GenericModal>
	);
}
