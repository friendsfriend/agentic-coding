/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";

/** Presentation-only activation; caller owns navigation or unsent-command preparation. */
export function ActionHeader(props: {
	onActivate: () => void;
	children: JSX.Element;
}) {
	return (
		<box flexDirection="column" onMouseDown={() => props.onActivate()}>
			{props.children}
		</box>
	);
}
