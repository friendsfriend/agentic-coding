/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";

export interface LayoutProps {
	header: JSX.Element;
	content: JSX.Element;
	footer: JSX.Element;
}

/**
 * Main application layout with header, content, and footer sections
 */
export function Layout(props: LayoutProps) {
	return (
		<box
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
			}}
		>
			{/* Header */}
			<box
				style={{
					width: "100%",
					height: 2,
					flexDirection: "row",
				}}
			>
				{props.header}
			</box>

			{/* Content */}
			<box
				style={{
					width: "100%",
					flexGrow: 1,
					flexDirection: "column",
				}}
			>
				{props.content}
			</box>

			{/* Footer */}
			<box
				style={{
					width: "100%",
					height: 3,
					flexDirection: "row",
				}}
			>
				{props.footer}
			</box>
		</box>
	);
}
