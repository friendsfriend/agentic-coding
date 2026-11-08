/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import {
	createContext,
	createEffect,
	createUniqueId,
	type JSX,
	onCleanup,
	onMount,
	useContext,
} from "solid-js";
import type { RowGestureState } from "../presentation/components/mouse/useRowMouse.ts";
import { useTap } from "../presentation/components/mouse/useTap.ts";
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
	scope?: unknown;
	interactive?: boolean;
	children: JSX.Element;
}) {
	const scope = useContext(ActionRegistry),
		id = createUniqueId();
	let node: BoxRenderable | undefined;
	let disposed = false;
	let unregister: (() => void) | undefined;
	const gesture: RowGestureState = {};
	const retire = () => {
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	createEffect(() => {
		props.scope;
		props.interactive;
		retire();
	});
	const activate = () => {
		if (!disposed && props.interactive !== false) {
			scope?.select(id);
			props.onActivate();
		}
	};
	const tap = useTap(activate, {
		gesture,
		stopPropagation: true,
		enabled: () => !disposed && props.interactive !== false,
	});
	onMount(() => {
		unregister = scope?.register({
			id,
			node: () => node,
			activate,
		});
	});
	onCleanup(() => {
		disposed = true;
		retire();
		unregister?.();
	});
	return (
		<box
			ref={(value) => {
				node = value;
			}}
			flexDirection="column"
			backgroundColor={
				scope?.selected() === id ? color("backgroundPanel") : undefined
			}
			{...tap}
		>
			{props.children}
		</box>
	);
}
