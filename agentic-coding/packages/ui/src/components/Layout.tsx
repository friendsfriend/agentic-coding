/** @jsxImportSource @opentui/solid */
// Application shell: a fixed header band, the content, and a fixed footer band.
// The env surface reserves two header and three footer lines, the dashboard one
// and one, so both pass their own line counts instead of owning a layout copy.

import type { JSX } from "solid-js";
import { invokeGlobalSelectionMouseUpHandler } from "./selectionCopy";

export interface LayoutProps {
	header?: JSX.Element;
	content: JSX.Element;
	footer?: JSX.Element;
	/** Header band height in rows. Default 2. */
	headerLines?: number;
	/** Footer band height in rows. Default 1. */
	footerLines?: number;
	/** A band renders only when it was given content and a positive height. */
	backgroundColor?: string;
}

export function Layout(props: LayoutProps) {
	const headerLines = () => props.headerLines ?? 2;
	const footerLines = () => props.footerLines ?? 1;
	return (
		<box
			backgroundColor={props.backgroundColor}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
			onMouseUp={() => invokeGlobalSelectionMouseUpHandler()}
		>
			{props.header && headerLines() > 0 && (
				<box style={{ width: "100%", height: headerLines(), flexShrink: 0 }}>
					{props.header}
				</box>
			)}
			<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
				{props.content}
			</box>
			{props.footer && footerLines() > 0 && (
				<box style={{ width: "100%", height: footerLines(), flexShrink: 0 }}>
					{props.footer}
				</box>
			)}
		</box>
	);
}
