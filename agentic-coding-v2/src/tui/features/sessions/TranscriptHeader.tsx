/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import { type JSX, onCleanup } from "solid-js";
import { useTap } from "../../presentation/components/mouse/useTap.ts";

/** Only the header toggles; selecting/scrolling output does not collapse it. */
export function TranscriptHeader(props: {
	identity: string;
	select: (id: string) => void;
	toggle: (id: string) => void;
	anchor: (node: BoxRenderable | null) => void;
	children: JSX.Element;
}) {
	const tap = useTap(
		() => {
			props.select(props.identity);
			props.toggle(props.identity);
		},
		{ stopPropagation: true },
	);
	onCleanup(() => props.anchor(null));
	return (
		<box flexDirection="column" ref={(node) => props.anchor(node)} {...tap}>
			{props.children}
		</box>
	);
}
