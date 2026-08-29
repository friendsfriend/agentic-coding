/** @jsxImportSource @opentui/solid */

import type { SyntaxStyle } from "@opentui/core";
import { Show } from "solid-js";

export interface MarkdownSourceLineProps {
	content: string;
	syntaxStyle: SyntaxStyle;
	/** Language from the surrounding fenced block, if this is code content. */
	codeLanguage?: string;
	/** Do not render the Markdown fence itself, but retain its source row. */
	isFence?: boolean;
	fg?: string;
	width?: number;
}

/**
 * Render one source line through OpenTUI's Markdown renderer.
 *
 * Keeping this as a one-line renderable means callers can keep the source line
 * as the selectable/commentable unit. Fenced code is wrapped in a tiny,
 * complete Markdown document because the native renderer otherwise cannot
 * infer a block when it receives only one source line.
 */
export function MarkdownSourceLine(props: MarkdownSourceLineProps) {
	const markdown = () => {
		if (props.isFence) return " ";
		if (props.codeLanguage !== undefined)
			return `\`\`\`${props.codeLanguage}\n${props.content}\n\`\`\``;
		return props.content || " ";
	};

	return (
		<Show when={!props.isFence} fallback={<text fg={props.fg}> </text>}>
			<markdown
				content={markdown()}
				syntaxStyle={props.syntaxStyle}
				fg={props.fg}
				width={props.width ?? 80}
				flexGrow={1}
			/>
		</Show>
	);
}

/** Track the Markdown fence state without changing source-line indices. */
export function markdownFenceStates(lines: string[]): Array<{
	codeLanguage?: string;
	isFence: boolean;
}> {
	let language: string | undefined;
	let marker: string | undefined;
	return lines.map((line) => {
		const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
		if (fence) {
			const isClosing =
				marker !== undefined && fence[1]?.startsWith(marker) === true;
			const state = { codeLanguage: language, isFence: true };
			if (isClosing) {
				language = undefined;
				marker = undefined;
			} else if (marker === undefined) {
				marker = fence[1]?.[0];
				language = fence[2] || "text";
			}
			return state;
		}
		return { codeLanguage: language, isFence: false };
	});
}
