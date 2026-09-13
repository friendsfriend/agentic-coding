/** @jsxImportSource @opentui/solid */
// One markdown renderer for every surface. The workflow/wiki review modals
// render parsed blocks through `MarkdownBlockView` (one selectable row per
// block, anchored to source lines); the environment modal renders the whole
// document through `MarkdownViewer`. Both use the theme-cached syntax style,
// so a live theme change restyles markdown everywhere.
import { uiColors } from "./colors";
import { getMarkdownSyntaxStyle } from "./markdownSyntax";

export interface MarkdownViewerProps {
	/** Whole-document markdown source. */
	content: string;
	/** Render width in terminal cells. */
	width: number;
	fg?: string;
}

/** Render a whole markdown document. */
export function MarkdownViewer(props: MarkdownViewerProps) {
	return (
		<markdown
			content={props.content}
			syntaxStyle={getMarkdownSyntaxStyle()}
			fg={props.fg ?? uiColors.textSecondary}
			width={props.width}
		/>
	);
}

export interface MarkdownBlockViewProps {
	/** Raw source of one top-level block (see `parseMarkdownBlocks`). */
	source: string;
	width: number;
	fg: string;
	flexGrow?: number;
}

/** Render one parsed markdown block (used by the review modals). */
export function MarkdownBlockView(props: MarkdownBlockViewProps) {
	return (
		<markdown
			content={props.source}
			syntaxStyle={getMarkdownSyntaxStyle()}
			fg={props.fg}
			width={props.width}
			flexGrow={props.flexGrow}
		/>
	);
}
