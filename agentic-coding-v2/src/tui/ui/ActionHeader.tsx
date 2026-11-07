/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import {
	createContext,
	createUniqueId,
	type JSX,
	onCleanup,
	onMount,
	useContext,
} from "solid-js";
import { color } from "./theme/index.ts";
export type ActionAnchor = {
	id: string;
	node: () => BoxRenderable | undefined;
	activate: () => void;
};
export const ActionRegistry = createContext<{
	selected: () => string | null;
	select: (id: string) => void;
	register: (anchor: ActionAnchor) => () => void;
}>();
/** Presentation-only activation; caller owns navigation or unsent-command preparation. */
export function ActionHeader(props: {
	onActivate: () => void;
	children: JSX.Element;
}) {
	const scope = useContext(ActionRegistry),
		id = createUniqueId();
	let node: BoxRenderable | undefined;
	let unregister: (() => void) | undefined;
	onMount(() => {
		unregister = scope?.register({
			id,
			node: () => node,
			activate: () => props.onActivate(),
		});
	});
	onCleanup(() => unregister?.());
	return (
		<box
			ref={(value) => {
				node = value;
			}}
			flexDirection="column"
			backgroundColor={
				scope?.selected() === id ? color("backgroundPanel") : undefined
			}
			onMouseDown={() => {
				scope?.select(id);
				props.onActivate();
			}}
		>
			{props.children}
		</box>
	);
}
